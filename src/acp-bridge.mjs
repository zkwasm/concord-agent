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
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { toolToProgress, toolDetail } from './render.mjs';
import { resolveConfig, usage } from './cli.mjs';
import { overBudget, windowElapsed, usageReport, budgetExceededNote } from './budget.mjs';
import { obtainRoomId } from './handoff.mjs';
import { createEngine } from './engine.mjs';

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
const store = openStore(STORE_PATH || fileURLToPath(new URL('./bridge-state.json', import.meta.url)));

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
const engine = createEngine({ agent: AGENT, cwd: AGENT_CWD, permission: PERMISSION_POLICY, log: console.log });

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
  const { reply, usage, stopReason } = await engine.runTurn(text, onUpdate);
  console.log(`■ turn end  ·  stop=${stopReason}  ·  fresh ${usage.fresh} tok, cache-read ${usage.cached} tok`);
  return { reply, usage };
}

// Roll the budget window, then report whether the fresh-token cap is hit — so a
// runaway agent can't burn unbounded cost while nobody's watching.
function budgetBlocked(now) {
  if (windowElapsed(store.getUsage(CONCORD_ROOM_ID).windowStart, now, BUDGET_WINDOW_MS)) store.resetUsage(CONCORD_ROOM_ID, now);
  return overBudget(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET);
}
const budgetNote = () => sendToRoom(budgetExceededNote(store.getUsage(CONCORD_ROOM_ID), AGENT_TOKEN_BUDGET, BUDGET_WINDOW_HOURS));

async function drain() {
  if (busy || pending.length === 0) return;
  busy = true;
  while (pending.length) {
    if (budgetBlocked(Date.now())) { await budgetNote(); pending.length = 0; break; } // drop queued; over budget
    const msg = pending.shift();
    console.log(`\n▶ turn start  ·  ${msg.slice(0, 80)}`);
    const { reply, usage } = await runTurn(msg);
    store.addUsage(CONCORD_ROOM_ID, usage.fresh, usage.cached, Date.now());
    if (reply.trim()) await sendToRoom(reply.trim());      // agent's full reply -> room
  }
  busy = false;
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
function cleanShutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n${sig} → shutting down agent (${AGENT_CWD}) …`);
  try { engine.shutdown(); } catch { /* best effort */ }
  setTimeout(() => process.exit(0), 500);   // give the group-kill a moment, then exit
}
process.on('SIGTERM', () => cleanShutdown('SIGTERM'));
process.on('SIGINT', () => cleanShutdown('SIGINT'));
// `concord resume` / `concord budget --reset` signals us to clear a budget pause
// without a restart (we own the in-memory usage, so a file edit wouldn't be seen).
process.on('SIGUSR1', () => { store.resetUsage(CONCORD_ROOM_ID, Date.now()); console.log('SIGUSR1 → budget window reset; accepting tasks again'); });

await joinRoom();
try { await engine.ready; } catch (e) { die(`agent failed to start: ${e?.message || e}`); }
console.log(`✓ acp-bridge up. Driving "${AGENT}" over ACP in ${AGENT_CWD} (progress=${PROGRESS ? 'on' : 'off'}, permission=${PERMISSION_POLICY}).`);
console.log(`  Idle = room long-poll + agent idle. Send a room message to wake it.`);
pollLoop();
