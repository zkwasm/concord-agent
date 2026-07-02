// Tests for the ACP engine. Run: node --test bridges/acp/engine.test.mjs
// The integration test drives the REAL engine against an in-process mock ACP
// agent built with the SDK's own agent() — no subprocess, no network, no claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as acp from '@agentclientprotocol/sdk';
import { createEngine, decidePermission, usageOf, adapterFor, makeUsageMapper } from './engine.mjs';

// ---- pure helpers ----
test('decidePermission: approve-all selects an allow option', () => {
  const r = decidePermission({ options: [
    { kind: 'reject_once', optionId: 'no' },
    { kind: 'allow_once', optionId: 'yes' },
  ] }, 'approve-all');
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('decidePermission: prefers allow_always over allow_once', () => {
  const r = decidePermission({ options: [
    { kind: 'allow_once', optionId: 'once' },
    { kind: 'allow_always', optionId: 'always' },
  ] }, 'approve-all');
  assert.equal(r.outcome.optionId, 'always');
});

test('decidePermission: reject policy selects a reject option', () => {
  const r = decidePermission({ options: [
    { kind: 'allow_once', optionId: 'yes' },
    { kind: 'reject_once', optionId: 'no' },
  ] }, 'reject');
  assert.equal(r.outcome.optionId, 'no');
});

test('decidePermission: no matching option → cancelled (never hang the agent)', () => {
  const r = decidePermission({ options: [{ kind: 'allow_once', optionId: 'yes' }] }, 'reject');
  assert.equal(r.outcome.outcome, 'cancelled');
});

test('usageOf: fresh = input+output, cached = cache-read; absent → 0', () => {
  assert.deepEqual(usageOf({ inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 }), { fresh: 30, cached: 5 });
  assert.deepEqual(usageOf({}), { fresh: 0, cached: 0 });
  assert.deepEqual(usageOf(undefined), { fresh: 0, cached: 0 });
});

test('adapterFor: neutral table + env override', () => {
  // version-agnostic: the launch arg is the pinned package (…@x.y.z)
  assert.ok(adapterFor('claude').args.at(-1).startsWith('@agentclientprotocol/claude-agent-acp'));
  assert.ok(adapterFor('codex').args.at(-1).startsWith('@agentclientprotocol/codex-acp'));
  assert.ok(adapterFor('nonsense').args.at(-1).startsWith('@agentclientprotocol/claude-agent-acp')); // default claude
  process.env.ACP_ADAPTER_CMD = 'my-agent --acp x';
  try { assert.deepEqual(adapterFor('claude'), { cmd: 'my-agent', args: ['--acp', 'x'] }); }
  finally { delete process.env.ACP_ADAPTER_CMD; }
});

// ---- integration: real engine vs in-process mock ACP agent ----
function mockAgent(captured) {
  return acp.agent({ name: 'mock-agent' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
    .onRequest('session/new', () => ({ sessionId: 'sess-test-1' }))
    .onRequest('session/prompt', async (ctx) => {
      const sessionId = ctx.params.sessionId;
      const send = (update) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on it.' } });
      await send({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Write hello.txt', kind: 'edit', status: 'pending', locations: [{ path: '/tmp/hello.txt' }] });
      // Sensitive op → request permission; the engine must auto-approve (approve-all).
      const perm = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'c1', title: 'Write hello.txt', kind: 'edit', status: 'pending' },
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'ok' },
          { kind: 'reject_once', name: 'No', optionId: 'no' },
        ],
      });
      captured.permission = perm.outcome;
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' done.' } });
      return { stopReason: 'end_turn', usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 } };
    });
}

test('engine drives a real ACP turn in-process: reply + usage + progress + auto-approve', async () => {
  const captured = {};
  const engine = createEngine({ agent: 'claude', cwd: '/tmp', permission: 'approve-all', log: () => {}, _agentApp: mockAgent(captured) });

  const updates = [];
  const { reply, usage, stopReason, usagePresent } = await engine.runTurn('please write hello', (u) => updates.push(u));

  assert.equal(reply, 'working on it. done.');                 // text chunks accumulated across the turn
  assert.deepEqual(usage, { fresh: 30, cached: 5 });            // ACP usage → our accounting
  assert.equal(usagePresent, true);
  assert.equal(stopReason, 'end_turn');
  assert.equal(captured.permission.outcome, 'selected');       // engine auto-approved the permission request
  assert.equal(captured.permission.optionId, 'ok');
  const tools = updates.filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
  assert.ok(tools.length >= 2, `tool updates surfaced to onUpdate (got ${tools.length})`);
  assert.equal(engine.dead(), false);                          // healthy after a successful turn

  await engine.shutdown();                                     // shutdown is awaitable
});

// ---- warm resume (session/resume + attachSession) ----
test('resume: engine resumes the previous ACP session and prompts against it', async () => {
  const captured = {};
  const agent = acp.agent({ name: 'resumable' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }))
    .onRequest('session/new', () => { captured.newCalled = true; return { sessionId: 'sess-fresh' }; })
    .onRequest('session/resume', (ctx) => { captured.resumedId = ctx.params.sessionId; return {}; })
    .onRequest('session/prompt', (ctx) => {
      captured.promptSession = ctx.params.sessionId;
      return { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } };
    });
  const engine = createEngine({ agent: 'claude', cwd: '/tmp', log: () => {}, resumeSessionId: 'sess-old-9', _agentApp: agent });
  const { stopReason } = await engine.runTurn('continue');
  assert.equal(captured.resumedId, 'sess-old-9');       // resume was requested with the saved id
  assert.equal(captured.newCalled, undefined);          // no fresh session was created
  assert.equal(captured.promptSession, 'sess-old-9');   // the turn ran against the RESUMED session
  assert.equal(engine.resumed(), true);
  assert.equal(engine.sessionId(), 'sess-old-9');
  assert.equal(stopReason, 'end_turn');
  await engine.shutdown();
});

test('resume: falls back to a fresh session when the agent cannot resume', async () => {
  const agent = acp.agent({ name: 'no-resume' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
    .onRequest('session/new', () => ({ sessionId: 'sess-fresh-2' }))
    .onRequest('session/prompt', () => ({ stopReason: 'end_turn', usage: {} }));
  const engine = createEngine({ agent: 'claude', cwd: '/tmp', log: () => {}, resumeSessionId: 'sess-gone', _agentApp: agent });
  await engine.ready;
  assert.equal(engine.resumed(), false);                // resume failed → clean fallback, not a dead engine
  assert.equal(engine.sessionId(), 'sess-fresh-2');
  await engine.shutdown();
});

// --- usage mapper (per-turn vs cumulative; absent) ---
test('makeUsageMapper: per-turn takes each turn as-is', () => {
  const map = makeUsageMapper('per-turn');
  assert.deepEqual(map({ inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 }), { fresh: 30, cached: 5, present: true });
  assert.deepEqual(map({ inputTokens: 7, outputTokens: 3, cachedReadTokens: 1 }), { fresh: 10, cached: 1, present: true });
});

test('makeUsageMapper: cumulative reports per-turn DELTAS (no double counting)', () => {
  const map = makeUsageMapper('cumulative');
  // adapter reports running session totals
  assert.deepEqual(map({ inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 }), { fresh: 30, cached: 5, present: true });
  assert.deepEqual(map({ inputTokens: 15, outputTokens: 35, cachedReadTokens: 9 }), { fresh: 20, cached: 4, present: true }); // (15+35)-(10+20)=20, 9-5=4
});

test('makeUsageMapper: absent/empty usage → present:false (budget can warn, not silently no-op)', () => {
  const map = makeUsageMapper('per-turn');
  assert.deepEqual(map(undefined), { fresh: 0, cached: 0, present: false });
  assert.deepEqual(map({}), { fresh: 0, cached: 0, present: false });
});

// --- resilience: a mid-turn agent failure REJECTS runTurn cleanly (no crash, no
//     floating unhandled rejection, no wedge) while the connection stays usable.
//     The bridge's drain() catches the rejection; dead() only flips on a real
//     connection/adapter death, not a single turn error. ---
test('engine: a failing turn rejects runTurn cleanly; engine stays usable', async () => {
  const failing = acp.agent({ name: 'boom' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
    .onRequest('session/new', () => ({ sessionId: 'boom-1' }))
    .onRequest('session/prompt', async () => { throw new Error('adapter blew up mid-turn'); });
  const engine = createEngine({ agent: 'claude', cwd: '/tmp', log: () => {}, _agentApp: failing });
  await assert.rejects(engine.runTurn('do it'), /blew up|Internal|error/i);
  assert.equal(engine.dead(), false);                          // a turn error doesn't kill the connection
  await engine.shutdown();
});

// --- P0: a turn that never reaches 'stop' (wedged adapter / infinite loop) is
//     BOUNDED by the per-turn wall-clock ceiling — the within-turn token-sink fix ---
test('engine: a wedged turn is killed by the turn-timeout ceiling (no bottomless burn)', async () => {
  const wedged = acp.agent({ name: 'wedged' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
    .onRequest('session/new', () => ({ sessionId: 'wedged-1' }))
    .onRequest('session/prompt', () => new Promise(() => {}));  // never resolves → never emits 'stop'
  const engine = createEngine({ agent: 'claude', cwd: '/tmp', log: () => {}, turnTimeoutMs: 400, _agentApp: wedged });
  const t0 = Date.now();
  await assert.rejects(engine.runTurn('loop forever'), /exceeded the .* ceiling/i);
  assert.ok(Date.now() - t0 < 3000, 'turn was cancelled promptly, not left to hang');
  assert.equal(engine.dead(), true);                           // adapter reaped → bridge will recreate
  await engine.shutdown();
});
