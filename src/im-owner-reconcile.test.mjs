// Integration-style tests for the owner's reconcile loop: it must produce a correct
// health.json from injected room/agent/connection state — covering the headline cases
// (no-live-agent, room-gone, creds-drift, connection-suspect). Mock Lark + mock fetch.
// Run: node --test src/im-owner-reconcile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBindings } from './im-bindings.mjs';
import { createOwner } from './im-owner.mjs';

// A fetch that lets each test dictate what /agents and /messages return per room.
function mkFetch({ agentsByRoom = {}, roomStatus = {} } = {}) {
  return async (urlStr) => {
    const m = urlStr.match(/\/agent\/rooms\/([^/]+)\/(agents|messages|join|info)/);
    const roomId = m?.[1]; const kind = m?.[2];
    if (kind === 'join') return { ok: true, status: 200, json: async () => ({ agentSessionId: 'sess-1' }) };
    if (kind === 'agents') {
      const a = agentsByRoom[roomId];
      if (a === undefined) return { ok: false, status: 404, json: async () => ({ error: 'Room not found' }) };
      return { ok: true, status: 200, json: async () => ({ agents: a }) };
    }
    // messages poll: honor an optional status override (e.g. 404 room-gone), else empty
    const st = roomStatus[roomId];
    if (st && st !== 200) return { ok: false, status: st, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  };
}
const fakeWs = (state = 'connected') => ({ start() {}, close() {}, getConnectionStatus: () => ({ state }) });

function setup({ creds = { lark: { appId: 'cli_A' } }, agentsByRoom, roomStatus, connState } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'concord-recon-'));
  mkdirSync(join(root, 'hosts', 'im-lark'), { recursive: true });
  writeFileSync(join(root, 'creds.json'), JSON.stringify(creds));
  // register this owner as the live one so the singleton check passes
  writeFileSync(join(root, 'hosts.json'), JSON.stringify({ 'im-lark': { id: 'im-lark', mode: 'im', platform: 'lark', pid: process.pid } }));
  const store = openBindings(root);
  const owner = createOwner({
    platform: 'lark', appId: 'cli_A', url: 'http://test', log: () => {}, bindings: store, home: root,
    _clients: { client: { im: { v1: { message: { create: async () => ({ code: 0 }) }, chat: { get: async () => ({ data: { user_count: '5' } }) } } } }, ws: fakeWs(connState), fetch: mkFetch({ agentsByRoom, roomStatus }) },
  });
  const readHealth = () => JSON.parse(readFileSync(owner._healthPath, 'utf8'));
  // shutdown() stops the detached pollRoom loops (polling=false) so the process can exit.
  return { root, store, owner, readHealth, cleanup: () => { try { owner.shutdown(); } catch { /* */ } rmSync(root, { recursive: true, force: true }); } };
}

test('snapshot: a bound room with a live agent → agent:present, healthy', async () => {
  const { store, owner, readHealth, cleanup } = setup({ agentsByRoom: { 'room-1': ['IM', 'claude'] } });
  try {
    store.bind('lark', 'oc_1', { roomId: 'room-1', agent: 'claude' });
    await owner.reconcile('tick');
    const h = readHealth();
    const b = h.bindings.find((x) => x.roomId === 'room-1');
    assert.equal(b.agentState, 'present');   // 'claude' is a non-IM agent
    assert.equal(b.relay, 'up');
    assert.equal(h.eventPlane.status, 'quiet');   // connected but no inbound events in-test → quiet (healthy)
  } finally { cleanup(); }
});

test('snapshot: room with ONLY the relay (IM) and no real agent → agent:absent (the C⑧ silent-void detector)', async () => {
  const { store, owner, readHealth, cleanup } = setup({ agentsByRoom: { 'room-2': ['IM'] } });
  try {
    store.bind('lark', 'oc_2', { roomId: 'room-2', agent: 'claude' });
    await owner.reconcile('tick');
    const b = readHealth().bindings.find((x) => x.roomId === 'room-2');
    assert.equal(b.agentState, 'absent');   // only IM present → the stopped-agent void
  } finally { cleanup(); }
});

test('snapshot: /agents 404 (endpoint not deployed OR room gone) → agent:unknown, never false "absent"', async () => {
  const { store, owner, readHealth, cleanup } = setup({ agentsByRoom: {} });  // every /agents → 404
  try {
    store.bind('lark', 'oc_3', { roomId: 'room-3', agent: 'claude' });
    await owner.reconcile('tick');
    const b = readHealth().bindings.find((x) => x.roomId === 'room-3');
    assert.equal(b.agentState, 'unknown');   // graceful degradation against an un-deployed endpoint
  } finally { cleanup(); }
});

test('snapshot: creds switched under the owner → credsDrift recorded', async () => {
  const { root, store, owner, readHealth, cleanup } = setup({ agentsByRoom: { 'room-4': ['IM', 'claude'] } });
  try {
    store.bind('lark', 'oc_4', { roomId: 'room-4', agent: 'claude' });
    writeFileSync(join(root, 'creds.json'), JSON.stringify({ lark: { appId: 'cli_NEW' } }));  // user did login --qr --new
    await owner.reconcile('tick');
    const h = readHealth();
    assert.equal(h.credsDrift.fileAppId, 'cli_NEW');
    assert.equal(h.credsDrift.bakedAppId, 'cli_A');
  } finally { cleanup(); }
});

test('snapshot: WSClient not connected → eventPlane suspect (a quiet-but-connected owner is NOT suspect)', async () => {
  const a = setup({ agentsByRoom: { 'room-5': ['IM', 'claude'] }, connState: 'reconnecting' });
  try {
    a.store.bind('lark', 'oc_5', { roomId: 'room-5', agent: 'claude' });
    await a.owner.reconcile('tick');
    assert.equal(a.readHealth().eventPlane.status, 'suspect');
  } finally { a.cleanup(); }
  const b = setup({ agentsByRoom: { 'room-6': ['IM', 'claude'] }, connState: 'connected' });
  try {
    b.store.bind('lark', 'oc_6', { roomId: 'room-6', agent: 'claude' });
    await b.owner.reconcile('tick');
    assert.equal(b.readHealth().eventPlane.status, 'quiet');   // connected, no inbound events → quiet (healthy), NOT suspect
  } finally { b.cleanup(); }
});

test('singleton: if the registry pid is no longer us, reconcile steps down (does not clobber the new owner)', async () => {
  const { root, store, owner, cleanup } = setup({ agentsByRoom: { 'room-7': ['IM'] } });
  try {
    store.bind('lark', 'oc_7', { roomId: 'room-7', agent: 'claude' });
    writeFileSync(join(root, 'hosts.json'), JSON.stringify({ 'im-lark': { pid: 999999 } }));  // another owner took over
    let exited = false; const realExit = process.exit; process.exit = () => { exited = true; throw new Error('exit'); };
    try { await owner.reconcile('tick'); } catch { /* stepDown throws via our stub */ }
    process.exit = realExit;
    assert.equal(exited, true);   // it stepped down instead of writing a competing snapshot
  } finally { cleanup(); }
});
