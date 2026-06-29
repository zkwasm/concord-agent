// Regression e2e: obtainRoomId must NOT keep the process alive after the room
// arrives. The old code left a 5-minute watchdog `setTimeout` un-cleared, so the
// CLI hung ~5 min after the user picked a room in the browser ("stuck waiting").
// The child below never calls process.exit — so it can only exit if the event loop
// drains on its own (no lingering ref'd timer). Run: node --test src/handoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const HANDOFF = new URL('./handoff.mjs', import.meta.url).pathname;

test('obtainRoomId lets the process exit promptly once the room callback fires', async () => {
  const code = `
    import { obtainRoomId } from ${JSON.stringify(HANDOFF)};
    process.env.ACP_NO_BROWSER = '1';
    let cb = null;
    const p = obtainRoomId('http://x.test', { log: (m) => { const mm = /cli=([^\\s]+)/.exec(m); if (mm) cb = decodeURIComponent(mm[1]); } });
    await new Promise((r) => setTimeout(r, 100));
    await fetch(cb + '&room=R1');
    const r = await p;
    if (r !== 'R1') { console.error('wrong room: ' + r); process.exit(3); }
    // intentionally NO process.exit — a lingering watchdog timer would hang us here.
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  const result = await Promise.race([
    new Promise((res) => child.on('exit', (c) => res(c))),
    new Promise((res) => setTimeout(() => res('TIMEOUT'), 5000)),
  ]);
  if (result === 'TIMEOUT') { child.kill('SIGKILL'); assert.fail('obtainRoomId left the event loop alive — the 5-min watchdog regressed'); }
  assert.equal(result, 0, 'child should exit cleanly once the room callback fires');
});
