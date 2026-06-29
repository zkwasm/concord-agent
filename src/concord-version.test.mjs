// `concord version` (and -v / --version) print the package version, read from
// package.json at runtime so it can never drift from what's published.
// Run: node --test src/concord-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CONCORD = new URL('./concord.mjs', import.meta.url).pathname;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('concord version / --version / -v print the package version', () => {
  for (const arg of ['version', '--version', '-v']) {
    const res = spawnSync(process.execPath, [CONCORD, arg], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${arg} should exit 0 — stderr:\n${res.stderr}`);
    assert.match(res.stdout, new RegExp(VERSION.replace(/\./g, '\\.')), `${arg} should print ${VERSION}`);
  }
});
