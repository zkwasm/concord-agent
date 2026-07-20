// Turn-failure recovery: transient-error classification, addressed notes, and the
// ping-pong gate. These three together are what keeps a provider hiccup from
// permanently killing a room (a dropped turn used to leave an un-addressed note
// that every peer classified as ambient → nobody ever took the floor again).
// Run: node --test src/turn-recovery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientTurnError, mentioning, createFailureGate, composeTurnText } from './cli.mjs';

const INBOX = [{ sender: '框架审核者', content: '⚠️ This one did not go through' }];

test('composeTurnText: a passthrough slash keeps "/" at offset 0 even with a full inbox', () => {
  // THE regression this file exists for: the inbox head used to be prepended
  // unconditionally, so the adapter stopped seeing /compact as a command and the
  // agent just chatted about compacting. Verified live against two real agents.
  const out = composeTurnText({ text: '/compact', slash: true }, INBOX, 0, 'zh');
  assert.equal(out, '/compact');
  assert.ok(out.startsWith('/'), 'a command that does not start with "/" is not a command');
});

test('composeTurnText: a normal message still gets the batched inbox prepended', () => {
  const out = composeTurnText({ text: '[Tom] go on', slash: false }, INBOX, 0, 'en');
  assert.ok(out.includes('[框架审核者] ⚠️ This one did not go through'), 'missed context must survive');
  assert.ok(out.endsWith('[Tom] go on'), 'the waking message stays last');
  assert.ok(out.startsWith('(The following 1 room message(s)'), 'context block is labelled');
});

test('composeTurnText: empty inbox returns the message untouched, either kind', () => {
  assert.equal(composeTurnText({ text: '/context', slash: true }, [], 0, 'en'), '/context');
  assert.equal(composeTurnText({ text: '[Tom] hi', slash: false }, [], 0, 'en'), '[Tom] hi');
});

test('composeTurnText: locale drives the context header, dropped count is surfaced', () => {
  assert.ok(composeTurnText({ text: 'x' }, INBOX, 3, 'zh').includes('更早 3 条已省略'));
  assert.ok(composeTurnText({ text: 'x' }, INBOX, 3, 'en').includes('3 earlier one(s) omitted'));
});

test('isTransientTurnError: the real production rate-limit message retries', () => {
  // Verbatim from a host log — the failure that killed the "网络小说创作框架" room.
  const real = new Error('Internal error: API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited');
  assert.equal(isTransientTurnError(real), true);
});

test('isTransientTurnError: provider throttle / overload / transport blips retry', () => {
  for (const m of [
    'API Error: rate_limit_error',
    'Rate limited',
    'server is temporarily limiting requests',
    'Overloaded',
    'overloaded_error',
    'Too Many Requests',
    'HTTP 429',
    'HTTP 529',
    'HTTP 503',
    'fetch failed',
    'socket hang up',
    'connect ETIMEDOUT 1.2.3.4:443',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN api.example.com',
  ]) assert.equal(isTransientTurnError(new Error(m)), true, `should be transient: ${m}`);
});

test('isTransientTurnError: permanent failures are NOT retried', () => {
  for (const m of [
    'invalid api key',
    'authentication_error: bad credentials',
    'model not found',
    'prompt too long: 300000 tokens exceeds the limit',
    'permission denied',
  ]) assert.equal(isTransientTurnError(new Error(m)), false, `should be permanent: ${m}`);
  assert.equal(isTransientTurnError(null), false);
  assert.equal(isTransientTurnError(undefined), false);
});

test('isTransientTurnError: our own stuck-turn cancel is never retried', () => {
  // It already burned the full ceiling; re-running it would just burn it again.
  const e = new Error('turn exceeded the 21600s ceiling and was cancelled');
  e.code = 'TURN_TIMEOUT';
  assert.equal(isTransientTurnError(e), false);
  // …even though the text alone would otherwise look transient.
  const t = new Error('timeout: overloaded');
  t.code = 'TURN_TIMEOUT';
  assert.equal(isTransientTurnError(t), false);
});

test('mentioning: addresses the note so a peer actually wakes', () => {
  assert.equal(mentioning('框架审核者', 'done', 'me'), '@框架审核者 done');
  // A name with spaces still resolves — the server matches participant names exactly.
  assert.equal(mentioning('Tom Decar', 'done', 'me'), '@Tom Decar done');
});

test('mentioning: never @-mentions itself, and degrades cleanly with no target', () => {
  assert.equal(mentioning('me', 'done', 'me'), 'done');   // self-mentions never resolve server-side
  assert.equal(mentioning('', 'done', 'me'), 'done');
  assert.equal(mentioning(null, 'done', 'me'), 'done');
  assert.equal(mentioning(undefined, 'done', 'me'), 'done');
});

test('failure gate: first failure addresses the trigger, an immediate repeat does not', () => {
  const gate = createFailureGate();
  assert.equal(gate.addressee('bob'), 'bob');    // wake bob so the exchange can resume
  assert.equal(gate.addressee('bob'), null);     // bob is failing too → un-addressed, no ping-pong
  assert.equal(gate.addressee('bob'), null);
});

test('failure gate: a successful turn clears the streak', () => {
  const gate = createFailureGate();
  assert.equal(gate.addressee('bob'), 'bob');
  assert.equal(gate.addressee('bob'), null);
  gate.reset();                                  // a turn succeeded in between
  assert.equal(gate.addressee('bob'), 'bob');    // a NEW streak may address again
});

test('failure gate: a different trigger is always addressed', () => {
  const gate = createFailureGate();
  assert.equal(gate.addressee('bob'), 'bob');
  assert.equal(gate.addressee('carol'), 'carol');   // different sender → not a ping-pong
  assert.equal(gate.addressee('carol'), null);      // …but carol repeating is
  assert.equal(gate.addressee('bob'), 'bob');
});

test('failure gate: an absent sender never becomes a repeat-suppressed streak', () => {
  const gate = createFailureGate();
  assert.equal(gate.addressee(undefined), undefined);
  assert.equal(gate.addressee(undefined), undefined);   // nothing to suppress; mentioning() drops it anyway
});
