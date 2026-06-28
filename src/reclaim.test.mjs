// Tests for clean stop orchestration. Run: node --test src/reclaim.test.mjs
// stopHost reaps BOTH the bridge pid AND the adapter process GROUP, escalating
// SIGTERM→SIGKILL and confirming each target is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reapPid, reapAdapterGroup, stopHost } from './reclaim.mjs';

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

// --- reapAdapterGroup identity guard: the round-4 false-negative fix ---
test('reapAdapterGroup: start match → reaps (reason=reaped)', async () => {
  const w = gracefulWorld([200]);
  const r = await reapAdapterGroup({ pid: 200, start: 'S' }, { ...w, startOf: () => 'S', sleep: noSleep });
  assert.equal(r.reason, 'reaped');
  assert.equal(r.reaped, true);
  assert.ok(w.killed.some(([p]) => p === -200));
});

test('reapAdapterGroup: PROVEN recycled (different non-null start) → not killed, reason=recycled (safe to clear)', async () => {
  const w = gracefulWorld([200]);
  const r = await reapAdapterGroup({ pid: 200, start: 'OURS' }, { ...w, startOf: () => 'OTHER', sleep: noSleep });
  assert.equal(r.reason, 'recycled');
  assert.equal(r.reaped, false);
  assert.ok(!w.killed.some(([p]) => p === -200));
});

test('reapAdapterGroup: UNVERIFIABLE (ps returns null at reap) → not killed, reason=unverifiable (caller must KEEP the pid)', async () => {
  const w = gracefulWorld([200]);
  const r = await reapAdapterGroup({ pid: 200, start: 'OURS' }, { ...w, startOf: () => null, sleep: noSleep });
  assert.equal(r.reason, 'unverifiable');            // NOT 'recycled' — we couldn't prove reuse
  assert.ok(!w.killed.some(([p]) => p === -200), 'never group-kill what we cannot verify');
});

test('reapAdapterGroup: start never recorded → unverifiable (not killed)', async () => {
  const w = gracefulWorld([200]);
  const r = await reapAdapterGroup({ pid: 200, start: null }, { ...w, startOf: () => 'whatever', sleep: noSleep });
  assert.equal(r.reason, 'unverifiable');
  assert.ok(!w.killed.some(([p]) => p === -200));
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

test('stopHost: reaps the bridge AND the adapter group (start-time verified)', async () => {
  const w = gracefulWorld([100, 200]);
  const { steps } = await stopHost({ pid: 100, adapterPid: 200, adapterStart: 'S200' }, { ...w, startOf: () => 'S200', sleep: noSleep, stepMs: 100, graceMs: 1000 });
  assert.deepEqual(steps, ['bridge:SIGTERM+exited', 'adapter:SIGTERM+exited']);
  assert.ok(w.killed.some(([p, s]) => p === 100 && s === 'SIGTERM'));   // bridge signalled directly
  assert.ok(w.killed.some(([p, s]) => p === -200 && s === 'SIGTERM'));  // adapter signalled as a GROUP
});

test('stopHost: a RECYCLED adapter pid (start-time mismatch) is NEVER group-killed', async () => {
  const w = gracefulWorld([100, 200]);                       // 200 is alive but no longer OUR adapter
  const { steps } = await stopHost({ pid: 100, adapterPid: 200, adapterStart: 'OURS' }, { ...w, startOf: () => 'SOMEONE-ELSE', sleep: noSleep });
  assert.deepEqual(steps, ['bridge:SIGTERM+exited', 'adapter:reused-skip']);
  assert.ok(!w.killed.some(([p]) => p === -200), 'the recycled group must never be signalled');
});

test('stopHost: adapter already reaped by the bridge handler → no double-kill', async () => {
  const w = gracefulWorld([100]);                          // 200 already gone
  const { steps } = await stopHost({ pid: 100, adapterPid: 200 }, { ...w, sleep: noSleep });
  assert.deepEqual(steps, ['bridge:SIGTERM+exited', 'adapter:already-exited']);
  assert.ok(!w.killed.some(([p]) => p === -200));          // never signalled a dead group
});

test('stopHost: crashed bridge (already gone) still reaps the orphaned adapter group', async () => {
  const w = gracefulWorld([200]);                          // bridge 100 already dead, adapter 200 orphaned
  const { steps } = await stopHost({ pid: 100, adapterPid: 200, adapterStart: 'S200' }, { ...w, startOf: () => 'S200', sleep: noSleep });
  assert.deepEqual(steps, ['bridge:already-exited', 'adapter:SIGTERM+exited']);
  assert.ok(w.killed.some(([p, s]) => p === -200 && s === 'SIGTERM'));  // orphan group reaped
});

test('stopHost: no pid / no adapter → nothing to do', async () => {
  const { steps } = await stopHost({}, { kill: () => true, isAlive: () => true, sleep: noSleep });
  assert.deepEqual(steps, ['bridge:no-pid', 'adapter:no-pid']);
});
