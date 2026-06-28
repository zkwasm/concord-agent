// Tests for clean stop orchestration. Run: node --test src/reclaim.test.mjs
// stopHost reaps BOTH the bridge pid AND the adapter process GROUP, escalating
// SIGTERM→SIGKILL and confirming each target is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reapPid, stopHost } from './reclaim.mjs';

const noSleep = () => Promise.resolve();

// --- reapPid ---
test('reapPid: SIGTERM, process exits within grace → clean (no SIGKILL)', async () => {
  let polls = 0;
  const killed = [];
  const r = await reapPid(7, {
    kill: (p, s) => (killed.push(s), true),
    isAlive: () => { polls += 1; return polls <= 1; },   // alive at precheck, gone on first grace poll
    sleep: noSleep, stepMs: 100, graceMs: 1000,
  });
  assert.deepEqual(killed, ['SIGTERM']);
  assert.deepEqual(r.steps, ['SIGTERM', 'exited']);
  assert.equal(r.alive, false);
});

test('reapPid: SIGKILL escalation when SIGTERM is ignored', async () => {
  const killed = [];
  const r = await reapPid(99, {
    kill: (p, s) => (killed.push(s), true),
    isAlive: () => true,                                  // never dies
    sleep: noSleep, stepMs: 100, graceMs: 300,
  });
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(r.steps, ['SIGTERM', 'SIGKILL']);
  assert.equal(r.alive, true);                            // still alive after best effort
});

test('reapPid: group:true signals the NEGATIVE pid (whole group)', async () => {
  let polls = 0;
  const targets = [];
  await reapPid(42, {
    kill: (p, s) => (targets.push(p), true),
    isAlive: () => { polls += 1; return polls <= 1; },
    sleep: noSleep, stepMs: 100, graceMs: 1000, group: true,
  });
  assert.equal(targets[0], -42);                          // kill(-pgid) = group signal
});

test('reapPid: already dead → never signalled', async () => {
  const killed = [];
  const r = await reapPid(5, { kill: (p, s) => (killed.push(s), true), isAlive: () => false, sleep: noSleep });
  assert.deepEqual(killed, []);
  assert.deepEqual(r.steps, ['already-exited']);
});

// --- stopHost (bridge + adapter group) ---
// A "graceful" world where any signal reaps its target on the next poll.
function gracefulWorld(aliveSet) {
  const alive = new Set(aliveSet);
  const killed = [];
  return {
    killed,
    kill: (p, s) => { killed.push([p, s]); alive.delete(Math.abs(p)); return true; },
    isAlive: (p) => alive.has(p),
  };
}

test('stopHost: reaps the bridge AND the adapter group', async () => {
  const w = gracefulWorld([100, 200]);
  const { steps } = await stopHost({ pid: 100, adapterPid: 200 }, { ...w, sleep: noSleep, stepMs: 100, graceMs: 1000 });
  assert.deepEqual(steps, ['bridge:SIGTERM+exited', 'adapter:SIGTERM+exited']);
  assert.ok(w.killed.some(([p, s]) => p === 100 && s === 'SIGTERM'));   // bridge signalled directly
  assert.ok(w.killed.some(([p, s]) => p === -200 && s === 'SIGTERM'));  // adapter signalled as a GROUP
});

test('stopHost: adapter already reaped by the bridge handler → no double-kill', async () => {
  const w = gracefulWorld([100]);                          // 200 already gone
  const { steps } = await stopHost({ pid: 100, adapterPid: 200 }, { ...w, sleep: noSleep });
  assert.deepEqual(steps, ['bridge:SIGTERM+exited', 'adapter:already-exited']);
  assert.ok(!w.killed.some(([p]) => p === -200));          // never signalled a dead group
});

test('stopHost: crashed bridge (already gone) still reaps the orphaned adapter group', async () => {
  const w = gracefulWorld([200]);                          // bridge 100 already dead, adapter 200 orphaned
  const { steps } = await stopHost({ pid: 100, adapterPid: 200 }, { ...w, sleep: noSleep });
  assert.deepEqual(steps, ['bridge:already-exited', 'adapter:SIGTERM+exited']);
  assert.ok(w.killed.some(([p, s]) => p === -200 && s === 'SIGTERM'));  // orphan group reaped
});

test('stopHost: no pid / no adapter → nothing to do', async () => {
  const { steps } = await stopHost({}, { kill: () => true, isAlive: () => true, sleep: noSleep });
  assert.deepEqual(steps, ['bridge:no-pid']);
});
