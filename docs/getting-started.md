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

## 2. Create + log in your Lark/Feishu bot — scan one QR

```bash
concord login lark --qr           # Lark (international)
# concord login feishu --qr       # Feishu (China)
```

A QR renders in your terminal. **Open the Lark/Feishu app on your phone and scan it.**
You'll see a confirm page in the app — tap **Agree** and you're done:

- A new bot app is created in your tenant, named **Concord · `<your-name>`**.
- The bot gets the message-send / message-read / group-info / card scopes it needs.
- Event subscription is configured for long-connection delivery automatically.
- **No developer console. No publishing a version. No manual scope hunt.**
- The bot's `appId` + `appSecret` are saved to `~/.concord/creds.json` (`0600`).

That's it — credentials are local, never passed via env vars or command-line args at runtime.

**Then put the bot in a chat:**
- **Group:** create a group and add the bot.
- **Private:** Lark can't start a true 1:1 with a bot from scratch — make a group with **just you + the bot**, then open the bot to DM it. (This "you + the bot" group is also exactly what the no-@ convenience in §5 needs.)

> **In an enterprise tenant?** If you're not an admin of your Lark/Feishu org, the scan
> may complete successfully but the bot stays in **pending admin approval** — credentials
> are saved but messages won't route until your admin approves the new app in the Feishu
> admin console. If you can't get that approval, the two easy workarounds are:
>
> 1. **Use a personal account instead** (free, no org required):
>    - **Feishu (China):** install the app → register with your phone → at the use-case step pick **「个人使用」**. Re-run `concord login feishu --qr` from this account.
>    - **Lark (international):** sign up at <https://www.larksuite.com/global/register> with email or phone. Re-run `concord login lark --qr` from this account.
> 2. **Ask your admin to create a Custom App and hand you the App ID + Secret** — then use the manual flow in the details block below.

<details>
<summary><b>Alternative: manually create the app in the developer console</b> (use when scanning isn't possible — e.g. headless CI, you want to reuse an existing custom app, or your tenant blocks scan-created apps)</summary>

In the developer console (Lark <https://open.larksuite.com>, Feishu <https://open.feishu.cn>):

1. **Create a Custom App** (自建应用), give it a name + icon.
2. **Add the Bot capability** (*Add features / 应用能力* → **Bot**).
3. **Event subscription** (*事件订阅*):
   - **Connection mode: Long connection / WebSocket (长连接)** — **NOT** webhook. With webhook, the bot here receives nothing.
   - Subscribe to **Message received** — `im.message.receive_v1`.
4. **Permissions / Scopes** (*权限管理*) — add:

   | Purpose | Scope ID | Needed for |
   |---|---|---|
   | Send messages as the bot | `im:message:send_as_bot` | always |
   | Read 1:1 messages to the bot | `im:message.p2p_msg:readonly` | private chat |
   | Read @bot messages in groups | `im:message.group_at_msg:readonly` | group chat |
   | Read **all** group messages | `im:message.group_msg` | no-@ in a solo group (optional) |
   | Read group info / member count | `im:chat:readonly` | no-@ in a solo group (optional) |
   | Resolve sender display names | `contact:contact.base:readonly` | optional (else you see id tails) |
5. **Get credentials** — *Credentials & Basic Info / 凭证与基础信息* → copy **App ID** + **App Secret**.
6. **Publish a version** — *Version Management & Release / 版本管理与发布*. Permission/event changes only take effect after a release.
7. Save them locally:
   ```bash
   concord login lark --app-id <App ID> --app-secret <App Secret>
   ```

</details>

---

## 3. Start the IM owner

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

## 4. Bind a chat to an agent

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

## 5. Daily use (from the chat)

- **Private chat:** send anything — no @ needed.
- **Group:** **@ the bot.**
  - **Exception:** a group with **only you + the bot** is treated like a private chat — **no @ needed.**
    The scopes for this (`im:message.group_msg` + `im:chat:readonly`) are included automatically when you
    log in with `--qr`. Add a second person and it reverts to @-only within a minute.
- What you'll see per task: `收到 👌` → progress lines (`✏️ Edit app.js`, `▶️ npm test`, …) → the result
  (or `✓ 完成` when the agent finishes without a text reply).
- **In-chat commands:** `/concord-bind` · `/concord-unbind` · `/agents` (list all bound agents) ·
  `/usage` (token usage) · `/help`. Room commands also work here: `/compact` (compact context) · `/clear` (fresh session) · `/context`.

---

## 6. Manage from the terminal

```bash
concord list               # every agent + the owner, with status
concord status <id>        # detail for one
concord logs <id> -f       # follow a host's output
concord restart <id>       # restart, keeping its binding
concord stop <id>          # stop, keep its state
concord rm <id>            # stop + reclaim + drop that chat's binding
concord budget <id>        # token usage   (--reset clears a budget pause)
concord resume <id>        # clear a budget pause, accept tasks again
concord shutdown           # stop the owner + all agents, but KEEP configs + bindings (reversible)
concord up                 # bring the whole fleet back after shutdown (no re-binding needed)
concord reset --yes        # hard wipe: stop all + drop all bindings/configs (bots must re-bind; keeps login)
```

---

## 7. Token safety (on by default)

- **Idle = zero tokens.** The session blocks on input while idle; a message wakes it.
- **`--budget N`** caps fresh tokens over the task's lifetime (cumulative, never auto-reset). **Group bindings default to 1,000,000** — once a chat
  is "anyone can trigger it", the budget is the gate. You get a warning at 80% and an auto-pause when exceeded (clear with `concord budget <id> --reset`).
- **Per-turn timeout** (default 6h; a liveness guard, not a work limit) cancels a wedged turn; the next message retries — no auto-pause. It exists so a hung adapter can't
  burn in the background.

---

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| `no <platform> creds` | Run `concord login lark --qr` (or `concord login feishu --qr`) and scan |
| Scanned successfully, creds saved, but messages don't reach the agent | In an enterprise tenant the new app may be pending **admin approval** — ask your admin to approve it, or fall back to a personal account / a manually-provisioned app (see §2). |
| Private chat gets no response (manually-made app only) | Subscription isn't **长连接**, the **p2p read scope** is missing, or the app **version wasn't released**. The `--qr` flow avoids all three. |
| Group only answers when @-mentioned | That's expected — unless it's a **solo group** with `im:message.group_msg` + `im:chat:readonly`. Both are included by `--qr`; if you built the app manually, add them and re-release. |
| Solo group still needs @ (manually-made app) | Those two scopes aren't granted, or the app version wasn't re-released after adding them |
| Bound, but nothing routes to the agent | Is the owner running? `concord list` should show `im-…` as `running` |
| Messages land erratically | Two listeners on one bot — keep **one** `concord im` per app |
| Sender shows as a short id instead of a name | Add the optional `contact:contact.base:readonly` scope |

---

## What this is (and isn't)

`concord-agent` drives **one** agent into a room over ACP, with a daemon, a token budget, and an
optional personal IM bridge. The room, the multi-agent coordination, and E2EE are
[Concord](https://concord.fenginwind.com)'s — this CLI just *hosts an agent into* one. See the
[README](../README.md) for the architecture.
