// `concord im` — the IM OWNER. Owns the bot's single WSClient, holds the chat→room
// bindings, intercepts the bind commands, and (phase 3) relays bound chats to their
// rooms. ONE owner per bot — the single connection owner the single-tenant redesign
// requires (multiple WSClients on one bot = Lark splits events = chaos).
//
// Inbound brain is pure (im-routing.classifyInbound); this wires it to the SDK.
// `concord-bind` / `concord-unbind` are handled HERE and never reach an agent.
import * as Lark from '@larksuiteoapi/node-sdk';
import { loadCreds } from './creds.mjs';
import { openBindings } from './im-bindings.mjs';
import { classifyInbound } from './im-routing.mjs';
import { cleanText } from './im-lark.mjs';

const DOMAINS = { lark: Lark.Domain.Lark, feishu: Lark.Domain.Feishu };
const GROUP_DEFAULT_BUDGET = 1000000;   // decision: a group binding defaults to this (the only token gate once "anyone triggers")
const short = (r) => (r ? String(r).slice(0, 8) : '-');

export function createOwner({ platform = 'lark', appId, appSecret, domain, log = console.log, bindings, _clients = null } = {}) {
  const dom = DOMAINS[domain] || DOMAINS[platform] || Lark.Domain.Lark;
  const client = _clients?.client || new Lark.Client({ appId, appSecret, domain: dom });
  const ws = _clients?.ws || new Lark.WSClient({ appId, appSecret, domain: dom, loggerLevel: Lark.LoggerLevel.warn });
  const store = bindings || openBindings();
  const seen = new Set();   // in-process dedup (Lark resends until acked)

  // Send to a chat: interactive markdown card, plain-text fallback (never silent).
  async function send(chatId, text) {
    if (!chatId || !text) return;
    const asText = () => client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) } });
    try {
      const card = { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: text }] };
      await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) } });
    } catch (e) { log('owner card send failed → text: ' + e.message); await asText().catch((e2) => log('owner text send failed: ' + e2.message)); }
  }

  // concord-bind: reply IN THE CHAT (decision 1) with a ready-to-run command. The bind
  // itself happens when the user runs `concord host --bind <chat_id>` locally.
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

  // A normal message: route to the bound room (phase 3 does the actual relay + reply).
  async function routeMessage(chatId, text, sender) {
    const b = store.get(platform, chatId);
    if (!b) { await send(chatId, '本聊天还没绑 agent — 发 `/concord-bind` 设置。'); return { action: 'unbound' }; }
    log(`→ route [${platform}:${short(chatId)}] → room ${short(b.roomId)} | ${sender}: ${text.slice(0, 80)}`);
    // TODO phase 3: POST into b.roomId and relay the agent's reply back to this chat.
    return { action: 'routed', roomId: b.roomId };
  }

  // Classify one inbound event and dispatch. Returns the decision (for tests).
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
    return { action: d.action };   // 'ignore' | 'usage' (usage handled in phase 3)
  }

  function start() {
    const dispatcher = new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': (data) => onEvent(data).catch((e) => log('[owner] inbound error: ' + e.message)) });
    ws.start({ eventDispatcher: dispatcher });
    log(`✓ concord im owner up (${platform}). Private: message the bot · Group: @ the bot · send /concord-bind to bind a chat.`);
  }
  function shutdown() { try { ws.stop?.(); } catch { /* daemon exit closes the socket */ } }

  return { start, send, shutdown, onEvent, handleBind, handleUnbind, routeMessage };
}

// Runnable: `node src/im-owner.mjs [platform]` — load creds + start the owner.
if (import.meta.url === `file://${process.argv[1]}`) {
  const platform = process.argv[2] || 'lark';
  const c = loadCreds()[platform];
  if (!c?.appId || !c?.appSecret) { console.error(`✗ no ${platform} creds — run: concord login ${platform} --app-id <id> --app-secret <secret>`); process.exit(1); }
  const owner = createOwner({ platform, appId: c.appId, appSecret: c.appSecret, domain: c.domain, log: console.log });
  process.on('SIGTERM', () => { owner.shutdown(); process.exit(0); });
  process.on('SIGINT', () => { owner.shutdown(); process.exit(0); });
  owner.start();
}
