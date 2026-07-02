// Agent naming at join time. A readable name is the room's core handle in a
// multi-agent room — it's how humans decide who to @ and who gets which task —
// so instead of mechanically concatenating strings, we let a ONE-OFF headless
// agent (claude -p; NOT the agent being hosted) look at the project dir, the
// room's name/purpose and who is already present, and propose role-style
// candidates for the human to pick from. Everything degrades gracefully: no
// room info → dir-only prompt; headless call fails/times out → mechanical
// fallback candidates; the human can always type a free-form name.

import { spawn } from 'node:child_process';
import { basename } from 'node:path';

// Best-effort room context via the agent API (the room id is the bearer token).
export async function gatherRoomInfo(url, roomId, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const out = { roomName: '', purpose: '', agents: [] };
  if (!url || !roomId) return out;
  const base = `${url.replace(/\/$/, '')}/agent/rooms/${roomId}`;
  const get = async (path) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetchImpl(`${base}${path}`, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
    catch { return null; }
    finally { clearTimeout(t); }
  };
  const [info, ag] = await Promise.all([get('/info'), get('/agents')]);
  if (info) { out.roomName = info.name || ''; out.purpose = info.purpose || ''; }
  if (ag && Array.isArray(ag.agents)) out.agents = ag.agents;
  return out;
}

export function namingPrompt({ dir, agentType, roomName, purpose, agents }) {
  const lines = [
    'You are helping name a new coding agent that is about to join a collaboration room.',
    `Project directory: ${basename(dir || '') || '(unknown)'}`,
    `Agent runtime: ${agentType || 'claude'}`,
  ];
  if (roomName) lines.push(`Room name: ${roomName}`);
  if (purpose) lines.push(`Room purpose: ${purpose.slice(0, 500)}`);
  if (agents?.length) lines.push(`Already in the room (do NOT reuse or collide with these): ${agents.join(', ')}`);
  lines.push(
    '',
    'Suggest 4 SHORT, readable names for this new agent. Requirements:',
    '- Role-flavored where possible (what would this agent DO in this room?), e.g. "parser-dev", "评审", "前端组长".',
    '- Each ≤ 16 characters, no spaces (hyphens ok), distinct from the existing members.',
    '- Match the language of the room purpose (Chinese room → Chinese names ok).',
    '- Output ONLY a JSON array of 4 strings. No prose, no markdown fence.',
  );
  return lines.join('\n');
}

// Pull the first JSON array of strings out of the model's output (it may wrap it
// in prose or a fence despite instructions). Filter to sane, non-colliding names.
export function parseCandidates(text, { taken = [] } = {}) {
  const m = String(text || '').match(/\[[\s\S]*?\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const lower = new Set(taken.map((t) => String(t).trim().toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const s = v.trim().replace(/\s+/g, '-');
    if (!s || s.length > 24) continue;
    const k = s.toLowerCase();
    if (lower.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

// Mechanical fallback when the headless call is unavailable: dir name, then
// numbered variants until one is free of the taken set.
export function fallbackCandidates(dir, taken = []) {
  const base = basename(dir || '').trim() || 'agent';
  const lower = new Set(taken.map((t) => String(t).trim().toLowerCase()));
  const out = [];
  if (!lower.has(base.toLowerCase())) out.push(base);
  for (let i = 2; out.length < 2 && i < 10; i++) {
    const c = `${base}-${i}`;
    if (!lower.has(c.toLowerCase())) out.push(c);
  }
  return out;
}

// One-off headless naming call. Uses the local `claude` CLI in print mode —
// vendor-neutral enough (naming needs no tools) and already a prerequisite on
// most machines; missing binary / non-zero exit / timeout all resolve to ''.
export function runHeadlessClaude(prompt, { timeoutMs = 30000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawnImpl('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return finish(''); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out : ''); });
  });
}

// Orchestrator: room context → headless suggestion → parsed candidates, with the
// mechanical fallback appended so the picker never comes up empty.
export async function suggestNames({ dir, agentType, url, roomId, fetchImpl, runHeadless = runHeadlessClaude, log = () => {} } = {}) {
  const info = await gatherRoomInfo(url, roomId, { fetchImpl });
  const taken = info.agents || [];
  log(`▸ 让一个一次性 headless agent 根据房间信息起名…${info.roomName ? `(房间「${info.roomName}」${taken.length ? ` · 在场: ${taken.join(', ')}` : ''})` : ''}`);
  const raw = await runHeadless(namingPrompt({ dir, agentType, ...info }));
  const llm = parseCandidates(raw, { taken });
  const fb = fallbackCandidates(dir, [...taken, ...llm]);
  const candidates = [...llm, ...fb].slice(0, 5);
  return { candidates, info, fromLLM: llm.length > 0 };
}
