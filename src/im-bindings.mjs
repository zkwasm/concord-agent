// Local chat→room binding table for the IM owner (`concord im`). Single-tenant:
// ONE bot drives N agents, routed by chat. Keyed by `platform:chat_id` so two
// platforms' chats never collide. JSON at ~/.concord/im-bindings.json, atomic
// writes — same shape/discipline as hosts.mjs. Pure persistence; routing logic
// lives in the owner. `openBindings(root)` is injectable for tests.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.env.CONCORD_HOME || join(homedir(), '.concord');
const keyOf = (platform, chatId) => `${platform}:${chatId}`;

export function openBindings(root = ROOT) {
  const path = join(root, 'im-bindings.json');
  const load = () => { if (!existsSync(path)) return {}; try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  const persist = (obj) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, path);
  };
  return {
    path,
    // Current binding for a chat, or null.
    get(platform, chatId) { return load()[keyOf(platform, chatId)] || null; },
    // All bindings, keyed by `platform:chat_id`.
    list() { return load(); },
    // Bind a chat to a room. Refuses to clobber an existing binding unless force —
    // the caller turns {ok:false, existing} into the "already bound, use --force" prompt.
    bind(platform, chatId, { roomId, chatType = null, chatName = null, agent = null, cwd = null } = {}, { force = false, now = Date.now() } = {}) {
      if (!platform || !chatId) throw new Error('bind needs platform + chatId');
      if (!roomId) throw new Error('bind needs a roomId');
      const all = load();
      const k = keyOf(platform, chatId);
      if (all[k] && !force) return { ok: false, existing: all[k] };
      all[k] = { platform, chatId, roomId, chatType, chatName, agent, cwd, boundAt: now };
      persist(all);
      return { ok: true, binding: all[k] };
    },
    // Cache a resolved human chat name onto the binding (the owner fills this in from Lark;
    // list/status/bindings then show "设计群" instead of a raw oc_ id). No-op if unchanged/empty.
    setChatName(platform, chatId, name) {
      if (!name) return false;
      const all = load();
      const k = keyOf(platform, chatId);
      if (!all[k] || all[k].chatName === name) return false;
      all[k] = { ...all[k], chatName: name };
      persist(all);
      return true;
    },
    // Remove a chat's binding. Returns whether something was removed.
    unbind(platform, chatId) {
      const all = load();
      const k = keyOf(platform, chatId);
      if (!all[k]) return false;
      delete all[k];
      persist(all);
      return true;
    },
    // Test/maintenance: wipe the whole table.
    clear() { try { rmSync(path, { force: true }); } catch { /* nothing to clear */ } },
  };
}
