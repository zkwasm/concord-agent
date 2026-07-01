// Tests for local IM bot credential storage. Run: node --test bridges/acp/creds.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCreds, getCreds, removeCreds, loadCreds, credsPath } from './creds.mjs';

// Track every temp root so they don't pile up in $TMPDIR across runs (was leaking one per test).
const roots = [];
const freshRoot = () => { const d = mkdtempSync(join(tmpdir(), 'concord-creds-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

test('save / get / remove per platform', () => {
  const root = freshRoot();
  saveCreds('feishu', { appId: 'cli_a', appSecret: 's', domain: 'feishu' }, root);
  saveCreds('lark', { appId: 'cli_b', appSecret: 't', domain: 'lark' }, root);
  assert.equal(getCreds('feishu', root).appId, 'cli_a');
  assert.equal(getCreds('lark', root).domain, 'lark');
  assert.ok(getCreds('feishu', root).savedAt);
  assert.equal(removeCreds('feishu', root), true);
  assert.equal(getCreds('feishu', root), null);
  assert.equal(getCreds('lark', root).appId, 'cli_b');   // other platform untouched
});

test('creds file is written 0600 (secret stays private)', () => {
  const root = freshRoot();
  saveCreds('lark', { appId: 'x', appSecret: 'secret' }, root);
  const mode = statSync(credsPath(root)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('missing / corrupt creds file → empty', () => {
  const root = freshRoot();
  assert.deepEqual(loadCreds(root), {});
  assert.equal(getCreds('lark', root), null);
});
