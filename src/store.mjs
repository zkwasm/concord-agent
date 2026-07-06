// Tiny JSON-file-backed runtime state for the IM bridges. No external deps.
//
// Chat↔room bindings (table A) live in Concord (authoritative), so the bridge
// only persists what's purely its own runtime concern:
//   1. per-room poll state — the agent sessionId used to resume reads on restart.
//   2. dedup sets — for idempotency / echo avoidance across restarts:
//        - relayedIn[roomId]: ids of messages THIS bridge injected into the room
//          (Lark → room). Skipped when polling room → Lark so they don't echo.
//        - sentOut[roomId]:  ids already forwarded room → Lark (crash safety).
//        - processedInbound: Lark event message_ids already handled (Lark retries
//          deliveries, so inbound must be idempotent). Also used by the acp bridge
//          to skip already-handled messages on resume.
//
// Writes are atomic (tmp + rename) so a crash mid-write can't corrupt the file.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_IDS = 2000; // bound each dedup list so the file can't grow without limit

function boundPush(arr, id) {
  arr.push(id);
  if (arr.length > MAX_IDS) arr.splice(0, arr.length - MAX_IDS);
}

export function openStore(filePath) {
  let state = { rooms: {}, processedInbound: [] };
  if (existsSync(filePath)) {
    try {
      state = { rooms: {}, processedInbound: [], ...JSON.parse(readFileSync(filePath, 'utf8')) };
    } catch {
      // Corrupt file → keep a copy and start fresh rather than crash-loop.
      try { renameSync(filePath, filePath + '.corrupt'); } catch { /* best effort */ }
    }
  } else {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  function persist() {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, filePath);
  }

  function roomState(roomId) {
    return state.rooms[roomId] || (state.rooms[roomId] = { sessionId: null, relayedIn: [], sentOut: [] });
  }

  function usageState(roomId) {
    const r = roomState(roomId);
    return r.usage || (r.usage = { fresh: 0, cached: 0, turns: 0 });
  }

  return {
    // --- per-room poll state (resume reads across restarts) ---
    getSessionId(roomId) { return roomState(roomId).sessionId; },
    setSessionId(roomId, sessionId) { roomState(roomId).sessionId = sessionId; persist(); },
    // The agent's ACP session id (NOT the Concord-room session above). Persisted so a
    // restart can `session/resume` the SAME agent context instead of starting cold.
    // Cleared by /clear so a wiped session is never resumed.
    getAcpSessionId(roomId) { return roomState(roomId).acpSessionId || null; },
    setAcpSessionId(roomId, id) { roomState(roomId).acpSessionId = id || null; persist(); },
    // Live context-window usage from ACP `usage_update` (tokens in context / window size).
    setContextUsage(roomId, used, size) { roomState(roomId).context = { used, size, at: Date.now() }; persist(); },
    getContextUsage(roomId) { return roomState(roomId).context || null; },

    // --- deferred-message inbox: room messages that must reach the agent's context
    //     but do NOT warrant a wake (other agents' chatter, @-others, system notes).
    //     Flushed as ONE batched block into the next turn. Persisted so a bridge
    //     restart can't silently drop context (they're already marked processed).
    //     Soft-capped: oldest overflow is counted, not kept. ---
    pushInbox(roomId, sender, content, cap = 50) {
      const r = roomState(roomId);
      const box = r.inbox || (r.inbox = []);
      box.push({ sender, content: String(content).slice(0, 4000), at: Date.now() });
      while (box.length > cap) { box.shift(); r.inboxDropped = (r.inboxDropped || 0) + 1; }
      persist();
    },
    getInbox(roomId) { return [...(roomState(roomId).inbox || [])]; },
    getInboxDropped(roomId) { return roomState(roomId).inboxDropped || 0; },
    clearInbox(roomId) { const r = roomState(roomId); r.inbox = []; r.inboxDropped = 0; persist(); },
    // The sender name this session was joined as. MUST be resumed with the SAME name — the
    // server binds a session to its creating sender and 403s a post whose sender differs
    // (e.g. resuming a session created under a 409-fallback name "claude-1234" while claiming
    // "claude"). Persisted so a restart resumes with the matching identity.
    getSender(roomId) { return roomState(roomId).sender || null; },
    setSender(roomId, sender) { roomState(roomId).sender = sender || null; persist(); },

    // --- idempotency / echo dedup ---
    markRelayedIn(roomId, msgId) { boundPush(roomState(roomId).relayedIn, msgId); persist(); },
    wasRelayedIn(roomId, msgId) { return roomState(roomId).relayedIn.includes(msgId); },
    markSentOut(roomId, msgId) { boundPush(roomState(roomId).sentOut, msgId); persist(); },
    wasSentOut(roomId, msgId) { return roomState(roomId).sentOut.includes(msgId); },
    markProcessedInbound(eventId) { boundPush(state.processedInbound, eventId); persist(); },
    wasProcessedInbound(eventId) { return state.processedInbound.includes(eventId); },

    // --- one-time self-introduction per room ---
    wasIntroduced(roomId) { return !!roomState(roomId).introduced; },
    setIntroduced(roomId) { roomState(roomId).introduced = true; persist(); },

    // --- ACP adapter process-group pgid + its start-time signature (so the CLI can
    //     reap an orphaned group even if the bridge died without its shutdown handler,
    //     but ONLY if the live pid is the same incarnation — start-time guards against
    //     killing a recycled pid that the OS handed to an unrelated process) ---
    getAdapterPid() { return state.adapterPid ?? null; },
    setAdapterPid(pid, start = null) { state.adapterPid = pid || null; state.adapterStart = pid ? (start || null) : null; persist(); },

    // --- live host runtime, surfaced by `concord list`/`status` (the CLI reads these
    //     raw from state.json). activity: what the agent is doing right now; paused: a
    //     hard-pause reason (repeated timeouts); exit: why the supervisor last died.
    //     Together they turn an opaque "running"/"crashed" into a legible state. ---
    setActivity(workState, label = null, at = Date.now()) { state.activity = { state: workState, label, at }; persist(); },
    setPaused(reason, at = Date.now()) { state.paused = reason ? { reason, at } : null; persist(); },
    setExit(reason, at = Date.now()) { state.exit = reason ? { reason, at } : null; persist(); },

    // --- per-agent (per-room) token accounting: a LIFETIME cumulative meter.
    //     Only grows; never reset except by an explicit `concord budget --reset`. ---
    getUsage(roomId) { return { ...usageState(roomId) }; },
    addUsage(roomId, fresh, cached) {
      const u = usageState(roomId);
      u.fresh += fresh || 0; u.cached += cached || 0; u.turns += 1;
      persist();
    },
    resetUsage(roomId) {
      const u = usageState(roomId);
      u.fresh = 0; u.cached = 0; u.turns = 0;
      roomState(roomId).warned80 = false;   // fresh meter → the 80% warning may fire again
      persist();
    },
    // One-time 80%-of-budget warning flag. Persisted so a crash-looping host
    // doesn't re-post the warning on every restart; cleared only by resetUsage.
    getWarned80(roomId) { return !!roomState(roomId).warned80; },
    setWarned80(roomId) { roomState(roomId).warned80 = true; persist(); },

    persist,
    _state: () => state, // test hook
  };
}
