// Pure inbound-routing decisions for the IM owner (`concord im`). No I/O, no SDK —
// unit-testable. The owner cleans the text (cleanText) first, then asks this what to
// do with each message. Keeping the brain pure means the daemon wiring stays thin.

// Strip @mentions and collapse whitespace, lowercased — so a command works whether it
// was sent as "concord-bind" (p2p) or "@bot concord-bind" (group). cleanText turned each
// @_user_N placeholder into "@"+mt.name, so strip those EXACT names first — a bot name with
// spaces/dots ("Concord · Arkreen") would otherwise leave residue after the generic @\S+
// strip (which stops at the first space) and the command would never match.
export function commandOf(text, mentions) {
  let s = String(text || '');
  for (const mt of mentions || []) if (mt.name) s = s.split('@' + mt.name).join(' ');
  return s.replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Slash form is canonical (reads as a command, like /usage); bare form accepted too so
// a missing slash doesn't fall through to the agent as "I don't know that command".
const BIND = new Set(['/concord-bind', 'concord-bind']);
const UNBIND = new Set(['/concord-unbind', 'concord-unbind']);
const USAGE = new Set(['/usage', '/stats', '用量']);
const HELP = new Set(['/help', 'help', '帮助']);
const AGENTS = new Set(['/agents', 'agents']);

// Decide what the owner should do with one inbound message.
//   chatType: 'p2p' | 'group'        mentions: Lark mentions array (group @ signal)
//   soloGroup: the group holds one human + the bot → treat like p2p (no @ needed)
// Routing rule: p2p (or a solo group) → always act; a shared group → only when the bot
// is @-mentioned. Commands are matched on the mention-stripped text so a leading @bot is
// ignored. Returns { action: 'ignore'|'bind'|'unbind'|'usage'|'message', text?, reason? }.
export function classifyInbound({ text, chatType, mentions, soloGroup = false } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { action: 'ignore', reason: 'empty' };
  const atBot = chatType === 'p2p' || soloGroup || (Array.isArray(mentions) && mentions.length > 0);
  if (!atBot) return { action: 'ignore', reason: 'group-no-at' };   // shared group message that didn't @ the bot
  const cmd = commandOf(clean, mentions);
  if (BIND.has(cmd)) return { action: 'bind' };
  if (UNBIND.has(cmd)) return { action: 'unbind' };
  if (HELP.has(cmd)) return { action: 'help' };
  if (AGENTS.has(cmd)) return { action: 'agents' };
  if (USAGE.has(cmd)) return { action: 'usage' };
  return { action: 'message', text: clean };
}
