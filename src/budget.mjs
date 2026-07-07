// Per-agent token accounting + optional budget guard. Pure logic → unit-testable.
//
// "fresh" = inputTokens + outputTokens (the priced tokens). cache-read is cheap
// and tracked for visibility only. Accounting is a LIFETIME cumulative meter per
// task/room: it only ever grows and is NEVER reset automatically — not by time,
// a restart, /compact, or /clear. The ONLY thing that zeroes it is an explicit
// `concord budget --reset`. The optional cap (budgetFresh > 0) is a lifetime
// ceiling that pauses the agent so it can't burn unbounded cost while nobody's
// watching; an over-cap agent resumes only via that same reset. budgetFresh <= 0
// means unlimited (the default): pure metering, never pauses.

export function overBudget(usage, budgetFresh) {
  return budgetFresh > 0 && (usage?.fresh ?? 0) >= budgetFresh;
}

export function fmtTok(n) {
  n = n || 0;
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
}

// Locale-aware (default en). zh keeps the original Chinese.
// en: "📊 Usage (cumulative): fresh 1.2k/10k budget · cache-read 45k · 3 turns"
export function usageReport(usage, budgetFresh, locale = 'en') {
  const u = usage || {};
  if (locale === 'zh') {
    const cap = budgetFresh > 0 ? `/${fmtTok(budgetFresh)} 预算` : '(无上限)';
    return `📊 用量(累计):fresh ${fmtTok(u.fresh)}${cap} · 缓存读 ${fmtTok(u.cached)} · ${u.turns || 0} 轮`;
  }
  const cap = budgetFresh > 0 ? `/${fmtTok(budgetFresh)} budget` : ' (no cap)';
  return `📊 Usage (cumulative): fresh ${fmtTok(u.fresh)}${cap} · cache-read ${fmtTok(u.cached)} · ${u.turns || 0} turns`;
}

export function budgetExceededNote(usage, budgetFresh, locale = 'en') {
  if (locale === 'zh') return `⚠️ token 累计已达上限(fresh ${fmtTok(usage?.fresh)}/${fmtTok(budgetFresh)})。已暂停接活,由 owner 跑 \`concord budget <id> --reset\` 清零后恢复。`;
  return `⚠️ Cumulative token cap reached (fresh ${fmtTok(usage?.fresh)}/${fmtTok(budgetFresh)}). Paused; the owner runs \`concord budget <id> --reset\` to zero it and resume.`;
}
