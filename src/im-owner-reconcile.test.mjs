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

// A fetch that lets each test drive the room-message poll (join + messages). Agent presence
// is NO LONGER a server call — it's read from the LOCAL registry (hosts.json), so tests inject
// live/stopped/dead host entries via setup({ hosts }) instead of mocking an /agents endpoint.
function mkFetch({ roomStatus = {} } = {}) {
  return async (urlStr) => {
    const m = urlStr.match(/\/agent\/rooms\/([^/]+)\/(messages|join|info)/);
    const roomId = m?.[1]; const kind = m?.[2];
    if (kind === 'join') return { ok: true, status: 200, json: async () => ({ agentSessionId: 'sess-1' }) };
    // messages poll: honor an optional status override (e.g. 404 room-gone), else empty
    const st = roomStatus[roomId];
    if (st && st !== 200) return { ok: false, status: st, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  };
}
const fakeWs = (state = 'connected') => ({ start() {}, close() {}, getConnectionStatus: () => ({ state }) });

// `hosts` = extra registry entries merged into hosts.json alongside the owner. A live local
// agent = { mode:'host', room:'<id>', pid: process.pid } (process.pid is guaranteed alive).
function setup({ creds = { lark: { appId: 'cli_A' } }, hosts = {}, roomStatus, connState } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'concord-recon-'));
  mkdirSync(join(root, 'hosts', 'im-lark'), { recursive: true });
  writeFileSync(join(root, 'creds.json'), JSON.stringify(creds));
  // register this owner as the live one so the singleton check passes; merge any test agents
  writeFileSync(join(root, 'hosts.json'), JSON.stringify({ 'im-lark': { id: 'im-lark', mode: 'im', platform: 'lark', pid: process.pid }, ...hosts }));
  const store = openBindings(root);
  const owner = createOwner({
    platform: 'lark', appId: 'cli_A', url: 'http://test', log: () => {}, bindings: store, home: root,
    _clients: { client: { im: { v1: { message: { create: async () => ({ code: 0 }) }, chat: { get: async ({ path } = {}) => ({ data: { user_count: '5', name: '群-' + String(path?.chat_id || '').slice(3, 7) } }) } } } }, ws: fakeWs(connState), fetch: mkFetch({ roomStatus }) },
  });
  const readHealth = () => JSON.parse(readFileSync(owner._healthPath, 'utf8'));
  // shutdown() stops the detached pollRoom loops (polling=false) so the process can exit.
  return { root, store, owner, readHealth, cleanup: () => { try { owner.shutdown(); } catch { /* */ } rmSync(root, { recursive: true, force: true }); } };
}

test('snapshot: a bound room with a live LOCAL agent → agent:present, healthy', async () => {
  const { store, owner, readHealth, cleanup } = setup({ hosts: { 'claude-1': { id: 'claude-1', mode: 'host', room: 'room-1', pid: process.pid } } });
  try {
    store.bind('lark', 'oc_1', { roomId: 'room-1', agent: 'claude' });
    await owner.reconcile('tick');
    const h = readHealth();
    const b = h.bindings.find((x) => x.roomId === 'room-1');
    assert.equal(b.agentState, 'present');   // a live local host serves room-1
    assert.equal(b.relay, 'up');
    assert.equal(h.eventPlane.status, 'quiet');   // connected but no inbound events in-test → quiet (healthy)
  } finally { cleanup(); }
});

test('snapshot: bound room with NO live local agent → agent:absent (the C⑧ silent-void detector)', async () => {
  const { store, owner, readHealth, cleanup } = setup();   // only the owner is registered, no agent
  try {
    store.bind('lark', 'oc_2', { roomId: 'room-2', agent: 'claude' });
    await owner.reconcile('tick');
    const b = readHealth().bindings.find((x) => x.roomId === 'room-2');
    assert.equal(b.agentState, 'absent');   // nothing live serves room-2 → the silent void
  } finally { cleanup(); }
});

test('snapshot: a STOPPED or dead-pid local agent → agent:absent (the server ever-joined signal would have falsely said present)', async () => {
  const { store, owner, readHealth, cleanup } = setup({ hosts: {
    'claude-stopped': { id: 'claude-stopped', mode: 'host', room: 'room-3', pid: process.pid, stopped: true },   // alive pid but stopped
    'claude-dead':    { id: 'claude-dead',    mode: 'host', room: 'room-3b', pid: 999999 },                      // pid not alive
  } });
  try {
    store.bind('lark', 'oc_3', { roomId: 'room-3', agent: 'claude' });
    store.bind('lark', 'oc_3b', { roomId: 'room-3b', agent: 'claude' });
    await owner.reconcile('tick');
    const h = readHealth();
    assert.equal(h.bindings.find((x) => x.roomId === 'room-3').agentState, 'absent');    // stopped:true → not live
    assert.equal(h.bindings.find((x) => x.roomId === 'room-3b').agentState, 'absent');   // dead pid → not live
  } finally { cleanup(); }
});

test('snapshot: owner resolves + persists the Lark chat name (so list stops showing raw oc_ ids)', async () => {
  const { store, owner, readHealth, cleanup } = setup({ hosts: { 'claude-n': { id: 'claude-n', mode: 'host', room: 'room-n', pid: process.pid } } });
  try {
    store.bind('lark', 'oc_1234', { roomId: 'room-n', agent: 'claude' });   // bound with NO chatName
    await owner.reconcile('tick');
    assert.equal(readHealth().bindings.find((x) => x.roomId === 'room-n').chatName, '群-1234');  // in the snapshot
    assert.equal(store.get('lark', 'oc_1234').chatName, '群-1234');                                // AND persisted to the binding for `list`
  } finally { cleanup(); }
});

test('snapshot: creds switched under the owner → credsDrift recorded', async () => {
  const { root, store, owner, readHealth, cleanup } = setup({ hosts: { 'claude-4': { id: 'claude-4', mode: 'host', room: 'room-4', pid: process.pid } } });
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
  const a = setup({ connState: 'reconnecting' });
  try {
    a.store.bind('lark', 'oc_5', { roomId: 'room-5', agent: 'claude' });
    await a.owner.reconcile('tick');
    assert.equal(a.readHealth().eventPlane.status, 'suspect');
  } finally { a.cleanup(); }
  const b = setup({ connState: 'connected' });
  try {
    b.store.bind('lark', 'oc_6', { roomId: 'room-6', agent: 'claude' });
    await b.owner.reconcile('tick');
    assert.equal(b.readHealth().eventPlane.status, 'quiet');   // connected, no inbound events → quiet (healthy), NOT suspect
  } finally { b.cleanup(); }
});

test('singleton: if the registry pid is no longer us, reconcile steps down (does not clobber the new owner)', async () => {
  const { root, store, owner, cleanup } = setup();
  try {
    store.bind('lark', 'oc_7', { roomId: 'room-7', agent: 'claude' });
    writeFileSync(join(root, 'hosts.json'), JSON.stringify({ 'im-lark': { pid: 999999 } }));  // another owner took over
    let exited = false; const realExit = process.exit; process.exit = () => { exited = true; throw new Error('exit'); };
    try { await owner.reconcile('tick'); } catch { /* stepDown throws via our stub */ }
    process.exit = realExit;
    assert.equal(exited, true);   // it stepped down instead of writing a competing snapshot
  } finally { cleanup(); }
});
