// Answer arbitration for multi-agent rooms — pure logic, no side effects (testable).
//
// Problem: a human posts a question with no @-mention, so EVERY agent's bridge
// classifies it as `wake` and they all answer the same thing → duplicate work.
// (Biological analogue: Drosophila SOP selection via Notch-Delta lateral
// inhibition — cells compete to become the one sensory-organ precursor.)
//
// Solution (message-log based, so it needs ZERO server support and NO
// coordination-primitives switch): each candidate rolls a random backoff; the
// first to fire posts a visible "picking this up" MARKER keyed to the question;
// the others see it and stand down (their copy of the question stays in their
// inbox as context, delivered on their next natural wake — "stagger, not
// suppress"). The elected agent answers; there is no timed fallback. Near-
// simultaneous posters are resolved by a deterministic name tie-break so exactly
// one proceeds.
//
// The marker travels through the room message stream — the single most reliable
// path in the whole system — never through claims/ballots/signals. The bridge
// filters markers out of what the agent's LLM sees.

// A machine-parseable token humans can ignore, embedded in the visible marker so
// the election is keyed to the exact question (independent questions → independent
// elections). Chosen brackets are unlikely to collide with real prose.
const MARKER_TOKEN = /⟦arb:([^⟧]+)⟧/;

// Backoff spread. Modest on purpose: wide jitter just adds latency before the
// winner even starts, and the tie-break already closes the rare same-window
// collision. Winner latency ≈ backoff + one settle round-trip.
export const ARB_BACKOFF_MIN_MS = 200;
export const ARB_BACKOFF_MAX_MS = 1400;

// Is this room message an arbitration marker (not real content)?
export function isArbMarker(content) {
  return MARKER_TOKEN.test(String(content || ''));
}

// The visible marker a winner posts. Human reads "🎯 我来接这条"; the trailing
// token is how peers key the election to this question.
export function buildMarker(msgId, name, locale = 'en') {
  const verb = locale === 'zh' ? '来接这条' : 'is taking this one';
  return `🎯 ${name} ${verb} ⟦arb:${msgId}⟧`;
}

// Extract the target message id from a marker, or null if it isn't one.
export function parseMarker(content) {
  const m = MARKER_TOKEN.exec(String(content || ''));
  return m ? m[1] : null;
}

// A random backoff in [MIN, MAX). rng defaults to Math.random; injected in tests.
export function arbBackoffMs(rng = Math.random) {
  return ARB_BACKOFF_MIN_MS + Math.floor(rng() * (ARB_BACKOFF_MAX_MS - ARB_BACKOFF_MIN_MS));
}

// Deterministic tie-break for the rare case where ≥2 agents post a marker within
// one propagation window: the lexicographically smallest name wins. Every agent
// sees the same set of markers and computes the same winner, so exactly one
// proceeds. Room join guarantees names are unique, so there is never a true tie.
export function arbWin(myName, competitors = []) {
  const me = String(myName);
  return competitors.every((n) => me < String(n));
}
