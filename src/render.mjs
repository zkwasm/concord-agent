// Turn an ACP `tool_call` update into a human-readable progress line for the room
// (and onward to Lark). Beyond the tool name, surface the key detail — file path /
// search query / command / url — so the room sees WHAT the agent is doing.
//
// Pure logic, no acpx/network → unit-testable (render.test.mjs). The live field
// names vary by adapter; the acp bridge's ACP_DEBUG_TOOLCALL hook dumps raw
// tool_calls so this extraction can be tuned against real data.

// ACP tool kind -> icon.
export const KIND_ICON = {
  read: '📖', edit: '✏️', delete: '🗑️', move: '🔀',
  search: '🔎', execute: '▶️', fetch: '🌐', think: '💭', other: '🔧',
};

// Raw-input fields, most-informative first, checked when there's no file location.
const DETAIL_FIELDS = ['query', 'command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'description'];
const PATH_FIELDS = new Set(['file_path', 'path']);  // show just the basename, not a long absolute path
const MAX_DETAIL = 100;
const basename = (p) => p.split('/').pop() || p;

// The single most useful detail for a tool_call: a concrete file (basename) if the
// adapter reports a location, else the best field from the raw tool input. File
// paths are shortened to the basename; string arrays (e.g. argv) are joined.
// Note: ACP sends the initial `tool_call` (pending) with empty rawInput/locations
// — the detail only arrives in a later `tool_call_update` (verified against acpx).
export function toolDetail(u) {
  const loc = Array.isArray(u.locations) && u.locations[0] && u.locations[0].path;
  if (loc) return basename(String(loc).trim());
  const ri = u.rawInput || u.raw_input || u.input || {};
  for (const k of DETAIL_FIELDS) {
    const v = ri[k];
    if (typeof v === 'string' && v.trim()) return PATH_FIELDS.has(k) ? basename(v.trim()) : v.trim();
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(' ').trim();
  }
  return '';
}

// "🔎 Web search: <query>" / "✏️ Write demo.txt" — icon by kind, then the title and
// key detail. If the title already names the detail (acpx enriches it to e.g.
// "Write demo.txt"), don't repeat it. Detail truncated so a long command/path
// can't blow up the card.
export function toolToProgress(u) {
  const icon = KIND_ICON[u.kind] || KIND_ICON.other;
  const name = u.title || u.kind || 'tool';
  const detail = toolDetail(u);
  const short = detail.length > MAX_DETAIL ? detail.slice(0, MAX_DETAIL) + '…' : detail;
  if (!short || name.toLowerCase().includes(short.toLowerCase())) return `${icon} ${name}`;
  return `${icon} ${name}: ${short}`;
}
