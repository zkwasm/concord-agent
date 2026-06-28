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
import { resolveConfig, usage } from './cli.mjs';
import { overBudget, windowElapsed, usageReport, budgetExceededNote } from './budget.mjs';
import { obtainRoomId } from './handoff.mjs';
import { createEngine } from './engine.mjs';
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
const AGENT_TOKEN_BUDGET = parseInt(cfg.budget, 10) || 0;                 // max fresh tokens / window; 0 = unlimited
const BUDGET_WINDOW_HOURS = parseFloat(cfg.budgetWindowHours) || 24;      // rolling window for the budget
const BUDGET_WINDOW_MS = BUDGET_WINDOW_HOURS * 3600 * 1000;
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
  if (AGENT_TOKEN_BUDGET > 0) bits.push(`额度 ${AGENT_TOKEN_BUDGET} fresh tok/${BUDGET_WINDOW_HOURS}h(/usage 查)`);
  return bits.join(' · ') + '。把任务发给我。';
}

const die = (m) => { console.error('✗ ' + m); process.exit(1); };
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
  // processed-id dedup below ensures old turns aren't re-run.
  const existing = store.getSessionId(CONCORD_ROOM_ID);
  if (existing) {
    const res = await post('/join', { sender: AGENT_NAME, agentSessionId: existing });
    if (res.ok) { senderName = AGENT_NAME; sessionId = (await res.json()).agentSessionId; store.setSessionId(CONCORD_ROOM_ID, sessionId); console.log(`✓ Concord: resumed room as "${AGENT_NAME}"`); return; }
    store.setSessionId(CONCORD_ROOM_ID, null); // stale resume token → fresh join
  }
  for (const name of [AGENT_NAME, `${AGENT_NAME}-${process.pid % 10000}`]) {
    const res = await post('/join', { sender: name });
    if (res.ok) { senderName = name; sessionId = (await res.json()).agentSessionId; store.setSessionId(CONCORD_ROOM_ID, sessionId); console.log(`✓ Concord: joined room as "${name}"`); return; }
    if (res.status !== 409) die(`join failed: ${res.status} ${await res.text()}`);
    console.warn(`  name "${name}" taken, retrying…`);
  }
  die('could not join room');
}

const sendToRoom = (text) => post('/messages', { sender: senderName, agentSessionId: sessionId, content: text });

// ---------------------------------------------------------------------------
// Agent side: one prompt turn per room message, against the resident ACP session
// ---------------------------------------------------------------------------
let busy = false;
const pending = [];
let engine = null;
let usageWarned = false;
let warned80 = false;                 // one-time 80%-of-budget room note (per window)
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
async function startEngine() {
  engine = createEngine({ agent: AGENT, cwd: AGENT_CWD, permission: PERMISSION_POLICY, log: console.log });
  await engine.ready;
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
async function runTurn(text) {
  const toolState = new Map();
  const onUpdate = (u) => {
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
      if (PROGRESS) sendToRoom(card);                // room card only when progress is on (off in multi-agent join)
      st.emitted = true;
    }
    toolState.set(id, st);
  };
  const { reply, usage, stopReason, usagePresent } = await engine.runTurn(text, onUpdate);
  if (!usagePresent && AGENT_TOKEN_BUDGET > 0 && !usageWarned) {
    usageWarned = true;   // a set --budget that can't be measured must NOT silently become unlimited.
    const w = `⚠️ 这个 agent 不上报 token 用量,设定的 --budget(${AGENT_TOKEN_BUDGET})无法按量强制执行;仅靠单轮超时兜底单轮上界。`;
    console.warn(w);
    sendToRoom(w).catch(() => {});   // safety-relevant fact → post regardless of PROGRESS (like turn-fail notes)
  }
  console.log(`■ turn end  ·  stop=${stopReason}  ·  fresh ${usage.fresh} tok, cache-read ${usage.cached} tok`);
  return { reply, usage };
}

// Roll the budget window, then report whether the fresh-token cap is hit — so a
// runaway agent can't burn unbounded cost while nobody's watching.
function budgetBlocked(now) {
  if (windowElapsed(store.getUsage(CONCORD_ROOM_ID).windowStart, now, BUDGET_WINDOW_MS)) { store.resetUsage(CONCORD_ROOM_ID, now); warned80 = false; }
  return overBudget(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET);
}
const budgetNote = () => sendToRoom(budgetExceededNote(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET, BUDGET_WINDOW_HOURS));

// Early-warning so spend is VISIBLE before the cap pauses the agent: one room note
// when usage first crosses 80% of the budget this window. No-op if no budget.
function maybeBudgetWarn() {
  if (!AGENT_TOKEN_BUDGET || warned80) return;
  const u = store.getUsage(CONCORD_ROOM_ID);
  if (u.fresh >= AGENT_TOKEN_BUDGET * 0.8) {
    warned80 = true;
    sendToRoom(`⚠️ 已用 ${u.fresh}/${AGENT_TOKEN_BUDGET} fresh tok(≥80%),接近本窗口预算上限。`).catch(() => {});
  }
}

async function drain() {
  if (busy || paused || pending.length === 0) return;
  busy = true;
  try {
    while (pending.length) {
      if (paused) { pending.length = 0; break; }
      if (budgetBlocked(Date.now())) { await budgetNote(); pending.length = 0; break; } // drop queued; over budget
      // Self-heal: a dead engine (adapter crash / dropped connection) is rebuilt
      // before the turn. If it won't come back, tell the room and stop draining;
      // the next inbound message retries (poll waits 30s → no tight crash loop).
      if (!engine || engine.dead()) {
        try { await ensureEngine(); }
        catch (e) { console.error('engine restart failed:', e.message); await sendToRoom(`⚠️ agent 暂时起不来(${String(e.message).slice(0, 120)}),稍后再发一次。`).catch(() => {}); break; }
      }
      const msg = pending.shift();
      console.log(`\n▶ turn start  ·  ${msg.slice(0, 80)}`);
      try {
        const { reply, usage } = await runTurn(msg);
        recreateTimes = [];                                    // a clean turn means the engine recovered → reset the crash-loop guard
        store.addUsage(CONCORD_ROOM_ID, usage.fresh, usage.cached, Date.now());
        maybeBudgetWarn();                                     // surface 80%-of-budget before the cap pauses us
        if (reply.trim()) await sendToRoom(reply.trim());      // agent's full reply -> room
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
            paused = true; pending.length = 0;
            await sendToRoom(`⏸️ 多次超时(${MAX_TIMEOUTS_WINDOW} 次),已暂停以免持续烧 token。用 \`concord list\` 找到 id 后 \`concord resume <id>\` 或 \`concord restart <id>\`。`).catch(() => {});
            break;
          }
          await sendToRoom(`⚠️ 这轮超时被取消了(${String(e.message).slice(0, 100)})。任务太大就拆小一点再发。`).catch(() => {});
        } else {
          await sendToRoom(`⚠️ 这条没处理成功(${String(e.message).slice(0, 120)}),可以再发一次。`).catch(() => {});
        }
      }
    }
  } finally {
    busy = false;   // ALWAYS reset, so a failure can't wedge the host busy forever
  }
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
        if (m.sender === senderName) continue;
        if (store.wasProcessedInbound(m.id)) continue;   // already handled (resume / redelivery)
        store.markProcessedInbound(m.id);
        // Stats query — pure program, no LLM turn, no ack.
        if (['/usage', '/stats', '用量'].includes((m.content || '').trim())) {
          await sendToRoom(usageReport(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET, BUDGET_WINDOW_HOURS));
          continue;
        }
        // Paused after repeated timeouts → don't enqueue (would just burn again).
        if (paused) continue;
        // Already over budget when a task arrives → refuse cleanly (no false ack).
        if (budgetBlocked(Date.now())) { await budgetNote(); continue; }
        // First time someone talks to us in this room: introduce ourselves. (host only.)
        if (PROGRESS && !store.wasIntroduced(CONCORD_ROOM_ID)) { await sendToRoom(introText()); store.setIntroduced(CONCORD_ROOM_ID); }
        if (PROGRESS) await sendToRoom(nextAck());          // instant "收到" before the agent works (host only)
        console.log(`Concord → agent | ${m.sender}: ${m.content}`);
        pending.push(`[${m.sender}] ${m.content}`);
      }
      drain();
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
// `concord resume` / `concord budget --reset` signals us to clear a budget pause
// without a restart (we own the in-memory usage, so a file edit wouldn't be seen).
process.on('SIGUSR1', () => { store.resetUsage(CONCORD_ROOM_ID, Date.now()); warned80 = false; paused = false; timeoutTimes = []; console.log('SIGUSR1 → budget window reset + unpaused; accepting tasks again'); });

await joinRoom();
try { await startEngine(); } catch (e) { die(`agent failed to start: ${e?.message || e}`); }
console.log(`✓ acp-bridge up. Driving "${AGENT}" over ACP in ${AGENT_CWD} (progress=${PROGRESS ? 'on' : 'off'}, permission=${PERMISSION_POLICY}).`);
console.log(`  Idle = room long-poll + agent idle. Send a room message to wake it.`);
pollLoop();
