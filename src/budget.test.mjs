// Pure-logic tests for token budget/accounting. Run: node --test bridges/acp/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overBudget, fmtTok, usageReport, budgetExceededNote } from './budget.mjs';

test('overBudget: 0/negative budget = unlimited', () => {
  assert.equal(overBudget({ fresh: 99999 }, 0), false);
  assert.equal(overBudget({ fresh: 99999 }, -1), false);
});

test('overBudget: at/over cap trips, under does not', () => {
  assert.equal(overBudget({ fresh: 999 }, 1000), false);
  assert.equal(overBudget({ fresh: 1000 }, 1000), true);
  assert.equal(overBudget({ fresh: 1500 }, 1000), true);
  assert.equal(overBudget({}, 1000), false);                 // missing fresh → 0
});

test('fmtTok: thousands shortening', () => {
  assert.equal(fmtTok(0), '0');
  assert.equal(fmtTok(999), '999');
  assert.equal(fmtTok(1000), '1.0k');
  assert.equal(fmtTok(1500), '1.5k');
  assert.equal(fmtTok(12000), '12k');
});

test('usageReport: cumulative, shows cap when budgeted, "no cap" when not (en default + zh)', () => {
  const en = usageReport({ fresh: 1200, cached: 45000, turns: 3 }, 10000);
  assert.match(en, /fresh 1\.2k\/10k budget/);
  assert.match(en, /cumulative/i);
  assert.match(en, /3 turns/);
  assert.match(usageReport({ fresh: 500, cached: 0, turns: 1 }, 0), /no cap/);
  // zh locale still supported
  assert.match(usageReport({ fresh: 1200, cached: 45000, turns: 3 }, 10000, 'zh'), /fresh 1\.2k\/10k 预算/);
  assert.match(usageReport({ fresh: 1200, cached: 45000, turns: 3 }, 10000, 'zh'), /3 轮/);
  assert.match(usageReport({ fresh: 500, cached: 0, turns: 1 }, 0, 'zh'), /无上限/);
});

test('budgetExceededNote mentions the numbers (≥10k rounds to integer k)', () => {
  assert.match(budgetExceededNote({ fresh: 10500 }, 10000), /11k\/10k/);
  assert.match(budgetExceededNote({ fresh: 8500 }, 8000), /8\.5k\/8\.0k/);
});
