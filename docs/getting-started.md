# Getting started — drive a coding agent from your own Lark/Feishu chat

This walks you from **nothing installed** to **"I sent a task in Lark and my agent did it"**.

You bring your **own** Lark/Feishu bot; its credentials stay on your machine. The model is:

> **one bot → one owner (`concord im`) → many bound chats → each chat drives one agent.**
>
> The owner holds the bot's single connection, keeps the chat→room bindings, and relays
> messages both ways. Each agent is just a resident process doing the work in a room.

---

## 0. Prerequisites

- **Node ≥ 20** (`node -v`).
- A **coding-agent CLI** installed and logged in — by default `claude` ([Claude Code](https://claude.com/claude-code)); `codex` / `gemini` also work.
- A **Lark or Feishu account** where you can create a *custom app* (you're the admin of your own workspace, or have developer access).

`concord-agent` does **not** ship an agent or an LLM key — it drives the agent CLI you already use, over the open [ACP](https://agentclientprotocol.com) protocol.

---

## 1. Install

```bash
npm install -g concord-agent
concord version          # prints the installed version
```

This installs the `concord` command.

---

## 2. Create your Lark/Feishu bot (one-time, ~5 min)

Everything here is in the developer console:

- **Lark** (international): <https://open.larksuite.com>
- **Feishu** (China / 飞书): <https://open.feishu.cn>

> Scope/permission names differ slightly between Lark and Feishu and across UI versions —
> search the console by the name in parentheses; the **scope ID** (monospace) is the stable key.

1. **Create app** → choose **Custom App** (自建应用). Give it a name and icon.

2. **Add the Bot capability** — in *Add features / 应用能力*, enable **Bot (机器人)**.

3. **Event subscription** (*事件订阅*):
   - **Connection mode: Long connection / WebSocket (长连接)** — **NOT** "send to developer's webhook". This is the #1 setup mistake; with webhook mode the bot receives nothing here.
   - Subscribe to the event **Message received** — `im.message.receive_v1`.

4. **Permissions / Scopes** (*权限管理*) — search and add:

   | Purpose | Scope ID | Needed for |
   |---|---|---|
   | Send messages as the bot | `im:message:send_as_bot` | always |
   | Read 1:1 messages to the bot | `im:message.p2p_msg:readonly` | private chat |
   | Read @bot messages in groups | `im:message.group_at_msg:readonly` | group chat |
   | Read **all** group messages | `im:message.group_msg` | *no-@ in a solo group* (optional) |
   | Read group info / member count | `im:chat:readonly` | *no-@ in a solo group* (optional) |
   | Resolve sender display names | `contact:contact.base:readonly` | optional (else you see id tails) |

   The last three are only for the convenience feature in §6 — skip them if you don't need it.

5. **Get credentials** — in *Credentials & Basic Info / 凭证与基础信息*, copy the **App ID** and **App Secret**.

6. **Publish a version** — *Version Management & Release / 版本管理与发布* → create a version → release it.
   **Permission and event changes only take effect after a release.** For a custom app in your own
   workspace the admin approves the release — if that's you, approve it.

7. **Put the bot in a chat:**
   - **Group:** create a group and add the bot.
   - **Private:** Lark can't start a true 1:1 with a bot from scratch — make a group with **just you + the bot**, then open the bot to DM it. (A "just you + the bot" group is also exactly what the §6 no-@ feature is for.)

---

## 3. Store your bot credentials locally

```bash
concord login lark --app-id <App ID> --app-secret <App Secret>
# Feishu (China):
# concord login feishu --app-id <App ID> --app-secret <App Secret>
```

Saved to `~/.concord/creds.json` with `0600` permissions. Credentials are **never** passed via
environment variables or command-line args at runtime, so they don't leak into process listings or shell history.

---

## 4. Start the IM owner

```bash
concord im                 # background daemon — one per bot
```

The owner owns the bot's single connection, holds the bindings, and relays bound chats.

```bash
concord im status          # is it up?
concord im logs            # what is it doing  (add -f to follow)
concord im stop            # stop it (bindings are kept)
```

> **One bot = one owner.** Don't run two `concord im` for the same app, and don't point another
> listener at the same bot — Lark delivers each event to only one connection, so a second listener
> steals messages at random.

---

## 5. Bind a chat to an agent

In the Lark chat (**group:** @ the bot; **private:** just send):

```
/concord-bind
```

The bot replies with a **ready-to-copy command**. Run it on the machine where the agent should
work (its working directory is where you run it):

```bash
concord host claude --bind <chat_id>            # the bot fills in the chat_id for you
# for a group, the bot's command includes a budget:
# concord host claude --bind <chat_id> --budget 1000000
```

The agent comes up, joins its room, and posts a short "connected" note in the chat. From now on,
**just send tasks in the chat.**

Re-bind a chat to a different agent with `--force`. Want a different folder? `cd` there first (or pass `--cwd`).

---

## 6. Daily use (from the chat)

- **Private chat:** send anything — no @ needed.
- **Group:** **@ the bot.**
  - **Exception:** a group with **only you + the bot** is treated like a private chat — **no @ needed.**
    This needs the two optional scopes from §4 (`im:message.group_msg` + `im:chat:readonly`); add a
    second person and it reverts to @-only within a minute.
- What you'll see per task: `收到 👌` → progress lines (`✏️ Edit app.js`, `▶️ npm test`, …) → the result
  (or `✓ 完成` when the agent finishes without a text reply).
- **In-chat commands:** `/concord-bind` · `/concord-unbind` · `/agents` (list all bound agents) ·
  `/usage` (token usage) · `/help`.

---

## 7. Manage from the terminal

```bash
concord list               # every agent + the owner, with status
concord status <id>        # detail for one
concord logs <id> -f       # follow a host's output
concord restart <id>       # restart, keeping its binding
concord stop <id>          # stop, keep its state
concord rm <id>            # stop + reclaim + drop that chat's binding
concord budget <id>        # token usage   (--reset clears a budget pause)
concord resume <id>        # clear a budget pause, accept tasks again
concord shutdown           # stop EVERYTHING — owner + all agents + clear all bindings
```

---

## 8. Token safety (on by default)

- **Idle = zero tokens.** The session blocks on input while idle; a message wakes it.
- **`--budget N`** caps fresh tokens per window. **Group bindings default to 1,000,000** — once a chat
  is "anyone can trigger it", the budget is the gate. You get a warning at 80% and an auto-pause when exceeded.
- **Per-turn timeout** bounds a single runaway turn; repeated timeouts auto-pause the agent so it can't
  burn in the background.

---

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| Private chat gets no response | Subscription isn't **长连接**, or the **p2p read scope** is missing, or the app **version wasn't released** |
| Group only answers when @-mentioned | That's expected — unless it's a **solo group** with `im:message.group_msg` + `im:chat:readonly` |
| Solo group still needs @ | Those two scopes aren't granted, or the app version wasn't re-released after adding them |
| `no <platform> creds` | Run `concord login lark …` |
| Bound, but nothing routes to the agent | Is the owner running? `concord list` should show `im-…` as `running` |
| Messages land erratically | Two listeners on one bot — keep **one** `concord im` per app |
| Sender shows as a short id instead of a name | Add the optional `contact:contact.base:readonly` scope |

---

## What this is (and isn't)

`concord-agent` drives **one** agent into a room over ACP, with a daemon, a token budget, and an
optional personal IM bridge. The room, the multi-agent coordination, and E2EE are
[Concord](https://concord.fenginwind.com)'s — this CLI just *hosts an agent into* one. See the
[README](../README.md) for the architecture.
