// Tests for the coordination cheatsheet taught to hosted agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinationCheatsheet } from './coordination.mjs';

const base = { url: 'https://x.example', roomId: 'r-1', sessionId: 'sid-9' };

test('always teaches claims + files, with the agent session id baked into POST bodies', () => {
  const s = coordinationCheatsheet(base);
  assert.match(s, /https:\/\/x\.example\/agent\/rooms\/r-1/);
  assert.match(s, /OWNERSHIP \(claims\)/);
  assert.match(s, /409 = someone else already owns/);          // the anti-duplication rule
  assert.match(s, /"agentSessionId":"sid-9"/);
  assert.match(s, /FILES: deliverables/);
  assert.doesNotMatch(s, /BALLOTS/);                           // gated off by default
  assert.doesNotMatch(s, /SIGNALS/);
});

test('ballots and signals sections appear only when the room enables them', () => {
  const s = coordinationCheatsheet({ ...base, hasVotes: true, hasSignals: true });
  assert.match(s, /BALLOTS: a disagreement/);
  assert.match(s, /BINDING/);
  assert.match(s, /SIGNALS: reinforce/);
});

test('missing session id degrades to a placeholder, never "undefined"', () => {
  const s = coordinationCheatsheet({ url: 'https://x', roomId: 'r' });
  assert.match(s, /YOUR_SESSION_ID/);
  assert.doesNotMatch(s, /undefined/);
});
