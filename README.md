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

## What it is (and isn't)

- **It is**: a thin, owned client that drives a coding agent over the **open ACP protocol** (via the official, vendor-neutral [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) by Zed), plus the room glue, a daemon/lifecycle manager, a token budget, and an optional personal IM bridge.
- **It isn't**: a coordination layer. Rooms, coordination primitives (signals / ballots / claims) and E2EE are Concord's; this CLI just *hosts an agent into* a room. It drives one agent — Concord coordinates many.

The "resident session = zero idle tokens" value comes from ACP itself; this tool packages it for Concord rooms with a budget guard and clean process reclamation.

## Commands

```
concord join <agent> [--room <id>] [--cwd .] [--budget N] [--fg]
    Host a coding agent in a Concord room (web / multi-agent). Progress OFF.
    No --room → opens a browser to create/pick one, then starts.
concord host <agent> [--room <id>] [--cwd .] [--budget N] [--fg]
    join + connect your own IM bot (personal mode). Progress ON.
concord login lark|feishu --app-id <id> [--app-secret <s>]   Store your own bot creds (0600)
concord logout [lark|feishu]
concord list | status <id> | logs <id> [-f]
concord stop <id> | restart <id> | rm <id> | prune
concord budget <id> [--reset] | resume <id>
concord help
```

Hosts run in the background by default (`--fg` to stay foreground). `<agent>`: `claude` (default) | `codex` | `gemini` | …

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

## Token budget

`--budget N` caps fresh tokens per rolling window (`--budget-window-hours`, default 24); over budget pauses the agent and posts a note. `concord budget <id> --reset` / `concord resume <id>` clears the pause. `/usage` in-room shows current usage.

## License

MIT — see [LICENSE](LICENSE).
