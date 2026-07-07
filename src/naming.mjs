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
  const out = { roomName: '', purpose: '', context: '', agents: [] };
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
  if (info) { out.roomName = info.name || ''; out.purpose = info.purpose || ''; out.context = info.context || ''; }
  if (ag && Array.isArray(ag.agents)) out.agents = ag.agents;
  return out;
}

// Room templates bake their role list into the room's context at creation
// (compose.ts rolesBlock): a known header line followed by "- name: description"
// lines. Extract the STRUCTURED role names — these are the room's own intended
// participants, the highest-grade naming source there is (no LLM guessing).
const ROLE_HEADERS = [
  'Suggested participant roles:',
  'Candidate roles (pick one no other agent has taken — 409 enforced):',
  '建议的参与者角色:',
  '候选角色(挑一个还没有其他 Agent 占用的 —— 由 409 强制保证唯一):',
];
export function extractTemplateRoles(context) {
  const lines = String(context || '').split('\n');
  const start = lines.findIndex((l) => ROLE_HEADERS.some((h) => l.trim().startsWith(h)));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*-\s*([^:::]+)[::]/.exec(lines[i]);
    if (!m) break;                                   // the block ends at the first non-item line
    const name = m[1].trim().replace(/\s+/g, '-');
    if (name && name.length <= 24 && !out.includes(name)) out.push(name);
  }
  return out;
}

// The name doubles as the agent's ROLE and persona in the room (mirroring the
// web paste-prompt: "ask the user what role you should play … use it as your
// sender name and persona throughout"). So the headless call proposes ROLES that
// fit the collaboration objective — not decorative labels.
export function namingPrompt({ dir, agentType, roomName, purpose, context, agents }) {
  const lines = [
    'A new coding agent is about to join a collaboration room. Its sender name doubles as its ROLE',
    'and persona in the room — it is how humans decide who to @ and who owns which task.',
    'Propose what role this agent should play.',
    '',
    `Project directory it works in: ${basename(dir || '') || '(unknown)'}`,
    `Agent runtime: ${agentType || 'claude'}`,
  ];
  if (roomName) lines.push(`Room name: ${roomName}`);
  if (purpose) lines.push(`Collaboration objective: ${purpose.slice(0, 500)}`);
  if (context) lines.push(`Room context (may contain a "Suggested participant roles" / "Candidate roles" list): ${context.slice(0, 1200)}`);
  if (agents?.length) lines.push(`Already in the room: ${agents.join(', ')}`);
  lines.push(
    '',
    'Propose 4 candidate role names, best first. Rules:',
    '- If the room context suggests participant roles, offer the untaken ones FIRST, verbatim.',
    '- Otherwise derive roles from the objective + the project directory: what distinct viewpoint or',
    '  responsibility would this agent OWN (implementer, reviewer, tester, researcher, designer, …)?',
    '- Complement the existing members — pick roles clearly DIFFERENT from what is already covered;',
    '  never reuse or collide with an existing name.',
    '- GROUND every candidate in the provided objective / context / project directory — do NOT',
    '  invent domains or duties they do not imply.',
    '- Write role names in the same language as the collaboration objective.',
    '- Each ≤ 16 characters, no spaces (hyphens ok). Concrete beats generic ("支付-评审" beats "helper").',
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

// Non-interactive ("print") invocation per agent CLI for the one-off naming call.
// Naming needs no tools, so ANY installed agent CLI works — we prefer the one being
// hosted so a codex/gemini user need not ALSO install claude. Best-effort flags;
// unknown/failed → fall back to claude, then to the mechanical dir-name.
const HEADLESS_ARGS = {
  claude: (p) => ['-p', p],
  gemini: (p) => ['-p', p],
  codex: (p) => ['exec', p],
};
// Spawn `cmd args`, capture stdout; missing binary / non-zero exit / timeout → ''.
function spawnCapture(cmd, args, { timeoutMs = 30000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return finish(''); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out : ''); });
  });
}
// Name via the local `claude` CLI. Kept as its own export for direct tests / callers.
export function runHeadlessClaude(prompt, opts = {}) {
  return spawnCapture('claude', ['-p', prompt], opts);
}
// Name via a given agent's own CLI (unknown agent → claude's invocation).
export function runHeadlessAgent(agentType, prompt, opts = {}) {
  const cmd = HEADLESS_ARGS[agentType] ? agentType : 'claude';
  return spawnCapture(cmd, HEADLESS_ARGS[cmd](prompt), opts);
}

// Orchestrator, grounded-first: ① the room template's own role list (untaken
// entries verbatim — deterministic, zero LLM); ② only when the template gives
// nothing, a one-off headless call grounded on the room's purpose/context;
// ③ dir-name fallback so the picker never comes up empty.
export async function suggestNames({ dir, agentType, url, roomId, fetchImpl, runHeadless = null, log = () => {} } = {}) {
  // Default namer: the hosted agent's own CLI first, then claude as a fallback (so a
  // codex/gemini box without claude still gets grounded names). Tests inject their own.
  const headless = runHeadless || (async (prompt) => {
    let out = await runHeadlessAgent(agentType, prompt);
    if (!out && agentType && agentType !== 'claude') out = await runHeadlessClaude(prompt);
    return out;
  });
  const info = await gatherRoomInfo(url, roomId, { fetchImpl });
  const taken = info.agents || [];
  const lower = new Set(taken.map((t) => String(t).trim().toLowerCase()));
  const templateRoles = extractTemplateRoles(info.context).filter((r) => !lower.has(r.toLowerCase()));
  if (templateRoles.length) {
    log(`▸ The room template defines participant roles${info.roomName ? ` (room "${info.roomName}")` : ''} — untaken: ${templateRoles.join(', ')}`);
    const candidates = [...templateRoles, ...fallbackCandidates(dir, [...taken, ...templateRoles])].slice(0, 5);
    return { candidates, info, source: 'template' };
  }
  log(`▸ Asking a one-off headless agent to suggest a name from the room info…${info.roomName ? ` (room "${info.roomName}"${taken.length ? ` · present: ${taken.join(', ')}` : ''})` : ''}`);
  const raw = await headless(namingPrompt({ dir, agentType, ...info }));
  const llm = parseCandidates(raw, { taken });
  const fb = fallbackCandidates(dir, [...taken, ...llm]);
  const candidates = [...llm, ...fb].slice(0, 5);
  return { candidates, info, source: llm.length ? 'headless' : 'fallback' };
}
