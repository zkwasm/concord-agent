// Tests for join-time agent naming (headless suggestion + parsing + fallback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namingPrompt, parseCandidates, fallbackCandidates, suggestNames, runHeadlessClaude } from './naming.mjs';

test('namingPrompt: role-framing + dir, room objective/context, taken names', () => {
  const p = namingPrompt({ dir: '/x/parser-service', agentType: 'claude', roomName: '支付重构', purpose: '重构支付系统', context: 'Suggested participant roles: 评审, 实现', agents: ['工程师'] });
  assert.match(p, /ROLE/);                                  // names are roles, not labels
  assert.match(p, /parser-service/);
  assert.match(p, /支付重构/);
  assert.match(p, /Suggested participant roles: 评审, 实现/); // room context flows through
  assert.match(p, /untaken ones FIRST/);                     // context roles take priority
  assert.match(p, /工程师/);
  assert.match(p, /JSON array/);
});

test('parseCandidates: extracts the array, drops collisions/dupes/long/non-strings', () => {
  const out = parseCandidates('Sure! Here you go:\n["parser-dev", "评审", "工程师", "评审", 42, "' + 'x'.repeat(30) + '", "backend fixer"]', { taken: ['工程师'] });
  assert.deepEqual(out, ['parser-dev', '评审', 'backend-fixer']);   // taken/dupe/number/too-long dropped; spaces → hyphens
});

test('parseCandidates: garbage → empty', () => {
  assert.deepEqual(parseCandidates('no array here'), []);
  assert.deepEqual(parseCandidates('[not json]'), []);
  assert.deepEqual(parseCandidates(''), []);
});

test('fallbackCandidates: dir name, numbered when taken', () => {
  assert.deepEqual(fallbackCandidates('/w/parser-service', []), ['parser-service', 'parser-service-2']);
  assert.deepEqual(fallbackCandidates('/w/parser-service', ['parser-service']), ['parser-service-2', 'parser-service-3']);
});

test('suggestNames: LLM candidates first, mechanical fallback appended; empty LLM → fallback only', async () => {
  const fetchImpl = async (u) => ({ ok: true, json: async () => (u.includes('/agents') ? { agents: ['工程师'] } : { name: 'R', purpose: 'p' }) });
  const good = await suggestNames({ dir: '/w/app', url: 'http://x', roomId: 'r1', fetchImpl, runHeadless: async () => '["reviewer","tester"]' });
  assert.equal(good.fromLLM, true);
  assert.deepEqual(good.candidates.slice(0, 2), ['reviewer', 'tester']);
  assert.ok(good.candidates.includes('app'));                        // fallback appended
  const bad = await suggestNames({ dir: '/w/app', url: 'http://x', roomId: 'r1', fetchImpl, runHeadless: async () => '' });
  assert.equal(bad.fromLLM, false);
  assert.deepEqual(bad.candidates, ['app', 'app-2']);                // never empty
});

test('runHeadlessClaude: missing binary and non-zero exit resolve to empty string', async () => {
  const boom = () => { throw new Error('ENOENT'); };
  assert.equal(await runHeadlessClaude('p', { spawnImpl: boom }), '');
  const failing = () => ({ stdout: { on: () => {} }, on: (ev, cb) => { if (ev === 'close') setImmediate(() => cb(1)); }, kill: () => {} });
  assert.equal(await runHeadlessClaude('p', { spawnImpl: failing }), '');
});
