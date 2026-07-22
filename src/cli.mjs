// CLI arg parsing + config resolution for the acp host bridge. Pure logic, no
// side effects → unit-testable (cli.test.mjs).
//
// Usage: node acp-bridge.mjs [agent] [--room id] [--cwd dir] [--name n] [--url u]
//                            [--public-url u] [--model m] [--effort e]
// Precedence: CLI flag > env var > default. Env stays supported so existing
// RUNBOOK invocations (CONCORD_ROOM_ID=… AGENT=… node …) keep working.

// Split argv into { flags, positional }. `--k v` → flags.k = v; a lone `--k`
// (end of args or followed by another flag) → flags.k = true.
export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { flags, positional };
}

export function usage() {
  return `concord <join|host> <agent> [room] [options]

  Host a coding agent in a Concord room — ACP-driven (official @agentclientprotocol/sdk), resident, idle = zero tokens.

  <agent>                     agent: claude | codex | gemini | … (default: claude)

  --room <id>                 Concord room to join (or pass positionally: concord join <agent> <id>). Omit → browser to create/pick one.
  --cwd <dir>                 Working directory the agent operates in (default: current dir)
  --url <url>                 Concord server base (default: https://concord.fenginwind.com; use http://localhost:3001 for local dev)
  --name <name>              Agent display name in the room (default: <agent>)
  --budget <n>                Lifetime fresh-token cap, then pause (default: unlimited; reset via "concord budget --reset")
  --model <m>                 Shown in the self-introduction (display only)
  --effort <e>                Shown in the self-introduction (display only)
  --public-url <url>          Public Concord base for the browser connect link (default: --url)
  -h, --help                  Show this help

  In-room commands:  /compact (compact context) · /clear (fresh session) · /context (context usage) · /usage (cumulative tokens) · /help

  Env equivalents (flag wins): CONCORD_ROOM_ID, AGENT_CWD, CONCORD_URL, AGENT_NAME,
  AGENT_TOKEN_BUDGET, AGENT_MODEL, AGENT_EFFORT, ACP_ADAPTER_CMD, ACP_PERMISSION.`;
}

// Resolve effective config. roomId / cwd default to null so the caller can decide
// what "unset" means (room → web handoff; cwd → process.cwd()).
export function resolveConfig(argv, env = {}) {
  const { flags, positional } = parseArgs(argv);
  const pick = (flag, key, def) => flags[flag] ?? env[key] ?? def;
  const agent = positional[0] || pick('agent', 'AGENT', 'claude');
  return {
    agent,
    name: pick('name', 'AGENT_NAME', agent),
    cwd: pick('cwd', 'AGENT_CWD', null),
    url: pick('url', 'CONCORD_URL', 'https://concord.fenginwind.com'),       // hosted Concord by default; --url http://localhost:3001 for local dev
    publicUrl: pick('public-url', 'CONCORD_PUBLIC_URL', null),
    roomId: flags.room ?? positional[1] ?? env.CONCORD_ROOM_ID ?? null,      // --room > positional (concord join <agent> <room>) > env > web handoff
    model: pick('model', 'AGENT_MODEL', ''),
    effort: pick('effort', 'AGENT_EFFORT', ''),
    budget: pick('budget', 'AGENT_TOKEN_BUDGET', null),                       // lifetime max fresh tokens; null = unlimited (pure metering)
    label: pick('as', 'CONCORD_LABEL', null),                                // --as <label>: a memorable handle for `concord list`/`stop`/… (registry metadata only)
    im: pick('im', 'ACP_IM', null),                                          // 'lark' | 'feishu' — bridge this host's room to your IM bot
    bind: flags.bind ?? null,                                                // --bind <chat_id>: bind this host's room to an IM chat (the `concord im` owner relays)
    force: flags.force === true,                                             // --force: overwrite an existing binding
    // progress is tri-state: true (--progress) / false (--no-progress) / null (use mode default: host=on, join=off)
    progress: flags.progress === true ? true : (flags['no-progress'] === true ? false : (env.ACP_PROGRESS != null ? env.ACP_PROGRESS === '1' : null)),
  };
}

// Wake economics: DELIVERY (the agent's context must contain every room message,
// in order) is nearly free via the batched inbox; a WAKE (an LLM turn) is the
// expensive part and must signal addressed intent. Classification:
//   'skip'  — own echoes (already in its context), and pure standing-by/NOOP
//             filler from other agents (no content, no context → dropped, so an
//             idle room can't sustain a "待命中" echo)
//   'wake'  — @-mentions me (anyone), or a human message with no @ at all
//   'defer' — everything else: agents' un-mentioned chatter/status posts,
//             messages @-ing others, system notices. Delivered later as one
//             batched context block on the agent's next NATURAL wake, never a
//             per-message turn — so N agents can't bill each other for small talk.
// Mentions come server-resolved (m.mentions); a text-scan fallback covers relays
// that don't carry the field.
export function classifyInbound(m, selfName) {
  if (!m) return 'skip';
  if (m.sender === selfName) return 'skip';
  if (m.senderType === 'system' || m.sender === 'system') return 'defer';
  const self = String(selfName || '').trim().toLowerCase();
  const mentions = Array.isArray(m.mentions) ? m.mentions : null;
  if (mentions) {
    if (mentions.some((x) => String(x).trim().toLowerCase() === self)) return 'wake';
    if (mentions.length) return 'defer';                      // addressed to someone else
  } else {
    const content = String(m.content || '');
    if (textMentionsName(content, selfName)) return 'wake';
    if (hasMentionToken(content)) return 'defer';             // @-ing someone that isn't me
  }
  // A pure standing-by / NOOP filler broadcast carries no content and no context;
  // dropping it (not even inboxing) is what stops an idle room from sustaining a
  // "待命中" echo. @-me was already resolved to 'wake' above, so this only hits
  // un-addressed agent posts.
  if (m.senderType !== 'human' && isFiller(m.content)) return 'skip';
  return m.senderType === 'human' ? 'wake' : 'defer';         // bare broadcast: humans wake everyone; agent status posts don't
}

// Back-compat shim (0.7.3 name): anything not 'skip' used to relay.
export function shouldRelayInbound(m, selfName) {
  return classifyInbound(m, selfName) !== 'skip';
}

// A "bare human broadcast": a human message addressed to NO ONE (no mentions, no
// @ anywhere). This is the ONLY kind of wake that answer-arbitration acts on — an
// @-mention (of me or anyone) is deliberately excluded, so a human who @-picks a
// specific agent still gets an immediate, un-arbitrated reply. Mirrors the
// classifyInbound branch `senderType==='human' && no @ → wake`.
export function isBareHumanBroadcast(m, selfName) {
  if (!m) return false;
  if ((m.senderType || 'human') !== 'human') return false;
  if (m.sender === selfName) return false;
  const mentions = Array.isArray(m.mentions) ? m.mentions : null;
  if (mentions && mentions.length) return false;                 // addressed to someone
  if (hasMentionToken(m.content)) return false;                  // text-scan fallback for relays w/o mentions
  return true;
}

// A "pure filler" broadcast: a bare NOOP, or a short standing-by line ("待命中",
// "NOOP —— 待命中", "standing by"). It carries no action and no context — the fuel
// of the multi-agent echo loop. NARROW by design: anything with real substance
// (a status report that merely opens with "NOOP", or anything ≥ a short line) is
// NOT filler and must pass through; a message addressing someone (@) is never
// filler. Used both to suppress an agent's own filler output and to drop peers'
// filler on the way in.
export function isFiller(content) {
  let s = String(content == null ? '' : content).trim();
  if (s === '') return false;                                                   // empty isn't filler — the ✓/silent branches own that
  if (/@\S/.test(s)) return false;                                              // addresses someone → real
  s = s.replace(/^[\s(（【\[]*noop\b[\s)）】\]:：—–\-.。!！,，、]*/i, '').trim();  // strip a leading NOOP token + its trailing dashes/punct
  if (s === '') return true;                                                     // bare NOOP (± punctuation)
  return s.length <= 16 && /^(待\s*命|standing\s*by)/i.test(s);                  // short line that OPENS with a standing-by phrase
}

// A TRANSIENT turn failure: the provider throttled us, is overloaded, or the
// transport blipped. The same prompt typically succeeds moments later, so these
// must be retried rather than reported as a dead end — a dropped turn costs the
// message that triggered it AND leaves an un-addressed note behind, which peers
// classify as ambient chatter, so the room falls silent for good.
// Our own stuck-turn cancellation is deliberately excluded: that turn already ran
// past the ceiling, and re-running it would just burn the ceiling again.
const TRANSIENT_TURN_RE = /rate.?limit|temporarily limiting|overloaded?|too many requests|\b(429|502|503|504|529)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network error/i;
export function isTransientTurnError(e) {
  if (!e) return false;
  if (e.code === 'TURN_TIMEOUT') return false;     // our own per-turn ceiling, not the provider's
  return TRANSIENT_TURN_RE.test(String(e.message ?? e));
}

// A room note that addresses NOBODY wakes nobody: peers classify an un-@'d agent
// post as ambient context, never a turn. So a failure note or a command result
// must be addressed back at whoever triggered it, or the exchange ends in silence.
export function mentioning(name, text, selfName) {
  const n = String(name || '').trim();
  return !n || n === String(selfName || '').trim() ? text : `@${n} ${text}`;
}

// An @ only starts a mention when the char before it couldn't belong to an email
// local-part / URL path / npm scope — "user@bob.com" and "x.com/@bob" must not
// wake bob, and a one-letter name must not substring-match inside "@alice".
// Mirrors the server's parseMentions boundary; fullwidth ＠ (CJK IMEs) counts.
const AT_LEFT = '(?<![A-Za-z0-9_.@+/\\-])';
const normalizeAt = (s) => String(s == null ? '' : s).replace(/＠/g, '@');

// Does the text @-mention this exact name (boundary-aware, case-insensitive)?
// The text-scan fallback for relays that don't carry server-resolved mentions.
export function textMentionsName(content, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Right boundary bars a CONTINUING Latin word char ("@bobby" ≠ bob) but
  // allows a following CJK char — Chinese runs on with no space ("@bob看看").
  return new RegExp(AT_LEFT + '@' + esc + '(?![A-Za-z0-9_-])', 'iu').test(normalizeAt(content));
}

// Does the text @-mention ANYONE at all (any well-formed mention token)?
export function hasMentionToken(content) {
  return new RegExp(AT_LEFT + '@\\S', 'u').test(normalizeAt(content));
}

// The addressing INVARIANT: every posted turn reply must @ someone — an agent
// message that mentions no one wakes no one (the #1 stall cause: a finished
// speaker forgetting the handoff), and with broadcast self-judgment it is also
// what caps a chain reaction (a broadcast may only ever produce ADDRESSED
// replies, so a broadcast can never breed another broadcast). A reply that
// already @s someone passes through untouched; one that doesn't is addressed
// back at whoever triggered the turn.
export function ensureAddressed(text, triggerSender, selfName) {
  if (hasMentionToken(text)) return text;
  return mentioning(triggerSender, text, selfName);
}

// …but an addressed failure note WAKES its addressee, and a peer that is failing
// too answers with its own addressed failure note: a two-agent error ping-pong,
// the same echo-loop shape 0.7.9 removed. This gate addresses a peer at most ONCE
// per consecutive-failure streak — a repeat goes out un-addressed (nobody woken,
// the human still sees it) — and any successful turn clears the streak.
// A turn's input = the batched inbox (missed context, if any) prepended to the
// message that actually woke the agent.
//
// EXCEPT for a passthrough slash command, which must reach the adapter with "/" at
// offset 0 — the adapter only treats a prompt as a command when the text ITSELF
// starts with one. Prepending the inbox silently degrades `/compact` into ordinary
// chat (the agent then TALKS about compacting instead of compacting), and in a
// multi-agent room the inbox is almost never empty — so the command would fail
// precisely where it is needed most. Verified live: two agents, same `/compact`,
// the one with a non-empty inbox never ran it.
export function composeTurnText(item, inbox = [], dropped = 0, locale = 'en') {
  if (item?.slash || !inbox.length) return item.text;
  const head = (locale === 'zh'
    ? `(以下 ${inbox.length} 条是你未被唤醒期间的房间消息,按时间顺序,仅供同步上下文,无需逐条回应${dropped ? `;更早 ${dropped} 条已省略` : ''}:)\n`
    : `(The following ${inbox.length} room message(s) arrived while you were away, in order — context only, no need to reply to each${dropped ? `; ${dropped} earlier one(s) omitted` : ''}:)\n`)
    + inbox.map((x) => `[${x.sender}] ${x.content}`).join('\n') + '\n\n';
  return head + item.text;
}

export function createFailureGate() {
  let last = null;
  return {
    addressee(sender) {
      const repeat = Boolean(sender) && sender === last;
      last = sender ?? null;
      return repeat ? null : sender;
    },
    reset() { last = null; },
  };
}
