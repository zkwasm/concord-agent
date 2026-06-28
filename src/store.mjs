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
    return r.usage || (r.usage = { fresh: 0, cached: 0, turns: 0, windowStart: null });
  }

  return {
    // --- per-room poll state (resume reads across restarts) ---
    getSessionId(roomId) { return roomState(roomId).sessionId; },
    setSessionId(roomId, sessionId) { roomState(roomId).sessionId = sessionId; persist(); },

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

    // --- per-agent (per-room) token accounting, for stats + budget guard ---
    getUsage(roomId) { return { ...usageState(roomId) }; },
    addUsage(roomId, fresh, cached, now) {
      const u = usageState(roomId);
      if (u.windowStart == null) u.windowStart = now;
      u.fresh += fresh || 0; u.cached += cached || 0; u.turns += 1;
      persist();
    },
    resetUsage(roomId, now) {
      const u = usageState(roomId);
      u.fresh = 0; u.cached = 0; u.turns = 0; u.windowStart = now;
      persist();
    },

    persist,
    _state: () => state, // test hook
  };
}
