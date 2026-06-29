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
  --budget <n>                Max fresh tokens per window, then pause (default: unlimited)
  --budget-window-hours <h>   Rolling budget window in hours (default: 24)
  --model <m>                 Shown in the self-introduction (display only)
  --effort <e>                Shown in the self-introduction (display only)
  --public-url <url>          Public Concord base for the browser connect link (default: --url)
  -h, --help                  Show this help

  In-room commands:  /usage — show token usage for this agent

  Env equivalents (flag wins): CONCORD_ROOM_ID, AGENT_CWD, CONCORD_URL, AGENT_NAME,
  AGENT_TOKEN_BUDGET, AGENT_BUDGET_WINDOW_HOURS, AGENT_MODEL, AGENT_EFFORT, ACP_ADAPTER_CMD, ACP_PERMISSION.`;
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
    budget: pick('budget', 'AGENT_TOKEN_BUDGET', null),                       // max fresh tokens / window; null = unlimited
    budgetWindowHours: pick('budget-window-hours', 'AGENT_BUDGET_WINDOW_HOURS', null), // rolling window, default 24h
    im: pick('im', 'ACP_IM', null),                                          // 'lark' | 'feishu' — bridge this host's room to your IM bot
    bind: flags.bind ?? null,                                                // --bind <chat_id>: bind this host's room to an IM chat (the `concord im` owner relays)
    force: flags.force === true,                                             // --force: overwrite an existing binding
    // progress is tri-state: true (--progress) / false (--no-progress) / null (use mode default: host=on, join=off)
    progress: flags.progress === true ? true : (flags['no-progress'] === true ? false : (env.ACP_PROGRESS != null ? env.ACP_PROGRESS === '1' : null)),
  };
}
