// Pure-logic tests for token budget/accounting. Run: node --test bridges/acp/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowElapsed, overBudget, fmtTok, usageReport, budgetExceededNote } from './budget.mjs';

test('windowElapsed: null start, within, and past', () => {
  assert.equal(windowElapsed(null, 1000, 500), true);        // never started → roll
  assert.equal(windowElapsed(1000, 1200, 500), false);       // within window
  assert.equal(windowElapsed(1000, 1600, 500), true);        // window passed
});

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

test('usageReport: shows cap when budgeted, "无上限" when not', () => {
  assert.match(usageReport({ fresh: 1200, cached: 45000, turns: 3 }, 10000, 24), /fresh 1\.2k\/10k 预算/);
  assert.match(usageReport({ fresh: 1200, cached: 45000, turns: 3 }, 10000, 24), /3 轮/);
  assert.match(usageReport({ fresh: 500, cached: 0, turns: 1 }, 0, 24), /无上限/);
});

test('budgetExceededNote mentions the numbers (≥10k rounds to integer k)', () => {
  assert.match(budgetExceededNote({ fresh: 10500 }, 10000, 24), /11k\/10k/);
  assert.match(budgetExceededNote({ fresh: 8500 }, 8000, 24), /8\.5k\/8\.0k/);
});
