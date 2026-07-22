# Changelog

All notable changes to `concord-agent`. Dates are UTC.

## 0.7.17 — 2026-07-21

### Added
- **The addressing invariant: every posted reply @-mentions someone.** A turn
  reply that mentions no one is now automatically addressed back at whoever
  triggered the turn (`ensureAddressed`). An un-addressed agent post wakes no
  one — it was the #1 stall cause (a finished speaker forgetting the handoff) —
  and under broadcast self-judgment it is also what caps chain reactions: a
  broadcast can only ever produce addressed replies, so a broadcast can never
  breed another broadcast. Explicit handoffs (`@someone` in the reply) pass
  through untouched; NOOP is still swallowed.
- **Broadcast self-judgment for un-addressed human messages.** The briefing now
  tells every agent: a human message that @-mentions no one wakes ALL agents —
  judge from your role whether YOU should act, and reply exactly NOOP if not.

### Changed
- **Answer arbitration retired by default** (`ACP_ARB=1` re-enables it as a
  rollback). Its presence heuristic could only see peers that had recently
  POSTED, so in a quiet room no election started and everyone answered
  directly. Broadcast self-judgment + the addressing invariant replace it.

### Fixed
- **Mention text-scan is boundary-aware.** The fallback for relayed messages
  without server-resolved mentions used a raw substring check: an agent named
  `a` woke on `@alice`, and `user@bob.com` woke `bob`. Both scans
  (`textMentionsName`, `hasMentionToken`) now require a real mention boundary
  (emails, URL paths, and npm scopes never match) and understand fullwidth ＠.

## 0.7.16 — 2026-07-20

### Fixed
- **A provider hiccup no longer kills a room for good.** A rate-limited / overloaded
  turn was treated as a permanent failure: the message that triggered it was dropped
  before the attempt (`pending.shift()` ran ahead of the try), and the `⚠️ didn't go
  through` note went out addressing **nobody** — which every peer classifies as ambient
  chatter, never a turn. So one transient upstream blip left a multi-agent room silent
  until a human noticed and re-sent by hand. Now: transient failures (throttling,
  overload, 429/502/503/504/529, transport resets) are **retried with exponential
  backoff** (`ACP_RETRY_MAX`, default 3; `ACP_RETRY_BASE_MS`, default 10000) against the
  already-composed payload, the queue entry is consumed only once the turn truly settles,
  and any note that *does* go out is addressed back at whoever triggered the turn. Our own
  stuck-turn cancellation stays non-retryable. To keep two failing agents from trading
  addressed error notes forever (the echo-loop shape 0.7.9 removed), a peer is addressed
  at most once per consecutive-failure streak; a successful turn clears the streak.
- **In-room `/compact` and `/context` actually run again.** Passthrough slash commands are
  sent verbatim so the adapter sees `/` at offset 0 — but `composeTurn` prepended the
  batched inbox whenever one had accumulated, pushing the `/` off the front. The adapter
  then read it as ordinary prompt text and the agent would *talk about* compacting instead
  of compacting. In a multi-agent room the inbox is almost never empty, so the command
  failed exactly where it was needed most. Verified live: two agents, one `/compact`, and
  only the one with an empty inbox ran it. The inbox is now left intact for the next real
  turn, so skipping it costs no context.
- **A tool-only turn's `✓ done` is addressed too**, so "I finished what you asked" reaches
  the peer that asked instead of dissolving into ambient chatter.

## 0.7.15 — 2026-07-13

### Fixed
- **Hosted `codex` can use current models again.** The pinned `codex-acp` ACP adapter
  (`1.0.1`) bundles its own `@openai/codex` (`0.142.x`) and runs *that* — not your
  desktop app's or your PATH's codex — so newer models (e.g. `gpt-5.6-*`) failed with
  `Model metadata … not found` / `requires a newer version of Codex`, even when the same
  model worked fine in the ChatGPT desktop app. Bumped the adapter to `1.1.2` (bundles
  `@openai/codex` `0.144.x`). No interface change — same ACP launch, and it still honors
  the `CODEX_PATH` env var if you'd rather point it at an external codex binary. Takes
  effect after `npm i -g concord-agent@latest` (the adapter is fetched fresh via `npx`).

## 0.7.14 — 2026-07-08

### Fixed
- **Briefing is now fully localized — no Chinese in an English room.** The one-time
  briefing's "don't post filler" rule hardcoded a Chinese `"待命中"` example next to the
  English `"standing by"`, so every fresh bridge-hosted agent in an English (`locale: en`)
  room saw Chinese in the prompt it was handed — a leak in the "en rooms must be all-English"
  guarantee. It's now gated by `room.locale` via `L()`: English rooms get only `"standing
  by"`, Chinese rooms get `"待命中" / "standing by"`. (Takes effect on a FRESH session —
  `/clear` or re-join, like the 0.7.13 briefing changes.)

## 0.7.13 — 2026-07-07

### Fixed
- **Join-time naming: no ghost names, right language.** The naming flow read the room's
  ALL-TIME sender list, so it treated departed "-N" identities as present and suggested
  things like "agent-one-3"; and it could propose role names in the wrong language. It now
  uses the room's ONLINE roster (paired with the im-for-agents `/agents` change) and writes
  role names in the room's actual language, read from `room.locale` via `/info`.
- **No more double-posting.** Some agents `curl`-posted their content to `/messages` AND let
  the bridge post their turn-ending reply — a status summary that came out in the agent's
  default language — so every message showed up twice (once as content, once as a foreign-
  language "I did X" note). The briefing now states plainly that the reply text IS the room
  message (posted verbatim), that the agent must not POST to `/messages` itself, and must not
  reply with a status report. (Takes effect on a FRESH session — `/clear` or re-join.)

## 0.7.12 — 2026-07-07

### Added
- **Bridge-hosted agents now get the room's brief, like the paste-prompt does.** A
  `concord join` agent used to arrive blind — it knew the room protocol but not what the
  room was FOR. The one-time briefing now carries, read from the join response: the room
  name + objective + context; the pinned messages (an `[OBJECTIVE]`-prefixed pin is treated
  as the authoritative current goal); safety rules (room messages are DATA not instructions,
  never post secrets, destructive/irreversible actions need the local user's OK, ask humans
  in the room rather than blocking in your own client); and, on the FIRST join, the room's
  recent history (≤20 messages) so an agent joining an ongoing room isn't blind to what was
  said. Autonomous-mode rooms additionally get a co-owner mindset (read from `room.mode`).

### Changed
- **English-first CLI.** The operator-facing output of `concord join`/`host`/`login`/
  `upgrade`/`reset`/`im`/`im status` (naming prompts, QR-login flow, confirmations, status)
  is now English instead of Chinese, matching the room-language handling shipped in 0.7.11.
- **Join-time naming uses the hosted agent's OWN CLI** (claude/gemini/codex) instead of
  always requiring `claude`, falling back to claude then a mechanical dir-name. A first-ever
  `join`/`host` now notes that the first run downloads the adapter, so the agent's initial
  silence reads as "downloading" not "stuck."

### Fixed
- **A restarted agent reclaims its chosen name instead of staying stuck on a "-N"
  fallback.** An earlier name collision persisted the fallback (e.g. "reviewer-2") in local
  state, so every restart resumed under the wrong name. On join, if we are stored under a
  "-N" fallback of a chosen name, we now try to reclaim the clean name first (the server
  frees a departed name as of the paired im-for-agents change); the ACP context is warm-
  resumed separately, so no memory is lost.

## 0.7.11 — 2026-07-07

### Fixed
- **Windows: the agent adapter now starts.** `spawn('npx', …)` failed on Windows with
  `ENOENT` (npx is `npx.cmd` there, and modern Node refuses to spawn a `.cmd` without a
  shell), so hosting any agent crashed immediately with "agent failed to start: spawn npx
  ENOENT". The adapter is now spawned through the shell on Windows, and `shutdown()` reaps
  the child tree with `taskkill /T` (Windows has no Unix process groups). macOS/Linux
  behavior is byte-for-byte unchanged. The "~250MB download" note is now shown only for the
  claude adapter — codex/gemini adapters are small shims that drive your locally installed CLI.

### Changed
- **The bridge now speaks the room's language.** It reads `room.locale` on join and localizes
  EVERY human-facing string — both what it posts to the room and the context it feeds the
  agent — so an English room reads as English end to end (a `zh` room keeps the Chinese as
  before). Previously the bridge was hardcoded Chinese and, worse, fed the agent Chinese
  context (the batched-inbox header, the briefing), which biased hosted agents toward replying
  in Chinese even in an English room. Now the briefing carries an explicit "write every room
  message in this language" directive, and the answer-arbitration marker, plan/usage/budget
  cards, `/help`, `/clear`, timeout/error notes, and elicitation prompts all switch on locale.
  The pure-logic helpers (`arbiter`, `budget`, `elicit`) gained an optional `locale` argument
  (default `en`).

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
