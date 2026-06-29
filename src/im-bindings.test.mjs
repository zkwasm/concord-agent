// Tests for the IM chat→room binding store. Run: node --test src/im-bindings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBindings } from './im-bindings.mjs';

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'concord-bind-'));
  return { store: openBindings(root), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('bind + get round-trips, keyed per chat', () => {
  const { store, cleanup } = freshStore();
  try {
    const r = store.bind('lark', 'oc_g1', { roomId: 'room-1', chatType: 'group', chatName: '后端' }, { now: 111 });
    assert.equal(r.ok, true);
    assert.deepEqual(store.get('lark', 'oc_g1'), { platform: 'lark', chatId: 'oc_g1', roomId: 'room-1', chatType: 'group', chatName: '后端', boundAt: 111 });
    assert.equal(store.get('lark', 'oc_other'), null);
  } finally { cleanup(); }
});

test('bind refuses to clobber without force; force overwrites', () => {
  const { store, cleanup } = freshStore();
  try {
    store.bind('lark', 'oc_g1', { roomId: 'room-1' });
    const blocked = store.bind('lark', 'oc_g1', { roomId: 'room-2' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.existing.roomId, 'room-1');           // caller turns this into the --force prompt
    assert.equal(store.get('lark', 'oc_g1').roomId, 'room-1'); // unchanged

    const forced = store.bind('lark', 'oc_g1', { roomId: 'room-2' }, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(store.get('lark', 'oc_g1').roomId, 'room-2');
  } finally { cleanup(); }
});

test('platform:chat_id keying — same chat id on two platforms never collides', () => {
  const { store, cleanup } = freshStore();
  try {
    store.bind('lark', 'oc_x', { roomId: 'room-lark' });
    store.bind('feishu', 'oc_x', { roomId: 'room-feishu' });
    assert.equal(store.get('lark', 'oc_x').roomId, 'room-lark');
    assert.equal(store.get('feishu', 'oc_x').roomId, 'room-feishu');
    assert.equal(Object.keys(store.list()).length, 2);
  } finally { cleanup(); }
});

test('unbind removes only the target; returns whether it existed', () => {
  const { store, cleanup } = freshStore();
  try {
    store.bind('lark', 'oc_g1', { roomId: 'room-1' });
    store.bind('lark', 'oc_g2', { roomId: 'room-2' });
    assert.equal(store.unbind('lark', 'oc_g1'), true);
    assert.equal(store.unbind('lark', 'oc_g1'), false);   // already gone
    assert.equal(store.get('lark', 'oc_g1'), null);
    assert.equal(store.get('lark', 'oc_g2').roomId, 'room-2');
  } finally { cleanup(); }
});

test('bind validates inputs', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.throws(() => store.bind('lark', '', { roomId: 'r' }), /platform \+ chatId/);
    assert.throws(() => store.bind('lark', 'oc_g1', {}), /roomId/);
  } finally { cleanup(); }
});

test('missing/corrupt file → empty table, not a throw', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.deepEqual(store.list(), {});
    assert.equal(store.get('lark', 'oc_g1'), null);
  } finally { cleanup(); }
});
