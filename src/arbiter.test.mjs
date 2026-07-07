// Tests for the answer-arbitration pure logic (markers, backoff, tie-break).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isArbMarker, buildMarker, parseMarker, arbBackoffMs, arbWin,
  ARB_BACKOFF_MIN_MS, ARB_BACKOFF_MAX_MS,
} from './arbiter.mjs';

test('marker round-trips: build → parse recovers the exact message id', () => {
  const id = 'msg-abc-123';
  const marker = buildMarker(id, '开发');
  assert.equal(parseMarker(marker), id);
  assert.ok(isArbMarker(marker));
  assert.match(marker, /🎯/);          // visible to humans
  assert.match(marker, /开发/);         // names the claimant
});

test('normal prose is never mistaken for a marker', () => {
  for (const s of ['我来接这条', '🎯 目标已达成', 'see ⟦note⟧ here', '', null, undefined]) {
    assert.equal(isArbMarker(s), false, `false positive on: ${s}`);
    assert.equal(parseMarker(s), null);
  }
});

test('backoff stays within [MIN, MAX) for the rng extremes', () => {
  assert.equal(arbBackoffMs(() => 0), ARB_BACKOFF_MIN_MS);
  assert.equal(arbBackoffMs(() => 0.999999), ARB_BACKOFF_MAX_MS - 1);
  const v = arbBackoffMs(() => 0.5);
  assert.ok(v >= ARB_BACKOFF_MIN_MS && v < ARB_BACKOFF_MAX_MS);
});

test('tie-break: the lexicographically smallest name wins, deterministically', () => {
  // I am the smallest → I win.
  assert.equal(arbWin('alice', ['bob', 'carol']), true);
  // Someone smaller exists → I stand down.
  assert.equal(arbWin('bob', ['alice']), false);
  assert.equal(arbWin('carol', ['alice', 'bob']), false);
  // No competitors → I win (the common, uncontested case).
  assert.equal(arbWin('anyone', []), true);
  // Every agent computes the SAME winner over the same marker set → exactly one proceeds.
  const names = ['开发', '评审', 'zoe'];
  const winners = names.filter((me) => arbWin(me, names.filter((n) => n !== me)));
  assert.equal(winners.length, 1);                              // never zero (silence), never two (duplicate)
  assert.equal(winners[0], names.slice().sort()[0]);           // and it's the smallest name
});
