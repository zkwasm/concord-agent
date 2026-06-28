// Clean resource reclamation for a hosted agent.
//
// Since we drive the agent over ACP ourselves (engine.mjs), the agent's ACP
// adapter — and the agent process it spawns — is the BRIDGE's own child process
// group. So a clean stop is simply: SIGTERM the bridge; its shutdown handler
// kills that group. No external resident daemon to chase (acpx's queue-owner
// was NOT a bridge child, which is what forced the old cancel→sessions-close
// dance and the orphan-token-burn risk). If SIGTERM doesn't take, escalate to
// SIGKILL. `kill`/`isAlive`/`sleep` are injected for testing.

const defaultAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function stopHost(entry, { kill, isAlive = defaultAlive, sleep = defaultSleep, graceMs = 4000, stepMs = 200 } = {}) {
  const { pid } = entry || {};
  const steps = [];
  if (!pid) { steps.push('no-pid'); return { steps }; }
  if (!isAlive(pid)) { steps.push('already-exited'); return { steps }; }

  if (kill && kill(pid, 'SIGTERM')) steps.push('SIGTERM');
  else { steps.push('already-exited'); return { steps }; }

  let waited = 0;
  while (waited < graceMs && isAlive(pid)) { await sleep(stepMs); waited += stepMs; }

  if (isAlive(pid)) {
    if (kill && kill(pid, 'SIGKILL')) steps.push('SIGKILL');
  } else {
    steps.push('exited');
  }
  return { steps };
}
