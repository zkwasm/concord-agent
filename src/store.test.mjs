// Pure-logic tests for the bridge runtime store. Run: node --test bridges/common/store.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';

// Track every temp dir so they don't pile up in $TMPDIR across runs (was leaking one per test).
const dirs = [];
function freshPath() {
  const d = mkdtempSync(join(tmpdir(), 'bridge-store-'));
  dirs.push(d);
  return join(d, 'state.json');
}
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

test('session id survives reopen (resume across restarts)', () => {
  const path = freshPath();
  const s1 = openStore(path);
  s1.setSessionId('room1', 'sess-123');
  s1.markRelayedIn('room1', 'm1');
  const s2 = openStore(path);
  assert.equal(s2.getSessionId('room1'), 'sess-123');
  assert.equal(s2.wasRelayedIn('room1', 'm1'), true);
});

test('sender name survives reopen (resume with the SAME identity → no 403 on post)', () => {
  const path = freshPath();
  const s1 = openStore(path);
  assert.equal(s1.getSender('room1'), null);          // unknown until first join
  s1.setSessionId('room1', 'sess-9');
  s1.setSender('room1', 'claude-1234');               // joined under a 409-fallback name
  const s2 = openStore(path);
  assert.equal(s2.getSender('room1'), 'claude-1234'); // resume must reuse this, not blind AGENT_NAME
  assert.equal(s2.getSessionId('room1'), 'sess-9');
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

test('usage accounting: lifetime cumulative, reset only on demand, survive reopen', () => {
  const path = freshPath();
  const s = openStore(path);
  assert.deepEqual(s.getUsage('r'), { fresh: 0, cached: 0, turns: 0 });
  s.addUsage('r', 100, 2000);
  s.addUsage('r', 50, 1000);
  let u = s.getUsage('r');
  assert.equal(u.fresh, 150);
  assert.equal(u.cached, 3000);
  assert.equal(u.turns, 2);
  // survives reopen (never auto-reset — not by time, restart, /compact or /clear)
  const s2 = openStore(path);
  assert.equal(s2.getUsage('r').fresh, 150);
  s2.addUsage('r', 25, 0);            // keeps accumulating after reopen
  assert.equal(s2.getUsage('r').fresh, 175);
  // explicit reset zeroes counters (the ONLY reset path: concord budget --reset)
  s2.resetUsage('r');
  assert.deepEqual(s2.getUsage('r'), { fresh: 0, cached: 0, turns: 0 });
});

test('acp session id: survives reopen for warm resume; cleared by /clear', () => {
  const path = freshPath();
  const s = openStore(path);
  assert.equal(s.getAcpSessionId('r'), null);
  s.setAcpSessionId('r', 'acp-abc');
  assert.equal(openStore(path).getAcpSessionId('r'), 'acp-abc');   // restart resumes this
  s.setAcpSessionId('r', null);                                    // /clear drops it
  assert.equal(openStore(path).getAcpSessionId('r'), null);        // a wiped session is never resumed
});

test('warned80: persists across reopen (no re-warn on restart); cleared by resetUsage', () => {
  const path = freshPath();
  const s = openStore(path);
  assert.equal(s.getWarned80('r'), false);
  s.setWarned80('r');
  assert.equal(openStore(path).getWarned80('r'), true);   // a crash-looping host must not re-post the warning
  s.resetUsage('r');                                      // fresh meter → warning may fire again
  assert.equal(openStore(path).getWarned80('r'), false);
});

test('inbox: deferred messages persist, cap counts overflow, clear resets', () => {
  const path = freshPath();
  const s = openStore(path);
  assert.deepEqual(s.getInbox('r'), []);
  s.pushInbox('r', 'alice', '待命中');
  s.pushInbox('r', 'bob', '@alice 交接');
  const re = openStore(path);                          // survives a bridge restart
  assert.equal(re.getInbox('r').length, 2);
  assert.equal(re.getInbox('r')[0].sender, 'alice');
  // soft cap: oldest dropped and counted
  const s2 = openStore(freshPath());
  for (let i = 0; i < 55; i++) s2.pushInbox('r', 'a', 'm' + i, 50);
  assert.equal(s2.getInbox('r').length, 50);
  assert.equal(s2.getInboxDropped('r'), 5);
  assert.equal(s2.getInbox('r')[0].content, 'm5');     // oldest evicted first
  s2.clearInbox('r');
  assert.deepEqual([s2.getInbox('r').length, s2.getInboxDropped('r')], [0, 0]);
});

test('context usage: live window meter round-trips', () => {
  const path = freshPath();
  const s = openStore(path);
  assert.equal(s.getContextUsage('r'), null);
  s.setContextUsage('r', 45000, 200000);
  const c = openStore(path).getContextUsage('r');
  assert.equal(c.used, 45000);
  assert.equal(c.size, 200000);
  assert.ok(c.at > 0);
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
