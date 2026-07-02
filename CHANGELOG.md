# Changelog

All notable changes to `concord-agent`. Dates are UTC.

## 0.7.0 — 2026-07-02

Behavior change to token accounting + new in-room commands. **Upgrade is drop-in — bindings,
login creds and room sessions are all preserved (no re-bind / re-login).** The only step:
`concord restart <id>` (or `concord shutdown` + `concord up`) any **currently-running** hosts so
they run the new daemon — the new `concord budget --reset` signals over `SIGUSR2`, which an
old still-running daemon would mishandle.

### Changed
- **Token accounting is now a lifetime cumulative meter.** Usage per task/room only ever grows
  and is **never reset automatically** — not by time, a restart, `/compact`, or `/clear`. The one
  and only way to zero it is an explicit **`concord budget <id> --reset`**. (Previously it reset on
  a rolling 24h window.) This is so you can see exactly how many tokens a whole task consumed.
- **`--budget N` is now a lifetime cap** (was per-window). No cap (the default) → pure metering,
  never pauses. Over the cap, the agent pauses and resumes only via `--reset`.
- **`concord resume` no longer touches the meter** — it only clears a *timeout* pause. Resetting
  the counter is a separate, explicit `concord budget --reset` (now delivered via `SIGUSR2`).
- **Removed** the `--budget-window-hours` flag and `AGENT_BUDGET_WINDOW_HOURS` env (no more window).

### Added
- **Warm resume across restarts.** `concord restart` / crash recovery now resumes the agent's
  previous ACP session (`session/resume`) — the conversation context survives instead of starting
  cold and empty. Falls back to a fresh session (with a log note) when the adapter can't resume.
  `/clear` drops the saved session id so a wiped context is never resumed back.
- **Live plan card.** The agent's TODO list (ACP `plan` updates) is rendered into the room as a
  compact checklist (`📋 计划 2/5` + ☐/▸/✓ lines), re-posted only when an entry's status changes.
  Progress-gated like tool cards.
- **Live context-window meter.** ACP `usage_update` (tokens in context / window size) is persisted
  per room; `concord status` shows a `context 45k / 200k` line and `/usage` appends `上下文 45k/200k`.
- **In-room commands** — type these in the room (or a bound IM chat) to manage the agent's session:
  - `/compact` — compact (summarize) the context (a real turn; its token cost is counted).
  - `/clear` — reset the agent to an empty context by recycling its session. Its **name, room
    membership, IM binding and the cumulative token meter are all kept** — only the agent's memory
    is wiped. (The adapter marks `/clear` unsupported, so this is a bridge-level session recycle.)
  - `/context` — show how much of the context window is in use (read-only).
  - `/help` — list the in-room commands. (Plus the existing `/usage` / `/stats` / `用量`.)
  - Safe allowlist: capability/permission/model/identity commands (`/model`, `/permissions`,
    `/add-dir`, `/login`, …) are deliberately **not** accepted from a room message.

## 0.6.4 — 2026-07-01

Documentation & internal only — **no runtime code changes** (agent/CLI behavior identical to 0.6.3).

### Documentation
- `README.md`: new **Fleet lifecycle** section (`shutdown` soft-stop · `up` · `reset`); `up`/`reset`
  added to the command list; `list`/`bindings` descriptions updated; added this changelog to the package.
- `docs/getting-started.md`: corrected the stale `shutdown` description (it keeps state now).

### Internal
- Test temp dirs are now cleaned up — `hosts`/`creds`/`store` tests were each leaking one
  `mkdtemp` dir per test into `$TMPDIR`.

## 0.6.3 — 2026-07-01

### Fixed
- **Group `/concord-bind` with a multi-word bot name.** When the bot's display name
  contained a space or dot (e.g. `Concord · Arkreen`), a group `@bot /concord-bind`
  was parsed as a normal message ("本聊天还没绑 agent") instead of the bind command —
  the generic `@mention` stripper stopped at the first space and left name residue.
  Commands are now stripped by the exact mention name. (p2p binds were unaffected.)

## 0.6.2 — 2026-07-01

### Fixed
- **`concord im status` / `concord bindings` agent-presence was stale.** They read the
  IM owner's health snapshot, which only refreshes each reconcile (~45s), so a
  just-`stop`ped agent still showed `[ok]`. They now recompute agent presence **live**
  from the local registry (same machine as the agents), so `stop` shows `⚠ 无 agent`
  immediately. The in-chat "no live agent" reply was already live — only the CLI display lagged.

## 0.6.1 — 2026-07-01

### Fixed
- **Replies silently lost after `restart` / `shutdown`+`up`.** A re-spawned agent
  resumed its Concord-room session but always claimed the sender name `AGENT_NAME`,
  even when the session had been created under a 409-fallback name (`claude-1234`).
  Reads (session-only) kept working, so the agent processed messages — but every reply
  `POST` failed the server's `sender == session-owner` check (403) and vanished. The
  bridge now persists the join sender and resumes with it, and self-heals on a 401/403
  room post by re-joining fresh and retrying (recovers state written by older versions).

### Changed
- `concord list` shows the **bound IM chat/bot** for each agent (resolves the Lark group
  name; a p2p chat shows `私聊(<id>)`).
- Single **`🤖 <Agent> 正在处理…`** acknowledgement in IM (was a noisy owner-ack +
  agent-intro + agent-ack triple when driven through `concord im`).

## 0.6.0 — 2026-07-01

### Added
- **Fleet lifecycle.** `concord shutdown` now **keeps** every agent config and IM
  binding (a reversible soft stop); **`concord up`** revives the whole fleet with no
  re-binding; **`concord reset [--yes]`** is the explicit hard wipe (stop all + drop all
  bindings/configs, keeps login creds).
- **Reactive "no live agent" reply.** A message to a bound chat whose room has no live
  local agent gets an immediate "run `concord up`" reply instead of silently vanishing.
- **IM health.** A reconcile loop in the IM owner writes a health snapshot; `concord im
  status` and `concord bindings` surface end-to-end health (long-connection · room
  reachability · agent presence) with the exact next-action command per binding.
- **`host --bind` reuse prompt.** Binding a new chat into a room that already has a live
  local agent offers to reuse that agent (default) instead of spawning a duplicate.

### Changed
- Agent presence is detected from the **local registry** (accurate, same-machine pid
  check) rather than a server "ever-joined" signal that could never report absence.
