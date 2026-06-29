// Tests for the IM owner's inbound dispatch (bind handshake / routing), with a mock
// Lark client + a real binding store on a temp dir. The WSClient connect is live-only.
// Run: node --test src/im-owner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBindings } from './im-bindings.mjs';
import { createOwner } from './im-owner.mjs';

function mockClient() {
  const sent = [];
  return {
    sent,
    im: { v1: { message: { create: async (req) => {
      const c = JSON.parse(req.data.content);
      const text = req.data.msg_type === 'interactive' ? c.elements?.[0]?.content : c.text;
      sent.push({ chatId: req.data.receive_id, msgType: req.data.msg_type, text });
      return { code: 0 };
    } } } },
  };
}
const fakeWs = { start() {}, stop() {} };

function ev({ text, chatType = 'p2p', mentions = null, chatId = 'oc_1', mid }) {
  return { message: { message_id: mid, chat_id: chatId, chat_type: chatType, content: JSON.stringify({ text }), mentions }, sender: { sender_id: { open_id: 'ou_x' } } };
}

function freshOwner() {
  const root = mkdtempSync(join(tmpdir(), 'concord-owner-'));
  const client = mockClient();
  const store = openBindings(root);
  const owner = createOwner({ platform: 'lark', log: () => {}, bindings: store, _clients: { client, ws: fakeWs } });
  return { owner, client, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('/concord-bind in an UNBOUND p2p chat → prompts the host command, no --budget', async () => {
  const { owner, client, cleanup } = freshOwner();
  try {
    const r = await owner.onEvent(ev({ text: '/concord-bind', chatType: 'p2p', chatId: 'oc_p' }));
    assert.equal(r.action, 'prompted');
    assert.equal(client.sent.length, 1);
    assert.match(client.sent[0].text, /concord host claude --bind oc_p/);
    assert.doesNotMatch(client.sent[0].text, /--budget/);   // p2p default = unlimited
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

test('normal message in an UNBOUND chat → "send /concord-bind"; in a BOUND chat → routed (no reply)', async () => {
  const { owner, client, store, cleanup } = freshOwner();
  try {
    const u = await owner.onEvent(ev({ text: 'hello', chatType: 'p2p', chatId: 'oc_u' }));
    assert.equal(u.action, 'unbound');
    assert.match(client.sent[0].text, /\/concord-bind/);

    store.bind('lark', 'oc_b', { roomId: 'room-xyz99999' });
    client.sent.length = 0;
    const b = await owner.onEvent(ev({ text: 'do the thing', chatType: 'p2p', chatId: 'oc_b' }));
    assert.equal(b.action, 'routed');
    assert.equal(b.roomId, 'room-xyz99999');
    assert.equal(client.sent.length, 0);   // routed to room (phase 3), not answered by the owner
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

test('duplicate message_id is dropped (Lark redelivery)', async () => {
  const { owner, cleanup } = freshOwner();
  try {
    await owner.onEvent(ev({ text: 'hi', chatType: 'p2p', mid: 'm1' }));
    const dup = await owner.onEvent(ev({ text: 'hi', chatType: 'p2p', mid: 'm1' }));
    assert.equal(dup.action, 'dup');
  } finally { cleanup(); }
});
