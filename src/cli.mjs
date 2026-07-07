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
    if (selfName && content.includes(`@${selfName}`)) return 'wake';
    if (/(^|\s)@\S{1,32}/.test(content)) return 'defer';      // @-ing someone that isn't me
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
  if (/(^|\s)@\S{1,32}/.test(String(m.content || ''))) return false;   // text-scan fallback for relays w/o mentions
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
