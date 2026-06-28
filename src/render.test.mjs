// Pure-logic tests for ACP tool_call -> progress line. Run: node --test bridges/acp/render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDetail, toolToProgress } from './render.mjs';

test('file location wins over raw input; shown as basename', () => {
  const u = { kind: 'read', title: 'Read', locations: [{ path: '/proj/src/foo.ts' }], rawInput: { file_path: 'ignored' } };
  assert.equal(toolDetail(u), 'foo.ts');
  assert.equal(toolToProgress(u), '📖 Read: foo.ts');
});

// Real acpx shapes (captured live): the pending tool_call is empty; the detail
// (title + file_path + locations) only arrives in the follow-up tool_call_update.
test('ACP pending tool_call is empty → bare card', () => {
  const pending = { sessionUpdate: 'tool_call', status: 'pending', title: 'Write', kind: 'edit', rawInput: {}, locations: [] };
  assert.equal(toolDetail(pending), '');
  assert.equal(toolToProgress(pending), '✏️ Write');
});

test('ACP tool_call_update carries detail; title already names the file → no repeat', () => {
  const upd = { sessionUpdate: 'tool_call_update', kind: 'edit', title: 'Write demo.txt', rawInput: { file_path: '/a/b/demo.txt', content: 'hi\n' }, locations: [{ path: '/a/b/demo.txt' }] };
  assert.equal(toolDetail(upd), 'demo.txt');
  assert.equal(toolToProgress(upd), '✏️ Write demo.txt');   // not "Write demo.txt: demo.txt"
});

test('search query / command / url pulled from raw input', () => {
  assert.equal(toolToProgress({ kind: 'search', title: 'Web search', rawInput: { query: 'lark card markdown' } }),
    '🔎 Web search: lark card markdown');
  assert.equal(toolToProgress({ kind: 'execute', title: 'Bash', rawInput: { command: 'npm test' } }),
    '▶️ Bash: npm test');
  assert.equal(toolToProgress({ kind: 'fetch', title: 'Fetch', rawInput: { url: 'https://x.dev' } }),
    '🌐 Fetch: https://x.dev');
});

test('argv-style array command is joined', () => {
  assert.equal(toolDetail({ kind: 'execute', rawInput: { command: ['git', 'status', '-s'] } }), 'git status -s');
});

test('raw_input / input field-name aliases are honored (paths → basename)', () => {
  assert.equal(toolDetail({ raw_input: { pattern: '*.ts' } }), '*.ts');   // pattern is not a path
  assert.equal(toolDetail({ input: { path: '/tmp/sub/x.ts' } }), 'x.ts'); // path → basename
});

test('unknown / missing kind falls back to the wrench icon and title', () => {
  assert.equal(toolToProgress({ title: 'Mystery' }), '🔧 Mystery');
  assert.equal(toolToProgress({ kind: 'weird', rawInput: {} }), '🔧 weird');
});

test('no detail → icon + name only', () => {
  assert.equal(toolToProgress({ kind: 'think', title: 'Think' }), '💭 Think');
});

test('long detail is truncated with an ellipsis', () => {
  const long = 'x'.repeat(250);
  const out = toolToProgress({ kind: 'execute', title: 'Bash', rawInput: { command: long } });
  assert.ok(out.endsWith('…'));
  assert.ok(out.length < 130, `expected truncated, got length ${out.length}`);
});

test('non-string / empty fields are skipped', () => {
  assert.equal(toolDetail({ rawInput: { query: '', command: 42, url: '  ' } }), '');
});
