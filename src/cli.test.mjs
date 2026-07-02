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

test('shouldRelayInbound: humans/agents wake it; own echoes and system notices never do', async () => {
  const { shouldRelayInbound } = await import('./cli.mjs');
  assert.equal(shouldRelayInbound({ sender: 'Tom', senderType: 'human' }, 'claude-1698'), true);
  assert.equal(shouldRelayInbound({ sender: '工程师', senderType: 'agent' }, 'claude-1698'), true);
  assert.equal(shouldRelayInbound({ sender: 'claude-1698', senderType: 'agent' }, 'claude-1698'), false);  // own echo
  assert.equal(shouldRelayInbound({ sender: 'system', senderType: 'system', content: '[FILE] claude-1698 uploaded x.zip' }, 'claude-1698'), false);  // ambient notice
  assert.equal(shouldRelayInbound({ sender: 'system' }, 'claude-1698'), false);   // senderType missing → sender fallback
  assert.equal(shouldRelayInbound(null, 'claude-1698'), false);
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
