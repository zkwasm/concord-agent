#!/usr/bin/env node
// `concord` — host coding agents in Concord rooms via the stdio supervisor.
// Subcommands manage background (daemon) supervisors registered in ~/.concord.
//
//   concord join <agent>   host an agent into a Concord room (web / multi-agent), progress OFF
//   concord host <agent>   join + your own IM bot (personal mode), progress ON
//   concord list|status|logs|stop|restart|rm|prune    lifecycle
//
// Clean reclamation: `stop` reaps BOTH the supervisor and the ACP adapter process
// GROUP (whose pgid the supervisor records in its state file), confirming the whole
// tree is dead before reporting success; `prune` sweeps orphaned adapter groups
// left by a crashed supervisor. No orphan token-burn. See reclaim.mjs.
import { spawn } from 'node:child_process';
import { openSync, createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, parseArgs } from './cli.mjs';
import { openRegistry, newId } from './hosts.mjs';
import { stopHost, reapPid } from './reclaim.mjs';
import { obtainRoomId } from './handoff.mjs';
import { saveCreds, removeCreds, loadCreds } from './creds.mjs';

const SUPERVISOR = fileURLToPath(new URL('./acp-bridge.mjs', import.meta.url));
const reg = openRegistry();

const USAGE = `concord — host coding agents in Concord rooms (stdio supervisor)

Usage:
  concord join <agent> [--room <id>] [--cwd .] [--budget N] [--fg]
      Host a coding agent into a Concord room (web / multi-agent). Progress OFF.
      No --room → opens a browser to create/pick one, then starts.
  concord host <agent> [--room <id>] [--cwd .] [--budget N] [--fg]
      join + connect your own IM bot (personal mode). Progress ON.
  concord login lark|feishu --app-id <id> [--app-secret <s>]   Store your own bot creds (0600)
  concord logout [lark|feishu]       Remove stored creds
  concord list                       List hosted agents
  concord status <id>                Detail for one host
  concord logs <id> [-f]             View a host's output (-f to follow)
  concord stop <id>                  Stop + clean reclaim (SIGTERM → kills the agent group)
  concord restart <id>               Stop then start again with the same config
  concord budget <id> [--reset]      Show token usage / clear a budget pause
  concord resume <id>                Clear a budget pause (accept tasks again)
  concord rm <id> | prune            Remove a stopped entry / drop dead ones
  concord help

Hosts run in the background by default (-d implied); pass --fg to stay foreground.
agent: claude | gemini | codex | cursor | copilot | …  (default: claude)`;

const die = (m) => { console.error('✗ ' + m); process.exit(1); };
const kill = (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } };
const shortRoom = (r) => (r ? r.slice(0, 8) : '-');
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

// Build the supervisor argv from saved fields (used by start + restart).
function buildSupArgs(f) {
  const a = [SUPERVISOR, f.agent, '--room', f.room, '--cwd', f.cwd, '--url', f.url];
  if (f.budget) a.push('--budget', String(f.budget));
  if (f.budgetWindowHours) a.push('--budget-window-hours', String(f.budgetWindowHours));
  return a;
}

function spawnDaemon(id, f, { fg }) {
  const env = { ...process.env, STORE_PATH: reg.statePath(id), ACP_PROGRESS: f.mode === 'host' ? '1' : '0' };
  const supArgs = buildSupArgs(f);
  if (fg) {
    reg.register({ id, ...f });
    const child = spawn(process.execPath, supArgs, { stdio: 'inherit', env });
    reg.update(id, { pid: child.pid });
    child.on('close', () => reg.update(id, { pid: null, stopped: true }));
    return child.pid;
  }
  mkdirSync(reg.hostDir(id), { recursive: true });   // ensure the host dir exists before opening its log
  const logPath = join(reg.hostDir(id), 'log');
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, supArgs, { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  reg.register({ id, ...f, pid: child.pid, log: logPath });
  return child.pid;
}

async function startHost(mode, args) {
  const cfg = resolveConfig(args, process.env);
  const fg = args.includes('--fg');
  const cwd = cfg.cwd || process.cwd();
  // Resolve the room in the FOREGROUND (the user is present at start) — a detached
  // daemon can't drive a browser. Then the daemon gets a concrete --room.
  let room = cfg.roomId;
  if (!room) { room = await obtainRoomId(cfg.publicUrl || cfg.url); console.log('  → room connected.'); }

  const id = newId(cfg.agent);
  const f = {
    agent: cfg.agent, mode, room, cwd, url: cfg.url,
    budget: cfg.budget || null, budgetWindowHours: cfg.budgetWindowHours || null,
  };
  const pid = spawnDaemon(id, f, { fg });
  if (!fg) console.log(`✓ ${mode} started — id ${id} · pid ${pid} · agent ${cfg.agent} · room ${shortRoom(room)}\n  concord logs ${id}   ·   concord stop ${id}`);
}

function listHosts() {
  const hosts = reg.list();
  if (!hosts.length) { console.log('(no hosted agents — `concord host <agent>` or `concord join <agent>`)'); return; }
  console.log('ID                 AGENT    MODE  ROOM      STATUS    PID     UP');
  for (const h of hosts) {
    const status = h.stopped ? 'stopped' : h.alive ? 'running' : 'crashed';
    console.log(
      `${h.id.padEnd(18)} ${(h.agent || '').padEnd(8)} ${(h.mode || '').padEnd(5)} ${shortRoom(h.room).padEnd(9)} ${status.padEnd(9)} ${String(h.pid || '-').padEnd(7)} ${h.started ? ago(h.started) : '-'}`,
    );
  }
}

function statusHost(id) {
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  const alive = h.pid ? kill(h.pid, 0) : false;
  console.log(`id      ${h.id}
agent   ${h.agent}    mode ${h.mode}
status  ${h.stopped ? 'stopped' : alive ? 'running' : 'crashed'}    pid ${h.pid || '-'}    up ${h.started ? ago(h.started) : '-'}
room    ${h.room}
url     ${h.url}
cwd     ${h.cwd}
state   ${reg.statePath(h.id)}
budget  ${h.budget ? `${h.budget} fresh tok / ${h.budgetWindowHours || 24}h` : 'unlimited'}
logs    concord logs ${h.id}`);
}

function logsHost(id, follow) {
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  const logPath = h.log || join(reg.hostDir(id), 'log');
  const s = createReadStream(logPath, { encoding: 'utf8' });
  s.on('error', () => die(`no logs for ${id} (foreground host? check the terminal it runs in)`));
  s.pipe(process.stdout);
  if (follow) {
    // naive follow: re-open and tail new bytes
    let size = 0;
    s.on('data', (c) => { size += Buffer.byteLength(c); });
    s.on('end', () => {
      setInterval(() => {
        const t = createReadStream(logPath, { encoding: 'utf8', start: size });
        t.on('data', (c) => { process.stdout.write(c); size += Buffer.byteLength(c); });
        t.on('error', () => {});
      }, 1000);
    });
  }
}

// The supervisor records the ACP adapter's process-group pgid in its state file
// (so we can reap the group even if the supervisor died without cleanup).
function readAdapterPid(id) {
  try { return JSON.parse(readFileSync(reg.statePath(id), 'utf8')).adapterPid ?? null; } catch { return null; }
}

async function stopHostCmd(id, { silent } = {}) {
  const h = reg.get(id);
  if (!h) { if (!silent) die(`no such host: ${id}`); return; }
  const { steps } = await stopHost({ ...h, adapterPid: readAdapterPid(id) }, { kill });
  reg.update(id, { pid: null, stopped: true, stoppedAt: Date.now() });
  if (!silent) console.log(`✓ stopped ${id} — reclaim: ${steps.join(' → ') || '(none)'}`);
}

async function restartHost(id) {
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  await stopHostCmd(id, { silent: true });   // now waits until the whole tree is dead
  const pid = spawnDaemon(id, { ...h, pid: undefined, stopped: false }, { fg: false });
  reg.update(id, { stopped: false });
  console.log(`✓ restarted ${id} — new pid ${pid}`);
}

async function prune() {
  // Crash-path safety: a supervisor that died without running its shutdown handler
  // leaves its detached ACP adapter group orphaned (reparented to init, still
  // burning tokens). Reap any such orphan whose supervisor pid is gone but whose
  // recorded adapter pgid is still alive, BEFORE dropping the dead registry entries.
  const reaped = [];
  for (const h of reg.list()) {
    if (h.alive) continue;                       // supervisor still running → leave it
    const apid = readAdapterPid(h.id);
    if (apid && kill(apid, 0)) { await reapPid(apid, { kill, group: true }); reaped.push(h.id); }
  }
  const dead = reg.pruneDead();
  const parts = [];
  if (reaped.length) parts.push(`reaped orphan agents: ${reaped.join(', ')}`);
  parts.push(dead.length ? `pruned dead: ${dead.join(', ')}` : 'no dead entries');
  console.log('✓ ' + parts.join(' · '));
}

// Clear a budget pause on a running host (SIGUSR1 — the daemon resets its window).
function resumeHost(id) {
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (!h.pid || !kill(h.pid, 'SIGUSR1')) die(`host ${id} is not running`);
  console.log(`✓ resumed ${id} — budget window reset, accepting tasks again`);
}

function budgetCmd(id, args) {
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (args.includes('--reset')) return resumeHost(id);
  let u = { fresh: 0, cached: 0, turns: 0 };
  try { u = JSON.parse(readFileSync(reg.statePath(id), 'utf8')).rooms?.[h.room]?.usage || u; } catch { /* no usage yet */ }
  const cap = h.budget ? `${h.budget} fresh tok / ${h.budgetWindowHours || 24}h` : 'unlimited';
  console.log(`budget  ${cap}\nused    fresh ${u.fresh} · cache-read ${u.cached} · ${u.turns || 0} turns\n(reset: concord budget ${id} --reset  or  concord resume ${id})`);
}

// Store this user's OWN IM bot creds locally (0600). Secret via --app-secret or,
// to keep it out of shell history, piped on stdin.
async function login(args) {
  const { flags, positional } = parseArgs(args);
  const platform = positional[0];
  if (!['lark', 'feishu'].includes(platform)) die('usage: concord login lark|feishu --app-id <id> [--app-secret <secret>]');
  const appId = flags['app-id'];
  let appSecret = flags['app-secret'];
  if (!appId) die('--app-id is required');
  if (!appSecret && !process.stdin.isTTY) appSecret = readFileSync(0, 'utf8').trim();   // piped: `… | concord login`
  if (!appSecret) die('--app-secret is required (or pipe it on stdin to keep it out of history)');
  saveCreds(platform, { appId, appSecret, domain: platform });
  console.log(`✓ saved ${platform} credentials for app ${appId} → ~/.concord/creds.json (0600)`);
}
function logout(args) {
  const platform = args[0];
  if (platform) { console.log(removeCreds(platform) ? `✓ removed ${platform} credentials` : `(no ${platform} credentials)`); return; }
  for (const p of Object.keys(loadCreds())) removeCreds(p);
  console.log('✓ removed all stored credentials');
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'join': case 'host': await startHost(cmd, rest); break;
  case 'login': await login(rest); break;
  case 'logout': logout(rest); break;
  case 'list': case 'ls': listHosts(); break;
  case 'status': rest[0] ? statusHost(rest[0]) : die('usage: concord status <id>'); break;
  case 'logs': rest[0] ? logsHost(rest[0], rest.includes('-f') || rest.includes('--follow')) : die('usage: concord logs <id> [-f]'); break;
  case 'stop': rest[0] ? await stopHostCmd(rest[0]) : die('usage: concord stop <id>'); break;
  case 'restart': rest[0] ? await restartHost(rest[0]) : die('usage: concord restart <id>'); break;
  case 'rm': rest[0] ? (reg.unregister(rest[0], { removeState: true }), console.log(`✓ removed ${rest[0]}`)) : die('usage: concord rm <id>'); break;
  case 'prune': await prune(); break;
  case 'resume': rest[0] ? resumeHost(rest[0]) : die('usage: concord resume <id>'); break;
  case 'budget': rest[0] ? budgetCmd(rest[0], rest.slice(1)) : die('usage: concord budget <id> [--reset]'); break;
  case undefined: case 'help': case '-h': case '--help': console.log(USAGE); break;
  default: console.error(`unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1);
}
