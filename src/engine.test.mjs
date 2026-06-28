// Tests for the ACP engine. Run: node --test bridges/acp/engine.test.mjs
// The integration test drives the REAL engine against an in-process mock ACP
// agent built with the SDK's own agent() — no subprocess, no network, no claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as acp from '@agentclientprotocol/sdk';
import { createEngine, decidePermission, usageOf, adapterFor } from './engine.mjs';

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
  const { reply, usage, stopReason } = await engine.runTurn('please write hello', (u) => updates.push(u));

  assert.equal(reply, 'working on it. done.');                 // text chunks accumulated across the turn
  assert.deepEqual(usage, { fresh: 30, cached: 5 });            // ACP usage → our accounting
  assert.equal(stopReason, 'end_turn');
  assert.equal(captured.permission.outcome, 'selected');       // engine auto-approved the permission request
  assert.equal(captured.permission.optionId, 'ok');
  const tools = updates.filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
  assert.ok(tools.length >= 2, `tool updates surfaced to onUpdate (got ${tools.length})`);

  engine.shutdown();
});
