// Tests for the pure inbound-routing brain. Run: node --test src/im-routing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, classifyInbound } from './im-routing.mjs';

test('commandOf strips @mentions + normalizes', () => {
  assert.equal(commandOf('@bot concord-bind'), 'concord-bind');
  assert.equal(commandOf('  Concord-Bind  '), 'concord-bind');
  assert.equal(commandOf('@bot   /usage'), '/usage');
  assert.equal(commandOf(''), '');
});

test('p2p: every non-empty message is acted on (no @ needed)', () => {
  assert.deepEqual(classifyInbound({ text: '改一下登录页', chatType: 'p2p' }), { action: 'message', text: '改一下登录页' });
  assert.equal(classifyInbound({ text: '', chatType: 'p2p' }).action, 'ignore');
});

test('group: only when the bot is @-mentioned', () => {
  assert.equal(classifyInbound({ text: 'hi', chatType: 'group', mentions: [] }).action, 'ignore');
  assert.equal(classifyInbound({ text: 'hi', chatType: 'group', mentions: null }).action, 'ignore');
  assert.deepEqual(classifyInbound({ text: '@bot 跑测试', chatType: 'group', mentions: [{ key: '@_user_1' }] }), { action: 'message', text: '@bot 跑测试' });
});

test('bind / unbind: /concord-bind canonical + bare accepted, in p2p and group', () => {
  // canonical slash form (reads as a command, @bot stripped in groups)
  assert.equal(classifyInbound({ text: '/concord-bind', chatType: 'p2p' }).action, 'bind');
  assert.equal(classifyInbound({ text: '@bot /concord-bind', chatType: 'group', mentions: [{ key: '@_user_1' }] }).action, 'bind');
  assert.equal(classifyInbound({ text: '/concord-unbind', chatType: 'p2p' }).action, 'unbind');
  assert.equal(classifyInbound({ text: '@bot /concord-unbind', chatType: 'group', mentions: [{ key: '@_u' }] }).action, 'unbind');
  // bare form still accepted (a missing slash must not fall through to the agent)
  assert.equal(classifyInbound({ text: 'concord-bind', chatType: 'p2p' }).action, 'bind');
  assert.equal(classifyInbound({ text: 'concord-unbind', chatType: 'p2p' }).action, 'unbind');
});

test('usage query detected; group usage still needs the @', () => {
  assert.equal(classifyInbound({ text: '/usage', chatType: 'p2p' }).action, 'usage');
  assert.equal(classifyInbound({ text: '用量', chatType: 'p2p' }).action, 'usage');
  assert.equal(classifyInbound({ text: '/usage', chatType: 'group', mentions: [] }).action, 'ignore');  // no @ → ignored
  assert.equal(classifyInbound({ text: '@bot /stats', chatType: 'group', mentions: [{ key: '@_u' }] }).action, 'usage');
});

test('a message that merely contains the word is still a message, not a command', () => {
  assert.equal(classifyInbound({ text: 'how do I use concord-bind?', chatType: 'p2p' }).action, 'message');
});
