// Host registry for daemon-mode `concord host`/`join`. Tracks running supervisors
// so list/status/stop/restart can find them. JSON at ~/.concord/hosts.json, atomic
// writes. Each host gets an ISOLATED state dir (~/.concord/hosts/<id>/) so multiple
// hosts never clobber each other's sessionId/dedup/budget (the old single hardcoded
// ./bridge-state.json would cross-talk — review finding).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.env.CONCORD_HOME || join(homedir(), '.concord');
const REGISTRY = join(ROOT, 'hosts.json');

export const hostDir = (id) => join(ROOT, 'hosts', id);
export const statePath = (id) => join(hostDir(id), 'state.json');

// Short, collision-resistant id (e.g. "claude-3f9c2a"). Not crypto — just unique
// enough to name a local daemon.
export function newId(agent) {
  const r = Math.random().toString(16).slice(2, 8);
  return `${(agent || 'agent').replace(/[^a-z0-9]/gi, '')}-${r}`;
}

function load(registryPath = REGISTRY) {
  if (!existsSync(registryPath)) return {};
  try { return JSON.parse(readFileSync(registryPath, 'utf8')); } catch { return {}; }
}
function persist(obj, registryPath = REGISTRY) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmp = registryPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, registryPath);
}

// True if a pid is alive (signal 0 probes without killing). Unknown/0 → false.
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Open a registry rooted at `root` (defaults to ~/.concord). Returns a small CRUD
// API; injectable root makes it unit-testable without touching the real home.
export function openRegistry(root = ROOT) {
  const registryPath = join(root, 'hosts.json');
  const dirFor = (id) => join(root, 'hosts', id);
  return {
    root,
    registryPath,
    hostDir: dirFor,
    statePath: (id) => join(dirFor(id), 'state.json'),
    register(entry) {
      if (!entry || !entry.id) throw new Error('register needs an id');
      const all = load(registryPath);
      all[entry.id] = { ...entry, started: entry.started ?? Date.now() };
      mkdirSync(dirFor(entry.id), { recursive: true });
      persist(all, registryPath);
      return all[entry.id];
    },
    update(id, patch) {
      const all = load(registryPath);
      if (!all[id]) return null;
      all[id] = { ...all[id], ...patch };
      persist(all, registryPath);
      return all[id];
    },
    get(id) { return load(registryPath)[id] || null; },
    list() {
      const all = load(registryPath);
      // Annotate liveness so list/status can show running vs crashed/orphaned.
      return Object.values(all).map((h) => ({ ...h, alive: pidAlive(h.pid) }));
    },
    unregister(id, { removeState = false } = {}) {
      const all = load(registryPath);
      if (!all[id]) return false;
      delete all[id];
      persist(all, registryPath);
      if (removeState) { try { rmSync(dirFor(id), { recursive: true, force: true }); } catch { /* best effort */ } }
      return true;
    },
    // Drop registry entries whose process is gone (crashed/killed externally).
    pruneDead() {
      const all = load(registryPath);
      const dead = Object.values(all).filter((h) => !pidAlive(h.pid)).map((h) => h.id);
      for (const id of dead) delete all[id];
      if (dead.length) persist(all, registryPath);
      return dead;
    },
  };
}
