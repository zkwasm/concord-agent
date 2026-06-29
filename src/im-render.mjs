// How to render an outbound message to Lark. Short status lines (the "收到 👌" ack,
// "✓ 绑定成功") read better as plain text — lighter, not boxed in a card. Replies with
// real structure get an interactive markdown card. Lark's card markdown does NOT render
// headings (`#` shows literally), so we convert them to bold. Pure → unit-testable.

// Inline-markdown signals that genuinely render differently in a card vs. plain text.
// Conservative on single-line input to avoid carding status lines.
const INLINE_MD = /\*\*|~~|`|\[[^\]]+\]\([^)]+\)|^\s{0,3}#{1,6}\s|^\s{0,3}[-*+]\s|^\s{0,3}\d+\.\s/m;

// True when the text benefits from a markdown card. Multi-line always cards (lists /
// code blocks / tables span lines); single-line cards only if it carries inline markdown.
export function shouldUseCard(text) {
  if (!text) return false;
  if (text.includes('\n')) return true;
  return INLINE_MD.test(text);
}

// Clean Claude's markdown for a Lark card: ATX headings (`## Title`) → **bold**, since
// Lark cards render the `#` literally. Lists, code blocks, inline code, bold, and links
// are left as-is — Lark's markdown element supports those.
export function larkText(text) {
  return String(text || '').replace(/^(\s{0,3})#{1,6}[ \t]+(.*?)[ \t]*#*\s*$/gm, (_m, indent, body) => `${indent}**${body}**`);
}

// The Lark interactive-card payload that renders `text` (cleaned) as markdown.
export function buildCard(text) {
  return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: larkText(text) }] };
}
