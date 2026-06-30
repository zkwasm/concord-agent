// Pure-logic tests for the bridge runtime store. Run: node --test bridges/common/store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), 'bridge-store-')), 'state.json');
}

test('session id survives reopen (resume across restarts)', () => {
  const path = freshPath();
  const s1 = openStore(path);
  s1.setSessionId('room1', 'sess-123');
  s1.markRelayedIn('room1', 'm1');
  const s2 = openStore(path);
  assert.equal(s2.getSessionId('room1'), 'sess-123');
  assert.equal(s2.wasRelayedIn('room1', 'm1'), true);
});

test('adapter pgid survives reopen (CLI can reap an orphaned group)', () => {
  const path = freshPath();
  const s1 = openStore(path);
  assert.equal(s1.getAdapterPid(), null);
  s1.setAdapterPid(48213);
  const s2 = openStore(path);
  assert.equal(s2.getAdapterPid(), 48213);
  s2.setAdapterPid(null);                 // cleared on clean shutdown
  assert.equal(openStore(path).getAdapterPid(), null);
});

test('dedup: relayedIn / sentOut / processedInbound', () => {
  const s = openStore(freshPath());
  assert.equal(s.wasRelayedIn('r', 'x'), false);
  s.markRelayedIn('r', 'x');
  assert.equal(s.wasRelayedIn('r', 'x'), true);
  assert.equal(s.wasSentOut('r', 'y'), false);
  s.markSentOut('r', 'y');
  assert.equal(s.wasSentOut('r', 'y'), true);
  assert.equal(s.wasProcessedInbound('evt1'), false);
  s.markProcessedInbound('evt1');
  assert.equal(s.wasProcessedInbound('evt1'), true);
});

test('dedup lists are bounded (no unbounded growth)', () => {
  const s = openStore(freshPath());
  for (let i = 0; i < 2500; i++) s.markProcessedInbound('e' + i);
  const list = s._state().processedInbound;
  assert.ok(list.length <= 2000, `expected <=2000, got ${list.length}`);
  assert.equal(s.wasProcessedInbound('e2499'), true); // most recent survive
  assert.equal(s.wasProcessedInbound('e0'), false);   // oldest evicted
});

test('usage accounting: accumulate, window start, reset, survive reopen', () => {
  const path = freshPath();
  const s = openStore(path);
  assert.deepEqual({ ...s.getUsage('r'), windowStart: s.getUsage('r').windowStart }, { fresh: 0, cached: 0, turns: 0, windowStart: null });
  s.addUsage('r', 100, 2000, 5000);   // first add sets windowStart
  s.addUsage('r', 50, 1000, 6000);
  let u = s.getUsage('r');
  assert.equal(u.fresh, 150);
  assert.equal(u.cached, 3000);
  assert.equal(u.turns, 2);
  assert.equal(u.windowStart, 5000);  // set once, not moved by later adds
  // survives reopen
  const s2 = openStore(path);
  assert.equal(s2.getUsage('r').fresh, 150);
  // reset zeroes counters + restamps the window
  s2.resetUsage('r', 9000);
  u = s2.getUsage('r');
  assert.deepEqual([u.fresh, u.cached, u.turns, u.windowStart], [0, 0, 0, 9000]);
});

test('getUsage returns a copy (caller cannot mutate internal state)', () => {
  const s = openStore(freshPath());
  s.addUsage('r', 10, 0, 1);
  s.getUsage('r').fresh = 99999;
  assert.equal(s.getUsage('r').fresh, 10);
});

test('runtime activity/paused/exit round-trip + survive reopen (for concord list/status)', () => {
  const path = freshPath();
  const s = openStore(path);
  s.setActivity('working', 'edit foo.ts', 1000);
  s.setPaused('timeouts', 2000);
  s.setExit('uncaught: boom', 3000);
  const re = openStore(path)._state();
  assert.deepEqual(re.activity, { state: 'working', label: 'edit foo.ts', at: 1000 });
  assert.deepEqual(re.paused, { reason: 'timeouts', at: 2000 });
  assert.deepEqual(re.exit, { reason: 'uncaught: boom', at: 3000 });
  // clearers null them out (resume clears pause; a clean start clears exit)
  s.setPaused(null); s.setExit(null);
  const re2 = openStore(path)._state();
  assert.equal(re2.paused, null);
  assert.equal(re2.exit, null);
});

test('corrupt file does not crash; starts fresh', () => {
  const path = freshPath();
  writeFileSync(path, '{ not valid json');
  const s = openStore(path); // must not throw
  s.setSessionId('room1', 'sid'); // still usable
  assert.equal(s.getSessionId('room1'), 'sid');
});
