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
import { openSync, createReadStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { resolveConfig, parseArgs } from './cli.mjs';
import { openRegistry, newId } from './hosts.mjs';
import { stopHost, reapAdapterGroup, procStart } from './reclaim.mjs';
import { obtainRoomId } from './handoff.mjs';
import { saveCreds, removeCreds, loadCreds, getCreds } from './creds.mjs';
import { openBindings } from './im-bindings.mjs';
import { fetchRoomName } from './room-meta.mjs';
import { suggestNames } from './naming.mjs';
import { ownerAction } from './owner-lifecycle.mjs';
import { overallHeadline, bindingVerdict, bindingNextAction } from './im-health.mjs';

const IM_PLATFORMS = ['lark', 'feishu'];

const SUPERVISOR = fileURLToPath(new URL('./acp-bridge.mjs', import.meta.url));
const OWNER = fileURLToPath(new URL('./im-owner.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const reg = openRegistry();

const USAGE = `concord — host coding agents in Concord rooms (stdio supervisor)

Usage:
  concord join <agent> [room] [--cwd .] [--budget N] [--as label] [--fg]
      Host a coding agent into a Concord room (web / multi-agent). Progress OFF.
      No room → opens a browser to create/pick one, then starts. (or --room <id>)
  concord host <agent> [room] [--cwd .] [--budget N] [--as label] [--im lark|feishu] [--fg]
      join + connect your own IM bot (personal mode). Progress ON. Talk to the agent
      from Lark/Feishu — private chat (no @) or @-mention in a group. --im picks the
      platform; omit it if exactly one is logged in (concord login). No creds → room-only.
  concord im [stop|status|logs]      IM owner: owns your bot + relays bound chats (one per bot)
  concord host <agent> --bind <chat_id> [--budget N] [--force]
      Bind an IM chat (sent /concord-bind there) to a fresh agent; the owner routes it here.
  concord login lark|feishu --qr [--new|--force]  Scan a QR to create + log in the bot. With existing creds: default reuses,
                                                   --new builds a fresh app, --force re-scans to update the existing one.
  concord login lark|feishu --app-id <id> [--app-secret <s>]   Store your own bot creds manually (0600)
  concord logout [lark|feishu]       Remove stored creds
  concord list                       List hosted agents (room name · what each is doing · status)
  concord status <id>                Detail for one host (activity, IM binding, dashboard link)
  concord logs <id> [-f]             View a host's output (-f to follow)
  concord open <id>                  Open the host's room in your browser (dashboard)
  concord label <id> <label>         Give a host a memorable name (usable anywhere an id is expected)
  concord bindings                   List IM chat → room bindings (with health)
  concord stop <id> [--yes]          Stop + clean reclaim (--yes skips the working-agent prompt)
  concord restart <id> [--yes]       Stop then start again with the same config
  concord budget <id> [--reset]      Show cumulative token usage / reset the counter (--reset)
  concord resume <id>                Clear a timeout pause (accept tasks again; token meter kept)
  concord rm <id> [--yes] | prune    Stop + reclaim (if running) then remove an entry / drop dead ones
  concord shutdown                   Stop EVERYTHING (owner + agents) but KEEP configs + bindings (reversible)
  concord up                         Bring the whole fleet back after shutdown (bots need no re-binding)
  concord reset [--yes]              Hard wipe: stop all + delete configs + clear bindings (bots must re-bind; keeps login)
  concord version                    Show the concord-agent version (also -v / --version)
  concord help

Hosts run in the background by default (-d implied); pass --fg to stay foreground.
Server: https://concord.fenginwind.com by default; --url http://localhost:3001 (or CONCORD_URL) for self-hosted/dev.
agent: claude | gemini | codex | cursor | copilot | …  (default: claude)`;

const die = (m) => { console.error('✗ ' + m); process.exit(1); };
const kill = (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } };
// Interactive y/N confirmation (used before interrupting a WORKING agent). Resolves
// false in a non-TTY so scripts never hang — callers require --yes there instead.
function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// Interactive naming at join time (TTY only; --as / --name / AGENT_NAME skip it).
// A readable name is how humans in a multi-agent room decide who to @ and who
// gets which task — so a ONE-OFF headless agent (not the hosted one) reads the
// project dir + room purpose + who's already present and proposes role-style
// candidates; the human picks a number, types a free-form name, or hits Enter
// for the first suggestion. Asked ONCE per host — restarts / `concord up` reuse
// the persisted name and never re-ask.
async function pickAgentName({ dir, agentType, url, room }) {
  const { candidates } = await suggestNames({ dir, agentType, url, roomId: room, log: console.log });
  if (!candidates.length) return null;
  console.log('  给这个 agent 起个名字(它在房间里负责什么?):');
  candidates.forEach((c, i) => console.log(`    ${i + 1}. ${c}${i === 0 ? '   (回车默认)' : ''}`));
  const a = await ask('  name> ');
  if (!a) return candidates[0];
  const n = parseInt(a, 10);
  if (Number.isInteger(n) && n >= 1 && n <= candidates.length && String(n) === a) return candidates[n - 1];
  return a.replace(/\s+/g, '-').slice(0, 24);
}
const shortRoom = (r) => (r ? r.slice(0, 8) : '-');
// Display width: CJK / fullwidth glyphs take two terminal columns, so the list table
// pads by width (not string length) — otherwise a room named 「设计评审」 skews the row.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const dispWidth = (s) => { let w = 0; for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1; return w; };
const padCol = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispWidth(s)));
const truncWidth = (s, max) => { s = String(s); if (dispWidth(s) <= max) return s; let out = '', w = 0; for (const ch of s) { const cw = WIDE.test(ch) ? 2 : 1; if (w + cw > max - 1) break; w += cw; out += ch; } return out + '…'; };
// What `list`/`status` show for a room: the cached human name if we have one, else the
// short id, truncated to keep the table column aligned. Purely local — never a network read.
const roomLabel = (h) => truncWidth(h.roomName || shortRoom(h.room), 20);
// How the IM side of a binding reads in list/status: the resolved group name, else 私聊(shortid)
// for a p2p chat (Lark p2p has no title) — never the bare opaque oc_ id on its own.
const chatLabel = (bd, w = 14) => (bd.chatName ? truncWidth(bd.chatName, w) : `私聊(${truncWidth(bd.chatId, Math.max(6, w - 4))})`);
// Rooms served by a LIVE local agent (fresh pid check). The authoritative, always-current
// agent-presence for CLI displays — the owner's health snapshot only refreshes each reconcile
// (~45s), so a just-`stop`ped agent would still read "present" there. Same box as the agents.
const liveAgentRoomsLocal = () => new Set(reg.list().filter((h) => h.mode !== 'im' && !h.stopped && h.alive && h.room).map((h) => h.room));
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

// Build the supervisor argv from saved fields (used by start + restart).
function buildSupArgs(f) {
  const a = [SUPERVISOR, f.agent, '--room', f.room, '--cwd', f.cwd, '--url', f.url];
  if (f.budget) a.push('--budget', String(f.budget));
  return a;
}

// Pick the IM platform for `concord host` (`join` is room-only). Explicit --im wins;
// else auto-use the single logged-in platform; multiple → require --im; none → room-only.
// The secret is NOT passed via env/argv — the bridge reads ~/.concord/creds.json (0600).
function resolveImPlatform(cfg, mode) {
  if (mode !== 'host') return null;
  if (cfg.im) {
    if (!IM_PLATFORMS.includes(cfg.im)) die(`--im must be one of: ${IM_PLATFORMS.join(' | ')}`);
    if (!getCreds(cfg.im)) die(`no ${cfg.im} credentials.\n  Easiest:   concord login ${cfg.im} --qr     (scan a QR in the app, no developer console)\n  Manual:    concord login ${cfg.im} --app-id <id> --app-secret <secret>`);
    return cfg.im;
  }
  const loggedIn = IM_PLATFORMS.filter((p) => getCreds(p));
  if (loggedIn.length === 1) return loggedIn[0];
  if (loggedIn.length > 1) die(`multiple IM platforms logged in (${loggedIn.join(', ')}) — pick one with --im lark|feishu`);
  return null;   // none logged in → host runs room-only
}

function spawnDaemon(id, f, { fg }) {
  // host (incl. --bind) → progress ON so the IM chat sees the agent working, not just the
  // final reply; join (web/multi-agent) → OFF. A bound host posts progress to the ROOM and
  // the `concord im` owner relays it on (im=null here — the owner owns the single bot conn).
  // CONCORD_HOST_ID: lets the bridge derive its 409-fallback room name from the SAME
  // suffix `concord list` shows (claude-a1b2c3), so the CLI id and the room roster
  // name line up instead of two unrelated numbers.
  const env = { ...process.env, STORE_PATH: reg.statePath(id), CONCORD_HOST_ID: id, ...(f.name ? { AGENT_NAME: f.name } : {}), ACP_PROGRESS: f.mode === 'host' ? '1' : '0', ACP_IM: f.im || '' };
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

// Is the agent's CLI on PATH? The ACP adapter bundles its OWN agent runtime (the
// big npx download), but it reads the user's `~/.<agent>/` credentials from a normal
// install — so if the CLI isn't on PATH the user almost certainly hasn't logged in,
// and we'd silently spend 250MB + minutes only to fail authenticating. Cheaper to
// check up front and tell the user how to install it. Pure PATH scan, no spawn.
const AGENT_INSTALL_HINT = {
  claude: 'npm i -g @anthropic-ai/claude-code   (then run `claude` once to log in)',
  gemini: 'npm i -g @google/gemini-cli           (then run `gemini` once to log in)',
  codex:  'npm i -g @openai/codex                (then run `codex` once to log in)',
};
function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of (process.env.PATH || '').split(delimiter)) {
    if (!d) continue;
    for (const e of exts) if (existsSync(join(d, name + e))) return join(d, name + e);
  }
  return null;
}

async function startHost(mode, args) {
  const cfg = resolveConfig(args, process.env);
  // A malformed --budget must NEVER silently coerce to "unlimited" (parseInt('abc')→0).
  // Reject it loudly at the entry point so the user sees the typo instead of an
  // unguarded agent. Unset is the documented default (unlimited).
  if (cfg.budget != null && !/^[1-9]\d*$/.test(String(cfg.budget).trim())) {
    die(`--budget must be a positive integer (got "${cfg.budget}"). Omit it for no cap; a malformed value won't be treated as unlimited.`);
  }
  // Fail fast if the chosen agent's CLI isn't installed — bypass with --no-agent-check
  // (or CONCORD_NO_AGENT_CHECK=1) for non-PATH installs / wrappers.
  if (!args.includes('--no-agent-check') && process.env.CONCORD_NO_AGENT_CHECK !== '1') {
    if (!findOnPath(cfg.agent)) {
      const hint = AGENT_INSTALL_HINT[cfg.agent] || `install the ${cfg.agent} CLI and run it once to log in`;
      die(`\`${cfg.agent}\` CLI not found on PATH.\n\nconcord-agent drives your local ${cfg.agent} CLI (it uses your existing login). Install it first:\n  ${hint}\n\nThen re-run this command. If you already have it installed in a non-standard location, pass --no-agent-check to skip this check.`);
    }
  }
  const fg = args.includes('--fg');
  const cwd = cfg.cwd || process.cwd();
  // Resolve the room in the FOREGROUND (the user is present at start) — a detached
  // daemon can't drive a browser. Then the daemon gets a concrete --room.
  let room = cfg.roomId;
  if (!room) { room = await obtainRoomId(cfg.publicUrl || cfg.url); console.log('  → room connected.'); }

  // --bind only: a bot chat can be served by ONE agent, and a second agent can't take over
  // the same bot — so if a live LOCAL agent already serves this room, binding another chat to
  // it should REUSE that agent (just add the binding), not spawn a duplicate. Default = reuse
  // (Enter). --new-agent forces a fresh one; --reuse skips the prompt. (Plain join/host into a
  // shared room stays multi-agent — no prompt.)
  if (cfg.bind) {
    const servedBy = reg.list().find((h) => h.mode !== 'im' && h.room === room && h.alive);
    if (servedBy) {
      const startNew = args.includes('--new-agent') ? true : args.includes('--reuse') ? false
        : await confirm(`room ${shortRoom(room)} 已有活 agent ${servedBy.id}。新起一个独立 agent(不复用)?`);
      if (!startNew) {
        const platform = resolveImPlatform(cfg, 'host');
        if (!platform) die('--bind needs a logged-in IM platform — `concord login lark --qr`.');
        const res = openBindings().bind(platform, cfg.bind, { roomId: room, agent: servedBy.agent, cwd: servedBy.cwd }, { force: cfg.force });
        if (!res.ok) die(`chat ${cfg.bind} is already bound to room ${shortRoom(res.existing.roomId)} — add --force to rebind`);
        console.log(`✓ 复用 ${servedBy.id}(room ${shortRoom(room)})· 绑定 ${platform} chat ${cfg.bind} → 同一房间。owner 会把消息转发给它。`);
        return;
      }
    }
  }

  // --bind: record a chat→room binding so the `concord im` owner relays this chat here.
  // Bound agents run progress ON (the owner relays the progress + reply from the room) and
  // do NOT own the bot (im=null) — the owner owns the single WSClient.
  let bound = false;
  if (cfg.bind) {
    const platform = resolveImPlatform(cfg, 'host');
    if (!platform) die('--bind needs a logged-in IM platform — easiest: `concord login lark --qr` (scan a QR; no developer console). Or use `--app-id`/`--app-secret`.');
    const res = openBindings().bind(platform, cfg.bind, { roomId: room, agent: cfg.agent, cwd }, { force: cfg.force });
    if (!res.ok) die(`chat ${cfg.bind} is already bound to room ${shortRoom(res.existing.roomId)} — add --force to rebind`);
    bound = true;
    const owner = reg.list().find((h) => h.mode === 'im' && h.platform === platform && h.alive);
    console.log(`✓ bound ${platform} chat ${cfg.bind} → room ${shortRoom(room)}${owner ? '' : '\n  ⚠️ no `concord im` owner running — start it (`concord im`) so this chat actually routes.'}`);
  }

  const im = bound ? null : resolveImPlatform(cfg, mode);
  const id = newId(cfg.agent);
  // Cache the human room name now — we're online and the user is present — so later
  // `concord list`/`status` can show it with zero network. Best-effort: '' on failure,
  // and list/status fall back to the short room id.
  const roomName = await fetchRoomName(cfg.url, room);
  // Room display name: explicit --as/--name wins; otherwise, with a human at the
  // terminal, run the one-off headless naming flow. Non-TTY (scripts, revive)
  // keeps the plain agent default — never blocks.
  let name = cfg.label || (cfg.name && cfg.name !== cfg.agent ? cfg.name : null);
  if (!name && process.stdin.isTTY && process.stdout.isTTY) {
    try { name = await pickAgentName({ dir: cwd, agentType: cfg.agent, url: cfg.url, room }); }
    catch { /* naming is a nicety — never block the start */ }
    if (name) console.log(`  ✓ 将以「${name}」加入房间`);
  }
  const f = {
    agent: cfg.agent, mode, room, cwd, url: cfg.url, im, bound,
    ...(roomName ? { roomName } : {}),
    ...(name ? { name, label: cfg.label || name } : {}),
    budget: cfg.budget || null,
  };
  const pid = spawnDaemon(id, f, { fg });
  if (!fg) console.log(`✓ ${mode} started — id ${id} · pid ${pid} · agent ${cfg.agent} · room ${shortRoom(room)}${im ? ` · im ${im}` : ''}\n  concord logs ${id}   ·   concord stop ${id}`);
}

function listHosts() {
  const hosts = reg.list();
  if (!hosts.length) { console.log('(no hosted agents — `concord host <agent>` or `concord join <agent>`)'); return; }
  // One formatter for header AND rows so the (now wider) ROOM column stays aligned. The IM
  // column (last) answers "which chat/bot is this agent hooked to" in one glance (Tom's ask).
  const row = (c) => `${padCol(c[0], 18)} ${padCol(c[1], 8)} ${padCol(c[2], 5)} ${padCol(c[3], 20)} ${padCol(c[4], 9)} ${padCol(c[5], 7)} ${padCol(c[6], 6)} ${padCol(c[7], 6)} ${c[8]}`;
  console.log(row(['NAME', 'AGENT', 'MODE', 'ROOM', 'STATUS', 'PID', 'UP', 'TOK', 'IM']));
  // Reverse index room → binding once, so each row shows its bound chat without re-scanning.
  const bindByRoom = {};
  for (const b of Object.values(openBindings().list())) bindByRoom[b.roomId] = b;
  for (const h of hosts) {
    const rt = readRuntime(h.id);
    // STATUS now tells you what the agent is DOING, not just whether the pid is alive:
    // working (mid-turn) / idle / paused (silently dropping) / crashed / stopped.
    const status = h.stopped ? 'stopped' : !h.alive ? 'crashed' : rt.paused ? 'paused' : rt.activity?.state === 'working' ? 'working' : 'idle';
    const u = readUsage(h.id, h.room);
    const tok = u ? String(u.fresh ?? 0) : '-';   // fresh tokens this window — a burner stands out at a glance
    const bd = bindByRoom[h.room];
    const im = bd ? `${bd.platform}·${chatLabel(bd)}` : '-';
    // NAME = the agent's actual in-room sender (what the roster shows), falling back
    // to the local label/id for hosts that haven't joined yet. `stop`/`status` still
    // accept label or id-prefix regardless of what's displayed.
    console.log(row([truncWidth(readSender(h.id, h.room) || h.label || h.id, 18), h.agent || '', h.mode || '', roomLabel(h), status, String(h.pid || '-'), h.started ? ago(h.started) : '-', tok, im]));
  }
}

function statusHost(id) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  const alive = h.pid ? kill(h.pid, 0) : false;
  const rt = readRuntime(h.id);
  const status = h.stopped ? 'stopped' : !alive ? 'crashed' : rt.paused ? 'paused' : rt.activity?.state === 'working' ? 'working' : 'idle';
  const lines = [];
  lines.push(`id      ${h.id}${h.label ? `    label ${h.label}` : ''}`);
  lines.push(`agent   ${h.agent}    mode ${h.mode}`);
  if (h.appId) lines.push(`app     ${h.appId}${h.platform ? ` · ${h.platform}` : ''}`);   // IM owner: which bot app it's connected to
  lines.push(`status  ${status}    pid ${h.pid || '-'}    up ${h.started ? ago(h.started) : '-'}`);
  // What it's doing right now / why it's paused / why it died — the legibility wins.
  if (alive && !h.stopped) {
    if (rt.paused) lines.push(`paused  ${rt.paused.reason} · ${ago(rt.paused.at)} ago  →  concord resume ${h.id}`);
    else if (rt.activity?.state === 'working') lines.push(`doing   ▶ ${rt.activity.label || '(working)'}  (${ago(rt.activity.at)})`);
    else if (rt.activity) lines.push(`doing   idle ${ago(rt.activity.at)}`);
  } else if (!h.stopped && rt.exit) {
    lines.push(`exit    ${rt.exit.reason} · ${ago(rt.exit.at)} ago`);
  }
  const sname = readSender(h.id, h.room);
  if (sname) lines.push(`name    ${sname}   (in-room sender — what the roster shows)`);
  lines.push(`room    ${h.roomName ? `${h.roomName}  ·  ${h.room}` : h.room}`);
  // The IM chat bound to this room (reverse lookup), so CLI and IM agree on what this host is.
  const binding = Object.values(openBindings().list()).find((b) => b.roomId === h.room);
  if (binding) lines.push(`im      ${binding.platform} · ${binding.chatName || binding.chatId}${binding.boundAt ? ` (bound ${ago(binding.boundAt)} ago)` : ''}`);
  lines.push(`web     ${h.url}/room/${h.room}`);          // open this exact room on the dashboard
  lines.push(`url     ${h.url}   (api base)`);
  lines.push(`cwd     ${h.cwd}`);
  lines.push(`state   ${reg.statePath(h.id)}`);
  lines.push(`budget  ${h.budget ? `${h.budget} fresh tok (lifetime cap)` : 'unlimited'}`);
  const u = readUsage(h.id, h.room);
  lines.push(`used    ${u ? `fresh ${u.fresh} · cache-read ${u.cached} · ${u.turns || 0} turns` : '(none yet)'}`);
  const cx = readContext(h.id, h.room);
  if (cx?.size) lines.push(`context ${Math.round(cx.used / 1000)}k / ${Math.round(cx.size / 1000)}k tokens in window`);
  lines.push(`logs    concord logs ${h.id}`);
  console.log(lines.join('\n'));
}

// Give a host a memorable handle. Stored as registry metadata; resolveId() then
// accepts it anywhere an id is expected (stop/status/logs/…).
function labelHost(id, label) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  reg.update(id, { label });
  console.log(`✓ labeled ${id} → "${label}"  (use it anywhere an id goes, e.g. concord stop ${label})`);
}

// `concord open <id>` — open this host's room on the dashboard. Best-effort OS opener;
// headless / no opener → just print the URL.
function openRoom(id) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  const url = `${h.url}/room/${h.room}`;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(opener, [url], { stdio: 'ignore', detached: true }).unref(); console.log(`✓ opening ${url}`); }
  catch { console.log(url); }
}

// `concord bindings` — the IM chat → room table (invisible until now without a JSON
// editor), cross-referenced against live hosts to flag orphaned bindings.
function listBindings() {
  const all = Object.values(openBindings().list());
  if (!all.length) { console.log('(no IM bindings — `concord host <agent> --bind <chat-id>`, or DM your bot after `concord login … --qr`)'); return; }
  const live = reg.list();
  const liveRooms = liveAgentRoomsLocal();
  const nameByRoom = new Map(live.filter((h) => h.roomName).map((h) => [h.room, h.roomName]));
  // Prefer the owner's end-to-end health verdict (connection→room), but override agent-presence
  // with the LIVE local check so a just-`stop`ped agent reads "no agent" now, not a snapshot tick
  // later; fall back to the local heuristic entirely when there's no snapshot (owner down).
  const verdictByChat = new Map();
  for (const p of IM_PLATFORMS) for (const sb of readHealth(p)?.bindings || []) verdictByChat.set(`${p}:${sb.chatId}`, bindingVerdict({ ...sb, agentState: liveRooms.has(sb.roomId) ? 'present' : 'absent' }));
  const row = (c) => `${padCol(c[0], 8)} ${padCol(c[1], 20)} ${padCol(c[2], 7)} ${padCol(c[3], 20)} ${padCol(c[4], 8)} ${c[5]}`;
  console.log(row(['PLATFORM', 'CHAT', 'TYPE', 'ROOM', 'AGENT', 'HEALTH']));
  for (const b of all) {
    const health = verdictByChat.get(`${b.platform}:${b.chatId}`) || (liveRooms.has(b.roomId) ? 'ok' : '⚠ no live host');
    console.log(row([b.platform || '-', truncWidth(b.chatName || b.chatId || '-', 20), b.chatType || '-', truncWidth(nameByRoom.get(b.roomId) || shortRoom(b.roomId), 20), b.agent || '-', health]));
  }
}

function logsHost(id, follow) {
  id = resolveId(id);
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

// The supervisor records the ACP adapter's pgid + its start-time signature in the
// state file, so an orphaned group can be reaped even if the supervisor died without
// cleanup — but ONLY when the live pid is verifiably the same process (start-time
// match), never a recycled pid the OS handed to something else.
function readAdapter(id) {
  try { const s = JSON.parse(readFileSync(reg.statePath(id), 'utf8')); return { pid: s.adapterPid ?? null, start: s.adapterStart ?? null }; }
  catch { return { pid: null, start: null }; }
}
function clearAdapter(id) {
  try { const p = reg.statePath(id); const s = JSON.parse(readFileSync(p, 'utf8')); s.adapterPid = null; s.adapterStart = null; writeFileSync(p, JSON.stringify(s, null, 2)); } catch { /* nothing to clear */ }
}
// Live token usage for a host (so `list`/`status` can surface a burner at a glance).
function readUsage(id, room) {
  try { return JSON.parse(readFileSync(reg.statePath(id), 'utf8')).rooms?.[room]?.usage ?? null; } catch { return null; }
}
// Live context-window usage (from ACP usage_update), written by the bridge.
function readContext(id, room) {
  try { return JSON.parse(readFileSync(reg.statePath(id), 'utf8')).rooms?.[room]?.context ?? null; } catch { return null; }
}
// The agent's ACTUAL in-room sender name (persisted by the bridge on join/resume).
// Shown by list/status so the CLI and the room roster agree on what this agent is called.
function readSender(id, room) {
  try { return JSON.parse(readFileSync(reg.statePath(id), 'utf8')).rooms?.[room]?.sender ?? null; } catch { return null; }
}
// Live runtime a host writes into its own state.json (activity / paused / exit), so
// `list`/`status` can show what it's DOING and WHY it stopped — not just pid-liveness.
function readRuntime(id) {
  try { const s = JSON.parse(readFileSync(reg.statePath(id), 'utf8')); return { activity: s.activity || null, paused: s.paused || null, exit: s.exit || null }; }
  catch { return { activity: null, paused: null, exit: null }; }
}
// Map a user handle to a canonical host id: exact id, else a unique label, else a
// unique id-prefix — so `concord stop billing-bot` (label) or `concord stop claude-3f`
// (prefix) work, not just the full hex id. No/ambiguous match → return as-is (the
// command then dies with "no such host").
function resolveId(token) {
  if (!token) return token;
  const all = reg.list();
  if (all.some((h) => h.id === token)) return token;
  const byLabel = all.filter((h) => h.label === token);
  if (byLabel.length === 1) return byLabel[0].id;
  const byPrefix = all.filter((h) => h.id.startsWith(token));
  if (byPrefix.length === 1) return byPrefix[0].id;
  return token;
}
// Guard a destructive command (stop/rm/restart) from silently aborting an agent
// mid-task. Returns true to proceed. --yes/--force skips; idle/dead never prompts; a
// non-TTY without --yes refuses (scripts must opt in, never hang). Computes liveness
// itself (reg.get records carry no `alive` flag — only reg.list() annotates it).
async function okToInterrupt(h, action, { yes } = {}) {
  if (yes) return true;
  const alive = h.pid ? kill(h.pid, 0) : false;
  if (!alive) return true;
  const rt = readRuntime(h.id);
  if (rt.activity?.state !== 'working') return true;
  const what = rt.activity.label ? ` (${rt.activity.label})` : '';
  if (!process.stdin.isTTY) { console.error(`✗ ${h.id} is WORKING${what} — re-run with --yes to ${action} it anyway.`); process.exitCode = 1; return false; }
  return confirm(`⚠️  ${h.id} is WORKING${what}. ${action} it anyway?`);
}
// Reap a host's orphaned adapter group — identity-guarded (a recycled pid is skipped,
// never killed) — and clear the recorded pid afterwards so the same stale integer is
// acted on at most once instead of being re-rolled on every future command.
async function reapHostAdapter(id) {
  const { pid, start } = readAdapter(id);
  if (!pid) return false;
  const { reaped, reason } = await reapAdapterGroup({ pid, start }, { kill, startOf: procStart });
  // Clear only when the pid is genuinely done with — reaped, already-gone, or PROVEN
  // recycled. On 'unverifiable' keep the pid (clearing it would permanently orphan a
  // still-live burner — round-4 finding). Two sub-cases: a TRANSIENT ps failure at reap
  // (start was captured) self-heals on a later sweep when ps recovers; but if ps was
  // absent AT CAPTURE the start is null forever, so this host is never auto-reaped —
  // only a clean shutdown or a manual kill clears it (the spawn-time warning flags it).
  if (reason !== 'unverifiable') clearAdapter(id);
  return reaped;
}
// Crash-path backstop: reap orphaned adapter groups (supervisor dead, adapter still
// alive AND verified ours). Run before MUTATING lifecycle commands only — never as a
// destructive side effect of read-only `list`/`status`/`logs`/`help`. Silent unless it reaps.
async function sweepOrphans() {
  try {
    for (const h of reg.list()) {
      if (h.alive) continue;
      if (await reapHostAdapter(h.id)) console.log(`✓ reaped orphaned agent group for ${h.id} (its supervisor had died)`);
    }
  } catch { /* best effort — never block a command on the sweep */ }
}

async function stopHostCmd(id, { silent, yes } = {}) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) { if (!silent) die(`no such host: ${id}`); return; }
  if (!silent && !(await okToInterrupt(h, 'stop', { yes }))) return;   // working-agent guard (user-facing stop only)
  const a = readAdapter(id);
  const { steps } = await stopHost({ ...h, adapterPid: a.pid, adapterStart: a.start }, { kill, startOf: procStart });
  reg.update(id, { pid: null, stopped: true, stoppedAt: Date.now() });
  if (!silent) console.log(`✓ stopped ${id} — reclaim: ${steps.join(' → ') || '(none)'}`);
}

// rm = ALWAYS reclaim the whole tree first, THEN forget. Even a seemingly-dead entry
// is reclaimed (stopHost double-targets the bridge AND the adapter group, identity-
// guarded), so `concord rm` on a running/orphaned host can never leave an adapter+agent
// group alive burning tokens or memory. Guarantee: rm never produces an orphan. The
// old rm just unregistered + deleted state, which orphaned a live group AND threw away
// the pids needed to ever reap it.
async function rmHost(id, { yes } = {}) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (!(await okToInterrupt(h, 'remove', { yes }))) return;
  await stopHostCmd(id, { silent: true });   // SIGTERM bridge + reap adapter group BEFORE we drop the pids/state
  reg.unregister(id, { removeState: true });
  // Drop any IM binding pointing at this host's room, so the owner stops relaying a
  // chat into a now-dead agent (the binding would otherwise linger and route into a void).
  let unbound = 0;
  if (h.room) { const b = openBindings(); for (const v of Object.values(b.list())) { if (v.roomId === h.room) { b.unbind(v.platform, v.chatId); unbound++; } } }
  console.log(`✓ removed ${id} (stopped + reclaimed first — no orphans)${unbound ? ` · dropped ${unbound} IM binding(s)` : ''}`);
}

async function restartHost(id, { yes } = {}) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (!(await okToInterrupt(h, 'restart', { yes }))) return;
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
    if (await reapHostAdapter(h.id)) reaped.push(h.id);
  }
  const dead = reg.pruneDead();
  const parts = [];
  if (reaped.length) parts.push(`reaped orphan agents: ${reaped.join(', ')}`);
  parts.push(dead.length ? `pruned dead: ${dead.join(', ')}` : 'no dead entries');
  console.log('✓ ' + parts.join(' · '));
}

// SOFT teardown: stop the IM owner + every agent, but KEEP each registry entry (marked
// stopped) and ALL IM bindings. "I'm done for now" — fully reversible: `concord up` revives
// the exact same fleet and the bots reconnect with no re-binding. (The hard wipe is `reset`.)
async function shutdownAll() {
  const hosts = reg.list();
  if (!hosts.length) { console.log('(nothing was running)'); return; }
  for (const h of hosts) { await stopHostCmd(h.id, { silent: true }); console.log(`✓ stopped ${h.id}`); }   // stopHostCmd keeps the entry (pid:null, stopped:true)
  const n = Object.keys(openBindings().list()).length;
  console.log(`✓ stopped ${hosts.length} process(es); kept ${n} IM binding(s) + all configs.`);
  console.log('  bring it all back:  concord up');
}

// Revive the fleet after `shutdown`: restart every stopped agent with its saved config and
// re-start the IM owner (creds-aware). Bindings were kept, so bots need no re-binding.
// Idempotent — already-running hosts are left alone.
async function upAll() {
  const hosts = reg.list();
  if (!hosts.length) { console.log('(nothing to bring up — no saved hosts. start one:  concord host <agent>)'); return; }
  let revived = 0, already = 0;
  for (const h of hosts.filter((x) => x.mode !== 'im')) {
    if (h.alive) { already++; continue; }
    const pid = spawnDaemon(h.id, { ...h, pid: undefined, stopped: false }, { fg: false });
    reg.update(h.id, { stopped: false });
    console.log(`✓ up ${h.id} — pid ${pid}`);
    revived++;
  }
  // Owners: revive via the creds-aware path (re-pins to the current app), but ONLY for
  // logged-in platforms — never resurrect an owner for creds the user has since removed.
  for (const platform of IM_PLATFORMS.filter((p) => getCreds(p))) {
    try { const { pid, started } = await startImOwnerIfNeeded(platform); if (started) { console.log(`✓ up IM owner (${platform}) — pid ${pid}`); revived++; } else already++; }
    catch (e) { console.log(`⚠️  IM owner (${platform}) 启动失败:${e?.message || e}`); }
  }
  console.log(`✓ up: ${revived} revived, ${already} already running`);
}

// HARD teardown: stop everything, drop every registry entry AND every IM binding — a clean
// slate. Bots must be re-bound (/concord-bind) afterwards. Does NOT touch login creds (that's
// `concord logout`). Destructive → confirm unless --yes.
async function resetAll({ yes } = {}) {
  const hosts = reg.list();
  const nB = Object.keys(openBindings().list()).length;
  if (!hosts.length && !nB) { console.log('(already a clean slate — nothing to reset)'); return; }
  if (!yes && !(await confirm(`Reset 会停止 ${hosts.length} 个 host、删除它们的配置,并清掉 ${nB} 个 IM 绑定(bot 需重新 /concord-bind)。继续?`))) { console.log('(已取消)'); return; }
  for (const h of hosts) { await stopHostCmd(h.id, { silent: true }); reg.unregister(h.id, { removeState: true }); console.log(`✓ stopped + removed ${h.id}`); }
  openBindings().clear();
  console.log(`✓ cleared ${nB} IM binding(s)`);
  console.log('✓ reset —— 干净 slate。(登录凭据保留;在聊天里发 /concord-bind 重新绑定 bot。)');
}

// Clear a timeout pause on a running host (SIGUSR1 — unpause only; the token
// meter is left untouched, resetting it is a separate explicit action).
function resumeHost(id) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (!h.pid || !kill(h.pid, 'SIGUSR1')) die(`host ${id} is not running`);
  console.log(`✓ resumed ${id} — accepting tasks again (token meter unchanged)`);
}

// Reset a host's lifetime token meter to zero (SIGUSR2). The ONLY thing that
// clears the counter — it never happens automatically.
function resetBudget(id) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (!h.pid || !kill(h.pid, 'SIGUSR2')) die(`host ${id} is not running`);
  console.log(`✓ reset ${id} — token usage counter zeroed`);
}

function budgetCmd(id, args) {
  id = resolveId(id);
  const h = reg.get(id);
  if (!h) die(`no such host: ${id}`);
  if (args.includes('--reset')) return resetBudget(id);
  let u = { fresh: 0, cached: 0, turns: 0 };
  try { u = JSON.parse(readFileSync(reg.statePath(id), 'utf8')).rooms?.[h.room]?.usage || u; } catch { /* no usage yet */ }
  const cap = h.budget ? `${h.budget} fresh tok (lifetime cap)` : 'unlimited';
  console.log(`budget  ${cap}\nused    fresh ${u.fresh} · cache-read ${u.cached} · ${u.turns || 0} turns (cumulative)\n(reset: concord budget ${id} --reset)`);
}

// Store this user's OWN IM bot creds locally (0600). Secret via --app-secret or,
// to keep it out of shell history, piped on stdin.
// Scan a QR in Feishu/Lark to create the bot app and save its creds — zero developer-
// console clicks. Uses registerApp from @larksuiteoapi/node-sdk (same dep we already
// have) — the standard OAuth 2.0 Device Authorization flow with Feishu's PersonalAgent
// archetype, which provisions the bot with the message/card/event scopes the IM owner
// needs and auto-detects feishu vs. lark from the scanning user's tenant.
//
// Reuse rules (so re-running this command doesn't litter the workspace with dead apps):
//   existing creds, no flag       → reuse, auto-start owner if needed (idempotent)
//   --new                         → always create a fresh app (overwrites existing creds)
//   --force                       → re-scan to update the existing app's config
//                                   (registerApp with appId = "grant more scopes" mode)
async function loginViaQR(platform, opts = {}) {
  const existing = getCreds(platform);
  if (existing && !opts.new && !opts.force) {
    console.log(`\n✓ 已登录 ${platform}:appId ${existing.appId}(凭据已存在,跳过扫码以免重建应用)`);
    console.log('  · 想换/补建一个新应用:  concord login ' + platform + ' --qr --new');
    console.log('  · 想用同一应用重新扫码:  concord login ' + platform + ' --qr --force');
    // Idempotent: still ensure the owner is up. Re-running this command becomes a
    // safe "check + repair" — useful after a reboot that lost the daemon.
    try {
      const { pid, started, restarted } = await startImOwnerIfNeeded(platform, undefined);
      const how = restarted ? '✓ IM owner 已对齐当前应用并重启' : started ? '✓ IM owner 已启动' : '✓ IM owner 已在运行';
      console.log(`\n${how} (pid ${pid}) — 直接去聊天发 /concord-bind 即可。`);
    } catch (e) {
      console.log('\n⚠️  自动启动 IM owner 失败:' + (e?.message || e));
    }
    return;
  }
  const { registerApp } = await import('@larksuiteoapi/node-sdk');
  const qrcode = (await import('qrcode-terminal')).default;
  const updateMode = opts.force && existing;
  console.log(`\n用「${platform === 'lark' ? 'Lark' : '飞书'}」App 扫码${updateMode ? `更新已有应用 ${existing.appId}` : '创建你的 bot 应用'} — 不用开发者后台、不用发版。\n`);
  let reg;
  try {
    reg = await registerApp({
      source: 'concord-agent',
      // createOnly hides the "select existing app" entry on the landing page;
      // for --force update we DROP it (and pass appId) so the scan binds the existing app.
      ...(updateMode ? { appId: existing.appId } : { createOnly: true }),
      appPreset: { name: 'Concord · {user}' },   // {user} = the scanning user's name
      onQRCodeReady: ({ url, expireIn }) => {
        qrcode.generate(url, { small: true });
        console.log(`\n二维码有效期约 ${Math.max(1, Math.round(expireIn / 60))} 分钟。`);
        console.log(`扫不动也可在浏览器打开:${url}\n`);
        console.log('等你在 App 里点完「同意」…');
      },
      onStatusChange: ({ status }) => { if (status === 'domain_switched') console.log('  (识别到 Lark 国际版,已自动切换)'); },
    });
  } catch (e) {
    die(`扫码登录失败:${e?.message || e}`);
  }
  // tenant_brand决定走哪个域(lark/feishu);存到 creds 里供 owner 直接用
  const domain = reg.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
  saveCreds(platform, { appId: reg.client_id, appSecret: reg.client_secret, domain });
  console.log(`\n✓ 已保存 ${platform} 凭据 → ~/.concord/creds.json (0600)`);
  console.log(`  appId: ${reg.client_id}  ·  domain: ${domain}`);
  // Auto-start the IM owner — without it the bot has creds but nothing's listening, so
  // a `/concord-bind` in the chat goes nowhere. Skip if one's already running (rebinding
  // a chat with new creds shouldn't double-spawn). Errors here are non-fatal — the user
  // has working creds either way and can fall back to `concord im` manually.
  try {
    const { pid, started, restarted, appId } = await startImOwnerIfNeeded(platform, undefined);
    if (restarted) console.log(`✓ IM owner 已切到新应用并重启 (pid ${pid}, appId ${appId}) — 现在去聊天里发 /concord-bind 就行。`);
    else if (started) console.log(`✓ IM owner 已启动 (pid ${pid}) — 现在去聊天里发 /concord-bind 就行。`);
    else console.log(`✓ IM owner 已在运行 (pid ${pid}) — 直接去聊天里发 /concord-bind 即可。`);
    console.log('   日志:  concord logs ' + imOwnerId(platform));
  } catch (e) {
    console.log('\n⚠️  自动启动 IM owner 失败:' + (e?.message || e));
    console.log('   手动起一下:  concord im');
  }
  // Enterprise tenants gate "personal-app creation" behind admin approval — the scan
  // returns valid creds (and the owner connects fine) but messages won't actually route
  // until the admin approves the new app. We can't detect this from here (creds look
  // healthy), so flag it gently. Individual / personal accounts (the recommended path)
  // skip this entirely.
  console.log('\n  小提示:在企业里如果发消息没反应,可能是新应用还在等管理员审批;');
  console.log('         批了之后不用重扫,owner 会自动跑通。详见 docs/getting-started.md §2。');
}

async function login(args) {
  const { flags, positional } = parseArgs(args);
  const platform = positional[0];
  if (!['lark', 'feishu'].includes(platform)) die('usage: concord login lark|feishu [--qr | --app-id <id> [--app-secret <secret>]]');
  // --qr: zero-config bot creation via scanning a QR with the Feishu/Lark app.
  // --new = always create a fresh app; --force = re-scan to update existing app.
  if (flags.qr === true || args.includes('--qr')) {
    await loginViaQR(platform, { new: flags.new === true, force: flags.force === true });
    return;
  }
  const appId = flags['app-id'];
  let appSecret = flags['app-secret'];
  if (!appId) die('--app-id is required (or use --qr to scan a QR and create the app for you)');
  if (!appSecret && !process.stdin.isTTY) appSecret = readFileSync(0, 'utf8').trim();   // piped: `… | concord login`
  if (!appSecret) die('--app-secret is required (or pipe it on stdin to keep it out of history)');
  saveCreds(platform, { appId, appSecret, domain: platform });
  console.log(`✓ saved ${platform} credentials for app ${appId} → ~/.concord/creds.json (0600)`);
  // If an owner is already running on a DIFFERENT app, move it onto this one (it's pinned
  // to the app baked in at spawn). Don't newly start one here — that's `concord im`'s job.
  try {
    const r = await startImOwnerIfNeeded(platform, undefined, { startIfAbsent: false });
    if (r.restarted) console.log(`✓ moved the running IM owner onto app ${appId} (pid ${r.pid})`);
  } catch (e) { console.log('⚠️  could not refresh the IM owner: ' + (e?.message || e)); }
}
function logout(args) {
  const platform = args[0];
  if (platform) { console.log(removeCreds(platform) ? `✓ removed ${platform} credentials` : `(no ${platform} credentials)`); return; }
  for (const p of Object.keys(loadCreds())) removeCreds(p);
  console.log('✓ removed all stored credentials');
}

// `concord im` — the IM owner daemon: owns the bot's single WSClient + relays bound
// chats. ONE per bot (single-instance). `concord im stop|status|logs` manage it.
const imOwnerId = (platform) => `im-${platform}`;

// Spawn the IM owner daemon for a platform (background, detached). Returns the running
// pid + whether we just started it or it was already up. Used by both `concord im` and
// `concord login --qr` (which auto-starts the owner so the user is done in one command).
// Ensure the IM owner for `platform` is running AND connected to the CURRENT creds' app.
// The owner bakes appId/appSecret into its WSClient at spawn, so a creds switch (new bot
// app) leaves a live owner pinned to the OLD app — the new app then has nothing listening
// and `/concord-bind` on it silently drops. So this is creds-aware: a running owner on a
// different app is STOPPED and restarted onto the new one. `startIfAbsent:false` only
// repairs a stale running owner without newly starting one (manual `--app-id` path).
async function startImOwnerIfNeeded(platform, url, { startIfAbsent = true } = {}) {
  const id = imOwnerId(platform);
  const wantAppId = getCreds(platform)?.appId || null;
  const existing = reg.get(id);
  const alive = !!(existing && existing.pid && kill(existing.pid, 0));
  const action = ownerAction({ alive, existingAppId: existing?.appId || null, wantAppId, startIfAbsent });
  if (action === 'keep') return { pid: existing.pid, started: false, restarted: false, appId: existing.appId };
  if (action === 'noop') return { pid: null, started: false, restarted: false, running: false };
  if (action === 'restart') await stopHostCmd(id, { silent: true });   // stale app → tear the old owner down first
  const env = { ...process.env, ...(url ? { CONCORD_URL: url } : {}) };
  mkdirSync(reg.hostDir(id), { recursive: true });
  const out = openSync(join(reg.hostDir(id), 'log'), 'a');
  const child = spawn(process.execPath, [OWNER, platform], { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  reg.register({ id, mode: 'im', platform, appId: wantAppId, agent: '-', room: '-', pid: child.pid, log: join(reg.hostDir(id), 'log') });
  return { pid: child.pid, started: true, restarted: action === 'restart', appId: wantAppId };
}
// The IM owner's self-written health snapshot (~/.concord/hosts/im-<platform>/health.json).
function readHealth(platform) {
  try { return JSON.parse(readFileSync(join(reg.hostDir(imOwnerId(platform)), 'health.json'), 'utf8')); } catch { return null; }
}

// `concord im status` — render the owner's end-to-end health (connection · per-binding agent/
// room state · the single next action). Also the one place a drifted owner gets repaired:
// it's connected to the WRONG app, so its in-band "restart me" can't reach the user — the CLI
// is the only working channel (D4).
async function imStatus() {
  const platforms = IM_PLATFORMS.filter((p) => getCreds(p));
  if (!platforms.length) { console.log('(no IM platform logged in — `concord login lark --qr`)'); return; }
  for (const platform of platforms) {
    const id = imOwnerId(platform);
    let h = reg.get(id);
    if (h && h.pid && kill(h.pid, 0)) {
      try { const r = await startImOwnerIfNeeded(platform, undefined, { startIfAbsent: false }); if (r.restarted) console.log(`✓ owner 检测到 creds 切换,已重启到当前 app (pid ${r.pid})`); } catch { /* non-fatal */ }
      h = reg.get(id);
    }
    const alive = h && h.pid && kill(h.pid, 0);
    console.log(`\n══ IM owner · ${platform} ══`);
    if (!alive) { console.log(`  ✗ owner 没在运行 —— 启动:concord login ${platform} --qr   (或 concord im)`); continue; }
    const snap = readHealth(platform);
    if (!snap) { console.log(`  owner 在跑 (pid ${h.pid}),但还没写出健康快照 —— 等一个对账周期(~45s)再看。`); continue; }
    // Refresh agent-presence from the LIVE registry so a just-`stop`ped agent shows as absent
    // immediately, not after the owner's next reconcile tick (the snapshot lags ~45s).
    const liveRooms = liveAgentRoomsLocal();
    for (const b of snap.bindings || []) b.agentState = liveRooms.has(b.roomId) ? 'present' : 'absent';
    console.log(`  ${overallHeadline(snap).summary}`);
    console.log(`  app ${snap.appId || '-'} · 长连接 ${snap.eventPlane?.state || '?'}/${snap.eventPlane?.status || '?'} · 对账 ${snap.reconciledAt ? ago(snap.reconciledAt) : '?'}前`);
    if (!snap.bindings?.length) { console.log('  (还没有绑定 —— 在聊天里发 /concord-bind)'); continue; }
    for (const b of snap.bindings) {
      console.log(`  · ${chatLabel(b, 24)} → ${b.roomName || shortRoom(b.roomId)}  [${bindingVerdict(b)}]`);
      const na = bindingNextAction(b);
      if (na && na.cmd) console.log(`      ${na.summary}  →  ${na.cmd}`);
    }
  }
}

async function imCmd(args) {
  const { positional } = parseArgs(args);
  const sub = positional[0];
  if (sub === 'status') return imStatus();
  if (sub === 'stop' || sub === 'logs') {
    const o = reg.list().find((h) => h.mode === 'im');
    if (!o) die('no `concord im` owner is registered');
    if (sub === 'stop') return stopHostCmd(o.id);
    return logsHost(o.id, args.includes('-f') || args.includes('--follow'));
  }
  const cfg = resolveConfig(args, process.env);
  const platform = resolveImPlatform(cfg, 'host');
  if (!platform) die('no IM platform logged in — easiest: `concord login lark --qr` (scan a QR; no developer console). Or use `--app-id`/`--app-secret`.');
  const id = imOwnerId(platform);
  const existing = reg.get(id);
  const wantAppId = getCreds(platform)?.appId || null;
  const alive = existing && existing.pid && kill(existing.pid, 0);
  // Only refuse when a healthy owner is already on the CURRENT app. A live owner pinned to
  // a STALE app falls through — startImOwnerIfNeeded restarts it onto the current creds.
  if (alive && (!wantAppId || existing.appId === wantAppId)) {
    die(`a concord im owner for ${platform} is already running (id ${id}, pid ${existing.pid}). One bot = one owner — stop it first: concord im stop`);
  }
  // --fg keeps the owner attached (stdio inherited) — useful for debugging the WSClient
  // handshake. The default background path goes through startImOwnerIfNeeded so the
  // detached spawn / registry write is the same as the `concord login --qr` auto-start.
  if (args.includes('--fg')) {
    reg.register({ id, mode: 'im', platform, appId: wantAppId, agent: '-', room: '-' });
    const env = { ...process.env, CONCORD_URL: cfg.url };
    const child = spawn(process.execPath, [OWNER, platform], { stdio: 'inherit', env });
    reg.update(id, { pid: child.pid });
    child.on('close', () => reg.update(id, { pid: null, stopped: true }));
    return;
  }
  const { pid, restarted } = await startImOwnerIfNeeded(platform, cfg.url);
  console.log(`✓ im owner ${restarted ? 'restarted onto current app' : 'started'} — ${platform} · id ${id} · pid ${pid}\n  concord logs ${id}   ·   concord im stop`);
}

const [cmd, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith('-'));               // ids/labels, flags stripped
const yes = rest.includes('--yes') || rest.includes('-y') || rest.includes('--force');
// Crash-path backstop, but ONLY before mutating lifecycle commands — a read-only
// `list`/`status`/`logs`/`help` must never have a destructive side effect. (`prune`
// does its own reap.) The reap itself is identity-guarded against PID reuse.
if (['join', 'host', 'stop', 'restart'].includes(cmd)) await sweepOrphans();
switch (cmd) {
  case 'join': case 'host': await startHost(cmd, rest); break;
  case 'login': await login(rest); break;
  case 'logout': logout(rest); break;
  case 'im': await imCmd(rest); break;
  case 'list': case 'ls': listHosts(); break;
  case 'bindings': listBindings(); break;
  case 'status': rest[0] ? statusHost(rest[0]) : die('usage: concord status <id>'); break;
  case 'logs': rest[0] ? logsHost(rest[0], rest.includes('-f') || rest.includes('--follow')) : die('usage: concord logs <id> [-f]'); break;
  case 'open': positional[0] ? openRoom(positional[0]) : die('usage: concord open <id>'); break;
  case 'label': positional[0] && positional[1] ? labelHost(positional[0], positional[1]) : die('usage: concord label <id> <label>'); break;
  case 'stop': positional[0] ? await stopHostCmd(positional[0], { yes }) : die('usage: concord stop <id> [--yes]'); break;
  case 'restart': positional[0] ? await restartHost(positional[0], { yes }) : die('usage: concord restart <id> [--yes]'); break;
  case 'rm': positional[0] ? await rmHost(positional[0], { yes }) : die('usage: concord rm <id> [--yes]'); break;
  case 'prune': await prune(); break;
  case 'up': await upAll(); break;
  case 'shutdown': await shutdownAll(); break;
  case 'reset': await resetAll({ yes }); break;
  case 'resume': rest[0] ? resumeHost(rest[0]) : die('usage: concord resume <id>'); break;
  case 'budget': rest[0] ? budgetCmd(rest[0], rest.slice(1)) : die('usage: concord budget <id> [--reset]'); break;
  case 'version': case '--version': case '-v': console.log(`concord-agent ${VERSION}`); break;
  case undefined: case 'help': case '-h': case '--help': console.log(USAGE); break;
  default: console.error(`unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1);
}
