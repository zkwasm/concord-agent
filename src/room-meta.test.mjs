// Tests for fetchRoomName. The contract that matters for host start: it must ALWAYS
// resolve (never throw, never hang) so a slow/dead server can never break `host`/`join`.
// Run: node --test src/room-meta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRoomName } from './room-meta.mjs';

test('returns the room name on a 200', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ name: 'Q3 Launch Plan' }) });
  assert.equal(await fetchRoomName('http://x', 'r1', { fetchImpl }), 'Q3 Launch Plan');
});

test('hits the /info endpoint with the room id, trimming a trailing slash', async () => {
  let called;
  const fetchImpl = async (u) => { called = u; return { ok: true, json: async () => ({ name: 'N' }) }; };
  await fetchRoomName('http://x/', 'r1', { fetchImpl });
  assert.equal(called, 'http://x/agent/rooms/r1/info');
});

test('returns "" (never throws) on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false });
  assert.equal(await fetchRoomName('http://x', 'r1', { fetchImpl }), '');
});

test('returns "" (never throws) when fetch rejects', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  assert.equal(await fetchRoomName('http://x', 'r1', { fetchImpl }), '');
});

test('returns "" when the body carries no usable name', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  assert.equal(await fetchRoomName('http://x', 'r1', { fetchImpl }), '');
});

test('returns "" for a missing url or room id without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ name: 'N' }) }; };
  assert.equal(await fetchRoomName('', 'r1', { fetchImpl }), '');
  assert.equal(await fetchRoomName('http://x', '', { fetchImpl }), '');
  assert.equal(called, false);
});

test('times out without throwing when the server hangs', async () => {
  const fetchImpl = (_u, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  assert.equal(await fetchRoomName('http://x', 'r1', { fetchImpl, timeoutMs: 20 }), '');
});
