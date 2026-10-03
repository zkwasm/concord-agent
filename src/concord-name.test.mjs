import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./concord.mjs', import.meta.url));

test('join/host reject invalid names without starting or registering a host', () => {
  for (const mode of ['join', 'host']) {
    for (const [flags, extraEnv] of [
      [['--name', '@Reviewer'], {}],
      [['--as', '@Reviewer'], {}],
      [[], { AGENT_NAME: '@Reviewer' }],
      [['--name'], {}],
    ]) {
      const home = mkdtempSync(join(tmpdir(), 'concord-name-'));
      try {
        // A nonexistent runtime makes the ordering observable: name validation
        // must happen before even the agent-install check, let alone a join.
        const result = spawnSync(process.execPath,
          [cli, mode, 'concord-nonexistent-test-agent', 'test-room', ...flags], {
            env: { ...process.env, CONCORD_HOME: home, AGENT_NAME: '', CONCORD_LABEL: '', ...extraEnv },
            encoding: 'utf8', timeout: 5000,
          });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /[Aa]gent name/);
        assert.doesNotMatch(result.stdout, /started|joined/);
        assert.deepEqual(readdirSync(home), [], 'must not create a host or registry');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
});
