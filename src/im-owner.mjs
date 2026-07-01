// `concord im` — the IM OWNER. Owns the bot's single WSClient, holds the chat→room
// bindings, intercepts the bind commands, and relays bound chats ↔ their Concord rooms.
// ONE owner per bot — the single connection owner the single-tenant redesign requires
// (multiple WSClients on one bot = Lark splits events = chaos).
//
//   IM chat ──/concord-bind──► owner replies the guided command IN the chat
//   IM chat ──message───────► owner POSTs into the bound room (as "IM") + instant ack
//   bound room ──agent reply─► owner relays it back to the IM chat (loop-guard: skip "IM")
//
// Inbound brain is pure (im-routing.classifyInbound); HTTP is injectable for tests.
import * as Lark from '@larksuiteoapi/node-sdk';
import { watch, writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { loadCreds } from './creds.mjs';
import { openBindings } from './im-bindings.mjs';
import { classifyInbound } from './im-routing.mjs';
import { cleanText } from './im-lark.mjs';
import { shouldUseCard, buildCard } from './im-render.mjs';
import { eventPlaneStatus, chatBreadcrumbs } from './im-health.mjs';

const CONCORD_HOME = process.env.CONCORD_HOME || join(homedir(), '.concord');
const TRIG_RANK = { watch: 3, connect: 2, tick: 1, start: 0 };

const DOMAINS = { lark: Lark.Domain.Lark, feishu: Lark.Domain.Feishu };
const GROUP_DEFAULT_BUDGET = 1000000;   // a group binding defaults to this (the only token gate once "anyone triggers")
const RELAY_SENDER = 'IM';              // the owner's identity in each bound room; replies from anyone else are relayed back
const short = (r) => (r ? String(r).slice(0, 8) : '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOwner({ platform = 'lark', appId, appSecret, domain, url, log = console.log, bindings, home = CONCORD_HOME, _clients = null } = {}) {
  const dom = DOMAINS[domain] || DOMAINS[platform] || Lark.Domain.Lark;
  const bakedAppId = appId || null;     // the app this owner is pinned to — for creds-drift detection
  const client = _clients?.client || new Lark.Client({ appId, appSecret, domain: dom });
  // Connection state from the SDK (getConnectionStatus + these callbacks) makes event-plane
  // health a REAL signal, not a "no events lately" guess. The owner never registered these
  // before, so a failed handshake / silent reconnect was invisible.
  let connState = 'idle';               // idle|connecting|connected|reconnecting|failed
  let lastEventAt = 0;
  const onConn = (s) => { connState = s; try { reconcile('connect'); } catch { /* non-fatal */ } };
  const ws = _clients?.ws || new Lark.WSClient({
    appId, appSecret, domain: dom, loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => { onConn('connected'); log('[owner] WSClient ready'); },
    onError: (e) => { connState = 'failed'; log('[owner] WSClient error: ' + (e?.message || e)); },
    onReconnecting: () => { connState = 'reconnecting'; },
    onReconnected: () => { onConn('connected'); },
  });
  const fetchImpl = _clients?.fetch || globalThis.fetch;
  const CONCORD_URL = url || process.env.CONCORD_URL || 'https://concord.fenginwind.com';
  const store = bindings || openBindings();
  const seen = new Set();         // in-process dedup (Lark resends until acked)
  const rooms = new Map();        // roomId → { sessionId, chatId, polling, roomStatus, consec401, lastRelayAt, lastAgentState }
  const blockedRooms = new Set(); // roomId whose relay name is taken by a ghost (dual-409) — surfaced as 'blocked'
  // reconcile coalescing + health snapshot
  let reconciling = false, pendingTrigger = null, prevSnapshot = null;
  const HEALTH_PATH = join(home, 'hosts', `im-${platform}`, 'health.json');

  // ---- IM side: send to a chat (interactive card, plain-text fallback) ----
  async function send(chatId, text) {
    if (!chatId || !text) return;
    const asText = () => client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) } });
    if (!shouldUseCard(text)) { await asText().catch((e) => log('owner text send failed: ' + e.message)); return; }   // status lines as plain text
    try {
      await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(buildCard(text)) } });
    } catch (e) { log('owner card send failed → text: ' + e.message); await asText().catch((e2) => log('owner text send failed: ' + e2.message)); }
  }

  // Best-effort display name for an open_id (cached) so the agent sees "张三: task" not
  // the raw open_id. Falls back to the id tail if the contact scope isn't granted.
  const nameCache = new Map();
  async function resolveName(openId) {
    if (!openId) return 'user';
    if (nameCache.has(openId)) return nameCache.get(openId);
    let name = openId.slice(-6);
    try { const r = await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } }); name = r?.data?.user?.name || name; } catch { /* contact scope may be absent */ }
    nameCache.set(openId, name);
    return name;
  }

  // Is this group effectively a private channel — one human besides the bot? Lark's
  // chat.get returns user_count (humans) apart from bot_count, so `user_count <= 1` is
  // unambiguous. Cached briefly so we don't query chat.get on every un-@ chit-chat line;
  // the TTL also lets a group that gains a 2nd person revert to @-only within a minute.
  // Needs the im:chat:readonly scope — without it chat.get throws and we stay @-only.
  const soloCache = new Map();   // chatId → { solo, at }
  const SOLO_TTL = 60000;
  async function isSoloGroup(chatId) {
    const c = soloCache.get(chatId);
    const now = Date.now();
    if (c && now - c.at < SOLO_TTL) return c.solo;
    let solo = false;
    try {
      const r = await client.im.v1.chat.get({ path: { chat_id: chatId } });
      const users = Number(r?.data?.user_count);
      if (Number.isFinite(users)) solo = users <= 1;
      log(`[owner] solo-check ${short(chatId)}: user_count=${r?.data?.user_count} → ${solo ? 'solo (no @ needed)' : 'shared (@ required)'}`);
    } catch (e) { log('solo-group check failed (grant im:chat:readonly?): ' + e.message); }
    soloCache.set(chatId, { solo, at: now });
    return solo;
  }

  // The CONCORD ROOM's name (not the Lark chat's), via the agent REST /info endpoint —
  // so the intro / /agents say which room the chat is bound to. The room id is itself
  // the bearer, so a bare GET suffices. Cached, best-effort.
  const roomNameCache = new Map();
  async function resolveRoomName(roomId) {
    if (roomNameCache.has(roomId)) return roomNameCache.get(roomId);
    let name = '';
    try { const r = await fetchImpl(`${CONCORD_URL}/agent/rooms/${roomId}/info`); if (r.ok) name = (await r.json())?.name || ''; } catch { /* best effort */ }
    roomNameCache.set(roomId, name);
    return name;
  }
  // The Lark CHAT's human name (group title), so `concord list`/`bindings`/`im status` can show
  // "lark·设计群" instead of a meaningless "lark·oc_1076…". '' for a p2p chat (no title) or if
  // the im:chat:readonly scope is missing. In-process cache: one chat.get per chat, ever.
  const chatNameCache = new Map();
  async function resolveChatName(chatId) {
    if (chatNameCache.has(chatId)) return chatNameCache.get(chatId);
    let name = '';
    try { const r = await client.im.v1.chat.get({ path: { chat_id: chatId } }); name = r?.data?.name || ''; } catch { /* p2p / missing scope */ }
    chatNameCache.set(chatId, name);
    return name;
  }

  // ---- Room side: join (relay identity), post inbound, poll for agent replies ----
  // Join as "IM"; if that name is taken in the room (409 — e.g. a previous owner's
  // session lingers after a restart), retry with a pid-suffixed name. Returns the
  // session AND the name we actually joined as (the loop guard keys on it).
  async function roomJoin(roomId) {
    for (const name of [RELAY_SENDER, `${RELAY_SENDER}-${process.pid % 10000}`]) {
      const res = await fetchImpl(`${CONCORD_URL}/agent/rooms/${roomId}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender: name }) });
      if (res.ok) return { sessionId: (await res.json()).agentSessionId, sender: name };
      if (res.status !== 409) throw new Error(`relay join ${short(roomId)} failed: ${res.status}`);
    }
    throw new Error(`relay join ${short(roomId)}: relay name taken`);
  }
  async function roomPost(roomId, sessionId, sender, content) {
    return fetchImpl(`${CONCORD_URL}/agent/rooms/${roomId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender, agentSessionId: sessionId, content }) });
  }
  // Relay-back loop: any room message NOT from us (the agent's reply / progress / budget
  // note) goes to the bound IM chat. Skipping our own relay sender is the loop guard.
  async function pollRoom(roomId) {
    const rc = rooms.get(roomId);
    let backoff = 2000;
    // pollRoom runs OUTSIDE the reconcile gate (detached promise); it records room health into
    // rc so reconcile reads it for free (zero extra request). 401-streak → quiesce (rebind to
    // recover); durable 404/410 → room gone, quiesce; 429 → rate-limited, not "unreachable".
    while (rc && rc.polling) {
      try {
        const res = await fetchImpl(`${CONCORD_URL}/agent/rooms/${roomId}/messages?session=${rc.sessionId}&wait=30`);
        if (res.status === 401) {
          rc.consec401 = (rc.consec401 || 0) + 1;
          if (rc.consec401 >= 5) { rc.roomStatus = 'unreachable'; rc.polling = false; log(`relay ${short(roomId)}: 5× 401 — quiescing (rebind to recover)`); break; }
          const j = await roomJoin(roomId); rc.sessionId = j.sessionId; rc.relaySender = j.sender; continue;
        }
        if (res.status === 404 || res.status === 410) { rc.roomStatus = 'unreachable'; rc.polling = false; log(`relay ${short(roomId)}: room gone (${res.status}) — quiescing`); break; }
        if (res.status === 429) { rc.roomStatus = 'rate-limited'; await sleep(backoff); backoff = Math.min(backoff * 2, 30000); continue; }
        if (!res.ok) { rc.roomStatus = 'unreachable'; await sleep(backoff); backoff = Math.min(backoff * 2, 30000); continue; }
        rc.roomStatus = 'reachable'; rc.consec401 = 0; backoff = 2000;
        for (const m of (await res.json()).messages || []) {
          if (m.sender === rc.relaySender) continue;        // our own injected user message → don't echo back
          rc.lastRelayAt = Date.now();
          await send(rc.chatId, m.content);                 // agent reply/progress → the IM chat
        }
      } catch (e) { log('relay poll error: ' + e.message); rc.roomStatus = rc.roomStatus || 'unknown'; await sleep(backoff); backoff = Math.min(backoff * 2, 30000); }
    }
  }
  async function ensureRoom(roomId, chatId) {
    const existing = rooms.get(roomId);
    if (existing) { existing.chatId = chatId; return existing; }
    const { sessionId, sender } = await roomJoin(roomId);
    const rc = { sessionId, chatId, relaySender: sender, polling: true };
    rooms.set(roomId, rc);
    pollRoom(roomId).catch((e) => log('relay loop ended: ' + e.message));
    log(`✓ relay up: ${platform}:${short(chatId)} ↔ room ${short(roomId)} (as ${sender})`);
    return rc;
  }

  // ---- bind handshake (reply IN the chat — decision 1) ----
  async function handleBind(chatId, chatType) {
    const existing = store.get(platform, chatId);
    if (existing) {
      await send(chatId, `✓ 本聊天已绑定到 agent(房间 ${short(existing.roomId)})—— 直接发任务即可。\n要换一个 agent,在你机器上跑:\n\`\`\`\nconcord host claude --bind ${chatId} --force\n\`\`\``);
      return { action: 'already-bound', roomId: existing.roomId };
    }
    const budget = chatType === 'group' ? ` --budget ${GROUP_DEFAULT_BUDGET}` : '';
    await send(chatId, `本聊天还没绑 agent。在你机器上跑(复制即用):\n\`\`\`\nconcord host claude --bind ${chatId}${budget}\n\`\`\`\n跑完这台聊天就接上 agent 了。`);
    return { action: 'prompted', chatId, chatType };
  }
  async function handleUnbind(chatId) {
    const ok = store.unbind(platform, chatId);
    if (!ok) await send(chatId, '本聊天当前没有绑定。');
    // On success the fs.watch → syncRelays "relay down" path posts the removal notice,
    // so an unbind from `concord rm` (terminal, can't message the chat) is announced too.
    return { action: ok ? 'unbound' : 'not-bound' };
  }
  async function handleAgents(chatId) {
    const all = Object.values(store.list()).filter((b) => b.platform === platform);
    if (!all.length) { await send(chatId, '当前没有绑定的 agent —— 发 `/concord-bind` 绑一个。'); return { action: 'agents', count: 0 }; }
    const lines = [`🤖 **当前 ${all.length} 个绑定的 agent**`];
    for (const b of all) { const nm = await resolveRoomName(b.roomId); lines.push(`· **${b.agent || 'agent'}** · 房间「${nm || short(b.roomId)}」${rooms.has(b.roomId) ? ' · ✓在线' : ' · ⚠️离线'}`); }
    await send(chatId, lines.join('\n'));
    return { action: 'agents', count: all.length };
  }
  // First-contact self-intro, posted to the chat when its binding comes up.
  function introText(b, roomName) {
    const n = Object.values(store.list()).filter((x) => x.platform === platform).length;
    const where = roomName ? `房间「${roomName}」` : `房间 ${short(b.roomId)}`;
    const parts = [`🤖 **${b.agent || 'agent'}** 已接入,绑定成功(${where})—— 直接发任务即可(群里请 **@我**)。`];
    if (b.cwd) parts.push(`工作目录:${b.cwd}`);
    parts.push(`当前共 **${n}** 个绑定的 agent(发 /agents 查看全部,防止开太多)。`);
    parts.push('/usage 看用量 · /help 看用法 · /concord-unbind 解绑。');
    return parts.join('\n');
  }
  async function handleHelp(chatId) {
    await send(chatId, ['🤖 **Concord agent 用法**', '· 直接发任务(群里 **@我**)', '· **/concord-bind** 绑定本聊天 · **/concord-unbind** 解绑', '· **/usage** 看用量 · **/agents** 看所有 agent'].join('\n'));
    return { action: 'help' };
  }
  // A normal message: instant ack (decision 4) + POST into the bound room. A bare command
  // (sender=null, e.g. /usage) is posted verbatim (no "name:" prefix, no ack) so the
  // agent's own handler matches it exactly.
  async function routeMessage(chatId, text, sender) {
    const b = store.get(platform, chatId);
    if (!b) { await send(chatId, '本聊天还没绑 agent —— 发 **/concord-bind** 设置。'); return { action: 'unbound' }; }
    // No live LOCAL agent serving this room → the message would vanish. Tell the user NOW
    // (instead of a false "收到 👌") so they don't sit waiting on a dead room. `host --bind`
    // agents are always local, so the registry is authoritative here.
    if (!liveAgentRooms().has(b.roomId)) {
      await send(chatId, '⚠️ 这个房间当前没有活着的 agent,消息还没人处理。请在机器上 `concord up` 拉起(或 `concord host …` 新建)。');
      return { action: 'no-agent', roomId: b.roomId };
    }
    // Single, meaningful ack — names the agent, no double "收到" (the bound agent no longer
    // self-acks; the owner is the one user-facing acker in bind mode).
    if (sender) { const a = b.agent || 'agent'; await send(chatId, `🤖 ${a[0].toUpperCase()}${a.slice(1)} 正在处理…`); }
    try {
      const rc = await ensureRoom(b.roomId, chatId);
      await roomPost(b.roomId, rc.sessionId, rc.relaySender, sender ? `${sender}: ${text}` : text);
    } catch (e) { log('route failed: ' + e.message); await send(chatId, `⚠️ 转发到 agent 失败(${String(e.message).slice(0, 80)})`); return { action: 'route-failed' }; }
    return { action: 'routed', roomId: b.roomId };
  }

  async function onEvent(data) {
    lastEventAt = Date.now();   // event-plane liveness: we are receiving inbound from Lark
    const m = data?.message || {};
    const id = m.message_id;
    if (id && seen.has(id)) return { action: 'dup' };
    if (id) seen.add(id);
    let raw = ''; try { raw = JSON.parse(m.content || '{}').text || ''; } catch { /* non-text */ }
    const text = cleanText(raw, m.mentions);
    const chatId = m.chat_id;
    // A group with just one human is the user's own bot-control channel (the only way to
    // get a "private" chat with the bot is to make such a group) → drop the @ requirement.
    const unAtGroup = m.chat_type === 'group' && !(Array.isArray(m.mentions) && m.mentions.length > 0);
    const soloGroup = unAtGroup ? await isSoloGroup(chatId) : false;
    const d = classifyInbound({ text, chatType: m.chat_type, mentions: m.mentions, soloGroup });
    log(`[owner] ${m.chat_type} ${short(chatId)} text=${JSON.stringify(text.slice(0, 40))} → ${d.action}`);
    if (d.action === 'bind') return handleBind(chatId, m.chat_type);
    if (d.action === 'unbind') return handleUnbind(chatId);
    if (d.action === 'help') return handleHelp(chatId);
    if (d.action === 'agents') return handleAgents(chatId);
    if (d.action === 'usage') return routeMessage(chatId, '/usage', null);   // bare → the agent's own /usage handler
    if (d.action === 'message') return routeMessage(chatId, d.text, await resolveName(data?.sender?.sender_id?.open_id));
    return { action: d.action };   // 'ignore'
  }

  // Bring up relays for every current binding; rebuild on bindings-file changes so a
  // fresh `concord host --bind` starts relaying without restarting the owner.
  // Bring up relays for every current binding. `notify` → confirm IN the chat when a
  // NEW binding is picked up (so the user who just ran `concord host --bind` sees it
  // worked) — silent on the owner's own startup so a restart never spams existing chats.
  async function syncRelays({ notify = false } = {}) {
    const all = store.list();
    const bound = new Set();
    for (const b of Object.values(all)) {
      if (b.platform !== platform) continue;
      bound.add(b.roomId);
      if (rooms.has(b.roomId)) continue;
      try {
        await ensureRoom(b.roomId, b.chatId);
        blockedRooms.delete(b.roomId);
        if (notify) await send(b.chatId, introText(b, await resolveRoomName(b.roomId)));
      } catch (e) {
        log('relay start failed: ' + e.message);
        if (/name taken/i.test(e.message)) blockedRooms.add(b.roomId);   // dual-409: a ghost holds the relay name → 'blocked', not a silent retry
        if (notify) await send(b.chatId, `⚠️ 绑定失败:连不上房间(${String(e.message).slice(0, 80)})。`);
      }
    }
    for (const [roomId, rc] of rooms) if (!bound.has(roomId)) { rc.polling = false; rooms.delete(roomId); log(`relay down: room ${short(roomId)} (unbound)`); await send(rc.chatId, '⚠️ 本聊天的 agent 已移除。发 **/concord-bind** 可重新绑定。').catch(() => {}); }
  }

  // ---- reconcile: align desired (bindings) vs actual (relay/conn/room/agent), self-correct
  //      or surface, write the health snapshot the CLI reads. Coalescing + non-fatal. ----
  // Same-machine, authoritative agent presence: which rooms have a LIVE local agent process.
  // The owner and every `host --bind` agent share this ~/.concord, and a bound room's agent
  // was started on THIS box, so the registry (pid + kill-0) is ground truth. This REPLACES an
  // earlier server call to /agent/rooms/:id/agents, whose "ever-joined in 30d" signal never
  // said "absent" — so a stopped agent still looked present and messages vanished (石沉大海).
  function liveAgentRooms() {
    const live = new Set();
    try {
      const all = JSON.parse(readFileSync(join(home, 'hosts.json'), 'utf8'));
      for (const h of Object.values(all)) {
        if (h.mode === 'im' || h.stopped || !h.room || !h.pid) continue;   // the owner isn't an agent; skip stopped/unrooted
        try { process.kill(h.pid, 0); live.add(h.room); } catch (e) { if (e.code === 'EPERM') live.add(h.room); }
      }
    } catch { /* no/unreadable registry → nothing is live */ }
    return live;
  }
  function writeSnapshot(snap) {
    try { mkdirSync(dirname(HEALTH_PATH), { recursive: true }); const tmp = HEALTH_PATH + '.tmp'; writeFileSync(tmp, JSON.stringify(snap, null, 2)); renameSync(tmp, HEALTH_PATH); }
    catch (e) { log('[owner] snapshot write failed: ' + e.message); }
  }
  function loadPrevSnapshot() { try { return JSON.parse(readFileSync(HEALTH_PATH, 'utf8')); } catch { return null; } }
  // Singleton guard: if the registry's owner pid for this platform is no longer us, another
  // owner took over (the spawn-time lock should prevent it, but this is the runtime backstop).
  function stillOwner() {
    try {
      const p = join(home, 'hosts.json');
      if (!existsSync(p)) return true;
      const e = JSON.parse(readFileSync(p, 'utf8'))[`im-${platform}`];
      if (!e || e.pid == null) return true;
      return e.pid === process.pid;
    } catch { return true; }   // never step down on a read error
  }
  function stepDown() { try { for (const rc of rooms.values()) rc.polling = false; ws.close?.({ force: true }); } catch { /* */ } process.exit(0); }

  async function reconcileOnce(trigger) {
    if (!stillOwner()) { log(`[owner] another owner now owns ${platform} — stepping down`); stepDown(); return; }
    await syncRelays({ notify: trigger === 'watch' });                  // self-correct relays (binding↔relay)
    try { const s = ws.getConnectionStatus?.(); if (s?.state) connState = s.state; } catch { /* SDK may not expose at all states */ }
    const now = Date.now();
    const mine = Object.values(store.list()).filter((b) => b.platform === platform);   // read bindings ONCE
    const liveRooms = liveAgentRooms();                                                // same-machine ground truth, read ONCE per tick
    const credsAppId = (() => { try { return loadCreds(home)[platform]?.appId || null; } catch { return null; } })();
    const credsDrift = bakedAppId && credsAppId && credsAppId !== bakedAppId ? { fileAppId: credsAppId, bakedAppId } : false;
    const bindingsSnap = [];
    for (const b of mine) {
      const rc = rooms.get(b.roomId);
      const relay = blockedRooms.has(b.roomId) ? 'blocked' : rc?.polling ? 'up' : 'down';
      const room = rc?.roomStatus || 'unknown';
      const agentState = liveRooms.has(b.roomId) ? 'present' : 'absent';
      if (rc) rc.lastAgentState = agentState;
      // Fill in a human chat name once (persisted to the binding), so list/status stop showing raw oc_ ids.
      let chatName = b.chatName || null;
      if (!chatName) { const nm = await resolveChatName(b.chatId); if (nm) { chatName = nm; store.setChatName(platform, b.chatId, nm); } }
      bindingsSnap.push({ chatId: b.chatId, chatName, roomId: b.roomId, agent: b.agent || null, relay, room, agentState, lastRelayAt: rc?.lastRelayAt || 0 });
    }
    const snap = {
      platform, appId: bakedAppId, ownerPid: process.pid, state: 'running', reconciledAt: now,
      controlPlane: { lark: connState === 'failed' ? 'fail' : 'ok', concord: 'unknown' },
      eventPlane: { state: connState, lastEventAt, status: eventPlaneStatus(connState, lastEventAt, now) },
      credsDrift, bindings: bindingsSnap,
    };
    try {
      const whileDown = trigger === 'start';                            // first reconcile after (re)start
      for (const bc of chatBreadcrumbs(prevSnapshot, snap, { whileDown })) await send(bc.chatId, bc.message).catch(() => {});
    } catch (e) { log('[owner] breadcrumb error: ' + e.message); }
    writeSnapshot(snap);
    prevSnapshot = snap;
  }
  async function reconcile(trigger) {
    if (reconciling) { pendingTrigger = (TRIG_RANK[trigger] ?? 0) > (TRIG_RANK[pendingTrigger] ?? -1) ? trigger : pendingTrigger; return; }
    reconciling = true;
    try { await reconcileOnce(trigger); }
    catch (e) { log('[owner] reconcile error (non-fatal): ' + (e?.message || e)); }
    finally { reconciling = false; const next = pendingTrigger; pendingTrigger = null; if (next) reconcile(next); }
  }

  function start() {
    prevSnapshot = loadPrevSnapshot();   // diff baseline: transitions during downtime surface on restart (C⑥)
    const dispatcher = new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': (data) => onEvent(data).catch((e) => log('[owner] inbound error: ' + e.message)) });
    try { const r = ws.start({ eventDispatcher: dispatcher }); if (r?.catch) r.catch((e) => { connState = 'failed'; log('[owner] ws.start failed: ' + (e?.message || e)); }); }
    catch (e) { connState = 'failed'; log('[owner] ws.start threw: ' + (e?.message || e)); }
    reconcile('start').catch((e) => log('initial reconcile error: ' + e.message));
    // Watch the DIRECTORY (the bindings file may not exist yet at startup), debounced —
    // a fresh `concord host --bind` then brings the relay up AND confirms in the chat.
    let deb;
    try {
      watch(dirname(store.path), { persistent: false }, (_e, fn) => {
        if (fn && fn !== 'im-bindings.json') return;
        clearTimeout(deb); deb = setTimeout(() => reconcile('watch'), 200);
      });
    } catch (e) { log('bindings watch unavailable: ' + e.message); }
    setInterval(() => reconcile('tick'), 45000);   // periodic: catches drift that never touches the bindings file
    log(`✓ concord im owner up (${platform}). Private: message the bot · Group: @ the bot · send /concord-bind to bind a chat.`);
  }
  function shutdown() {
    for (const rc of rooms.values()) rc.polling = false;
    try { ws.close?.({ force: true }); } catch { /* daemon exit closes the socket */ }   // SDK method is close({force}), not stop()
    try { writeSnapshot({ ...(prevSnapshot || { platform, appId: bakedAppId, bindings: [] }), ownerPid: process.pid, state: 'stopped', reconciledAt: Date.now() }); } catch { /* best effort */ }
  }

  return { start, send, shutdown, onEvent, handleBind, handleUnbind, routeMessage, syncRelays, reconcile, _healthPath: HEALTH_PATH };
}

// Runnable: `node src/im-owner.mjs [platform]` — load creds + start the owner.
if (import.meta.url === `file://${process.argv[1]}`) {
  const platform = process.argv[2] || 'lark';
  const c = loadCreds()[platform];
  if (!c?.appId || !c?.appSecret) { console.error(`✗ no ${platform} creds — easiest: \`concord login ${platform} --qr\` (scan a QR; no developer console). Or use --app-id/--app-secret.`); process.exit(1); }
  const owner = createOwner({ platform, appId: c.appId, appSecret: c.appSecret, domain: c.domain, url: process.env.CONCORD_URL, log: console.log });
  process.on('SIGTERM', () => { owner.shutdown(); process.exit(0); });
  process.on('SIGINT', () => { owner.shutdown(); process.exit(0); });
  owner.start();
}
