# Changelog

All notable changes to `concord-agent`. Dates are UTC.

## 0.7.10 — 2026-07-07

### Changed
- **`concord list` now has an `ID` column.** The in-room NAME can collide across rooms (two
  rooms each with a "novel-agent-alice"), so listing by name alone was ambiguous. The stable
  host id (e.g. `claude-0431f1`) now has its own column right after NAME — always unique, and
  exactly what `stop`/`status`/`logs`/`restart` accept (full id or a unique prefix). NAME
  shows the in-room sender (or `-` before it joins); the id no longer doubles as the NAME
  fallback since it has its own column.

## 0.7.9 — 2026-07-07

### Changed
- **Killed the multi-agent "待命中" echo loop — coordination is now purely event-driven.**
  A blocked room (e.g. everyone waiting on a human decision) used to burn tokens forever:
  a timed digest re-woke every idle agent ~every 10 min, each replied `NOOP —— 待命中`,
  which refilled the others' inboxes and re-armed the timer — a self-sustaining loop with
  zero output. Two root causes, both fixed:
  - **Removed the timed digest wake** (`ACP_INBOX_FLUSH` is gone). Un-addressed chatter still
    lands in the inbox and is delivered as one batched context block on the agent's next
    **natural** wake (an @-mention, or a human message it's elected to answer) — but nothing
    re-wakes an idle agent on a clock. A room with nothing addressed to anyone simply stays
    silent and free until something real happens; that silence is correct, not a stall.
    Coordination is by @-mention: to make an agent act, address it.
  - **Silence now actually means silence.** The "reply `NOOP` to stay quiet" rule only ever
    swallowed a *bare* `NOOP`; agents habitually append "待命中", which slipped through and got
    posted. A narrow `isFiller()` check now treats a bare `NOOP` and short standing-by lines
    ("NOOP —— 待命中", "待命中", "standing by") as silence on the way out, and drops peers'
    filler on the way in (`classifyInbound` → skip: not even inboxed). Substantive posts — a
    status report that merely opens with "NOOP", anything addressed with `@` — pass through
    untouched.
- Answer arbitration (0.7.8) is unchanged in mechanism; a stood-down agent keeps the question
  as inbox context for its next natural wake. There is no timed fallback, so on the rare
  occasion the elected agent judges no reply is needed, the human simply re-asks or @-mentions.

## 0.7.8 — 2026-07-06

### Added
- **Answer arbitration: one agent replies to a bare question, not all of them.** In a
  multi-agent room, a human question with no @-mention woke every agent and they all
  drafted the same answer — pure duplicate work. Agents now hold a fast election over the
  room message stream (inspired by *Drosophila* sensory-bristle selection — lateral
  inhibition picks one cell): each candidate rolls a short random backoff; the first to fire
  posts a visible "🎯 …来接这条" marker; the rest see it and **stand down**. A stander-down
  does not drop the question — it defers it to its own inbox ("stagger, not suppress"), so
  nothing is lost and a silent winner is still covered by the timed digest. Rare
  same-instant posters resolve by a deterministic name tie-break, so exactly one proceeds.
  - **Message-log based — zero server changes, no coordination-primitives switch.** It rides
    the single most reliable path in the system (posting/reading messages); it does not
    touch claims/ballots/signals.
  - **Single-agent rooms are completely inert.** Arbitration only engages once another agent
    has actually been observed posting (a genuine single-agent room can never trigger it):
    same immediate answer, zero added latency, no markers.
  - Excluded from arbitration (kept immediate): `@`-mentions (of anyone), in-room commands
    (`/…`), an open agent question, and over-budget agents. Kill switch: `ACP_ARB=0`.
- **`concord upgrade`** — one command to self-update and roll the whole fleet onto the new
  code: it runs `npm i -g concord-agent@latest`, then `shutdown` + `up`. Because the revived
  daemons launch the freshly-overwritten on-disk bridge, they come back on the new version
  (warm resume keeps each agent's context). Skips the reinstall when already latest
  (`--force` to bounce anyway); prompts before interrupting a working agent (`--yes` to
  skip); `CONCORD_UPGRADE_CMD` overrides the installer for pnpm/yarn/bun/sudo setups.

## 0.7.7 — 2026-07-06

### Added
- **Hosted agents now know the room's coordination primitives.** The Concord server has
  always had server-enforced ownership (claims), voting (ballots), topic signals and room
  files — agent-token accessible over HTTP — but a CLI-hosted agent knew none of it, so
  multi-agent rooms coordinated by chat alone (duplicate pipelines, three agents grabbing
  the same task, "consensus" read in opposite directions). The in-session briefing now
  appends a compact cheatsheet the agent can act on with its own shell (curl):
  - **claims** — claim a task BEFORE building/investigating; 409 = someone owns it, don't
    duplicate; release when done;
  - **files** — deliverables go to room files, chat carries decisions and pointers;
  - **ballots** (when the room has votes) — settle disagreements by binding vote instead of
    re-arguing; **signals** (when enabled) — reinforce topics that matter.
  Sections are gated by the room's actual primitives (fetched from /info at boot).

## 0.7.6 — 2026-07-05

### Changed
- **Multi-agent wake economics: delivery ≠ wake.** Previously every room message woke every
  agent for a full LLM turn, and the "never go silent" rule forced a filler reply — so N
  idle agents billed each other for "待命中" echo loops. Now messages are classified:
  - **wake** (a real turn): messages that @-mention this agent, and human messages with no @;
  - **defer** (free): other agents' un-mentioned status chatter, messages @-ing someone else,
    and system notices — they land in a persistent per-room **inbox** and are delivered as ONE
    batched context block on the next wake, so the agent's view of the discussion stays
    complete without per-message turns;
  - **timed digest**: if the inbox has content and nothing wakes the agent naturally, it is
    woken once after `ACP_INBOX_FLUSH` (default 600s; 0 disables) to absorb the batch — a room
    where everyone only broadcasts can never fall permanently silent.
  - **right to silence**: a turn may reply exactly `NOOP` (or end empty with no tool use) and
    nothing is posted — the echo loop dies at its first hop. The in-session briefing teaches
    the protocol: @-mention a peer's exact name to make it act; un-mentioned posts wake no one.

## 0.7.5 — 2026-07-05

### Fixed
- **Stale "paused" display after upgrading.** Nothing auto-pauses since 0.7.4, but a pause
  record left in state.json by an older daemon was never cleared, so `concord list`/`status`
  showed `paused` forever (the agent actually worked fine). A clean start now drops the stale
  record, next to the crash-record cleanup. (`concord resume <id>` also clears it by hand.)
- **`concord up` no longer resurrects an unused IM owner.** Stored login creds alone (e.g. a
  one-time QR test) made every `up` spawn an IM owner even with zero chat bindings. The owner
  is now revived only for platforms that are logged in AND have at least one binding.

## 0.7.4 — 2026-07-02

### Changed
- **Long tasks are no longer punished.** The "3 timeouts in 6h → auto-pause" fuse is
  removed (it turned normal long-running work into an unrecoverable-feeling `paused`
  state), and the per-turn wall-clock ceiling default is raised **1800s → 21600s (6h)**.
  The ceiling is now purely a liveness guard against a wedged adapter: on timeout the
  turn is cancelled (burn stops), the room is told, and the next message retries.
  `ACP_TURN_TIMEOUT=0` disables it entirely. `concord resume` remains only to clear a
  stale pause record left by an older daemon.

### Fixed
- **Hosted agent no longer suggests `/concord:resume` / plugin commands.** A Claude that
  also has the concord PLUGIN installed saw room-style messages, concluded it never
  formally joined, and replied with "我没有自动接入 Concord 房间…用 /concord:resume 入场"
  noise. The bridge now prepends a one-time briefing to the first turn of every fresh
  session: you are ALREADY in room X as "name", the bridge owns all room I/O, never run
  /concord:* or touch .concord/. Resumed sessions already carry it in context.

## 0.7.3 — 2026-07-02

### Fixed
- **Ambient 'system' messages no longer wake the agent.** File-upload notices
  (`[FILE] x uploaded …`, sender_type=system) used to trigger a full LLM turn whose
  reply ("no action needed, standing by") was posted back into the room — burning the
  agent's tokens AND every other participant's. System notices are now filtered at the
  poll loop, next to the own-echo skip. Humans and other agents still wake it.

## 0.7.2 — 2026-07-02

### Added
- **Join-time naming: a one-off headless agent proposes role-style names.** In a
  multi-agent room the name is how humans decide who to @ and who gets which task, so
  `concord join`/`host` (TTY, no `--as`/`--name`) now gathers the project dir + the room's
  name/purpose + who is already present, runs a ONE-OFF `claude -p` call (separate from the
  hosted agent), and offers the candidates — pick a number, type a free-form name (e.g.
  "评审"), or hit Enter for the first. Asked once per host; restarts / `concord up` reuse
  the persisted name. Headless call unavailable → falls back to dir-name candidates;
  non-TTY runs never prompt.

### Fixed
- **`concord list`/`status` now show the agent's ACTUAL in-room name.** The first column
  (now `NAME`) reads the persisted room sender, so whatever the roster shows is exactly what
  the CLI shows — in every case, not just the fallback one. `status` adds a `name` line.
  Lifecycle commands still accept the label or an id-prefix.
- **CLI id and room name now line up.** When the agent's name is taken in a room, the
  fallback name now uses the host id's hex tail — `claude-a1b2c3` in `concord list` is
  `claude-a1b2c3` in the room roster — instead of an unrelated pid-derived decimal
  (`claude-6016`). Stable across restarts, so a restarting host stops minting a new
  ghost identity each time (a pid-based name remains as a last-resort candidate).
- **80%-of-budget warning re-posted after every restart.** The one-time flag was in-memory,
  so a crash-looping host would spam the warning into the room on each incarnation. It is now
  persisted with the usage meter and cleared only by `concord budget --reset`.

## 0.7.1 — 2026-07-02

Drop-in upgrade; restart running hosts (`concord shutdown && concord up`) to pick it up.

### Added
- **Agent-initiated questions in chat (elicitation).** When the agent needs a decision
  (Claude's `AskUserQuestion` tool, or an MCP-server elicitation), the question now appears in the
  room / bound IM chat as a numbered card — reply with the option number (`2`), multi-select with
  commas (`1,3`), free text for a custom answer, or `skip`. The answer flows back into the agent's
  turn and it continues. Answers are only taken from **humans** (other agents' chatter in a
  multi-agent room is queued as normal work, never consumed as an answer); one open question at a
  time; unanswered questions time out (`ACP_ELICIT_TIMEOUT`, default 600s) and the agent proceeds.
  Verified live end-to-end against the real adapter.
- **Warm resume across restarts.** `concord restart` / crash recovery now resumes the agent's
  previous ACP session (`session/resume`) — the conversation context survives instead of starting
  cold and empty. Falls back to a fresh session (with a log note) when the adapter can't resume.
  `/clear` drops the saved session id so a wiped context is never resumed back. Verified live.
- **Live plan card.** The agent's TODO list (ACP `plan` updates) is rendered into the room as a
  compact checklist (`📋 计划 2/5` + ☐/▸/✓ lines), re-posted only when an entry's status changes.
  Progress-gated like tool cards.
- **Live context-window meter.** ACP `usage_update` (tokens in context / window size) is persisted
  per room; `concord status` shows a `context 45k / 200k` line and `/usage` appends `上下文 45k/200k`.

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
