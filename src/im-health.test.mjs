// Boundary logic for the IM owner health snapshot. Run: node --test src/im-health.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPlaneStatus, bindingNextAction, overallHeadline, bindingVerdict, chatBreadcrumbs } from './im-health.mjs';

const NOW = 1_000_000;

test('eventPlaneStatus: quiet (connected, no recent events) is HEALTHY, never suspect', () => {
  assert.equal(eventPlaneStatus('connected', NOW - 5000, NOW), 'flowing');
  assert.equal(eventPlaneStatus('connected', NOW - 20 * 60 * 1000, NOW), 'quiet'); // long silence but connected → quiet
  assert.equal(eventPlaneStatus('connected', 0, NOW), 'quiet');                     // never any event but connected → quiet
});

test('eventPlaneStatus: anything not connected → suspect', () => {
  for (const s of ['idle', 'connecting', 'reconnecting', 'failed']) assert.equal(eventPlaneStatus(s, NOW, NOW), 'suspect');
});

test('bindingNextAction: worst-first ordering (blocked > room-gone > no-agent > paused > down)', () => {
  assert.equal(bindingNextAction({ chatId: 'c', relay: 'blocked', room: 'reachable', agentState: 'absent' }).severity, 'high');
  assert.match(bindingNextAction({ chatId: 'c', relay: 'up', room: 'unreachable', agentState: 'present' }).summary, /房间不可达/);
  assert.match(bindingNextAction({ chatId: 'c', agent: 'gemini', relay: 'up', room: 'reachable', agentState: 'absent' }).summary, /没有活 agent/);
  assert.equal(bindingNextAction({ chatId: 'c', agent: 'gemini', relay: 'up', room: 'reachable', agentState: 'absent' }).cmd, 'concord host gemini --bind c');
  assert.equal(bindingNextAction({ chatId: 'c', relay: 'up', room: 'reachable', agentState: 'present' }), null); // healthy
});

test('overallHeadline: creds-drift and suspect connection beat per-binding issues', () => {
  assert.match(overallHeadline({ credsDrift: { fileAppId: 'B', bakedAppId: 'A' }, eventPlane: { status: 'flowing' }, bindings: [] }).summary, /creds 已切到别的 app/);
  assert.match(overallHeadline({ eventPlane: { status: 'suspect', state: 'failed' }, bindings: [] }).summary, /长连接未就绪/);
  assert.equal(overallHeadline({ eventPlane: { status: 'flowing' }, controlPlane: { lark: 'ok' }, bindings: [{ chatId: 'c', relay: 'up', room: 'reachable', agentState: 'present' }] }).severity, 'ok');
  assert.match(overallHeadline({ eventPlane: { status: 'flowing' }, controlPlane: { lark: 'ok' }, bindings: [{ chatId: 'c', relay: 'up', room: 'reachable', agentState: 'absent' }] }).summary, /没有活 agent/);
});

test('overallHeadline: no snapshot → owner probably not running', () => {
  assert.match(overallHeadline(null).summary, /无快照/);
  assert.match(overallHeadline({ state: 'stopped', bindings: [] }).summary, /已停止/);
});

test('bindingVerdict: one-word rollup', () => {
  assert.equal(bindingVerdict({ relay: 'up', room: 'reachable', agentState: 'present' }), 'ok');
  assert.equal(bindingVerdict({ relay: 'up', room: 'reachable', agentState: 'absent' }), '⚠ 无 agent');
  assert.equal(bindingVerdict({ relay: 'blocked' }), '⚠ relay 阻塞');
});

test('chatBreadcrumbs: agent present→absent fires the silent-void warning (C⑧)', () => {
  const prev = { bindings: [{ chatId: 'c', agentState: 'present', room: 'reachable', relay: 'up' }] };
  const curr = { bindings: [{ chatId: 'c', agent: 'claude', agentState: 'absent', room: 'reachable', relay: 'up' }] };
  const bc = chatBreadcrumbs(prev, curr);
  assert.equal(bc.length, 1);
  assert.equal(bc[0].chatId, 'c');
  assert.match(bc[0].message, /agent 不在了/);
});

test('chatBreadcrumbs: steady state (no transition) is silent — no per-tick spam', () => {
  const s = { bindings: [{ chatId: 'c', agentState: 'present', room: 'reachable', relay: 'up' }] };
  assert.deepEqual(chatBreadcrumbs(s, s), []);
});

test('chatBreadcrumbs: recovery (absent→present) and whileDown framing', () => {
  const prev = { bindings: [{ chatId: 'c', agentState: 'absent', room: 'reachable', relay: 'up' }] };
  const curr = { bindings: [{ chatId: 'c', agentState: 'present', room: 'reachable', relay: 'up' }] };
  const bc = chatBreadcrumbs(prev, curr, { whileDown: true });
  assert.equal(bc.length, 1);
  assert.match(bc[0].message, /agent 回来了/);
  assert.match(bc[0].message, /owner 重启/);
});

test('chatBreadcrumbs: brand-new binding is not a breadcrumb (intro handles it)', () => {
  const prev = { bindings: [] };
  const curr = { bindings: [{ chatId: 'c', agentState: 'present', room: 'reachable', relay: 'up' }] };
  assert.deepEqual(chatBreadcrumbs(prev, curr), []);
});
