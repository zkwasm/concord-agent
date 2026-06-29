// Tests for outbound Lark rendering. Run: node --test src/im-render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCard, larkText, buildCard } from './im-render.mjs';

test('shouldUseCard: status lines → plain; structured/markdown → card', () => {
  assert.equal(shouldUseCard('收到 👌'), false);
  assert.equal(shouldUseCard('✓ 绑定成功,agent 已就位'), false);
  assert.equal(shouldUseCard(''), false);
  assert.equal(shouldUseCard('line1\nline2'), true);          // multi-line
  assert.equal(shouldUseCard('see **this**'), true);          // inline bold
  assert.equal(shouldUseCard('run `ls`'), true);              // inline code
  assert.equal(shouldUseCard('- a bullet'), true);            // list
});

test('larkText: ATX headings → bold (Lark cards render # literally); rest untouched', () => {
  assert.equal(larkText('# Title'), '**Title**');
  assert.equal(larkText('### Deep heading'), '**Deep heading**');
  assert.equal(larkText('## Title ##'), '**Title**');          // closing #'s stripped
  assert.equal(larkText('  ## Indented'), '  **Indented**');   // indent preserved
  // non-headings left alone
  assert.equal(larkText('a #hashtag not a heading'), 'a #hashtag not a heading');
  assert.equal(larkText('- list\n`code`\n**bold**'), '- list\n`code`\n**bold**');
});

test('larkText: multi-line doc with mixed markdown', () => {
  const md = '# Plan\n\nSteps:\n- one\n- two\n\n```\ncode\n```';
  const out = larkText(md);
  assert.match(out, /\*\*Plan\*\*/);     // heading bolded
  assert.match(out, /- one/);            // list intact
  assert.match(out, /```\ncode\n```/);   // code block intact
});

test('buildCard wraps cleaned markdown in an interactive card', () => {
  const card = buildCard('# Hi\n- x');
  assert.equal(card.elements[0].tag, 'markdown');
  assert.match(card.elements[0].content, /\*\*Hi\*\*/);
});
