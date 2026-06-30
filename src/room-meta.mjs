// Best-effort lookup of a Concord room's HUMAN name via the agent REST /info endpoint
// (the same call `im-owner` already makes). The CLI uses this once at `host`/`join`
// start — while the user is present and we're already online — to cache `roomName`
// into the host registry, so `concord list`/`status` can show the name later with
// ZERO network. That offline-instant property is the whole point: list/status must
// never block on the network, so we resolve the name eagerly and read it from disk.
//
// ALWAYS resolves, NEVER throws: returns the name string, or '' on any failure
// (non-200, bad body, network error, or timeout). Callers fall back to the short
// room id. A tight timeout keeps host start snappy even against a hung server.
export async function fetchRoomName(url, roomId, { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  if (!url || !roomId) return '';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${url.replace(/\/$/, '')}/agent/rooms/${roomId}/info`, { signal: ac.signal });
    if (!r.ok) return '';
    const body = await r.json();
    return body && typeof body.name === 'string' ? body.name : '';
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}
