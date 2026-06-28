// Drive a coding agent over ACP (Agent Client Protocol) using the OFFICIAL
// @agentclientprotocol/sdk. We are the ACP *client*; the agent's ACP adapter is
// the *server* subprocess we spawn.
//
// Why not acpx: acpx (OpenClaw, MIT) is itself just an ACP client wrapped in a
// CLI. Depending on a third-party orchestrator (and one adjacent to our own
// space) at runtime is the wrong dependency. ACP is an OPEN protocol; its SDK
// (@agentclientprotocol/sdk) and the per-vendor adapters (@agentclientprotocol/
// claude-agent-acp, …) are vendor-neutral Apache-2.0 packages by Zed. We depend
// on the protocol, write the thin orchestration ourselves, and own it.
//
//   this bridge (ACP client) <--ndjson stdio--> agent ACP adapter (server) <--> claude/codex/…
//
// The adapter subprocess is spawned `detached` so it is its OWN process-group
// leader: child.pid == the group pgid, and `shutdown()` group-kills it (adapter
// + the agent it spawns). shutdown() is ASYNC and waits for the group to actually
// die before resolving, so a caller can reclaim deterministically (no fixed-delay
// race). The group pgid is exposed (`adapterPid`) so a supervisor can reap an
// orphaned group even if this process died without running shutdown().
//
// NOTE (resume): every engine starts a FRESH ACP session (buildSession().start()).
// The SDK's high-level ActiveSession is new-only; session/load + session/resume
// exist but require the adapter to advertise the capability (claude-agent-acp
// reports loadSession:false) and lower-level update routing. So a bridge restart
// = fresh agent context (cold prompt cache). This is a known PoC limitation, not
// acpx `--resume` parity — see README "Limitations".
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Pinned adapter versions — never float to @latest (supply-chain hygiene). Bump
// deliberately. Override the whole launch with ACP_ADAPTER_CMD ("cmd a b c") or
// point at a locally-installed bin to avoid the npx fetch entirely.
const ADAPTER_VER = { claude: '0.52.0', codex: '1.0.1' };

// Per-vendor ACP adapter launch command. The adapters are neutral Apache-2.0
// packages by Zed (the protocol authors), not a third-party orchestrator.
export const ADAPTERS = {
  claude: { cmd: 'npx', args: ['-y', `@agentclientprotocol/claude-agent-acp@${ADAPTER_VER.claude}`] },
  codex: { cmd: 'npx', args: ['-y', `@agentclientprotocol/codex-acp@${ADAPTER_VER.codex}`] },
  gemini: { cmd: 'gemini', args: ['--experimental-acp'] },
};

export function adapterFor(agent) {
  if (process.env.ACP_ADAPTER_CMD) {
    const p = process.env.ACP_ADAPTER_CMD.trim().split(/\s+/);
    return { cmd: p[0], args: p.slice(1) };
  }
  return ADAPTERS[agent] || ADAPTERS.claude;
}

// Decide a permission request without a human (PoC parity with acpx --approve-all).
// policy 'approve-all' → pick the first allow_* option; 'reject' → first reject_*.
// No matching option → cancel (so the agent doesn't hang). Pure → unit-testable.
export function decidePermission(params, policy = 'approve-all') {
  const opts = (params && params.options) || [];
  const want = policy === 'reject' ? ['reject_once', 'reject_always'] : ['allow_always', 'allow_once'];
  for (const k of want) {
    const o = opts.find((x) => x.kind === k);
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

// ACP per-turn Usage → our {fresh, cached} accounting (fresh = input+output,
// cached = cache-read). Usage is optional in ACP; absent → 0. The ACP Usage
// schema is ambiguous (PromptResponse.usage is documented "for this turn" but the
// field descriptions say "across all turns") and flagged UNSTABLE, so the engine
// supports both interpretations — see makeUsageMapper.
export function usageOf(u = {}) {
  return { fresh: (u.inputTokens ?? 0) + (u.outputTokens ?? 0), cached: u.cachedReadTokens ?? 0 };
}

// Build a per-engine usage mapper. mode 'per-turn' (default): each turn's usage is
// taken as-is. mode 'cumulative' (ACP_USAGE_MODE=cumulative): the adapter reports
// running session totals, so report the DELTA vs the previous turn — otherwise the
// budget would sum running totals and trip the cap far too early. Returns
// { fresh, cached, present }; present=false when the adapter omitted usage (so the
// caller can warn instead of silently letting the budget no-op).
export function makeUsageMapper(mode = process.env.ACP_USAGE_MODE || 'per-turn') {
  let prev = null;
  return function map(raw) {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return { fresh: 0, cached: 0, present: false };
    if (mode === 'cumulative') {
      const p = prev || {};
      const fresh = Math.max(0, ((raw.inputTokens ?? 0) + (raw.outputTokens ?? 0)) - ((p.inputTokens ?? 0) + (p.outputTokens ?? 0)));
      const cached = Math.max(0, (raw.cachedReadTokens ?? 0) - (p.cachedReadTokens ?? 0));
      prev = raw;
      return { fresh, cached, present: true };
    }
    return { ...usageOf(raw), present: true };
  };
}

// Hard per-turn wall-clock ceiling. The budget is checked BETWEEN turns; this is
// the WITHIN-turn backstop so a single degenerate/looping turn — or an adapter that
// never emits 'stop' — can't burn unbounded. On timeout the turn is cancelled AND
// the adapter group is killed (the LLM process dies → burn stops immediately); the
// bridge then recreates a fresh engine. Default 1800s is generous (normal coding
// turns finish well under it → no UX impact); ACP_TURN_TIMEOUT=0 disables it.
const TURN_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ACP_TURN_TIMEOUT ?? '1800', 10);
  return (Number.isFinite(raw) && raw >= 0 ? raw : 1800) * 1000;
})();
const TURN_TIMEOUT = Symbol('turn-timeout');

// Create a resident ACP engine. Turns are serialized by the caller (one in flight).
//   runTurn(text, onUpdate) → { reply, usage:{fresh,cached}, stopReason, usagePresent }
//   shutdown()  → Promise; group-kill the adapter and wait for the group to die
//   ready       → resolves with the agent sessionId once the session is live
//   dead()      → true once the connection failed or the adapter exited (recreate)
//   adapterPid  → the adapter process-GROUP pgid (or null in test mode)
// Test seam: pass `_agentApp` (an in-process acp.agent({...}) AgentApp) to drive
// the real engine without a subprocess.
export function createEngine({ agent, cwd, permission = 'approve-all', log = console.log, turnTimeoutMs = TURN_TIMEOUT_MS, _agentApp = null } = {}) {
  let child = null;
  let source;
  if (_agentApp) {
    source = _agentApp;                       // in-process agent (tests)
  } else {
    const { cmd, args } = adapterFor(agent);
    child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
    source = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  }

  let session = null;
  let settled = false;
  let failed = false;        // connection died / adapter exited unexpectedly → recreate
  let exited = !child;       // adapter process has exited (true immediately in test mode)
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => {
    readyResolve = (v) => { settled = true; res(v); };
    readyReject = (e) => { failed = true; if (!settled) { settled = true; rej(e); } };
  });
  let shutdownResolve;
  const shutdownP = new Promise((r) => { shutdownResolve = r; });
  const mapUsage = makeUsageMapper();

  const app = acp.client({ name: 'concord' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => decidePermission(ctx.params, permission));

  app.connectWith(source, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    session = await ctx.buildSession(cwd).start();
    readyResolve(session.sessionId);
    await shutdownP;                          // hold the connection open across turns
    try { session.dispose(); } catch { /* already gone */ }
  }).catch((e) => { failed = true; readyReject(e); log('✗ ACP connection ended: ' + (e?.message || e)); });

  if (child) {
    child.on('error', (e) => { failed = true; readyReject(e); });
    child.on('exit', (code, sig) => { exited = true; failed = true; readyReject(new Error(`adapter exited (code ${code}, sig ${sig})`)); });
  }

  // A turn that exceeds the ceiling: kill the adapter group so the LLM burn stops
  // now, mark the engine dead so the bridge rebuilds a fresh one next turn.
  async function abortTurn(secs) {
    log(`■ turn exceeded ${secs}s ceiling — cancelling + reaping the adapter to stop the burn`);
    failed = true;
    try { await shutdown(); } catch { /* best effort */ }
  }

  async function runTurn(text, onUpdate = () => {}) {
    await ready;
    const done = session.prompt(text);        // fire the turn; resolves at stop
    done.catch(() => {});                      // on the error path nextUpdate() rejects first; keep `done` from floating as an unhandled rejection
    let reply = '';
    const secs = Math.round(turnTimeoutMs / 1000);
    const deadline = turnTimeoutMs ? Date.now() + turnTimeoutMs : Infinity;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { await abortTurn(secs); throw new Error(`turn exceeded the ${secs}s ceiling and was cancelled (raise with ACP_TURN_TIMEOUT)`); }
      // Race each nextUpdate() against the remaining turn budget so a wedged adapter
      // (never emits 'stop', never sends another update) can't hang the turn forever.
      const np = session.nextUpdate();
      let timer;
      const m = turnTimeoutMs
        ? await Promise.race([np, new Promise((res) => { timer = setTimeout(() => res(TURN_TIMEOUT), remaining); })]).finally(() => clearTimeout(timer))
        : await np;
      if (m === TURN_TIMEOUT) {
        np.catch(() => {});                    // the raced update will never land — don't let it float
        await abortTurn(secs);
        throw new Error(`turn exceeded the ${secs}s ceiling and was cancelled (raise with ACP_TURN_TIMEOUT)`);
      }
      if (m.kind === 'stop') {
        await done;
        const u = mapUsage(m.response?.usage);
        return { reply, usage: { fresh: u.fresh, cached: u.cached }, stopReason: m.stopReason, usagePresent: u.present };
      }
      const u = m.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') reply += u.content.text;
      try { onUpdate(u); } catch (e) { log('onUpdate error: ' + e.message); }
    }
  }

  // Tear down: release the held-open connection, group-SIGTERM the adapter, WAIT
  // for the group to actually exit (bounded), escalate to group-SIGKILL, and only
  // resolve once it's gone. Async so the caller can exit *after* reclaim completes
  // — the SIGKILL backstop must not live in a process that exits before it fires.
  async function shutdown({ graceMs = 4000 } = {}) {
    shutdownResolve();
    if (!child || !child.pid) return;
    const pgid = child.pid;
    try { process.kill(-pgid, 'SIGTERM'); } catch { /* group already gone */ }
    const start = Date.now();
    while (!exited && pidAlive(pgid) && Date.now() - start < graceMs) await sleep(100);
    if (!exited && pidAlive(pgid)) {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
      const s2 = Date.now();
      while (pidAlive(pgid) && Date.now() - s2 < 2000) await sleep(100);
    }
  }

  return {
    runTurn,
    shutdown,
    ready,
    dead: () => failed,
    sessionId: () => session?.sessionId ?? null,
    adapterPid: () => child?.pid ?? null,   // the adapter process-group pgid (stable for its lifetime)
  };
}
