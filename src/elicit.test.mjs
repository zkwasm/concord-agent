// Pure-logic tests for ACP form elicitation ⇄ chat text. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForm, renderQuestion, parseReply } from './elicit.mjs';

// A faithful copy of what claude-agent-acp emits for one single-select
// AskUserQuestion (fields question_0 + question_0_custom).
const SINGLE = {
  mode: 'form',
  sessionId: 's1',
  message: 'Which database should we use?',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string', title: 'Database',
        oneOf: [
          { const: 'Postgres', title: 'Postgres — relational, battle-tested' },
          { const: 'SQLite', title: 'SQLite — embedded, zero-ops' },
        ],
      },
      question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer instead of choosing an option above (optional).' },
    },
  },
};

const MULTI = {
  mode: 'form',
  sessionId: 's1',
  message: 'Please answer the following questions.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: { type: 'string', title: 'DB', description: 'Which database?', oneOf: [{ const: 'Postgres' }, { const: 'SQLite' }] },
      question_0_custom: { type: 'string', title: 'Other' },
      question_1: { type: 'array', title: 'Features', description: 'Which features?', items: { anyOf: [{ const: 'auth' }, { const: 'billing' }, { const: 'search' }] } },
      question_1_custom: { type: 'string', title: 'Other' },
    },
  },
};

test('parseForm folds _custom fields into their base question', () => {
  const f = parseForm(SINGLE);
  assert.equal(f.fields.length, 1);
  assert.equal(f.fields[0].key, 'question_0');
  assert.equal(f.fields[0].customKey, 'question_0_custom');
  assert.deepEqual(f.fields[0].options.map((o) => o.label), ['Postgres', 'SQLite']);
  const m = parseForm(MULTI);
  assert.equal(m.fields.length, 2);
  assert.equal(m.fields[1].multi, true);
});

test('renderQuestion: numbered options + hints', () => {
  const text = renderQuestion(parseForm(SINGLE));
  assert.match(text, /Which database/);
  assert.match(text, /1\. Postgres — relational/);
  assert.match(text, /2\. SQLite/);
  assert.match(text, /skip/);
});

test('parseReply: number picks the option label', () => {
  const form = parseForm(SINGLE);
  assert.deepEqual(parseReply(form, '2').response, { action: 'accept', content: { question_0: 'SQLite' } });
  assert.deepEqual(parseReply(form, 'postgres').response.content, { question_0: 'Postgres' });   // label, case-insensitive
});

test('parseReply: unmatched text flows into the custom "Other" slot', () => {
  const form = parseForm(SINGLE);
  assert.deepEqual(parseReply(form, '用 DuckDB 吧').response.content, { question_0_custom: '用 DuckDB 吧' });
});

test('parseReply: multi-question with multi-select (semicolon-separated, comma multi)', () => {
  const form = parseForm(MULTI);
  const r = parseReply(form, '1; 1,3');
  assert.deepEqual(r.response.content, { question_0: 'Postgres', question_1: ['auth', 'search'] });
});

test('parseReply: skip → accept empty; cancel → cancel; empty → hint', () => {
  const form = parseForm(SINGLE);
  assert.deepEqual(parseReply(form, 'skip').response, { action: 'accept', content: {} });
  assert.deepEqual(parseReply(form, '取消').response, { action: 'cancel' });
  assert.equal(parseReply(form, '  ').ok, false);
});

test('parseReply: partial answers on multi-question leave the rest unanswered', () => {
  const form = parseForm(MULTI);
  assert.deepEqual(parseReply(form, '2').response.content, { question_0: 'SQLite' });   // q1 skipped
});
