// Browser room-creation handoff, shared by the supervisor and the `concord` CLI.
// No --room → open the web connect page (user logs in + creates/picks a room), the
// room id comes back over a one-shot loopback callback. The CLI never holds creds:
// the browser does the authenticated create, and the returned room id is itself the
// agent-REST bearer.
//
// Security: a one-time nonce binds the callback to THIS process. Without it, any
// local process / malicious page could POST room=ATTACKER to the loopback and win
// the race, attaching the agent to a room it controls (review finding).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function openBrowser(url) {
  if (process.env.ACP_NO_BROWSER) return;   // headless/test: just print the URL
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); }
  catch { /* user can click the printed URL instead */ }
}

export function obtainRoomId(publicUrl, { log = console.log } = {}) {
  const nonce = randomUUID();
  return new Promise((resolve, reject) => {
    let timer;
    const server = createServer((req, res) => {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      if (q.get('nonce') !== nonce) { res.writeHead(403).end('bad nonce'); return; }   // reject forged callbacks
      const roomId = q.get('room');
      if (!roomId) { res.writeHead(400).end('missing room'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center"><div>✓ Room connected. Close this tab and return to the terminal.</div></body>');
      server.close();
      clearTimeout(timer);          // got the room → cancel the watchdog so it can't keep the CLI alive (the "hangs after selecting" bug)
      resolve(roomId);
    });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    server.listen(0, '127.0.0.1', () => {
      const cb = `http://127.0.0.1:${server.address().port}/cb?nonce=${nonce}`;
      const url = `${publicUrl}/im/connect?cli=${encodeURIComponent(cb)}`;
      log('\n  No room id given — opening your browser to pick/create one:');
      log(`  ${url}`);
      log("  (If it doesn't open, paste that URL into your browser.)\n");
      openBrowser(url);
    });
    timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for room selection (5 min)')); }, 5 * 60 * 1000);
    timer.unref();   // belt-and-suspenders: even if never cleared, the watchdog must never block process exit
  });
}
