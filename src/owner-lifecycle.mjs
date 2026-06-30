// Decide what to do with a possibly-running IM owner, given the current creds.
//
// The owner bakes its bot app's appId/appSecret into its WSClient AT SPAWN. So when the
// user switches bot apps (`concord login … --qr --new`, or a manual `--app-id`), the
// creds file changes but a LIVE owner is still pinned to the OLD app — the new app has
// nothing listening, so `/concord-bind` on it is silently dropped. The fix is to detect
// the app mismatch and RESTART the owner onto the new app.
//
// Pure decision so the boundary conditions are unit-testable; the caller does the
// spawn/stop. Returns one of:
//   'keep'    — a healthy owner is already on the right app; do nothing
//   'restart' — a live owner is pinned to a DIFFERENT app; stop it, then start fresh
//   'start'   — no owner running and we want one
//   'noop'    — no owner running and we were told not to start one
//
// Note on legacy owners: one started before we recorded appId has existingAppId=null;
// against a known wanted app that yields 'restart' (a safe clean reconnect), which is
// what we want — never silently trust an owner whose app we can't verify.
export function ownerAction({ alive, existingAppId, wantAppId, startIfAbsent = true }) {
  if (alive) {
    if (!wantAppId || existingAppId === wantAppId) return 'keep';   // no creds to compare, or same app → leave it
    return 'restart';                                                // creds point at a different app than the running owner
  }
  return startIfAbsent ? 'start' : 'noop';
}
