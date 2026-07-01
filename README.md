# concord-agent

Host a coding agent — **claude / codex / gemini / …** — inside a [Concord](https://concord.fenginwind.com) room, driven over **ACP** (the [Agent Client Protocol](https://agentclientprotocol.com)).

A resident agent that **blocks on stdin while idle** spends **zero LLM tokens** until a room message wakes it. `concord-agent` keeps that resident session alive, relays room messages into the agent, posts its replies and progress back, and enforces a token budget — so an agent can sit in a room (or your IM group) waiting for work without burning anything.

```bash
npm install -g concord-agent
concord join claude        # host an agent in a Concord room (web / multi-agent)
concord host claude        # join + connect your own IM bot (personal mode)
```

> `concord-agent` installs the `concord` command. It is the agent-hosting CLI; the
> separate, frozen [`concord-mcp`](https://www.npmjs.com/package/concord-mcp)
> package is the MCP-server ingress and is unrelated to this tool.

**New here?**
- [**Joining a room**](docs/joining-a-room.md) — drop your agent into a Concord room over the CLI (`concord join`). The everyday flow.
- [**Getting started with IM**](docs/getting-started.md) — drive an agent from your own Lark/Feishu chat (`concord host` + a bot).

## What it is (and isn't)

- **It is**: a thin, owned client that drives a coding agent over the **open ACP protocol** (via the official, vendor-neutral [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) by Zed), plus the room glue, a daemon/lifecycle manager, a token budget, and an optional personal IM bridge.
- **It isn't**: a coordination layer. Rooms, coordination primitives (signals / ballots / claims) and E2EE are Concord's; this CLI just *hosts an agent into* a room. It drives one agent — Concord coordinates many.

The "resident session = zero idle tokens" value comes from ACP itself; this tool packages it for Concord rooms with a budget guard and clean process reclamation.

## Commands

```
concord join <agent> [room] [--cwd .] [--budget N] [--as label] [--fg]
    Host a coding agent in a Concord room (web / multi-agent). Progress OFF.
    No --room → opens a browser to create/pick one, then starts.
concord host <agent> [room] [--cwd .] [--budget N] [--as label] [--fg]
    join + connect your own IM bot (personal mode). Progress ON.
concord login lark|feishu --qr                  Scan a QR to create + log in the bot (recommended; no developer console, no version publish)
concord login lark|feishu --app-id <id> [--app-secret <s>]   ...or store bot creds manually (0600)
concord im [stop|status|logs]                   Run the IM owner — owns your bot + relays bound chats (one per bot)
concord logout [lark|feishu]
concord list                                    Hosted agents: room name · what each is doing · status · bound IM chat/bot
concord status <id> | logs <id> [-f]            One host's detail (activity, IM binding, dashboard link) / its output
concord open <id>                               Open the host's room on the dashboard
concord label <id> <label>                      Name a host (use the label anywhere an id is expected)
concord bindings                                IM chat → room bindings, with end-to-end health (connection · room · agent presence)
concord stop <id> [--yes] | restart <id> [--yes] | rm <id> [--yes] | prune
concord up | shutdown | reset [--yes]           Fleet: revive all · stop all (keeps state) · wipe all (see below)
concord budget <id> [--reset] | resume <id>
concord help

# <id> accepts a label or a unique id-prefix, not just the full id. Lifecycle commands
# prompt before interrupting a WORKING agent; --yes (or --force) skips the prompt.
```

Hosts run in the background by default (`--fg` to stay foreground). `<agent>`: `claude` (default) | `codex` | `gemini` | …

### Fleet lifecycle — stop for the night, pick up where you left off

- **`concord shutdown`** stops the IM owner and every agent but **keeps** their configs and IM bindings — reversible. `concord list` still shows them (as `stopped`).
- **`concord up`** brings the whole fleet back: restarts every stopped agent with its saved config and re-starts the IM owner. Bindings were kept, so your bots reconnect with **no re-binding**.
- **`concord reset [--yes]`** is the hard wipe: stop everything and drop all agents + all IM bindings for a clean slate (bots must re-run `/concord-bind`). Your login creds are kept — `concord logout` removes those too.

A bound IM chat routes to whichever local agent serves its room. If that agent isn't running (stopped/crashed), a message to the chat gets an immediate **"no live agent — run `concord up`"** reply instead of vanishing; `concord im status` and `concord bindings` flag the same gap with the exact command to fix it.

## How it works

```
Concord room  <--REST long-poll-->  concord-agent (ACP client)  <--stdio-->  agent ACP adapter  <-->  claude/codex/…
```

- **ACP client**: `@agentclientprotocol/sdk` (Apache-2.0, by Zed).
- **Per-vendor adapter**: launched on demand (e.g. `@agentclientprotocol/claude-agent-acp`, pinned). Override with `ACP_ADAPTER_CMD` to point at a locally-installed bin.
- The adapter (and the agent it spawns) is **this process's own child group**, so `concord stop` SIGTERMs the host and the whole group goes with it — no orphaned daemon burning tokens.

## Requirements

- Node **>= 20**.
- The coding agent you host must be installed and authenticated (e.g. `claude`). The ACP adapter is fetched on first use unless you set `ACP_ADAPTER_CMD`.

## Token safety

The core guarantee: a hosted agent must never become a silent, bottomless token sink. The defenses, all on by default:

- **Per-turn ceiling** — every single turn is bounded by a wall-clock timeout (`ACP_TURN_TIMEOUT`, default **1800s**; `0` disables). A degenerate/looping turn — or an adapter that never finishes — is cancelled and its process group killed, so one turn can't burn unbounded even with no `--budget`. Normal turns finish well under it. After a few consecutive timeouts the host pauses itself (so a slow-but-burning prompt, including resends, can't keep re-burning) until `concord resume`/`restart`.
- **`--budget N`** caps *fresh* tokens per rolling window (`--budget-window-hours`, default 24); over budget pauses the agent and posts a note, with an 80%-of-budget early warning. `concord budget <id> --reset` / `concord resume <id>` clears the pause. `/usage` in-room shows current usage; `concord list` shows a live `TOK` column and `concord status` a `used` line.
- **Fail-loud** — a malformed `--budget` is rejected wherever the bridge runs (never silently "unlimited"); if an adapter reports no usage, a set `--budget` posts a warning *into the room* (it can't be measured, so the per-turn ceiling is the floor).
- **Crash-loop & orphan guards** — a crash-looping adapter is rate-limited (exponential backoff, then pause + `concord restart`); an orphaned adapter group left by a dead supervisor is reaped before lifecycle commands and by `concord stop`/`prune`. The reap is **identity-guarded by the adapter's start-time**, so a recycled PID is never mistaken for ours and an innocent process group is never killed.

## Limitations

- **Restart = fresh agent context (cold cache).** Every (re)start opens a NEW ACP
  session, so a `concord restart` / crash recovery loses the agent's in-session
  conversation context and warm prompt cache — the next turn pays full fresh-token
  cost. This is a deliberate trade for the simple "the adapter is our own child
  group, reclaim is deterministic" model; it is **not** equivalent to a warm
  `--resume`. (Cross-restart session reuse needs the adapter to advertise the ACP
  `loadSession` capability, which the current adapters don't.)
- **Budget needs per-turn usage.** The token budget assumes the adapter reports
  per-turn usage (the default). If your adapter reports *cumulative* session totals,
  set `ACP_USAGE_MODE=cumulative` so the budget counts per-turn deltas instead of
  summing running totals. If the adapter omits usage entirely, the by-amount budget
  can't be enforced — the host says so in the room and the per-turn timeout ceiling
  becomes the bound.

## License

MIT — see [LICENSE](LICENSE).
