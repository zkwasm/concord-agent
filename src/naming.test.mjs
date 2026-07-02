// Tests for join-time agent naming (headless suggestion + parsing + fallback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namingPrompt, parseCandidates, fallbackCandidates, suggestNames, runHeadlessClaude, extractTemplateRoles } from './naming.mjs';

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

test('extractTemplateRoles: parses the composed roles block (en + zh headers)', () => {
  const en = 'Objective: build.\nSuggested participant roles:\n- Planner: plans the work\n- Coder: implements it\nOther text.';
  assert.deepEqual(extractTemplateRoles(en), ['Planner', 'Coder']);
  const zh = '目标。\n候选角色(挑一个还没有其他 Agent 占用的 —— 由 409 强制保证唯一):\n- 规划者: 出计划\n- 编码者: 写代码\n后续。';
  assert.deepEqual(extractTemplateRoles(zh), ['规划者', '编码者']);
  assert.deepEqual(extractTemplateRoles('no roles here'), []);
  assert.deepEqual(extractTemplateRoles(''), []);
});

test('suggestNames: template roles win — untaken entries verbatim, NO headless call', async () => {
  const ctx = 'Suggested participant roles:\n- Planner: plans\n- Coder: codes\n- Reviewer: reviews';
  const fetchImpl = async (u) => ({ ok: true, json: async () => (u.includes('/agents') ? { agents: ['Coder'] } : { name: 'R', purpose: 'p', context: ctx }) });
  let headlessCalled = false;
  const r = await suggestNames({ dir: '/w/app', url: 'http://x', roomId: 'r1', fetchImpl, runHeadless: async () => { headlessCalled = true; return '["x"]'; } });
  assert.equal(r.source, 'template');
  assert.equal(headlessCalled, false);                               // grounded roles → no LLM guessing
  assert.deepEqual(r.candidates.slice(0, 2), ['Planner', 'Reviewer']); // taken "Coder" excluded, order kept
});

test('suggestNames: no template roles → headless (grounded) first, fallback appended; empty LLM → fallback only', async () => {
  const fetchImpl = async (u) => ({ ok: true, json: async () => (u.includes('/agents') ? { agents: ['工程师'] } : { name: 'R', purpose: 'p', context: '' }) });
  const good = await suggestNames({ dir: '/w/app', url: 'http://x', roomId: 'r1', fetchImpl, runHeadless: async () => '["reviewer","tester"]' });
  assert.equal(good.source, 'headless');
  assert.deepEqual(good.candidates.slice(0, 2), ['reviewer', 'tester']);
  assert.ok(good.candidates.includes('app'));                        // fallback appended
  const bad = await suggestNames({ dir: '/w/app', url: 'http://x', roomId: 'r1', fetchImpl, runHeadless: async () => '' });
  assert.equal(bad.source, 'fallback');
  assert.deepEqual(bad.candidates, ['app', 'app-2']);                // never empty
});

test('runHeadlessClaude: missing binary and non-zero exit resolve to empty string', async () => {
  const boom = () => { throw new Error('ENOENT'); };
  assert.equal(await runHeadlessClaude('p', { spawnImpl: boom }), '');
  const failing = () => ({ stdout: { on: () => {} }, on: (ev, cb) => { if (ev === 'close') setImmediate(() => cb(1)); }, kill: () => {} });
  assert.equal(await runHeadlessClaude('p', { spawnImpl: failing }), '');
});
