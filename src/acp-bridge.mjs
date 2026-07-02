// Concord room <-> coding agent, over ACP (Agent Client Protocol).
//
// We drive the agent through the OFFICIAL @agentclientprotocol/sdk (see engine.mjs),
// NOT through any third-party orchestrator. The agent runs as a resident ACP
// adapter subprocess that is OUR child; idle = bridge blocked on the room
// long-poll + the agent idle on its side = ZERO LLM tokens. One room message =>
// one prompt turn against the resident session.
//
//   Concord room  <--REST long-poll-->  this bridge (ACP client)  <--stdio-->  agent ACP adapter  <-->  claude/codex/…
//
// Zero changes to Concord core. One npm dep: @agentclientprotocol/sdk (neutral,
// Apache-2.0, by the protocol authors). The per-vendor adapter is launched on
// demand (engine.mjs ADAPTERS); override with ACP_ADAPTER_CMD.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { toolToProgress, toolDetail } from './render.mjs';
import { resolveConfig, usage, shouldRelayInbound } from './cli.mjs';
import { overBudget, usageReport, budgetExceededNote } from './budget.mjs';
import { obtainRoomId } from './handoff.mjs';
import { createEngine } from './engine.mjs';
import { parseForm, renderQuestion, parseReply } from './elicit.mjs';
import { procStart } from './reclaim.mjs';

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) { console.log(usage()); process.exit(0); }

// Inputs come from CLI flags (preferred) or env (CLI flag > env > default).
//   node acp-bridge.mjs [agent] [--room id] [--cwd dir] [--name n] [--url u] [--model m] [--effort e]
const cfg = resolveConfig(process.argv.slice(2), process.env);
const AGENT = cfg.agent;                 // claude | codex | gemini | … (engine.mjs ADAPTERS)
const AGENT_NAME = cfg.name;
const AGENT_CWD = cfg.cwd || process.cwd();   // working dir the hosted agent operates in
const CONCORD_URL = cfg.url;
const CONCORD_PUBLIC_URL = cfg.publicUrl || CONCORD_URL;   // public base for the web connect link
// Permission policy for tool calls: 'approve-all' (PoC default, auto-run tools in
// the cwd) or 'reject'. Security hardening (default to an allowlist) is tracked
// separately; default kept as-is so behavior doesn't change.
const PERMISSION_POLICY = process.env.ACP_PERMISSION || 'approve-all';
const STORE_PATH = process.env.STORE_PATH;   // persist sessionId + processed-id dedup (resume/idempotency)
const AGENT_MODEL = cfg.model;           // optional, shown in the self-intro
const AGENT_EFFORT = cfg.effort;         // optional, shown in the self-intro
// Validate AT THE POINT OF USE (not only the CLI front door): a direct `node
// acp-bridge.mjs` / env-driven run with a malformed budget must NOT silently become
// "unlimited" via parseInt(...)||0 — that's the exact unbounded-sink P1 closes.
if (cfg.budget != null && cfg.budget !== '' && !/^[1-9]\d*$/.test(String(cfg.budget).trim())) {
  console.error(`✗ AGENT_TOKEN_BUDGET/--budget must be a positive integer (got "${cfg.budget}"); refusing to run unguarded.`);
  process.exit(1);
}
const AGENT_TOKEN_BUDGET = parseInt(cfg.budget, 10) || 0;                 // lifetime max fresh tokens; 0 = unlimited (pure metering)
// Progress output (self-intro / ack / progress cards) is for a HUMAN watching. In a
// multi-agent room (join mode) it pollutes the room + burns other agents' tokens,
// so it's gated. host→on, join→off (set via ACP_PROGRESS by the CLI); default on.
const PROGRESS = cfg.progress == null ? true : cfg.progress;

// Instant human-style acknowledgement when a task arrives, BEFORE the agent
// starts working — pure program, no LLM, not fed into the agent's context.
const ACKS = ['收到 👌', '好的,这就处理', '没问题,我看看', '收到,马上做', '好嘞,在做了'];
let ackIdx = 0;
const nextAck = () => ACKS[ackIdx++ % ACKS.length];

// One-time self-introduction so the user knows who/what they're working with.
function introText() {
  const bits = [`🤖 ${AGENT_NAME} 已就绪`, `agent: ${AGENT}`];
  if (AGENT_MODEL) bits.push(`模型 ${AGENT_MODEL}`);
  if (AGENT_EFFORT) bits.push(`effort ${AGENT_EFFORT}`);
  bits.push(`工作目录 ${AGENT_CWD}`);
  if (AGENT_TOKEN_BUDGET > 0) bits.push(`额度 ${AGENT_TOKEN_BUDGET} fresh tok 累计上限(/usage 查)`);
  return bits.join(' · ') + '。把任务发给我。';
}

const die = (m) => { try { store?.setExit?.('exit: ' + m); } catch { /* state is best-effort */ } console.error('✗ ' + m); process.exit(1); };
// The CLI always injects STORE_PATH (~/.concord/hosts/<id>/state.json). The
// fallback (direct `node acp-bridge.mjs` runs) goes to a WRITABLE user dir, never
// next to the module — a globally-installed package dir is typically read-only.
const store = openStore(STORE_PATH || join(homedir(), '.concord', 'bridge-state.json'));

let CONCORD_ROOM_ID = cfg.roomId;
// No room → browser handoff (shared, nonce-protected). Don't log the room id (bearer).
if (!CONCORD_ROOM_ID) { CONCORD_ROOM_ID = await obtainRoomId(CONCORD_PUBLIC_URL); console.log('  → room connected.'); }

// ---------------------------------------------------------------------------
// Concord room side (same REST shape as the Lark + supervisor bridges)
// ---------------------------------------------------------------------------
let sessionId = null;
let senderName = AGENT_NAME;
const room = `${CONCORD_URL}/agent/rooms/${CONCORD_ROOM_ID}`;
const post = (path, body) => fetch(room + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function joinRoom() {
  // Resume the persisted session first: stable identity across restarts + the
  // processed-id dedup below ensures old turns aren't re-run. Resume with the SAME sender
  // the session was created under (persisted) — NOT a blind AGENT_NAME. A prior restart may
  // have joined under a 409-fallback name ("claude-1234"); resuming that session while
  // claiming "claude" reads fine (GET is session-only) but every POST 403s (sender≠owner),
  // so replies silently vanish. Reusing the stored sender keeps sender==owner.
  const existing = store.getSessionId(CONCORD_ROOM_ID);
  const storedSender = store.getSender(CONCORD_ROOM_ID) || AGENT_NAME;
  if (existing) {
    const res = await post('/join', { sender: storedSender, agentSessionId: existing });
    if (res.ok) { senderName = storedSender; sessionId = (await res.json()).agentSessionId; store.setSessionId(CONCORD_ROOM_ID, sessionId); store.setSender(CONCORD_ROOM_ID, senderName); console.log(`✓ Concord: resumed room as "${senderName}"`); return; }
    store.setSessionId(CONCORD_ROOM_ID, null); // stale resume token → fresh join
  }
  // Fallback suffix when AGENT_NAME is taken: the host id's hex tail (what
  // `concord list` shows — "claude-a1b2c3" there is "claude-a1b2c3" in the room),
  // so the two names line up. Bare runs without a host id keep the pid fallback.
  const suffix = (process.env.CONCORD_HOST_ID || '').split('-').pop() || String(process.pid % 10000);
  // Last-resort pid candidate: if the stable name is ALSO held by a stale session
  // (state.json lost), a fresh unique name still gets us into the room.
  const candidates = [...new Set([AGENT_NAME, `${AGENT_NAME}-${suffix}`, `${AGENT_NAME}-${process.pid % 10000}`])];
  for (const name of candidates) {
    const res = await post('/join', { sender: name });
    if (res.ok) { senderName = name; sessionId = (await res.json()).agentSessionId; store.setSessionId(CONCORD_ROOM_ID, sessionId); store.setSender(CONCORD_ROOM_ID, name); console.log(`✓ Concord: joined room as "${name}"`); return; }
    if (res.status !== 409) die(`join failed: ${res.status} ${await res.text()}`);
    console.warn(`  name "${name}" taken, retrying…`);
  }
  die('could not join room');
}

// The room caps a single message body at 2MB (HTTP) and hard-truncates content past
// ~50k chars. fetch never throws on an HTTP error status, so a too-large reply would be
// rejected (413) and vanish silently. On 413, resend a truncated version so the chat
// gets the (clipped) reply instead of nothing — same "never go silent" rule as a turn end.
const ROOM_MSG_LIMIT = 45000;
// Smart truncation: a hard prefix-cut drops the conclusion (often the most useful part)
// AND hides whether the task finished. Keep the head AND the tail, and say exactly how
// much was dropped, so the human reads it as a length cut, not a crash. Clipping at
// ROOM_MSG_LIMIT (< the room's ~50k char cap) proactively also beats the SILENT
// server-side truncation, not just the 2MB-body 413.
function clip(text) {
  const head = Math.floor(ROOM_MSG_LIMIT * 0.7), tail = ROOM_MSG_LIMIT - head;
  const dropped = text.length - head - tail;
  const lines = text.split('\n').length;
  return `${text.slice(0, head)}\n\n  …✂ 已省略中间 ${dropped} 字(共 ${lines} 行,回复过大,保留开头与结尾)…\n\n${text.slice(-tail)}`;
}
async function sendToRoom(text) {
  const content = text.length > ROOM_MSG_LIMIT ? clip(text) : text;
  let res = await post('/messages', { sender: senderName, agentSessionId: sessionId, content });
  if (res.status === 413) return post('/messages', { sender: senderName, agentSessionId: sessionId, content: clip(text) });   // backstop if even the clipped body is rejected
  // 401 (session expired) or 403 (sender≠session owner — e.g. a mismatched resume, or a stale
  // session inherited from an upgrade): drop the bad session, re-join FRESH (clearing the stored
  // session so it's not a resume), and retry ONCE. Without this every reply silently 403s and the
  // user sees nothing — exactly the "agent processed the turn but never replied" bug.
  if (res.status === 401 || res.status === 403) {
    console.warn(`room post ${res.status} → rejoin + retry`);
    store.setSessionId(CONCORD_ROOM_ID, null);   // force a fresh join, not a resume of the bad session
    try { await joinRoom(); res = await post('/messages', { sender: senderName, agentSessionId: sessionId, content }); }
    catch (e) { console.warn('rejoin failed: ' + e.message); }
  }
  if (!res.ok) console.warn(`room post ${res.status} — message may not have landed`);
  return res;
}

// ---------------------------------------------------------------------------
// IM bridge (personal mode) — only when `concord host --im <platform>` set. Lazy so a
// room-only host (join / host without IM) never loads the Lark SDK. 1:1: this host's
// room <-> the user's own bot. Inbound IM → fed to the turn queue; replies/progress go
// back to the originating chat AND the room (record).
// ---------------------------------------------------------------------------
const IM_PLATFORM = process.env.ACP_IM || '';
let im = null;                 // { send(chatId,text), shutdown() } or null
let currentImChat = null;      // the IM chat the in-flight turn came from (reply target)

// Deliver a user-facing line to the room AND, when the active turn came from IM, back to
// that chat. With no IM this is exactly sendToRoom → room-only behavior is unchanged.
function out(text, imChat = currentImChat) {
  const p = sendToRoom(text);
  if (im && imChat) im.send(imChat, text).catch(() => {});
  return p;
}

async function startIm() {
  if (!IM_PLATFORM) return;
  const { getCreds } = await import('./creds.mjs');
  const c = getCreds(IM_PLATFORM);
  if (!c?.appId || !c?.appSecret) { console.warn(`⚠️ --im ${IM_PLATFORM} set but no stored creds — running room-only.`); return; }
  const { createImBridge } = await import('./im-lark.mjs');
  im = createImBridge({ platform: IM_PLATFORM, appId: c.appId, appSecret: c.appSecret, domain: c.domain, log: console.log });
  im.start({
    isSeen: (mid) => store.wasProcessedInbound('im:' + mid),
    markSeen: (mid) => store.markProcessedInbound('im:' + mid),
    onMessage: ({ chatId, text, sender }) => handleInbound({ text, sender, imChat: chatId }),
  });
}

// ---------------------------------------------------------------------------
// Agent side: one prompt turn per room message, against the resident ACP session
// ---------------------------------------------------------------------------
let busy = false;
const pending = [];
let engine = null;
let usageWarned = false;
let recreateTimes = [];               // timestamps of recent engine recreates (crash-loop guard)
const RECREATE_WINDOW_MS = 5 * 60 * 1000;
const RECREATE_MAX = 5;               // max engine recreates per window before we pause
let timeoutTimes = [];                // timestamps of recent turn-timeouts. A WINDOW (not a consecutive
const TIMEOUT_WINDOW_MS = 6 * 60 * 60 * 1000;   // count) so an alternating timeout/clean pattern can't launder
const MAX_TIMEOUTS_WINDOW = 3;        // the streak: each timed-out turn burns ~ACP_TURN_TIMEOUT off-budget.
let paused = false;                   // hard pause (repeated timeouts) — `concord resume` / restart clears

// (Re)create the resident ACP engine: spawn the adapter, wait until the session is
// live, and record the adapter's process-group pgid so the CLI can reap it even if
// we die without running cleanShutdown. Throws if the adapter won't start.
// ── Agent-initiated questions (ACP form elicitation) ───────────────────────
// The agent's AskUserQuestion (or an MCP elicitation) arrives as a REQUEST that
// blocks its turn until we answer. We post the question card to the room / IM,
// then resolve with the first HUMAN reply (agents chattering in a multi-agent
// room are queued as normal work, never consumed as answers). One at a time; a
// timeout cancels so the turn can't hang past the per-turn ceiling.
const ELICIT_TIMEOUT_MS = (parseInt(process.env.ACP_ELICIT_TIMEOUT ?? '600', 10) || 600) * 1000;
let pendingElicit = null;   // { form, resolve, timer, imChat }

function settleElicit(response) {
  if (!pendingElicit) return;
  clearTimeout(pendingElicit.timer);
  const { resolve } = pendingElicit;
  pendingElicit = null;
  resolve(response);
}

async function handleElicitation(params) {
  if (params?.mode !== 'form') return { action: 'cancel' };         // url-mode not advertised; belt & braces
  if (pendingElicit) return { action: 'cancel' };                    // one open question at a time
  const form = parseForm(params);
  const imChat = currentImChat;
  await out(renderQuestion(form), imChat).catch(() => {});
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      out(`⏳ ${Math.round(ELICIT_TIMEOUT_MS / 60000)} 分钟没有回答,已跳过该提问,agent 继续。`, imChat).catch(() => {});
      settleElicit({ action: 'cancel' });
    }, ELICIT_TIMEOUT_MS);
    pendingElicit = { form, resolve, timer, imChat };
  });
}

async function startEngine() {
  // Warm resume: hand the previous ACP session id back to the adapter so a restart
  // keeps the agent's context. Falls back to a fresh session inside the engine.
  engine = createEngine({ agent: AGENT, cwd: AGENT_CWD, permission: PERMISSION_POLICY, log: console.log, resumeSessionId: store.getAcpSessionId(CONCORD_ROOM_ID), onElicitation: handleElicitation });
  await engine.ready;
  briefed = engine.resumed();   // a resumed session was already briefed; a fresh one gets the briefing on its first turn
  store.setAcpSessionId(CONCORD_ROOM_ID, engine.sessionId());
  const apid = engine.adapterPid();
  // Record the adapter's start-time so an orphan reap can't kill a recycled pid. A null
  // start (ps hiccup) would DISABLE the guard for this host, so retry a few times; if it
  // stays null, warn loudly — the safety net (orphan reaping) is off until ps recovers.
  let start = procStart(apid);
  for (let i = 0; i < 3 && apid && !start; i++) { await new Promise((r) => setTimeout(r, 100)); start = procStart(apid); }
  if (apid && !start) console.warn('⚠️ could not read the adapter start-time (ps unavailable) — orphan reaping is disabled for this host until it can be verified.');
  store.setAdapterPid(apid, start);
}
// Before a turn: if the engine died (adapter crash / dropped connection), tear the
// dead one down and bring up a fresh one so the host self-heals instead of dying.
// Rate-limited: a crash-looping adapter must NOT spawn adapter-after-adapter, each
// burning a turn. Cap recreates per window with exponential backoff; past the cap,
// throw so drain() pauses and the user must `concord restart` (no silent burn loop).
async function ensureEngine() {
  if (engine && !engine.dead()) return;
  if (engine) { console.warn('engine died → recreating'); try { await engine.shutdown(); } catch { /* best effort */ } }
  const now = Date.now();
  recreateTimes = recreateTimes.filter((t) => now - t < RECREATE_WINDOW_MS);
  if (recreateTimes.length >= RECREATE_MAX) {
    throw new Error(`agent restarted ${RECREATE_MAX}× in ${Math.round(RECREATE_WINDOW_MS / 60000)}min — paused. Run \`concord restart\` once it's fixed.`);
  }
  if (recreateTimes.length > 0) await new Promise((r) => setTimeout(r, Math.min(30000, 500 * 2 ** recreateTimes.length)));
  recreateTimes.push(Date.now());
  await startEngine();
}

// Run one prompt turn through the engine. Tool-call ACP updates → one enriched
// progress card per tool (toolToProgress in render.mjs). ACP sends `tool_call`
// (pending, empty input) then `tool_call_update`(s) that fill in title/path — so
// we emit the enriched card once detail arrives (or on completion). Dedup by id.
// Live plan (agent TODO list) → one compact checklist card per status change.
// The agent replaces the whole plan on each update, so dedup by a signature of
// entry statuses; re-post only when something actually moved. PROGRESS-gated.
let lastPlanSig = '';
function planCard(entries) {
  const icon = { pending: '☐', in_progress: '▸', completed: '✓' };
  const done = entries.filter((e) => e.status === 'completed').length;
  const MAX = 12;
  const lines = entries.slice(0, MAX).map((e) => `${icon[e.status] || '☐'} ${e.content}`);
  if (entries.length > MAX) lines.push(`… +${entries.length - MAX} more`);
  return `📋 计划 ${done}/${entries.length}\n${lines.join('\n')}`;
}

// One-time in-session briefing so the agent KNOWS it is already inside the room.
// Without it, a Claude that also has the concord PLUGIN installed sees room-style
// messages ("@评审 …"), concludes it never formally joined, and starts suggesting
// `/concord:resume` / touching .concord/ — pure confusion. Prepended to the FIRST
// turn of every fresh session (a resumed session already has it in context).
let briefed = false;
const briefing = () =>
  `[concord-agent bridge] You are ALREADY connected to Concord room ${CONCORD_ROOM_ID} as "${senderName}". ` +
  `This bridge relays room messages to you as "[sender] text" and posts your replies back to the room automatically. ` +
  `Do NOT run or suggest any /concord:* plugin commands (join/resume/stop) and do NOT read or write .concord/ state — the bridge owns all room I/O. ` +
  `Just do the work and reply normally.`;

async function runTurn(text) {
  if (!briefed) { briefed = true; text = `${briefing()}\n\n${text}`; }
  const toolState = new Map();
  const onUpdate = (u) => {
    // Live context-window meter (tokens in context / window size) → store, so
    // `concord status` and /usage can show it. No room post (too chatty).
    if (u.sessionUpdate === 'usage_update') {
      if (typeof u.used === 'number' && typeof u.size === 'number') store.setContextUsage(CONCORD_ROOM_ID, u.used, u.size);
      return;
    }
    if (u.sessionUpdate === 'plan') {
      const entries = Array.isArray(u.entries) ? u.entries : [];
      if (!entries.length) return;
      const sig = entries.map((e) => `${e.status}:${e.content}`).join('|');
      if (sig === lastPlanSig) return;
      lastPlanSig = sig;
      const card = planCard(entries);
      console.log(card.split('\n').map((l) => `  ${l}`).join('\n'));
      if (PROGRESS) out(card);
      return;
    }
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return;
    if (process.env.ACP_DEBUG_TOOLCALL) console.log('[raw tool_call]', JSON.stringify(u).slice(0, 600));
    const id = u.toolCallId || u.title || 'tool';
    const st = toolState.get(id) || { emitted: false };
    if (u.kind) st.kind = u.kind;                  // remember kind/title from whichever event carries them
    if (u.title) st.title = u.title;
    const uu = { ...u, kind: u.kind || st.kind, title: u.title || st.title };
    const completed = u.status === 'completed' || u.status === 'failed';
    if (!st.emitted && (toolDetail(uu) || completed)) {   // emit enriched once; fallback to bare card on completion
      const card = toolToProgress(uu);
      console.log(`  ${card}`);                      // local log always
      if (PROGRESS) out(card);                        // room (+ IM chat of the active turn) when progress is on
      st.emitted = true;
    }
    toolState.set(id, st);
  };
  const { reply, usage, stopReason, usagePresent } = await engine.runTurn(text, onUpdate);
  if (!usagePresent && AGENT_TOKEN_BUDGET > 0 && !usageWarned) {
    usageWarned = true;   // a set --budget that can't be measured must NOT silently become unlimited.
    const w = `⚠️ 这个 agent 不上报 token 用量,设定的 --budget(${AGENT_TOKEN_BUDGET})无法按量强制执行;仅靠单轮超时兜底单轮上界。`;
    console.warn(w);
    out(w);   // safety-relevant fact → room + IM, regardless of PROGRESS (like turn-fail notes)
  }
  console.log(`■ turn end  ·  stop=${stopReason}  ·  fresh ${usage.fresh} tok, cache-read ${usage.cached} tok`);
  return { reply, usage };
}

// Whether the lifetime fresh-token cap is hit — so a runaway agent can't burn
// unbounded cost while nobody's watching. No cap (0) → never blocks. The counter
// is never auto-reset; an over-cap agent resumes only via `concord budget --reset`.
function budgetBlocked() {
  return overBudget(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET);
}
const budgetNote = (imChat) => out(budgetExceededNote(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET), imChat);

// Early-warning so spend is VISIBLE before the cap pauses the agent: one room note
// when cumulative usage first crosses 80% of the budget. No-op if no budget.
function maybeBudgetWarn() {
  if (!AGENT_TOKEN_BUDGET || store.getWarned80(CONCORD_ROOM_ID)) return;   // persisted: a restart must not re-warn
  const u = store.getUsage(CONCORD_ROOM_ID);
  if (u.fresh >= AGENT_TOKEN_BUDGET * 0.8) {
    store.setWarned80(CONCORD_ROOM_ID);
    out(`⚠️ 已用 ${u.fresh}/${AGENT_TOKEN_BUDGET} fresh tok(≥80%),接近累计预算上限。`);
  }
}

async function drain() {
  if (busy || paused || pending.length === 0) return;
  busy = true;
  try {
    while (pending.length) {
      if (paused) { pending.length = 0; break; }
      const item = pending[0];                                 // peek: reply/notes target THIS message's IM chat
      if (budgetBlocked()) { await budgetNote(item.imChat); pending.length = 0; break; } // drop queued; over budget
      // Self-heal: a dead engine (adapter crash / dropped connection) is rebuilt
      // before the turn. If it won't come back, tell the user and stop draining;
      // the next inbound message retries (poll waits 30s → no tight crash loop).
      if (!engine || engine.dead()) {
        try { await ensureEngine(); }
        catch (e) { console.error('engine restart failed:', e.message); await out(`⚠️ agent 暂时起不来(${String(e.message).slice(0, 120)}),稍后再发一次。`, item.imChat).catch(() => {}); break; }
      }
      pending.shift();
      currentImChat = item.imChat;                             // route this turn's progress + reply to its IM chat (if any)
      console.log(`\n▶ turn start  ·  ${item.text.slice(0, 80)}`);
      store.setActivity('working', item.text.replace(/^\[[^\]]*\]\s*/, '').slice(0, 60));   // surface to `concord list`/`status`
      try {
        const { reply, usage } = await runTurn(item.text);
        recreateTimes = [];                                    // a clean turn means the engine recovered → reset the crash-loop guard
        store.addUsage(CONCORD_ROOM_ID, usage.fresh, usage.cached);
        maybeBudgetWarn();                                     // surface 80%-of-budget before the cap pauses us
        // Never go silent: a clean turn can end with no assistant text (Claude Code
        // sometimes puts the conclusion in a post_turn_summary the ACP adapter drops).
        // The progress cards already show the work — this just confirms the turn ended.
        if (reply.trim()) await out(reply.trim());             // agent's full reply -> room + IM chat
        else await out('✓ 完成');
      } catch (e) {
        // A mid-turn ACP failure must NOT crash the host (the #1 review finding).
        // Surface it and keep the bridge alive; the next iteration rebuilds the engine.
        console.error('turn failed:', e.message);
        if (e && e.code === 'TURN_TIMEOUT') {
          // A timed-out turn isn't budget-billed (it never reached 'stop'), so the
          // per-amount cap can't catch a slow-but-burning prompt. Bound it by a WINDOW
          // count (not consecutive — an alternating timeout/clean pattern must still
          // converge to a pause; a clean turn does NOT launder a timeout's burn).
          const now = Date.now();
          timeoutTimes = timeoutTimes.filter((t) => now - t < TIMEOUT_WINDOW_MS);
          timeoutTimes.push(now);
          if (timeoutTimes.length >= MAX_TIMEOUTS_WINDOW) {
            paused = true; pending.length = 0; store.setPaused('timeouts');   // persist so `concord list` shows PAUSED, not a silently-dropping "running"
            await out(`⏸️ 多次超时(${MAX_TIMEOUTS_WINDOW} 次),已暂停以免持续烧 token。用 \`concord list\` 找到 id 后 \`concord resume <id>\` 或 \`concord restart <id>\`。`).catch(() => {});
            break;
          }
          await out(`⚠️ 这轮超时被取消了(${String(e.message).slice(0, 100)})。任务太大就拆小一点再发。`).catch(() => {});
        } else {
          await out(`⚠️ 这条没处理成功(${String(e.message).slice(0, 120)}),可以再发一次。`).catch(() => {});
        }
      } finally {
        currentImChat = null;
      }
    }
  } finally {
    busy = false;   // ALWAYS reset, so a failure can't wedge the host busy forever
    if (!paused) store.setActivity('idle');   // queue drained → idle (a pause is surfaced separately)
  }
}

// One inbound message (from the room poll OR the IM bridge) → maybe ack/intro, then
// queue a turn. imChat = the IM chat to reply into (null for a Concord-room message).
// In-room slash commands passed to the agent VERBATIM — the ACP adapter only
// treats a prompt as a command when the text ITSELF starts with "/", so these
// must NOT carry the `[sender]` prefix. Small, safe allowlist: session-context
// management only. Capability/permission/identity commands are deliberately
// absent (a room message must never change the agent's scope); anything not
// listed stays an attributed chat line (default-deny).
const PASSTHROUGH_SLASH = new Set(['/compact', '/context']);
const ROOM_HELP = '📋 房内命令:/compact 压缩上下文 · /clear 清空上下文(重开 session) · /context 查看上下文占用 · /usage 累计用量 · /help 本帮助';

// `/clear` — reset the agent to an EMPTY context by recycling its engine (a fresh
// ACP adapter+agent subprocess). Only the LLM side is swapped: room identity
// (senderName + room session), IM binding, and the lifetime usage meter live at
// module level / are owned elsewhere and are left untouched — the agent stays in
// the room, same name, same bindings, just with a blank mind. NOT a passthrough:
// the adapter marks `/clear` unsupported, so the ACP-native path is a new session.
async function clearSession(imChat) {
  if (busy) { await out('⏳ agent 正忙,当前 turn 结束后再 /clear。', imChat); return; }
  console.log('🧹 /clear → recycling engine for a fresh session');
  store.setActivity('working', '/clear');
  try {
    settleElicit({ action: 'cancel' });                     // an open question dies with the session it belongs to
    if (engine) { try { await engine.shutdown(); } catch { /* best effort */ } }
    store.setAcpSessionId(CONCORD_ROOM_ID, null);           // a wiped session must NEVER be warm-resumed back
    lastPlanSig = '';                                       // stale plan card must not suppress the fresh session's first plan
    await startEngine();                                    // fresh adapter + empty-context session; joinRoom/startIm/meter untouched
    store.setActivity('idle');
    await out('🧹 已清空 agent 上下文,从零开始(名字、房间、绑定、用量计数都不变)。', imChat);
  } catch (e) {
    // Room/IM/identity layer is intact; the engine is left dead and the next message
    // rebuilds it via ensureEngine (same as a crash) — so we never lose the room.
    store.setActivity('idle');
    await out(`⚠️ 清空失败:${String(e?.message || e).slice(0, 120)}(下条消息会自动重试起 agent)。`, imChat).catch(() => {});
  }
}

async function handleInbound({ text, sender, imChat = null, senderType = 'human' }) {
  const content = (text || '').trim();
  if (!content) return;
  if (['/usage', '/stats', '用量'].includes(content)) {       // pure query — no turn, no ack
    const ctxUse = store.getContextUsage(CONCORD_ROOM_ID);
    const ctxLine = ctxUse?.size ? ` · 上下文 ${Math.round(ctxUse.used / 1000)}k/${Math.round(ctxUse.size / 1000)}k` : '';
    await out(usageReport(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET) + ctxLine, imChat);
    return;
  }
  if (content === '/help') { await out(ROOM_HELP, imChat); return; }   // pure query — list in-room commands
  if (content === '/clear') { await clearSession(imChat); return; }    // recycle the agent's session → empty context (identity/binding/meter kept)
  // An open agent question consumes the next HUMAN reply as its answer. Agent /
  // system messages fall through to normal queueing — in a multi-agent room the
  // other agents' chatter must never be mistaken for the human's choice.
  if (pendingElicit && senderType === 'human') {
    const r = parseReply(pendingElicit.form, content);
    if (!r.ok) { await out(r.hint, imChat); return; }
    console.log(`← answer | ${sender}: ${content}`);
    settleElicit(r.response);
    return;
  }
  if (paused) { if (im && imChat) im.send(imChat, '⏸️ 已暂停(多次超时);让 owner 跑 `concord resume`/`restart` 后再发。').catch(() => {}); return; }
  if (budgetBlocked()) { await budgetNote(imChat); return; }   // over budget → refuse cleanly
  // Self-intro + ack ONLY when this agent owns its own IM bridge (`--im`). In `--bind` mode the
  // `concord im` owner is the user-facing acker ("🤖 Claude 正在处理…"), so a second ack here
  // would double up in the chat (the owner relays our room posts back). Progress cards + the
  // final reply still flow either way.
  if (PROGRESS && IM_PLATFORM && !store.wasIntroduced(CONCORD_ROOM_ID)) { await out(introText(), imChat); store.setIntroduced(CONCORD_ROOM_ID); }
  if (PROGRESS && IM_PLATFORM) await out(nextAck(), imChat);   // instant "收到" before the agent works (self-owned IM only)
  console.log(`→ agent | ${sender}: ${content}`);
  // Allowlisted session-control slash → verbatim (no prefix) so the adapter executes it; else attributed chat.
  const isSlash = PASSTHROUGH_SLASH.has(content.split(/\s+/, 1)[0]);
  pending.push({ text: isSlash ? content : `[${sender}] ${content}`, imChat });
  drain();
}

// ---------------------------------------------------------------------------
// Room -> agent: long-poll, enqueue anything that isn't our own message.
// ---------------------------------------------------------------------------
async function pollLoop() {
  let n = 0;
  for (;;) {
    try {
      const res = await fetch(`${room}/messages?session=${sessionId}&wait=30`);
      if (res.status === 401) { console.warn('Concord session expired → rejoin'); await joinRoom(); continue; }
      for (const m of (await res.json()).messages || []) {
        if (!shouldRelayInbound(m, senderName)) continue;   // own echoes + ambient 'system' notices never wake the agent
        if (store.wasProcessedInbound(m.id)) continue;   // already handled (resume / redelivery)
        store.markProcessedInbound(m.id);
        await handleInbound({ text: m.content, sender: m.sender, imChat: null, senderType: m.senderType || 'human' });   // room message → reply to room only
      }
      if (++n % 10 === 0) await post('/heartbeat', { agentSessionId: sessionId });
    } catch (e) { console.error('poll error:', e.message); await new Promise((r) => setTimeout(r, 2000)); }
  }
}

// On stop/restart the CLI SIGTERMs us; shut the engine down so the ACP adapter +
// the agent it spawns (our child process group) don't survive as orphans.
let shuttingDown = false;
async function cleanShutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n${sig} → shutting down agent (${AGENT_CWD}) …`);
  const hard = setTimeout(() => process.exit(0), 12000); hard.unref();   // backstop if shutdown wedges
  // AWAIT the group-kill: engine.shutdown() group-SIGTERMs the adapter, waits for
  // the group to actually exit, then group-SIGKILLs. We only exit AFTER it's gone —
  // the SIGKILL backstop must not live in a process that exits before it fires.
  try { im?.shutdown(); } catch { /* best effort */ }
  try { if (engine) await engine.shutdown(); } catch { /* best effort */ }
  store.setAdapterPid(null);   // group reaped → clear the pgid so the CLI doesn't re-reap a dead pid
  process.exit(0);
}
process.on('SIGTERM', () => { cleanShutdown('SIGTERM'); });
process.on('SIGINT', () => { cleanShutdown('SIGINT'); });
// A stray fire-and-forget rejection (e.g. a sendToRoom losing the network) must
// not take the whole host down — log and carry on. drain() handles turn-level
// failures; this is the last-resort backstop (the #1 review finding).
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection (non-fatal):', reason?.message || reason); });
// A FATAL uncaught error still crashes the supervisor (exit 1) — but record WHY first,
// so `concord status` can show the reason instead of a bare "crashed".
process.on('uncaughtException', (e) => { try { store.setExit('uncaught: ' + (e?.message || e)); } catch { /* best effort */ } console.error('uncaughtException:', e); process.exit(1); });
// `concord resume` (SIGUSR1) clears a timeout pause WITHOUT touching the usage
// meter. `concord budget --reset` (SIGUSR2) is the ONLY thing that zeroes the
// lifetime token counter — the daemon owns the in-memory usage, so a file edit
// wouldn't be seen. Kept separate so resuming never silently wipes the meter.
process.on('SIGUSR1', () => { paused = false; timeoutTimes = []; store.setPaused(null); store.setActivity('idle'); console.log('SIGUSR1 → unpaused; accepting tasks again'); });
process.on('SIGUSR2', () => { store.resetUsage(CONCORD_ROOM_ID); store.setActivity('idle'); console.log('SIGUSR2 → token usage counter reset'); });

await joinRoom();
try { await startEngine(); } catch (e) { die(`agent failed to start: ${e?.message || e}\n  (first run fetches the ACP adapter via npx — check network access to the npm registry, or pre-warm it by running the command printed above)`); }
try { await startIm(); } catch (e) { console.warn('IM bridge failed to start (room-only): ' + (e?.message || e)); }
console.log(`✓ acp-bridge up. Driving "${AGENT}" over ACP in ${AGENT_CWD} (progress=${PROGRESS ? 'on' : 'off'}, permission=${PERMISSION_POLICY}${IM_PLATFORM ? `, im=${IM_PLATFORM}` : ''}).`);
console.log(`  Idle = room long-poll + agent idle. Send a room${IM_PLATFORM ? `/IM` : ''} message to wake it.`);
store.setExit(null);            // clean start → clear any stale crash record from a prior incarnation
store.setActivity('idle');     // up and waiting for work
pollLoop();
