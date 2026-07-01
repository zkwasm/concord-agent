// Tests for the host registry. Run: node --test bridges/acp/hosts.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry, pidAlive, newId } from './hosts.mjs';

// Track every temp root so they don't pile up in $TMPDIR across runs (was leaking one per test).
const roots = [];
const freshRoot = () => { const d = mkdtempSync(join(tmpdir(), 'concord-hosts-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

test('register / get / isolated state dir + path', () => {
  const r = openRegistry(freshRoot());
  const e = r.register({ id: 'claude-abc', pid: 123, agent: 'claude', mode: 'host', room: 'r1', cwd: '/p' });
  assert.equal(e.id, 'claude-abc');
  assert.ok(e.started > 0);
  assert.deepEqual(r.get('claude-abc').room, 'r1');
  assert.ok(r.statePath('claude-abc').endsWith('/hosts/claude-abc/state.json'));
  assert.ok(existsSync(r.hostDir('claude-abc')));    // isolated dir created
});

test('list annotates liveness; update / unregister', () => {
  const r = openRegistry(freshRoot());
  r.register({ id: 'a', pid: process.pid, agent: 'claude' });   // alive
  r.register({ id: 'b', pid: 2 ** 30, agent: 'gemini' });        // dead pid
  const byId = Object.fromEntries(r.list().map((h) => [h.id, h]));
  assert.equal(byId.a.alive, true);
  assert.equal(byId.b.alive, false);
  r.update('a', { room: 'r9' });
  assert.equal(r.get('a').room, 'r9');
  assert.equal(r.unregister('b'), true);
  assert.equal(r.get('b'), null);
});

test('pruneDead drops only entries whose process is gone', () => {
  const r = openRegistry(freshRoot());
  r.register({ id: 'live', pid: process.pid });
  r.register({ id: 'dead', pid: 2 ** 30 });
  const dropped = r.pruneDead();
  assert.deepEqual(dropped, ['dead']);
  assert.ok(r.get('live'));
  assert.equal(r.get('dead'), null);
});

test('survives missing / corrupt registry file', () => {
  const r = openRegistry(freshRoot());
  assert.deepEqual(r.list(), []);          // no file yet
  assert.equal(r.get('x'), null);
});

test('pidAlive + newId', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
  assert.equal(pidAlive(0), false);
  assert.match(newId('claude'), /^claude-[0-9a-f]{6}$/);
});
