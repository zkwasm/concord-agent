// Boundary conditions for the IM owner lifecycle decision — the exact matrix behind the
// "switched bot app but the bind goes silent" bug. Run: node --test src/owner-lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerAction } from './owner-lifecycle.mjs';

test('healthy owner already on the right app → keep (idempotent re-login)', () => {
  assert.equal(ownerAction({ alive: true, existingAppId: 'cli_A', wantAppId: 'cli_A' }), 'keep');
});

test('live owner pinned to a DIFFERENT app → restart (the --qr --new bug)', () => {
  assert.equal(ownerAction({ alive: true, existingAppId: 'cli_OLD', wantAppId: 'cli_NEW' }), 'restart');
});

test('legacy owner with no recorded appId, against a known app → restart (never trust unverifiable)', () => {
  assert.equal(ownerAction({ alive: true, existingAppId: null, wantAppId: 'cli_NEW' }), 'restart');
});

test('live owner but no creds to compare → keep (nothing to switch to)', () => {
  assert.equal(ownerAction({ alive: true, existingAppId: 'cli_A', wantAppId: null }), 'keep');
});

test('no owner running, want one → start', () => {
  assert.equal(ownerAction({ alive: false, existingAppId: null, wantAppId: 'cli_A', startIfAbsent: true }), 'start');
});

test('no owner running, told not to start (manual --app-id) → noop', () => {
  assert.equal(ownerAction({ alive: false, existingAppId: null, wantAppId: 'cli_A', startIfAbsent: false }), 'noop');
});

test('no owner running, app mismatch is irrelevant when dead → start/noop by flag', () => {
  assert.equal(ownerAction({ alive: false, existingAppId: 'cli_OLD', wantAppId: 'cli_NEW', startIfAbsent: true }), 'start');
  assert.equal(ownerAction({ alive: false, existingAppId: 'cli_OLD', wantAppId: 'cli_NEW', startIfAbsent: false }), 'noop');
});
