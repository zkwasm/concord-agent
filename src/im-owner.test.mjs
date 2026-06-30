// Tests for the IM owner's inbound dispatch + relay, with a mock Lark client and a
// mock fetch (room join/post/poll). WSClient connect + the live round-trip are
// verified against a real Lark app. Run: node --test src/im-owner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBindings } from './im-bindings.mjs';
import { createOwner } from './im-owner.mjs';

function mockClient({ userCount = 5 } = {}) {
  const sent = [];
  return {
    sent,
    im: { v1: {
      message: { create: async (req) => {
        const c = JSON.parse(req.data.content);
        sent.push({ chatId: req.data.receive_id, msgType: req.data.msg_type, text: req.data.msg_type === 'interactive' ? c.elements?.[0]?.content : c.text });
        return { code: 0 };
      } },
      chat: { get: async () => ({ data: { user_count: String(userCount), bot_count: '1' } }) },   // member count for solo-group detection
    } },
  };
}
const fakeWs = { start() {}, stop() {} };

// Mock the room REST: join → a session id, POST /messages → captured, poll → empty.
function mockFetch(captured) {
  return async (urlStr, opts = {}) => {
    if (urlStr.includes('/join')) return { ok: true, status: 200, json: async () => ({ agentSessionId: 'sess-1' }) };
    if ((opts.method === 'POST') && urlStr.includes('/messages')) { captured.posts.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };   // poll
  };
}

function ev({ text, chatType = 'p2p', mentions = null, chatId = 'oc_1', mid }) {
  return { message: { message_id: mid, chat_id: chatId, chat_type: chatType, content: JSON.stringify({ text }), mentions }, sender: { sender_id: { open_id: 'ou_x' } } };
}

function freshOwner({ userCount } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'concord-owner-'));
  const client = mockClient({ userCount });
  const captured = { posts: [] };
  const store = openBindings(root);
  const owner = createOwner({ platform: 'lark', url: 'http://test', log: () => {}, bindings: store, home: root, _clients: { client, ws: fakeWs, fetch: mockFetch(captured) } });
  return { owner, client, store, captured, cleanup: () => { owner.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

test('/concord-bind in an UNBOUND p2p chat → prompts the host command, no --budget', async () => {
  const { owner, client, cleanup } = freshOwner();
  try {
    const r = await owner.onEvent(ev({ text: '/concord-bind', chatType: 'p2p', chatId: 'oc_p' }));
    assert.equal(r.action, 'prompted');
    assert.match(client.sent[0].text, /concord host claude --bind oc_p/);
    assert.doesNotMatch(client.sent[0].text, /--budget/);
  } finally { cleanup(); }
});

test('/concord-bind in an UNBOUND group → prompt carries --budget 1000000', async () => {
  const { owner, client, cleanup } = freshOwner();
  try {
    await owner.onEvent(ev({ text: '@bot /concord-bind', chatType: 'group', mentions: [{ key: '@_u' }], chatId: 'oc_g' }));
    assert.match(client.sent[0].text, /concord host claude --bind oc_g --budget 1000000/);
  } finally { cleanup(); }
});

test('/concord-bind in an ALREADY-bound chat → --force prompt', async () => {
  const { owner, client, store, cleanup } = freshOwner();
  try {
    store.bind('lark', 'oc_p', { roomId: 'room-abc12345' });
    const r = await owner.onEvent(ev({ text: '/concord-bind', chatType: 'p2p', chatId: 'oc_p' }));
    assert.equal(r.action, 'already-bound');
    assert.match(client.sent[0].text, /--force/);
  } finally { cleanup(); }
});

test('unbound message → "send /concord-bind"; bound message → instant ack + POST to room', async () => {
  const { owner, client, store, captured, cleanup } = freshOwner();
  try {
    const u = await owner.onEvent(ev({ text: 'hello', chatType: 'p2p', chatId: 'oc_u' }));
    assert.equal(u.action, 'unbound');
    assert.match(client.sent[0].text, /\/concord-bind/);

    store.bind('lark', 'oc_b', { roomId: 'room-xyz99999' });
    client.sent.length = 0;
    const b = await owner.onEvent(ev({ text: 'do the thing', chatType: 'p2p', chatId: 'oc_b' }));
    assert.equal(b.action, 'routed');
    assert.match(client.sent[0].text, /收到/);                                 // owner instant ack (decision 4)
    assert.ok(captured.posts.some((p) => /do the thing/.test(p.content)));      // posted into the bound room
    assert.ok(captured.posts.every((p) => p.sender === 'IM'));                  // as the relay identity (loop guard)
  } finally { cleanup(); }
});

test('group message without @ is ignored; /concord-unbind removes a binding', async () => {
  const { owner, client, store, cleanup } = freshOwner();
  try {
    const ig = await owner.onEvent(ev({ text: 'chit chat', chatType: 'group', mentions: [], chatId: 'oc_g' }));
    assert.equal(ig.action, 'ignore');
    assert.equal(client.sent.length, 0);

    store.bind('lark', 'oc_g', { roomId: 'room-1' });
    const r = await owner.onEvent(ev({ text: '@bot /concord-unbind', chatType: 'group', mentions: [{ key: '@_u' }], chatId: 'oc_g' }));
    assert.equal(r.action, 'unbound');
    assert.equal(store.get('lark', 'oc_g'), null);
  } finally { cleanup(); }
});

test('solo group (user_count=1): un-@ message is routed, like p2p', async () => {
  const { owner, client, store, captured, cleanup } = freshOwner({ userCount: 1 });
  try {
    store.bind('lark', 'oc_solo', { roomId: 'room-solo1234' });
    const r = await owner.onEvent(ev({ text: 'run the build', chatType: 'group', mentions: [], chatId: 'oc_solo' }));
    assert.equal(r.action, 'routed');
    assert.match(client.sent[0].text, /收到/);
    assert.ok(captured.posts.some((p) => /run the build/.test(p.content)));
  } finally { cleanup(); }
});

test('shared group (user_count=3): un-@ message is still ignored', async () => {
  const { owner, client, store, cleanup } = freshOwner({ userCount: 3 });
  try {
    store.bind('lark', 'oc_shared', { roomId: 'room-shared99' });
    const r = await owner.onEvent(ev({ text: 'chit chat', chatType: 'group', mentions: [], chatId: 'oc_shared' }));
    assert.equal(r.action, 'ignore');
    assert.equal(client.sent.length, 0);
  } finally { cleanup(); }
});

test('syncRelays({notify:true}) joins a new binding and confirms "✓ 绑定成功" in the chat, once', async () => {
  const { owner, client, store, cleanup } = freshOwner();
  try {
    store.bind('lark', 'oc_new', { roomId: 'room-new12345' });
    await owner.syncRelays({ notify: true });
    assert.ok(client.sent.some((s) => /绑定成功/.test(s.text)));
    client.sent.length = 0;
    await owner.syncRelays({ notify: true });                              // already joined → no re-notify
    assert.equal(client.sent.filter((s) => /绑定成功/.test(s.text)).length, 0);
  } finally { cleanup(); }
});

test('/agents lists current bindings + count', async () => {
  const { owner, client, store, cleanup } = freshOwner();
  try {
    store.bind('lark', 'oc_a', { roomId: 'room-aaaa1111', agent: 'claude' });
    store.bind('lark', 'oc_b', { roomId: 'room-bbbb2222', agent: 'codex' });
    const r = await owner.onEvent(ev({ text: '/agents', chatType: 'p2p', chatId: 'oc_a' }));
    assert.equal(r.action, 'agents');
    assert.equal(r.count, 2);
    assert.match(client.sent.at(-1).text, /claude/);
    assert.match(client.sent.at(-1).text, /codex/);
  } finally { cleanup(); }
});

test('duplicate message_id is dropped (Lark redelivery)', async () => {
  const { owner, cleanup } = freshOwner();
  try {
    await owner.onEvent(ev({ text: 'hi', chatType: 'p2p', mid: 'm1' }));
    const dup = await owner.onEvent(ev({ text: 'hi', chatType: 'p2p', mid: 'm1' }));
    assert.equal(dup.action, 'dup');
  } finally { cleanup(); }
});
