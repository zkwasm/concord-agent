// Personal-mode Lark / Feishu IM bridge for `concord host --im lark|feishu`.
//
// 1:1 by design: ONE user's own custom-app bot <-> ONE Concord room <-> ONE agent.
// So there is NO chat<->room binding table, NO central relay, NO multi-tenant — the
// gateway-era machinery (deleted with model B) is gone. Inbound IM messages are fed
// straight to the host's turn queue; the agent's replies/progress go back to the
// originating chat (and the room keeps the record).
//
//   Lark/Feishu  ──(WSClient, im.message.receive_v1)──►  host  ──runTurn──►  agent
//   Lark/Feishu  ◄──(im.v1.message.create, card)──────  host  ◄──reply─────  agent
//
// Private chat (p2p): handled directly, NO @ needed (you ↔ your own agent).
// Group chat: only handled when the bot is @-mentioned (Lark only delivers group
// messages the bot is @'d in, so a non-empty `mentions` is the signal).
import * as Lark from '@larksuiteoapi/node-sdk';

const DOMAINS = { lark: Lark.Domain.Lark, feishu: Lark.Domain.Feishu };
export const SUPPORTED = ['lark', 'feishu'];

// Replace Lark @ placeholders (@_user_N) with the readable @name, then trim. Pure.
export function cleanText(text, mentions) {
  let out = text || '';
  for (const mt of mentions || []) {
    if (mt.key) out = out.split(mt.key).join('@' + (mt.name || ''));
  }
  return out.trim();
}

// Whether to act on an inbound message. p2p (private) → always (no @ required).
// group → only if the bot was @-mentioned (non-empty mentions). Pure → unit-tested.
export function shouldHandle({ chatType, mentions } = {}) {
  if (chatType === 'p2p') return true;
  return Array.isArray(mentions) && mentions.length > 0;
}

// Create the IM bridge. Connection (WSClient) needs a real app id/secret, so this is
// only fully exercised against a live Lark/Feishu app; the pure helpers above are
// unit-tested. `_clients` injectable for tests.
export function createImBridge({ platform = 'lark', appId, appSecret, domain, log = console.log, _clients = null } = {}) {
  const dom = DOMAINS[domain] || DOMAINS[platform] || Lark.Domain.Lark;
  const client = _clients?.client || new Lark.Client({ appId, appSecret, domain: dom });
  const ws = _clients?.ws || new Lark.WSClient({ appId, appSecret, domain: dom, loggerLevel: Lark.LoggerLevel.warn });
  const nameCache = new Map();

  // Best-effort display name for an open_id (cached). Falls back if contact scope absent.
  async function resolveName(openId, fallback) {
    if (!openId) return fallback || `${platform} user`;
    if (nameCache.has(openId)) return nameCache.get(openId);
    let name = fallback || `${platform}:${openId.slice(-6)}`;
    try {
      const r = await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } });
      name = r?.data?.user?.name || name;
    } catch { /* contact:user.base scope may be absent → keep fallback */ }
    nameCache.set(openId, name);
    return name;
  }

  // Send text to a chat as an interactive markdown card (so the agent's Markdown
  // renders), falling back to plain text so a card error never means silence.
  async function send(chatId, text) {
    if (!chatId || !text) return;
    const asText = () => client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    try {
      const card = { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: text }] };
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      });
    } catch (e) {
      log('im card send failed, falling back to text: ' + e.message);
      await asText().catch((e2) => log('im text send failed: ' + e2.message));
    }
  }

  // Start receiving. onMessage({ chatId, text, sender }) per actionable inbound.
  // isSeen/markSeen dedup Lark's redelivery (Lark resends until acked).
  function start({ onMessage, isSeen = () => false, markSeen = () => {} } = {}) {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const id = data.message?.message_id;
          if (id && isSeen(id)) return;
          const chatId = data.message?.chat_id;
          const chatType = data.message?.chat_type;            // 'p2p' | 'group'
          const mentions = data.message?.mentions;
          let text = '';
          try { text = JSON.parse(data.message?.content || '{}').text || ''; } catch { /* non-text msg */ }
          text = cleanText(text, mentions);
          if (id) markSeen(id);                                // ack regardless so Lark stops resending
          if (!text || !shouldHandle({ chatType, mentions })) return;   // empty, or group without @ → ignore
          const openId = data.sender?.sender_id?.open_id;
          const sender = await resolveName(openId, data.sender?.sender_id?.user_id);
          onMessage({ chatId, text, sender });
        } catch (e) { log('im inbound error: ' + e.message); }
      },
    });
    ws.start({ eventDispatcher: dispatcher });
    log(`✓ IM bridge up (${platform}) — private chat: just message the bot; group: @ the bot.`);
  }

  function shutdown() { try { ws.stop?.(); } catch { /* daemon exit closes the socket anyway */ } }

  return { start, send, shutdown };
}
