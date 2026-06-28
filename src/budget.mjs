// Per-agent token accounting + budget guard. Pure logic → unit-testable.
//
// "fresh" = inputTokens + outputTokens (the priced tokens). cache-read is cheap
// and tracked for visibility only. The budget caps fresh tokens per rolling
// window so a hosted agent can't burn unbounded cost while the user is away
// (the resident-daemon design already makes *idle* cost zero; this guards the
// *active* cost). budgetFresh <= 0 means unlimited.

export function windowElapsed(windowStart, now, windowMs) {
  return windowStart == null || (now - windowStart) >= windowMs;
}

export function overBudget(usage, budgetFresh) {
  return budgetFresh > 0 && (usage?.fresh ?? 0) >= budgetFresh;
}

export function fmtTok(n) {
  n = n || 0;
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
}

// "📊 用量(近 24h):fresh 1.2k/10k 预算 · 缓存读 45k · 3 轮"
export function usageReport(usage, budgetFresh, windowHours) {
  const u = usage || {};
  const cap = budgetFresh > 0 ? `/${fmtTok(budgetFresh)} 预算` : '(无上限)';
  return `📊 用量(近 ${windowHours}h):fresh ${fmtTok(u.fresh)}${cap} · 缓存读 ${fmtTok(u.cached)} · ${u.turns || 0} 轮`;
}

export function budgetExceededNote(usage, budgetFresh, windowHours) {
  return `⚠️ token 额度已用尽(fresh ${fmtTok(usage?.fresh)}/${fmtTok(budgetFresh)},近 ${windowHours}h)。已暂停接活,额度到期或由 owner 重置后恢复。`;
}
