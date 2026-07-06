// Pure-logic tests for acp host CLI parsing. Run: node --test bridges/acp/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveConfig } from './cli.mjs';

test('parseArgs: positionals and --flags with values', () => {
  const { flags, positional } = parseArgs(['claude', '--room', 'r1', '--cwd', '/tmp']);
  assert.deepEqual(positional, ['claude']);
  assert.equal(flags.room, 'r1');
  assert.equal(flags.cwd, '/tmp');
});

test('parseArgs: lone flag (end of args / followed by another flag) is boolean', () => {
  const { flags } = parseArgs(['--verbose', '--room', 'r1']);
  assert.equal(flags.verbose, true);
  assert.equal(flags.room, 'r1');
});

test('resolveConfig: CLI flag > env > default', () => {
  const cfg = resolveConfig(['claude', '--room', 'cli-room'], { AGENT: 'gemini', CONCORD_ROOM_ID: 'env-room', CONCORD_URL: 'http://env' });
  assert.equal(cfg.agent, 'claude');     // positional beats env AGENT
  assert.equal(cfg.roomId, 'cli-room');  // --room beats env CONCORD_ROOM_ID
  assert.equal(cfg.url, 'http://env');   // env used when no flag
});

test('resolveConfig: env used when no flags; name defaults to agent', () => {
  const cfg = resolveConfig([], { AGENT: 'codex' });
  assert.equal(cfg.agent, 'codex');
  assert.equal(cfg.name, 'codex');
  assert.equal(cfg.roomId, null);        // room is optional → null triggers web handoff
});

test('resolveConfig: bare defaults', () => {
  const cfg = resolveConfig([], {});
  assert.equal(cfg.agent, 'claude');
  assert.equal(cfg.url, 'https://concord.fenginwind.com');
  assert.equal(cfg.roomId, null);
  assert.equal(cfg.cwd, null);           // caller fills with process.cwd()
});

test('resolveConfig: room id can be the 2nd positional (concord join <agent> <room>)', () => {
  assert.equal(resolveConfig(['claude', 'room-xyz'], {}).roomId, 'room-xyz');                  // bare positional room
  assert.equal(resolveConfig(['claude', 'room-xyz'], {}).agent, 'claude');                     // 1st positional stays the agent
  assert.equal(resolveConfig(['claude', 'pos', '--room', 'flag'], {}).roomId, 'flag');         // --room wins over positional
  assert.equal(resolveConfig(['claude', 'pos'], { CONCORD_ROOM_ID: 'env' }).roomId, 'pos');    // explicit positional beats env
});

test('resolveConfig: --name and --public-url honored', () => {
  const cfg = resolveConfig(['claude', '--name', 'backend', '--public-url', 'https://x.dev'], {});
  assert.equal(cfg.name, 'backend');
  assert.equal(cfg.publicUrl, 'https://x.dev');
});

test('classifyInbound: wake = addressed intent; defer = ambient; skip = own echo', async () => {
  const { classifyInbound } = await import('./cli.mjs');
  const me = '评审';
  // skip: my own echo
  assert.equal(classifyInbound({ sender: me, senderType: 'agent', mentions: [] }, me), 'skip');
  assert.equal(classifyInbound(null, me), 'skip');
  // wake: @-mentions me (agent or human), case-insensitive
  assert.equal(classifyInbound({ sender: 'alice', senderType: 'agent', content: '@评审 看下这个', mentions: ['评审'] }, me), 'wake');
  assert.equal(classifyInbound({ sender: 'Tom', senderType: 'human', content: '@评审 上', mentions: ['评审', 'alice'] }, me), 'wake');
  // wake: human broadcast with no mentions
  assert.equal(classifyInbound({ sender: 'Tom', senderType: 'human', content: '大家停一下', mentions: [] }, me), 'wake');
  // defer: agent broadcast (status chatter) — the echo-loop killer
  assert.equal(classifyInbound({ sender: 'alice', senderType: 'agent', content: '待命中。', mentions: [] }, me), 'defer');
  // defer: addressed to someone else (human or agent)
  assert.equal(classifyInbound({ sender: 'Tom', senderType: 'human', content: '@alice 你来', mentions: ['alice'] }, me), 'defer');
  assert.equal(classifyInbound({ sender: 'bob', senderType: 'agent', content: '@alice 交接', mentions: ['alice'] }, me), 'defer');
  // defer: system notices (context, no wake)
  assert.equal(classifyInbound({ sender: 'system', senderType: 'system', content: '[FILE] x uploaded a.zip' }, me), 'defer');
  // fallback without server-resolved mentions: text scan
  assert.equal(classifyInbound({ sender: 'alice', senderType: 'agent', content: '@评审 请看' }, me), 'wake');
  assert.equal(classifyInbound({ sender: 'Tom', senderType: 'human', content: '@alice 你来' }, me), 'defer');
  assert.equal(classifyInbound({ sender: 'Tom', senderType: 'human', content: '直接说事' }, me), 'wake');
});

test('resolveConfig: token budget is a CLI param (flag > env > unset)', () => {
  const cfg = resolveConfig(['claude', '--room', 'r', '--budget', '50000'], {});
  assert.equal(cfg.budget, '50000');
  // flag overrides env
  assert.equal(resolveConfig(['claude', '--budget', '9000'], { AGENT_TOKEN_BUDGET: '1' }).budget, '9000');
  // env fallback when no flag
  assert.equal(resolveConfig(['claude'], { AGENT_TOKEN_BUDGET: '1234' }).budget, '1234');
  // unset → null (unlimited)
  assert.equal(resolveConfig(['claude'], {}).budget, null);
});
