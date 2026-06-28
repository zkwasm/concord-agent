// Clean resource reclamation for a hosted agent.
//
// Topology: the CLI spawns the bridge detached (its own group); the bridge spawns
// the ACP adapter detached (a SEPARATE group); the adapter spawns the agent
// (claude/codex) inside the adapter's group. So there are TWO things to reap:
//   1. the bridge process (entry.pid)
//   2. the adapter process GROUP (entry.adapterPid == the adapter's pgid)
//
// The bridge's own SIGTERM handler reaps the adapter group on a graceful stop. But
// if the bridge hung or was SIGKILLed, that handler never ran and the adapter group
// is orphaned (reparented to init), still burning tokens. So stopHost reaps BOTH —
// bridge first, then the adapter group directly as a belt-and-suspenders — and only
// reports the steps it actually took, confirming each target is gone. This is the
// fix for the "stop reports success while the agent group is still alive" class.
//
// `kill`/`isAlive`/`sleep` are injected for testing. `kill` must accept a NEGATIVE
// pid for group signalling (node's process.kill does).

const defaultAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reap one target: SIGTERM, wait up to graceMs for it to exit, SIGKILL, brief
// confirm. `group:true` signals the whole process group (kill(-pid)); isAlive
// always probes the leader pid as the liveness proxy. Returns { steps, alive }.
export async function reapPid(pid, { kill, isAlive = defaultAlive, sleep = defaultSleep, graceMs = 4000, stepMs = 200, group = false } = {}) {
  const signal = (sig) => (kill ? kill(group ? -pid : pid, sig) : false);
  if (!isAlive(pid)) return { steps: ['already-exited'], alive: false };
  if (!signal('SIGTERM')) return { steps: ['signal-failed'], alive: isAlive(pid) };
  const steps = ['SIGTERM'];
  let waited = 0;
  while (waited < graceMs && isAlive(pid)) { await sleep(stepMs); waited += stepMs; }
  if (isAlive(pid)) {
    if (signal('SIGKILL')) steps.push('SIGKILL');
    let w2 = 0;
    while (w2 < 1500 && isAlive(pid)) { await sleep(stepMs); w2 += stepMs; }
  } else {
    steps.push('exited');
  }
  return { steps, alive: isAlive(pid) };
}

// Stop a host: reap the bridge AND confirm the adapter group is gone.
export async function stopHost(entry, opts = {}) {
  const { kill, isAlive = defaultAlive, sleep = defaultSleep, graceMs = 4000, stepMs = 200 } = opts;
  const { pid, adapterPid } = entry || {};
  const steps = [];

  // 1. the bridge — its graceful handler reaps the adapter group on its own.
  if (!pid) steps.push('bridge:no-pid');
  else {
    const r = await reapPid(pid, { kill, isAlive, sleep, graceMs, stepMs });
    steps.push('bridge:' + r.steps.join('+'));
  }

  // 2. the adapter GROUP — belt-and-suspenders for when the bridge handler didn't
  //    run. If already gone (bridge reaped it), this is a no-op. Confirms the tree.
  if (adapterPid && isAlive(adapterPid)) {
    const r = await reapPid(adapterPid, { kill, isAlive, sleep, graceMs, stepMs, group: true });
    steps.push('adapter:' + r.steps.join('+'));
  } else if (adapterPid) {
    steps.push('adapter:already-exited');
  }

  return { steps };
}
