// Tests for the personal-mode IM bridge. Run: node --test src/im-lark.test.mjs
// The WSClient connection needs a live app, so we test the pure decision logic
// (which is exactly what makes private chat work) + the card→text send fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, shouldHandle, createImBridge } from './im-lark.mjs';

// --- cleanText: @ placeholder cleanup ---
test('cleanText: replaces @_user_N placeholders and trims', () => {
  assert.equal(cleanText('  @_user_1 帮我改下  ', [{ key: '@_user_1', name: 'bot' }]), '@bot 帮我改下');
  assert.equal(cleanText('hello', []), 'hello');
  assert.equal(cleanText('', null), '');
  assert.equal(cleanText(undefined, undefined), '');
});

// --- shouldHandle: the private-chat fix ---
test('shouldHandle: private chat (p2p) is always handled — no @ required', () => {
  assert.equal(shouldHandle({ chatType: 'p2p', mentions: [] }), true);
  assert.equal(shouldHandle({ chatType: 'p2p', mentions: null }), true);
  assert.equal(shouldHandle({ chatType: 'p2p', mentions: [{ key: '@_user_1' }] }), true);
});

test('shouldHandle: group chat only when the bot is @-mentioned', () => {
  assert.equal(shouldHandle({ chatType: 'group', mentions: [{ key: '@_user_1' }] }), true);
  assert.equal(shouldHandle({ chatType: 'group', mentions: [] }), false);
  assert.equal(shouldHandle({ chatType: 'group', mentions: null }), false);
});

test('shouldHandle: unknown/missing chatType defaults to "requires a mention" (safe)', () => {
  assert.equal(shouldHandle({ mentions: [] }), false);
  assert.equal(shouldHandle({ mentions: [{ key: '@x' }] }), true);
  assert.equal(shouldHandle({}), false);
});

// --- send: interactive markdown card, with a plain-text fallback ---
function mockClient({ failCard = false } = {}) {
  const calls = [];
  return {
    calls,
    im: { v1: { message: { create: async (req) => {
      calls.push(req.data.msg_type);
      if (failCard && req.data.msg_type === 'interactive') throw new Error('card rejected');
      return { code: 0 };
    } } } },
    contact: { v3: { user: { get: async () => ({ data: { user: { name: 'Tester' } } }) } } },
  };
}
const fakeWs = { start() {}, stop() {} };

test('send: posts an interactive card on success', async () => {
  const c = mockClient();
  const im = createImBridge({ platform: 'lark', log: () => {}, _clients: { client: c, ws: fakeWs } });
  await im.send('chat1', 'hi **there**');
  assert.deepEqual(c.calls, ['interactive']);
});

test('send: falls back to plain text when the card is rejected (never silent)', async () => {
  const c = mockClient({ failCard: true });
  const im = createImBridge({ platform: 'lark', log: () => {}, _clients: { client: c, ws: fakeWs } });
  await im.send('chat1', 'hi');
  assert.deepEqual(c.calls, ['interactive', 'text']);   // tried card, then text
});

test('send: no-ops on empty chat/text', async () => {
  const c = mockClient();
  const im = createImBridge({ platform: 'lark', log: () => {}, _clients: { client: c, ws: fakeWs } });
  await im.send('', 'hi');
  await im.send('chat1', '');
  assert.deepEqual(c.calls, []);
});
