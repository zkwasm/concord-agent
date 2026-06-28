// Tests for clean stop orchestration. Run: node --test bridges/acp/reclaim.test.mjs
// The agent's ACP adapter is the bridge's own child group, so a stop is just
// SIGTERM the bridge (→ its shutdown kills the group), with SIGKILL escalation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopHost } from './reclaim.mjs';

const noSleep = () => Promise.resolve();

test('stopHost: SIGKILL escalation when SIGTERM is ignored', async () => {
  const killed = [];
  const res = await stopHost(
    { pid: 99 },
    { kill: (pid, sig) => (killed.push(sig), true), isAlive: () => true, sleep: noSleep, stepMs: 100, graceMs: 300 },
  );
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);          // never exited → escalated
  assert.deepEqual(res.steps, ['SIGTERM', 'SIGKILL']);
});

test('stopHost: process exits cleanly after SIGTERM → no SIGKILL', async () => {
  const killed = [];
  let polls = 0;
  const res = await stopHost(
    { pid: 7 },
    { kill: (pid, sig) => (killed.push(sig), true), isAlive: () => { polls += 1; return polls <= 1; }, sleep: noSleep, stepMs: 100, graceMs: 1000 },
  );
  // precheck alive (poll 1), then exited on the grace poll → only SIGTERM
  assert.deepEqual(killed, ['SIGTERM']);
  assert.deepEqual(res.steps, ['SIGTERM', 'exited']);
});

test('stopHost: no pid → nothing to do', async () => {
  const res = await stopHost({}, { kill: () => true, isAlive: () => true, sleep: noSleep });
  assert.deepEqual(res.steps, ['no-pid']);
});

test('stopHost: already exited before SIGTERM', async () => {
  const killed = [];
  const res = await stopHost(
    { pid: 5 },
    { kill: (p, s) => (killed.push(s), true), isAlive: () => false, sleep: noSleep },
  );
  assert.deepEqual(killed, []);                              // never signalled a dead pid
  assert.deepEqual(res.steps, ['already-exited']);
});
