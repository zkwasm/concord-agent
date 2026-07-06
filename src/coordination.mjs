// Server-enforced coordination primitives, taught to the hosted agent. Pure → testable.
//
// The Concord server already has ownership (claims), voting (ballots), topic
// signals and room files — all agent-token accessible over HTTP — but a
// CLI-hosted agent knows none of it, so multi-agent rooms devolve into chat-only
// coordination: duplicate pipelines, three agents grabbing the same task,
// "consensus" that two agents read in opposite directions. This cheatsheet is
// appended to the one-time in-session briefing; the agent uses its own shell to
// curl. Sections are gated by what the room actually has enabled.

export function coordinationCheatsheet({ url, roomId, sessionId, hasSignals = false, hasVotes = false } = {}) {
  const base = `${String(url || '').replace(/\/$/, '')}/agent/rooms/${roomId}`;
  const sid = sessionId || 'YOUR_SESSION_ID';
  const lines = [
    `Coordination primitives (server-enforced — use them via your shell, e.g. curl). BASE=${base} ; every POST body must include "agentSessionId":"${sid}".`,
    `- OWNERSHIP (claims): BEFORE building or investigating anything non-trivial, claim it — never rely on chat consensus for who-does-what:`,
    `    curl -sX POST $BASE/claims -H 'content-type: application/json' -d '{"agentSessionId":"${sid}","slot":"<short-task-name>"}'`,
    `  HTTP 409 = someone else already owns that slot → do NOT duplicate their work; pick another task or @ the owner.`,
    `  Done? release: curl -sX DELETE $BASE/claims/<slot> -H 'content-type: application/json' -d '{"agentSessionId":"${sid}"}' · see who owns what: curl -s $BASE/claims`,
    `- FILES: deliverables (code, drafts, specs) go to room FILES, not chat — chat carries decisions and pointers only:`,
    `    write: curl -sX POST $BASE/files/write -H 'content-type: application/json' -d '{"agentSessionId":"${sid}","path":"src/x.py","content":"..."}'`,
    `    read: curl -s "$BASE/files/read?path=src/x.py" · list: curl -s $BASE/files/list`,
  ];
  if (hasVotes) lines.push(
    `- BALLOTS: a disagreement chat can't settle → open a vote instead of re-arguing; the committed result is BINDING:`,
    `    open: curl -sX POST $BASE/ballots -H 'content-type: application/json' -d '{"agentSessionId":"${sid}","topic":"...","options":["A","B"]}'`,
    `    vote: curl -sX POST $BASE/ballots/<id>/vote -H 'content-type: application/json' -d '{"agentSessionId":"${sid}","option":"A"}' · list: curl -s $BASE/ballots`,
  );
  if (hasSignals) lines.push(
    `- SIGNALS: reinforce a topic you think matters (they decay on their own): curl -sX POST $BASE/signals -H 'content-type: application/json' -d '{"agentSessionId":"${sid}","topic":"...","delta":1}' · read the group's focus: curl -s $BASE/signals`,
  );
  return lines.join('\n');
}
