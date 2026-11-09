// Monthly reference tables (Meal Allowances, What's New report times) that the user imports with "Add Meal Expenses and Report Time PDFs".
// They are kept on the device only. The app itself contains no monthly tables: without them it uses the
// contract (7.02.02) rates.

import { FIRST_CONTRACT_PERIOD } from './contract.js';

const KEY = 'expense-checker-tables-v1';
let memory = null; // fallback when localStorage is unavailable (private mode)

function loadUser() {
  if (memory) return memory;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { meals: v.meals || {}, report: v.report || {} };
  } catch {
    return { meals: {}, report: {} };
  }
}

/** Saves an imported table. Returns true when it was stored permanently. */
export function saveTable(t) {
  const u = loadUser();
  u[t.kind][t.period] = { ...t, source: 'imported', importedAt: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
    memory = null;
    return true;
  } catch {
    memory = u;
    return false;
  }
}

/** Removes every table added on this device ("Clear all added PDFs" in Settings). */
export function clearTables() {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing was kept */
  }
}

export function removeTable(kind, period) {
  const u = loadUser();
  delete u[kind][period];
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    memory = u;
  }
}

const monthNo = (p) => Number(String(p).slice(0, 4)) * 12 + Number(String(p).slice(4, 6));

/**
 * Tables to use for a statement period, from tables keyed by period ("202606").
 *  meals:    that month only (the rates change every month).
 *  refMeals: before March 2026 (no 7.02.02 column in effect yet) and without that month's table: the nearest
 *            table from before March 2026, for its Canada rates.
 *  report:   that month, or else the latest earlier bulletin (the list rarely changes).
 */
export function selectTables(period, mealsByPeriod = {}, reportsByPeriod = {}) {
  const meals = mealsByPeriod[period] || null;
  let refMeals = null;
  if (!meals && Number(period) < FIRST_CONTRACT_PERIOD) {
    const pre = Object.keys(mealsByPeriod)
      .filter((p) => Number(p) < FIRST_CONTRACT_PERIOD && mealsByPeriod[p].canada)
      .sort((a, b) => Math.abs(monthNo(a) - monthNo(period)) - Math.abs(monthNo(b) - monthNo(period)) || Number(b) - Number(a));
    if (pre.length) refMeals = mealsByPeriod[pre[0]];
  }
  let report = reportsByPeriod[period] || null;
  if (!report) {
    const earlier = Object.keys(reportsByPeriod).filter((p) => p < period).sort();
    if (earlier.length) report = { ...reportsByPeriod[earlier[earlier.length - 1]], fallbackFor: period };
  }
  return { meals, refMeals, report };
}

/** Tables the user imported on this device, for a statement period. */
export function tablesFor(period) {
  const u = loadUser();
  return selectTables(period, u.meals, u.report);
}

/** Every month with at least one imported table: [{ period, meals: source|null, report: source|null }] newest first. */
export function listTables() {
  const u = loadUser();
  const periods = [...new Set([...Object.keys(u.meals), ...Object.keys(u.report)])].sort().reverse();
  return periods.map((p) => ({ period: p, meals: u.meals[p] ? u.meals[p].source : null, report: u.report[p] ? u.report[p].source : null }));
}
