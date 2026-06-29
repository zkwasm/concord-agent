// Pure inbound-routing decisions for the IM owner (`concord im`). No I/O, no SDK —
// unit-testable. The owner cleans the text (cleanText) first, then asks this what to
// do with each message. Keeping the brain pure means the daemon wiring stays thin.

// Strip @mentions and collapse whitespace, lowercased — so a command works whether it
// was sent as "concord-bind" (p2p) or "@bot concord-bind" (group, after cleanText turns
// the @_user_N placeholder into @name).
export function commandOf(text) {
  return String(text || '').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Slash form is canonical (reads as a command, like /usage); bare form accepted too so
// a missing slash doesn't fall through to the agent as "I don't know that command".
const BIND = new Set(['/concord-bind', 'concord-bind']);
const UNBIND = new Set(['/concord-unbind', 'concord-unbind']);
const USAGE = new Set(['/usage', '/stats', '用量']);

// Decide what the owner should do with one inbound message.
//   chatType: 'p2p' | 'group'        mentions: Lark mentions array (group @ signal)
// Routing rule: p2p → always act; group → only when the bot is @-mentioned. Commands
// are matched on the mention-stripped text so the leading @bot in a group is ignored.
// Returns { action: 'ignore'|'bind'|'unbind'|'usage'|'message', text?, reason? }.
export function classifyInbound({ text, chatType, mentions } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { action: 'ignore', reason: 'empty' };
  const atBot = chatType === 'p2p' || (Array.isArray(mentions) && mentions.length > 0);
  if (!atBot) return { action: 'ignore', reason: 'group-no-at' };   // group message that didn't @ the bot
  const cmd = commandOf(clean);
  if (BIND.has(cmd)) return { action: 'bind' };
  if (UNBIND.has(cmd)) return { action: 'unbind' };
  if (USAGE.has(cmd)) return { action: 'usage' };
  return { action: 'message', text: clean };
}
