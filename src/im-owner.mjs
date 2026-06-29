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
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { loadCreds } from './creds.mjs';
import { openBindings } from './im-bindings.mjs';
import { classifyInbound } from './im-routing.mjs';
import { cleanText } from './im-lark.mjs';

const DOMAINS = { lark: Lark.Domain.Lark, feishu: Lark.Domain.Feishu };
const GROUP_DEFAULT_BUDGET = 1000000;   // a group binding defaults to this (the only token gate once "anyone triggers")
const RELAY_SENDER = 'IM';              // the owner's identity in each bound room; replies from anyone else are relayed back
const short = (r) => (r ? String(r).slice(0, 8) : '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOwner({ platform = 'lark', appId, appSecret, domain, url, log = console.log, bindings, _clients = null } = {}) {
  const dom = DOMAINS[domain] || DOMAINS[platform] || Lark.Domain.Lark;
  const client = _clients?.client || new Lark.Client({ appId, appSecret, domain: dom });
  const ws = _clients?.ws || new Lark.WSClient({ appId, appSecret, domain: dom, loggerLevel: Lark.LoggerLevel.warn });
  const fetchImpl = _clients?.fetch || globalThis.fetch;
  const CONCORD_URL = url || process.env.CONCORD_URL || 'https://concord.fenginwind.com';
  const store = bindings || openBindings();
  const seen = new Set();         // in-process dedup (Lark resends until acked)
  const rooms = new Map();        // roomId → { sessionId, chatId, polling }

  // ---- IM side: send to a chat (interactive card, plain-text fallback) ----
  async function send(chatId, text) {
    if (!chatId || !text) return;
    const asText = () => client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) } });
    try {
      const card = { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: text }] };
      await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) } });
    } catch (e) { log('owner card send failed → text: ' + e.message); await asText().catch((e2) => log('owner text send failed: ' + e2.message)); }
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
    while (rc && rc.polling) {
      try {
        const res = await fetchImpl(`${CONCORD_URL}/agent/rooms/${roomId}/messages?session=${rc.sessionId}&wait=30`);
        if (res.status === 401) { const j = await roomJoin(roomId); rc.sessionId = j.sessionId; rc.relaySender = j.sender; continue; }
        for (const m of (await res.json()).messages || []) {
          if (m.sender === rc.relaySender) continue;        // our own injected user message → don't echo back
          await send(rc.chatId, m.content);                 // agent reply/progress → the IM chat
        }
      } catch (e) { log('relay poll error: ' + e.message); await sleep(2000); }
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
      await send(chatId, `本聊天已绑定到 room \`${short(existing.roomId)}\`。要重绑,在你机器上跑:\n\`concord host claude --bind ${chatId} --force\``);
      return { action: 'already-bound', roomId: existing.roomId };
    }
    const budget = chatType === 'group' ? ` --budget ${GROUP_DEFAULT_BUDGET}` : '';
    await send(chatId, `本聊天(${chatType}, \`${chatId}\`)还没绑 agent。在你机器上跑:\n\`concord host claude --bind ${chatId}${budget}\`\n这会起一个 agent 并把本聊天绑给它。`);
    return { action: 'prompted', chatId, chatType };
  }
  async function handleUnbind(chatId) {
    const ok = store.unbind(platform, chatId);
    await send(chatId, ok ? '✓ 已解绑,本聊天不再路由到 agent。' : '本聊天当前没有绑定。');
    return { action: ok ? 'unbound' : 'not-bound' };
  }
  // A normal message: instant ack (decision 4), then POST into the bound room.
  async function routeMessage(chatId, text, sender) {
    const b = store.get(platform, chatId);
    if (!b) { await send(chatId, '本聊天还没绑 agent — 发 `/concord-bind` 设置。'); return { action: 'unbound' }; }
    await send(chatId, '收到 👌');
    try {
      const rc = await ensureRoom(b.roomId, chatId);
      await roomPost(b.roomId, rc.sessionId, rc.relaySender, `${sender}: ${text}`);
    } catch (e) { log('route failed: ' + e.message); await send(chatId, `⚠️ 转发到 agent 失败(${String(e.message).slice(0, 80)})`); return { action: 'route-failed' }; }
    return { action: 'routed', roomId: b.roomId };
  }

  async function onEvent(data) {
    const m = data?.message || {};
    const id = m.message_id;
    if (id && seen.has(id)) return { action: 'dup' };
    if (id) seen.add(id);
    let raw = ''; try { raw = JSON.parse(m.content || '{}').text || ''; } catch { /* non-text */ }
    const text = cleanText(raw, m.mentions);
    const d = classifyInbound({ text, chatType: m.chat_type, mentions: m.mentions });
    const chatId = m.chat_id;
    const sender = data?.sender?.sender_id?.open_id || 'user';
    log(`[owner] ${m.chat_type} ${short(chatId)} text=${JSON.stringify(text.slice(0, 40))} → ${d.action}`);
    if (d.action === 'bind') return handleBind(chatId, m.chat_type);
    if (d.action === 'unbind') return handleUnbind(chatId);
    if (d.action === 'message') return routeMessage(chatId, d.text, sender);
    return { action: d.action };   // 'ignore' | 'usage'
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
        if (notify) await send(b.chatId, '✓ 绑定成功,agent 已就位 —— 直接发任务给我吧。');
      } catch (e) {
        log('relay start failed: ' + e.message);
        if (notify) await send(b.chatId, `⚠️ 绑定失败:连不上房间(${String(e.message).slice(0, 80)})。`);
      }
    }
    for (const [roomId, rc] of rooms) if (!bound.has(roomId)) { rc.polling = false; rooms.delete(roomId); log(`relay down: room ${short(roomId)} (unbound)`); }
  }

  function start() {
    const dispatcher = new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': (data) => onEvent(data).catch((e) => log('[owner] inbound error: ' + e.message)) });
    ws.start({ eventDispatcher: dispatcher });
    syncRelays({ notify: false }).catch((e) => log('initial sync error: ' + e.message));   // existing bindings — silent
    // Watch the DIRECTORY (the bindings file may not exist yet at startup), debounced —
    // a fresh `concord host --bind` then brings the relay up AND confirms in the chat.
    let deb;
    try {
      watch(dirname(store.path), { persistent: false }, (_e, fn) => {
        if (fn && fn !== 'im-bindings.json') return;
        clearTimeout(deb); deb = setTimeout(() => syncRelays({ notify: true }).catch((e) => log('reload error: ' + e.message)), 200);
      });
    } catch (e) { log('bindings watch unavailable: ' + e.message); }
    log(`✓ concord im owner up (${platform}). Private: message the bot · Group: @ the bot · send /concord-bind to bind a chat.`);
  }
  function shutdown() { for (const rc of rooms.values()) rc.polling = false; try { ws.stop?.(); } catch { /* daemon exit closes the socket */ } }

  return { start, send, shutdown, onEvent, handleBind, handleUnbind, routeMessage, syncRelays };
}

// Runnable: `node src/im-owner.mjs [platform]` — load creds + start the owner.
if (import.meta.url === `file://${process.argv[1]}`) {
  const platform = process.argv[2] || 'lark';
  const c = loadCreds()[platform];
  if (!c?.appId || !c?.appSecret) { console.error(`✗ no ${platform} creds — run: concord login ${platform} --app-id <id> --app-secret <secret>`); process.exit(1); }
  const owner = createOwner({ platform, appId: c.appId, appSecret: c.appSecret, domain: c.domain, url: process.env.CONCORD_URL, log: console.log });
  process.on('SIGTERM', () => { owner.shutdown(); process.exit(0); });
  process.on('SIGINT', () => { owner.shutdown(); process.exit(0); });
  owner.start();
}
