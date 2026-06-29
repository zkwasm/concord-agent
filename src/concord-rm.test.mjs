// Regression e2e for the `concord rm` orphan bug (token/memory safety): rm on a
// RUNNING host MUST reclaim the process FIRST, then forget it — never leave a live
// token/memory-burning orphan. The old rm just unregistered + deleted state, orphaning
// the whole agent group AND discarding the pids needed to ever reap it.
//
// We register a host whose `pid` is a real `sleep` process (no adapter pid → the
// adapter-group reap is a no-op here; that group-kill path is covered by
// reclaim.test.mjs). Running the real CLI `concord rm <id>` must kill the sleep and
// drop the registry entry. Run: node --test src/concord-rm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openRegistry } from './hosts.mjs';

const CONCORD = new URL('./concord.mjs', import.meta.url).pathname;

test('concord rm on a RUNNING host kills the process before removing it (no orphan)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'concord-rm-'));
  const proc = spawn('sleep', ['300'], { stdio: 'ignore' });   // stand-in "bridge" that stays alive until signalled
  // Node reaps the child on its own SIGCHLD → 'exit' fires once it's truly gone (no zombie ambiguity).
  const exited = new Promise((resolve) => proc.on('exit', () => resolve(true)));
  try {
    await new Promise((r) => setTimeout(r, 50));               // let sleep actually start
    assert.equal(proc.killed, false);

    const reg = openRegistry(home);
    const id = 'claude-test01';
    reg.register({ id, agent: 'claude', mode: 'join', room: 'r', cwd: '.', url: 'http://x', pid: proc.pid });
    assert.ok(reg.get(id), 'host registered');

    // the real CLI, against an isolated CONCORD_HOME
    const res = spawnSync(process.execPath, [CONCORD, 'rm', id], { env: { ...process.env, CONCORD_HOME: home }, encoding: 'utf8' });
    assert.equal(res.status, 0, 'rm should exit 0 — stderr:\n' + res.stderr);

    const didExit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 6000))]);
    assert.equal(didExit, true, 'rm MUST have killed the running process before removing it (no orphan)');
    assert.equal(reg.get(id), null, 'registry entry removed after reclaim');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    rmSync(home, { recursive: true, force: true });
  }
});
