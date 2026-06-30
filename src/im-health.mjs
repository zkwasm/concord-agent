// Pure classification + diff for the IM owner's health snapshot. NO I/O — the owner
// gathers raw check results and calls these; they decide status / next-action / what
// transitions are worth telling the user about. Kept pure so the boundary logic is
// unit-testable (im-health.test.mjs).

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 };

// Event-plane status from the Lark WSClient connection state + last inbound event time.
// connState: 'idle'|'connecting'|'connected'|'reconnecting'|'failed' (SDK getConnectionStatus().state).
// 'flowing' = connected + recent events; 'quiet' = connected, nobody talking (HEALTHY — must
// NEVER read as a fault); 'suspect' = not actually connected. lastEventAt/now are ms.
export function eventPlaneStatus(connState, lastEventAt, now, flowingWindowMs = 10 * 60 * 1000) {
  // Receiving inbound PROVES the connection works — it overrides a stale/wrong connState
  // (the SDK's getConnectionStatus is confirmed to exist but its live behavior is unverified,
  // so don't let a quirky 'idle' false-alarm an actively-used binding).
  if (lastEventAt && now - lastEventAt < flowingWindowMs) return 'flowing';
  if (connState !== 'connected') return 'suspect';
  return 'quiet';
}

// The single most-broken link for ONE binding → a human next-action, or null if healthy.
// Worst-first. b carries the raw per-binding check results.
//   b = { chatId, agent, relay:'up'|'down'|'blocked', room:'reachable'|'unreachable'|'rate-limited'|'unknown', agentState:'present'|'absent'|'paused'|'unknown' }
export function bindingNextAction(b) {
  const who = b.agent || 'claude';
  if (b.relay === 'blocked') return { summary: '⚠ relay 名被占,接不进房间', cmd: `concord host ${who} --bind ${b.chatId} --force`, severity: 'high' };
  if (b.room === 'unreachable') return { summary: '⚠ 房间不可达(可能已删除)', cmd: 'concord bindings', severity: 'high' };
  if (b.agentState === 'absent') return { summary: '⚠ 房间里没有活 agent —— 消息会石沉大海', cmd: `concord host ${who} --bind ${b.chatId}`, severity: 'high' };
  if (b.agentState === 'paused') return { summary: '⏸ agent 已暂停', cmd: 'concord resume <id>', severity: 'medium' };
  if (b.relay === 'down') return { summary: '… relay 未建立(对账中)', cmd: '', severity: 'low' };
  return null;
}

// The one worst thing across the whole owner — for `concord im status`'s headline line.
export function overallHeadline(snap) {
  if (!snap) return { summary: '? owner 无快照(可能没在跑)', severity: 'high' };
  if (snap.state === 'stopped') return { summary: 'IM owner 已停止', severity: 'high' };
  if (snap.credsDrift) return { summary: '⚠ creds 已切到别的 app —— owner 仍连着旧 app,在你机器上跑 `concord im` 重启它', severity: 'critical' };
  if (snap.eventPlane && snap.eventPlane.status === 'suspect') return { summary: `⚠ 长连接未就绪 (${snap.eventPlane.state}) —— 收不到消息`, severity: 'critical' };
  if (snap.controlPlane && snap.controlPlane.lark === 'fail') return { summary: '⚠ 连不上 Lark 后台', severity: 'critical' };
  const worst = (snap.bindings || []).map((b) => bindingNextAction(b)).filter(Boolean).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
  if (worst) return worst;
  return { summary: '✓ 一切正常', severity: 'ok' };
}

// A rolled-up one-word HEALTH verdict per binding (for `concord bindings`), worst link first.
export function bindingVerdict(b) {
  if (b.relay === 'blocked') return '⚠ relay 阻塞';
  if (b.room === 'unreachable') return '⚠ 房间没了';
  if (b.agentState === 'absent') return '⚠ 无 agent';
  if (b.agentState === 'paused') return '⏸ 暂停';
  if (b.relay === 'down') return '… 对账中';
  return 'ok';
}

// Transitions worth a one-time IN-CHAT breadcrumb. Compares the previous snapshot to the
// current one per binding. Connection-level faults are deliberately EXCLUDED (they can't be
// delivered over the same dead channel, and flap). Returns [{ chatId, message }].
// `whileDown` framing is added when the previous snapshot predates a restart gap.
export function chatBreadcrumbs(prev, curr, { whileDown = false } = {}) {
  const out = [];
  const prevByChat = new Map((prev?.bindings || []).map((b) => [b.chatId, b]));
  const prefix = whileDown ? '(owner 重启)' : '';
  for (const b of curr.bindings || []) {
    const p = prevByChat.get(b.chatId);
    if (!p) continue;                                  // brand-new binding: syncRelays' own intro handles it
    // agent present → absent: the sharpest silent-void case (C⑧)
    if (p.agentState === 'present' && b.agentState === 'absent') {
      out.push({ chatId: b.chatId, message: `${prefix}⚠️ 这个房间里的 agent 不在了 —— 你发的消息暂时没人处理。重启它:\`${(bindingNextAction(b) || {}).cmd || 'concord list'}\`` });
    } else if (p.agentState === 'absent' && b.agentState === 'present') {
      out.push({ chatId: b.chatId, message: `${prefix}✓ agent 回来了 —— 可以继续发任务了。` });
    } else if (p.room !== 'unreachable' && b.room === 'unreachable') {
      out.push({ chatId: b.chatId, message: `${prefix}⚠️ 绑定的房间连不上了(可能已被删除)。` });
    }
  }
  return out;
}

export const _sevRank = SEV_RANK;
