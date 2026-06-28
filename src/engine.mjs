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
// The adapter subprocess is OUR child in its OWN process group, so `shutdown()`
// kills the whole group (adapter + the agent it spawns). No detached resident
// daemon → none of acpx's "orphaned queue-owner keeps burning tokens" class of
// bug. A crashed bridge also closes the adapter's stdin (EOF) → well-behaved
// adapters exit on their own.
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

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

// ACP per-turn Usage → our {fresh, cached} accounting (matches the old acpx path:
// fresh = input+output, cached = cache-read). Usage is optional in ACP; absent → 0.
export function usageOf(u = {}) {
  return { fresh: (u.inputTokens ?? 0) + (u.outputTokens ?? 0), cached: u.cachedReadTokens ?? 0 };
}

// Create a resident ACP engine. Turns are serialized by the caller (one in flight).
//   runTurn(text, onUpdate) → { reply, usage, stopReason }   (onUpdate(u) per session/update)
//   shutdown()  → close the session + kill the adapter group
//   ready       → resolves with the agent sessionId once the session is live
// Test seam: pass `_agentApp` (an in-process acp.agent({...}) AgentApp) to drive
// the real engine without a subprocess.
export function createEngine({ agent, cwd, permission = 'approve-all', log = console.log, _agentApp = null } = {}) {
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
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = (v) => { settled = true; res(v); }; readyReject = (e) => { if (!settled) { settled = true; rej(e); } }; });
  let shutdownResolve;
  const shutdownP = new Promise((r) => { shutdownResolve = r; });

  const app = acp.client({ name: 'concord' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => decidePermission(ctx.params, permission));

  app.connectWith(source, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    session = await ctx.buildSession(cwd).start();
    readyResolve(session.sessionId);
    await shutdownP;                          // hold the connection open across turns
    try { session.dispose(); } catch { /* already gone */ }
  }).catch((e) => { readyReject(e); log('✗ ACP connection ended: ' + (e?.message || e)); });

  if (child) {
    child.on('error', (e) => readyReject(e));
    child.on('exit', (code, sig) => { readyReject(new Error(`adapter exited (code ${code}, sig ${sig})`)); });
  }

  async function runTurn(text, onUpdate = () => {}) {
    await ready;
    const done = session.prompt(text);        // fire the turn; resolves at stop
    let reply = '';
    for (;;) {
      const m = await session.nextUpdate();
      if (m.kind === 'stop') {
        await done;
        return { reply, usage: usageOf(m.response?.usage || {}), stopReason: m.stopReason };
      }
      const u = m.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') reply += u.content.text;
      try { onUpdate(u); } catch (e) { log('onUpdate error: ' + e.message); }
    }
  }

  function shutdown() {
    shutdownResolve();
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already gone */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 4000).unref();
    }
  }

  return { runTurn, shutdown, ready, sessionId: () => session?.sessionId ?? null };
}
