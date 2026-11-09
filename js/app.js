import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { extractPages } from './pdftext.js';
import { parseStatement, precheck } from './parser.js';
import { verify, fmtClock } from './engine.js';
import { RULE_TEXT, RATE_TABLE, MEAL_NAMES, AGREEMENT } from './contract.js';
import { countryName } from './stations.js';
import { detectKind, parseMealTable, parseReportTimes } from './tables.js';
import { saveTable, tablesFor, listTables, clearTables } from './tablestore.js';
import { APP_VERSION } from './version.js';
import { checkAccess, localAccess, MAX_OFFLINE_DAYS } from './access.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = globalThis.__PDFJS_WORKER_SRC__ || new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

// ---------------------------------------------------------------- helpers
const $ = (s) => document.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'svg') el.innerHTML = v; // trusted static icons only
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  again: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>',
};
const icon = (name) => {
  const span = document.createElement('span');
  span.innerHTML = ICON[name];
  return span.firstChild;
};

const money = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(2)}`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const periodLabel = (p) => {
  const y = String(p).slice(0, 4);
  const m = Number(String(p).slice(4, 6));
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : String(p || 'unknown');
};
const SEV_LABEL = { ok: 'OK', error: 'Problem', warn: 'Review', info: 'Info' };

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'expense-checker-settings';
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { theme: saved.theme || '' };
  } catch {
    return { theme: '' };
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings last for this visit only */
  }
}
let settings = loadSettings();
applyTheme(settings.theme);

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

// ---------------------------------------------------------------- state
const state = { fileName: '', st: null, pre: null, result: null, filter: 'attention' };

// ---------------------------------------------------------------- online check-in / on-off switch (access.js)
let locked = false;
let lastAccessAttempt = 0;
const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function applyAccess(a, { pending = false } = {}) {
  locked = a.state === 'blocked' || a.state === 'disabled';
  document.body.classList.toggle('locked', locked);
  const gate = $('#gate');
  gate.hidden = !locked;
  gate.classList.toggle('off', a.state === 'disabled');
  // SVG elements have no .hidden property: use the attribute
  $('#gate-ico-wifi').toggleAttribute('hidden', a.state === 'disabled');
  $('#gate-ico-off').toggleAttribute('hidden', a.state !== 'disabled');
  const retry = $('#gate-retry');
  if (a.state === 'disabled') {
    $('#gate-title').textContent = 'Expense Checker is not available';
    $('#gate-text').textContent = a.message || 'This app has been switched off.';
    retry.textContent = 'Check again';
    retry.hidden = false;
  } else if (pending) {
    $('#gate-title').textContent = 'Checking the connection…';
    $('#gate-text').textContent = '';
    retry.hidden = true;
  } else if (a.state === 'blocked') {
    $('#gate-title').textContent = 'Connect to the internet';
    $('#gate-text').textContent =
      `Expense Checker needs to connect to the internet at least once every ${MAX_OFFLINE_DAYS} days.` +
      (a.lastOk && a.reason !== 'clock' ? ` Last connection: ${fmtDay(a.lastOk)}.` : '') +
      ' Turn on Wi-Fi or mobile data, then tap Try again.';
    retry.textContent = 'Try again';
    retry.hidden = false;
  }
  const warn = $('#access-warn');
  warn.hidden = a.state !== 'warn';
  if (a.state === 'warn') $('#access-warn-text').textContent = `Connect to the internet within ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} to keep using Expense Checker.`;
}

async function runAccessCheck() {
  lastAccessAttempt = Date.now();
  if (locked) $('#gate-status').textContent = 'Checking…';
  const a = await checkAccess();
  applyAccess(a);
  $('#gate-status').textContent = locked && !a.online && a.state !== 'disabled' ? 'Still no connection.' : '';
  return a;
}

/** Before any work: lock straight away if the 30 days ran out while the app stayed open. */
function accessAllowed() {
  if (locked) return false;
  const a = localAccess();
  if (a.state === 'blocked' || a.state === 'disabled') {
    applyAccess(a);
    return false;
  }
  return true;
}

{
  const now = localAccess();
  // nothing recorded yet (first start): show "Checking…" instead of a lock screen while the site is contacted
  applyAccess(now, { pending: now.state === 'blocked' && now.reason === 'never' });
  runAccessCheck();
  $('#gate-retry').addEventListener('click', runAccessCheck);
  window.addEventListener('online', runAccessCheck);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastAccessAttempt > 6 * 3600 * 1000) runAccessCheck();
  });
}

// ---------------------------------------------------------------- import
const fileInput = $('#file');
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (f) handleFile(f);
  fileInput.value = '';
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    drop.classList.remove('drag');
  }),
);
document.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
  if (files.length) handleFiles(files);
});

const tablesInput = $('#tables-file');
tablesInput.addEventListener('change', () => {
  const files = tablesInput.files ? [...tablesInput.files] : [];
  tablesInput.value = '';
  if (files.length) importTables(files);
});
if (matchMedia('(pointer: coarse)').matches) $('#drop-hint').hidden = true;

function showStatus(node) {
  const s = $('#status');
  if (node) s.replaceChildren(node);
  else s.replaceChildren();
  s.hidden = !node;
}

async function readPdf(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) throw new Error(`${file.name} is not a PDF.`);
  return extractPages(pdfjsLib, buf);
}

// ---------------------------------------------------------------- monthly tables
function tableFromDoc(doc, name) {
  const kind = detectKind(doc);
  if (!kind) return null;
  return kind === 'meals' ? parseMealTable(doc, name) : parseReportTimes(doc, name);
}
const KIND_LABEL = { meals: 'Meal Allowances', report: 'What’s New report times' };

function storeTable(t) {
  if (t.errors.length) return { ok: false, text: `${t.fileName}: ${t.errors.join(' ')}` };
  const saved = saveTable(t);
  const what = t.kind === 'meals' ? `${t.rows.length} stations` : `${t.rows.length} flights with an earlier report time`;
  return { ok: true, text: `${KIND_LABEL[t.kind]} · ${periodLabel(t.period)} added (${what}).${saved ? '' : ' Private browsing: it is kept for this visit only.'}` };
}

function showTablesMsg(results) {
  const box = $('#tables-msg');
  box.replaceChildren(
    ...results.map((r) => h('div', { class: `tmsg ${r.ok ? 'ok' : 'bad'}` }, icon(r.ok ? 'ok' : 'error'), h('span', { text: r.text }))),
  );
}

async function importTables(files, alsoStatement = false) {
  if (!accessAllowed()) return null;
  const results = [];
  let statement = null;
  showTablesMsg([{ ok: true, text: `Reading ${files.length} PDF${files.length > 1 ? 's' : ''}…` }]);
  for (const f of files) {
    try {
      const doc = await readPdf(f);
      const t = tableFromDoc(doc, f.name);
      if (t) results.push(storeTable(t));
      else if (alsoStatement && !statement) statement = { file: f, doc };
      else results.push({ ok: false, text: `${f.name}: not a Meal Allowances table or a What’s New bulletin with report times.` });
    } catch (err) {
      results.push({ ok: false, text: `${f.name}: ${err && err.message ? err.message : String(err)}` });
    }
  }
  showTablesMsg(results);
  renderTablesList();
  if (state.st && !$('#precheck').hidden && !state.result) {
    state.tablesMsg = results;
    renderPrecheck();
  }
  return statement;
}

function renderTablesList() {
  const list = listTables();
  const box = $('#tables-list');
  if (!list.length) {
    box.replaceChildren(h('p', { class: 'muted small', text: 'No PDFs added yet. A month’s statement can only be checked once its Meal Allowances table is added.' }));
    return;
  }
  const row = (t) =>
    h(
      'li',
      {},
      h('span', { class: 'm', text: periodLabel(t.period) }),
      h(
        'span',
        { class: 'tchips' },
        h('span', { class: `tchip ${t.meals ? 'on' : 'off'}`, title: t.meals ? `Meal Allowances (${t.meals})` : 'Meal Allowances missing', text: t.meals ? 'Meal rates ✓' : 'Meal rates —' }),
        h('span', { class: `tchip ${t.report ? 'on' : 'off'}`, title: t.report ? `What’s New (${t.report})` : 'What’s New missing', text: t.report ? 'Report times ✓' : 'Report times —' }),
      ),
    );
  const recent = list.slice(0, 3);
  const older = list.slice(3);
  const nodes = [h('ul', { class: 'tlist' }, recent.map(row))];
  if (older.length) nodes.push(h('details', { class: 'tmore' }, h('summary', { text: `${older.length} earlier month${older.length > 1 ? 's' : ''}` }), h('ul', { class: 'tlist' }, older.map(row))));
  box.replaceChildren(...nodes); // replaceChildren would print "null" for an empty slot

}
renderTablesList();

async function handleFiles(files) {
  if (files.length === 1) return handleFile(files[0]);
  const statement = await importTables(files, true);
  if (statement) handleFile(statement.file, statement.doc);
}

async function handleFile(file, preDoc = null) {
  if (!accessAllowed()) return;
  state.fileName = file.name;
  $('#import').hidden = true;
  $('#tables').hidden = true;
  $('#precheck').hidden = true;
  $('#results').hidden = true;
  showStatus(h('div', { class: 'card busy' }, h('div', { class: 'spinner' }), h('div', {}, h('b', { text: 'Reading PDF…' }), h('div', { class: 'muted small', text: file.name }))));
  try {
    const doc = preDoc || (await readPdf(file));
    const t = tableFromDoc(doc, file.name);
    if (t) {
      // a monthly table imported through the main button: store it and go back to the start screen
      const res = storeTable(t);
      showStatus(null);
      $('#import').hidden = false;
      $('#tables').hidden = false;
      showTablesMsg([res]);
      renderTablesList();
      $('#tables').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const st = parseStatement(doc);
    state.st = st;
    state.pre = precheck(st);
    state.result = null;
    showStatus(null);
    renderPrecheck();
  } catch (err) {
    if (!(err && err.title)) console.error(err); // titled errors are expected user mistakes
    const msg = err && err.name === 'PasswordException' ? 'This PDF is password protected.' : err && err.message ? err.message : String(err);
    showStatus(
      h(
        'div',
        { class: 'banner error' },
        icon('error'),
        h('div', {}, h('h2', { text: (err && err.title) || 'The PDF could not be read' }), h('p', { text: msg }), h('p', { class: 'small', text: 'Use the PDF saved from Rainmaker > Crew Pay Details > Print > Save as PDF.' })),
      ),
    );
    $('#status').append(againRow());
  }
}

// ---------------------------------------------------------------- pre-check
function renderPrecheck() {
  const { st, pre } = state;
  const sec = $('#precheck');
  const m = st.meta;
  const card = h('div', { class: 'card' });
  card.append(
    h('h2', { text: 'Step 1 · PDF check' }),
    h('p', { class: 'muted small', text: 'Before checking expenses, the app confirms the PDF was printed the right way and that the monthly PDFs of the same month are added.' }),
    h('div', { class: 'file-line' }, icon('file'), h('span', { class: 'name', text: state.fileName })),
  );
  if (m.employee || m.period) {
    card.append(
      h('dl', { class: 'kv' }, m.employee ? [h('dt', { text: 'Employee' }), h('dd', { text: m.employee })] : null, m.period ? [h('dt', { text: 'Period' }), h('dd', { text: `${periodLabel(m.period)} (${m.period})` })] : null),
    );
    card.lastChild.style.marginBottom = '12px';
  }
  if (st.errors.length && !st.header) {
    card.append(h('div', { class: 'banner error' }, icon('error'), h('div', {}, h('h2', { text: 'Not a Crew Pay Details report' }), h('p', { text: st.errors[0] }))));
    sec.replaceChildren(card, againRow());
    sec.hidden = false;
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const checkItem = (c) => {
    const level = c.ok ? 'ok' : c.optional ? 'warn' : 'bad';
    return h(
      'li',
      { class: `check ${level}` },
      icon(level === 'bad' ? 'error' : level),
      h('div', {}, h('div', { class: 'c-label', text: c.label }), h('div', { class: 'c-detail', text: c.detail }), c.ok || !c.fix ? null : h('div', { class: 'c-fix' }, h('b', { text: c.optional ? 'Recommended: ' : 'Fix: ' }), c.fix)),
    );
  };
  card.append(h('div', { class: 'check-group', text: 'Printed from Rainmaker' }), h('ul', { class: 'checks' }, pre.checks.map(checkItem)));

  // the Meal Allowances table of the statement's own month is required; its What's New bulletin is recommended
  const mon = periodLabel(m.period);
  const monthly = monthlyChecks(m.period);
  const monthlyOk = monthly.every((c) => c.ok || c.optional);
  const noReport = monthly.some((c) => c.id === 'report' && !c.ok);
  card.append(monthlyBlock(mon, monthly, checkItem));

  if (pre.ok && monthlyOk) {
    const text = noReport
      ? `Printed correctly, and the ${mon} Meal Allowances table is added. Without the ${mon} What’s New bulletin, some rules may not be validated (the earlier report time of some flights).`
      : `Printed correctly, and the ${mon} Meal Allowances table and What’s New bulletin are added.`;
    card.append(
      h('div', { class: 'banner ok' }, icon('ok'), h('div', {}, h('h2', { text: 'Ready to check' }), h('p', { text }))),
      h('div', { class: 'btn-row no-print' }, h('button', { class: 'btn primary big', type: 'button', onclick: runCheck, svg: ICON.play + '<span>Check expenses</span>' })),
    );
    sec.replaceChildren(card);
  } else if (pre.ok) {
    card.append(
      h(
        'div',
        { class: 'banner warn' },
        icon('warn'),
        h('div', {}, h('h2', { text: `Add the ${mon} Meal Allowances table` }), h('p', { text: `The PDF is printed correctly. To check it, add the Meal Allowances table of ${mon} above (required). The What’s New bulletin is optional but recommended.` })),
      ),
    );
    sec.replaceChildren(card, againRow(false));
  } else {
    const bad = pre.checks.filter((c) => !c.ok);
    card.append(
      h(
        'div',
        { class: 'banner error' },
        icon('error'),
        h('div', {}, h('h2', { text: 'This PDF can’t be checked yet' }), h('p', { text: `${bad.length} print setting${bad.length > 1 ? 's are' : ' is'} not right. Re-print it from Rainmaker, then import the new PDF.` })),
      ),
      howToList(bad),
    );
    sec.replaceChildren(card, againRow());
  }
  const banner = card.querySelector('.banner');
  if (banner) banner.style.marginTop = '14px';
  sec.hidden = false;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The monthly PDFs of a statement: [{ id, ok, optional, label, detail, fix }]
//   Meal Allowances table: required.  What's New bulletin: optional, missing = warning.
function monthlyChecks(period) {
  const t = tablesFor(period);
  const mon = periodLabel(period);
  const report = t.report && !t.report.fallbackFor ? t.report : null;
  const earlier = t.report && t.report.fallbackFor ? t.report : null;
  return [
    {
      id: 'meals',
      ok: !!t.meals,
      label: `Meal Allowances table · ${mon} (required)`,
      detail: t.meals ? `Added: ${t.meals.rows.length} stations.` : 'Not added yet: the meal rates cannot be checked without it.',
      fix: `add ${period}-MealAllowances.pdf (Block Bid Package › ${mon} › Base: ALL).`,
    },
    {
      id: 'report',
      ok: !!report,
      optional: true,
      label: `What’s New bulletin · ${mon} (optional)`,
      detail: report
        ? `Added: ${report.rows.length} flights with an earlier report time.`
        : earlier
          ? `Not added: some rules may not be validated. The ${periodLabel(earlier.period)} list of earlier report times is used, so a flight added in ${mon} could be missed.`
          : 'Not added: some rules may not be validated. Standard report times are used, so the earlier report time of some flights is not taken into account.',
      fix: `add ${period}_Whats_New-BL.pdf (Block Bid Package › ${mon} › Base: ALL).`,
    },
  ];
}

function monthlyBlock(mon, monthly, checkItem) {
  const missing = monthly.some((c) => !c.ok);
  const requiredMissing = monthly.some((c) => !c.ok && !c.optional);
  const msgs = state.tablesMsg || [];
  state.tablesMsg = null;
  return h(
    'div',
    { class: 'tables-block' },
    h('div', { class: 'check-group', text: `Monthly PDFs for ${mon}` }),
    msgs.map((r) => h('div', { class: `tmsg ${r.ok ? 'ok' : 'bad'}` }, icon(r.ok ? 'ok' : 'error'), h('span', { text: r.text }))),
    h('ul', { class: 'checks' }, monthly.map(checkItem)),
    missing
      ? h('div', { class: 'btn-row no-print' }, h('label', { class: requiredMissing ? 'btn primary' : 'btn', for: 'tables-file', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add Meal Expenses and Report Time PDFs</span>' }))
      : null,
    missing ? tablesGuide() : null,
  );
}

// The "Where to get these PDFs" guide of the start screen, reused (closed) wherever a table is missing.
function tablesGuide() {
  const g = $('#tables-guide').cloneNode(true);
  g.removeAttribute('id');
  g.open = false;
  g.classList.add('no-print');
  return g;
}

// The same illustrated steps as the start screen, with the steps that fix the failed checks outlined.
function howToList(bad) {
  const ids = new Set(bad.map((b) => b.id));
  const why = {
    plus: ids.has('plus') ? 'Missed: columns not opened' : null,
    details: ids.has('details') ? 'Missed: Details not shown' : null,
    pdf: ids.has('landscape') ? 'Missed: printed in Portrait' : ids.has('columns') ? 'Missed: columns cut off' : null,
  };
  const steps = $('#howto-steps').cloneNode(true);
  steps.removeAttribute('id');
  for (const li of steps.querySelectorAll('.step')) {
    const tag = why[li.dataset.step];
    if (!tag) continue;
    li.classList.add('need');
    li.querySelector('.step-head > div').prepend(h('span', { class: 'need-tag', text: tag }));
  }
  return h('div', { class: 'reprint' }, h('div', { class: 't', text: 'How to re-print' }), h('p', { class: 'muted small', text: 'Follow all the steps again; the outlined ones are what was missing.' }), steps);
}

function againRow(primary = true) {
  return h('div', { class: 'btn-row no-print' }, h('label', { class: primary ? 'btn primary' : 'btn', for: 'file', svg: ICON.again + '<span>Import another Rainmaker PDF</span>' }));
}

// ---------------------------------------------------------------- results
function runCheck() {
  if (!accessAllowed()) return;
  if (!monthlyChecks(state.st.meta.period).every((c) => c.ok || c.optional)) {
    renderPrecheck();
    return;
  }
  try {
    state.result = verify(state.st, { tables: tablesFor(state.st.meta.period) });
  } catch (err) {
    console.error(err);
    showStatus(h('div', { class: 'banner error' }, icon('error'), h('div', {}, h('h2', { text: 'Something went wrong while checking' }), h('p', { text: String(err && err.message ? err.message : err) }))));
    return;
  }
  const r = state.result;
  const attention = r.items.filter((i) => i.severity === 'error' || i.severity === 'warn').length + r.other.filter((o) => o.severity === 'error' || o.severity === 'warn').length;
  state.filter = attention ? 'attention' : 'all';
  // collapse the pre-check into a one-line confirmation
  const sec = $('#precheck');
  sec.replaceChildren(
    h('div', { class: 'card' }, h('div', { class: 'file-line' }, icon('file'), h('span', { class: 'name', text: state.fileName })), h('div', { class: 'banner ok' }, icon('ok'), h('div', {}, h('h2', { text: 'PDF check passed' }), h('p', { class: 'small', text: state.pre.checks.map((c) => c.label).join(' · ') })))),
  );
  renderResults();
}

function renderResults() {
  const r = state.result;
  const sec = $('#results');
  const s = r.summary;
  const nodes = [];

  // verdict
  const nErr = r.items.filter((i) => i.severity === 'error').length + r.other.filter((o) => o.severity === 'error').length;
  const nWarn = r.items.filter((i) => i.severity === 'warn').length + r.other.filter((o) => o.severity === 'warn').length;
  const nOk = r.items.filter((i) => i.severity === 'ok').length;
  let head;
  let sub;
  if (s.verdict === 'ok') {
    head = 'All expenses were paid according to the contract';
    sub = `${nOk} meal allowance${nOk === 1 ? '' : 's'} and gratuities checked. Nothing missing.`;
  } else if (s.verdict === 'error') {
    head = `${nErr} item${nErr === 1 ? '' : 's'} not paid according to the contract`;
    sub = s.certainOwed > 0 ? `${money(s.certainOwed)} appears to be owed.` : 'See the items below.';
    if (nWarn) sub += ` ${nWarn} more item${nWarn === 1 ? '' : 's'} to review.`;
  } else {
    head = `Paid correctly, with ${nWarn} item${nWarn === 1 ? '' : 's'} to review`;
    sub = s.owed > 0 ? `Up to ${money(s.owed)} may be owed, depending on how the rule is applied.` : 'See the items below.';
  }
  nodes.push(h('div', { class: `banner ${s.verdict}` }, icon(s.verdict), h('div', {}, h('h2', { text: head }), h('p', { text: sub }))));

  // summary card
  const m = r.meta;
  const bldl = (x) => `B ${money(x.B)} · L ${money(x.L)} · D ${money(x.D)} · S ${money(x.S)}`;
  const tm = r.tables.meals;
  const rateRows = [];
  if (tm) {
    rateRows.push(h('dt', { text: 'Meal rates' }), h('dd', { text: `${periodLabel(tm.period)} Meal Allowances table (${tm.source})` }));
    rateRows.push(h('dt', { text: 'Canada' }), h('dd', { text: bldl(tm.canada) }));
    if (tm.us) rateRows.push(h('dt', { text: 'U.S.' }), h('dd', { text: `${bldl(tm.us)} (Canadian funds)` }));
  } else {
    const src =
      r.rates.key === 'CHART'
        ? `Canada rates of the ${r.rates.label}${r.rates.fromOtherMonth ? ` (no table for ${periodLabel(m.period)})` : ''}`
        : r.rates.key === 'FBMFR-ASSUMED'
          ? `${r.rates.label} (no table from before March 2026 loaded)`
          : `7.02.02, ${r.rates.label}`;
    rateRows.push(h('dt', { text: 'Meal rates' }), h('dd', { text: `${src}: ${bldl(r.rates)}` }));
    rateRows.push(h('dt', { text: 'U.S. meals' }), h('dd', { text: `Not checked: add the ${periodLabel(m.period)} Meal Allowances table` }));
  }
  const tr = r.tables.report;
  rateRows.push(
    h('dt', { text: 'Report times' }),
    h('dd', {
      text: tr && !tr.fallback
        ? `What’s New ${periodLabel(tr.period)}, ${tr.rows} flights with an earlier report time`
        : `${tr ? `What’s New ${periodLabel(tr.period)} used (no bulletin for ${periodLabel(m.period)})` : 'Standard report times (no What’s New bulletin)'}: some rules may not be validated`,
    }),
  );
  const stats = h(
    'div',
    { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'v', text: money(s.paidTotal) }), h('div', { class: 'l', text: 'Expenses paid' })),
    h('div', { class: `stat ${s.certainOwed > 0 ? 'err' : 'ok'}` }, h('div', { class: 'v', text: money(s.certainOwed) }), h('div', { class: 'l', text: 'Not paid' })),
    h('div', { class: `stat ${s.owed - s.certainOwed > 0 ? 'warn' : ''}` }, h('div', { class: 'v', text: money(Math.max(0, s.owed - s.certainOwed)) }), h('div', { class: 'l', text: 'To review' })),
  );
  nodes.push(
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Step 2 · Expense check' }),
      h(
        'dl',
        { class: 'kv' },
        h('dt', { text: 'Employee' }),
        h('dd', { text: m.employee || '—' }),
        h('dt', { text: 'Period' }),
        h('dd', { text: `${periodLabel(m.period)} (${m.period})` }),
        h('dt', { text: 'Home base' }),
        h('dd', { text: r.home }),
        rateRows,
      ),
      stats,
    ),
  );

  // items
  nodes.push(h('div', { class: 'section-title', text: 'Allowances' }));
  const itemsCard = h('div', { class: 'card' });
  const counts = { attention: r.items.filter((i) => i.severity === 'error' || i.severity === 'warn').length, all: r.items.length, info: r.items.filter((i) => i.severity === 'info').length };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' });
  const list = h('div', { class: 'items' });
  const setFilter = (f) => {
    state.filter = f;
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.f === f));
    list.replaceChildren(...itemNodes(r, f));
  };
  for (const [f, label] of [
    ['attention', `Needs attention (${counts.attention})`],
    ['all', `All (${counts.all})`],
  ]) {
    seg.append(h('button', { type: 'button', 'data-f': f, 'aria-pressed': String(state.filter === f), onclick: () => setFilter(f), text: label }));
  }
  itemsCard.append(seg, list);
  list.replaceChildren(...itemNodes(r, state.filter));
  nodes.push(itemsCard);

  // other allowances
  nodes.push(h('div', { class: 'section-title', text: 'Other allowances' }));
  nodes.push(
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'items' },
        r.other.map((o) =>
          h(
            'div',
            { class: `item sev-${o.severity}` },
            icon(o.severity),
            h('div', { class: 'item-body' }, h('div', { class: 'item-title', text: o.title }), h('div', { class: 'item-note', text: o.text })),
            o.paid !== null ? h('div', { class: 'item-amt' }, h('div', { class: 'row' }, 'Paid', h('b', { text: money(o.paid) })), h('div', { class: 'row' }, 'Contract', h('b', { text: money(o.expected) }))) : h('div'),
          ),
        ),
      ),
    ),
  );

  // day by day
  nodes.push(h('div', { class: 'section-title', text: 'Day by day' }));
  nodes.push(h('div', { class: 'card' }, h('p', { class: 'muted small', text: 'Tap a day to see its flights and allowances. Times are local.' }), h('div', { class: 'days' }, dayNodes(r))));

  // totals + rules
  const reconOk = r.recon.every((x) => x.ok);
  nodes.push(
    h(
      'div',
      { class: 'card' },
      h(
        'details',
        { class: 'more' },
        h('summary', { text: `Statement totals ${reconOk ? '— all match' : '— mismatch found'}` }),
        h(
          'div',
          {},
          h('p', { class: 'muted small', text: 'The Total row of the report compared with the sum of the day rows.' }),
          h(
            'table',
            { class: 'rates' },
            h('tr', {}, h('th', { text: 'Column' }), h('th', { text: 'Days' }), h('th', { text: 'Total row' }), h('th', { text: '' })),
            r.recon.map((x) => h('tr', {}, h('td', { text: x.label }), h('td', { text: money(x.sum) }), h('td', { text: money(x.total) }), h('td', { text: x.ok ? '✓' : '✗' }))),
          ),
        ),
      ),
    ),
  );
  nodes.push(rulesCard(r));
  nodes.push(
    h(
      'div',
      { class: 'btn-row wide no-print' },
      h('label', { class: 'btn', for: 'file', svg: ICON.again + '<span>Check another Rainmaker PDF</span>' }),
      h('button', { class: 'btn', type: 'button', onclick: printReport, svg: ICON.print + '<span>Print / save report</span>' }),
    ),
  );

  sec.replaceChildren(...nodes);
  sec.hidden = false;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function itemNodes(r, filter) {
  const items = filter === 'attention' ? r.items.filter((i) => i.severity === 'error' || i.severity === 'warn') : r.items;
  if (!items.length) {
    return [h('div', { class: 'empty' }, filter === 'attention' ? 'Nothing needs attention: every allowance found matches the contract.' : 'No allowances on this statement.')];
  }
  return items.map(itemNode);
}

function itemNode(it) {
  const why = it.lines && it.lines.length ? h('details', {}, h('summary', { text: 'Why' }), h('ul', {}, it.lines.map((l) => h('li', { text: l })))) : null;
  return h(
    'article',
    { class: `item sev-${it.severity}` },
    icon(it.severity),
    h(
      'div',
      { class: 'item-body' },
      h('div', { class: 'item-top' }, h('span', { text: it.date }), h('span', { text: '·' }), h('span', { text: it.meal }), it.pairing ? [h('span', { text: '·' }), h('span', { text: it.pairing })] : null),
      h('div', { class: 'item-title', text: it.title }),
      it.note ? h('div', { class: 'item-note', text: it.note }) : null,
      why,
    ),
    h('div', { class: 'item-amt' }, h('div', { class: 'row' }, 'Paid', h('b', { text: money(it.paid) })), h('div', { class: 'row' }, 'Contract', h('b', { text: it.expected === null ? '—' : money(it.expected) }))),
  );
}

const CHIP_ORDER = ['B', 'L', 'D', 'ND', 'S', 'CICO'];
function dayNodes(r) {
  const byDay = new Map();
  for (const it of r.items) {
    const k = it.dayKey;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(it);
  }
  const out = [];
  for (const d of r.days) {
    const its = byDay.get(d.key) || [];
    const hasExp = CHIP_ORDER.some((c) => d.expenses[c] > 0);
    if (!d.pairing && !its.length && !hasExp) continue;
    const chips = h('div', { class: 'chips' });
    for (const c of CHIP_ORDER) {
      const mine = its.filter((i) => i.M === c);
      if (!mine.length) continue;
      const sev = mine.some((i) => i.severity === 'error') ? 'error' : mine.some((i) => i.severity === 'warn') ? 'warn' : mine.some((i) => i.severity === 'info') ? 'info' : 'ok';
      chips.append(h('span', { class: `chip ${sev}`, title: `${c === 'CICO' ? 'CICO' : MEAL_NAMES[c]}: ${SEV_LABEL[sev]}`, text: c }));
    }
    const sub = [d.pairing, d.route].filter(Boolean).join(' · ') || 'No flights';
    const body = h('div', { class: 'day-body' });
    if (d.legs.length) {
      body.append(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'legs' },
            h('tr', {}, ['Flight', 'Route', 'Sched', 'Actual', 'Note'].map((t) => h('th', { text: t }))),
            d.legs.map((g) =>
              h(
                'tr',
                { class: g.flown === false ? 'notflown' : null },
                h('td', { text: `${g.type === 'LEG' ? '' : g.type + ' '}${g.flt}` }),
                h('td', { text: `${g.org}–${g.dst}` }),
                h('td', { text: g.std ? `${g.std}–${g.sta}` : '' }),
                h('td', { text: g.atd ? `${g.atd}–${g.ata}` : '' }),
                h('td', { class: 'dd', text: [g.dhd === 'D' ? 'deadhead' : '', g.dd].filter(Boolean).join(' ') }),
              ),
            ),
          ),
        ),
      );
    } else if (d.noDetail) {
      body.append(h('p', { class: 'muted small', text: 'Rainmaker shows no flight details for this day.' }));
    }
    if (its.length) body.append(h('div', { class: 'items' }, its.map(itemNode)));
    else if (d.pairing && !d.noDetail) body.append(h('p', { class: 'muted small', text: 'No allowances paid or expected on this day.' }));
    out.push(h('details', { class: 'day' }, h('summary', {}, h('div', { class: 'd-main' }, h('div', { class: 'd-date', text: d.date }), h('div', { class: 'd-sub', text: sub })), chips), body));
  }
  return out;
}

function rulesCard(r) {
  const rateRow = (t, current) => h('tr', { class: current ? 'current' : null }, h('td', { text: t.label }), h('td', { text: t.B.toFixed(2) }), h('td', { text: t.L.toFixed(2) }), h('td', { text: t.D.toFixed(2) }), h('td', { text: t.S.toFixed(2) }));
  const rateRows = RATE_TABLE.map((t) => rateRow(t, t.key === r.rates.key));
  // before March 2026: the Canada rates of the monthly table (not part of the agreement's 7.02.02 table)
  if (r.rates.key === 'CHART') rateRows.unshift(rateRow({ ...r.rates, label: `Before March 2026: ${r.rates.label}` }, true));
  const stations = r.stations
    .map((s) => `${s.code} (${countryName(s.country)}${s.domestic === false ? ', overseas' : s.domestic === null ? ', unknown: treated as overseas' : ''}${s.offset ? `, ${s.offset > 0 ? '+' : '−'}${Math.abs(s.offset / 60)}h vs ${r.home}` : ''})`)
    .join(' · ');
  return h(
    'div',
    { class: 'card' },
    h(
      'details',
      { class: 'more' },
      h('summary', { text: 'Contract rules applied' }),
      h(
        'div',
        { class: 'list' },
        h('p', { class: 'muted small', text: `Quoted from the ${AGREEMENT}. Page numbers are pages of the PDF file.` }),
        RULE_TEXT.map((x) =>
          h(
            'div',
            { class: 'rule' },
            h('div', { class: 'ref', text: `${x.ref} · PDF p. ${x.page}` }),
            h('div', { class: 't', text: x.title }),
            h('blockquote', { class: 'quote', text: x.text }),
            x.use ? h('p', { class: 'use', text: x.use }) : null,
          ),
        ),
        h(
          'div',
          { class: 'rule' },
          h('div', { class: 'ref', text: '7.02.02 · PDF p. 21' }),
          h('div', { class: 't', text: 'Canada/United States Meal Allowances (column for this period highlighted)' }),
          h('div', { class: 'table-wrap' }, h('table', { class: 'rates' }, h('tr', {}, ['Effective Date', 'B', 'L', 'D', 'S'].map((t) => h('th', { text: t }))), rateRows)),
        ),
        h(
          'div',
          { class: 'rule' },
          h('div', { class: 'ref', text: 'How the check works' }),
          h('div', { class: 't', text: 'Duty periods and layovers' }),
          h(
            'p',
            {
              text:
                'Duty periods follow B5.02.01 (with the B5.03.01 pre-duty report times) and end at the release time after the last actual arrival. ' +
                'Layovers at overseas stations follow LOU 43; all other meals follow 7.02 and 7.02.01. ' +
                `A ground stop of more than 7 h away from ${r.home} is treated as a layover. Legs marked PP, SICK or DISPLACED were not flown and are ignored. ` +
                'Station clocks come from the flight times themselves. Meal periods are checked in local time with actual and scheduled times. ' +
                '"Not paid" means the contract clearly applies. "Possibly owed" means it applies under another reasonable reading (for example using the arrival meal period or another station’s clock).',
            },
          ),
          h('p', { class: 'small muted', text: `Stations: ${stations}` }),
        ),
      ),
    ),
  );
}

function printReport() {
  const opened = [...document.querySelectorAll('#results details:not([open])')];
  opened.forEach((d) => (d.open = true));
  const restore = () => {
    opened.forEach((d) => (d.open = false));
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

// ---------------------------------------------------------------- back to the start (top-left title)
function goHome() {
  if (locked) return; // the lock screen stays until the app may be used again
  Object.assign(state, { fileName: '', st: null, pre: null, result: null, filter: 'attention', tablesMsg: null });
  showStatus(null);
  for (const id of ['#precheck', '#results']) {
    $(id).replaceChildren();
    $(id).hidden = true;
  }
  $('#import').hidden = false;
  $('#tables').hidden = false;
  showTablesMsg([]);
  renderTablesList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#home-link').addEventListener('click', (e) => {
  e.preventDefault();
  goHome();
});

// ---------------------------------------------------------------- settings dialog
const dlg = $('#settings');
$('#open-settings').addEventListener('click', () => {
  $('#theme').value = settings.theme || '';
  // "Your data": how many months of monthly PDFs are stored on this device
  const months = listTables();
  $('#data-summary').textContent = months.length
    ? `Monthly PDFs added on this device: ${months.length} month${months.length > 1 ? 's' : ''} (${months.map((t) => periodLabel(t.period)).slice(0, 3).join(', ')}${months.length > 3 ? ', …' : ''}).`
    : 'No monthly PDFs are stored on this device.';
  $('#clear-data').disabled = !months.length;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  settings = { theme: $('#theme').value };
  saveSettings(settings);
  applyTheme(settings.theme);
  if (state.result) runCheck();
});

// "Clear all added PDFs" (Settings) with a confirmation: back to a clean sheet
const confirmClear = $('#confirm-clear');
$('#clear-data').addEventListener('click', () => {
  const n = listTables().length;
  $('#confirm-clear-text').textContent =
    `This removes the Meal Allowances tables and What’s New bulletins of ${n} month${n > 1 ? 's' : ''} added on this device and goes back to the start screen. ` +
    'You will need to add them again to check a statement.';
  if (typeof confirmClear.showModal === 'function') confirmClear.showModal();
  else if (window.confirm('Clear all added PDFs?')) clearEverything();
});
confirmClear.addEventListener('close', () => {
  if (confirmClear.returnValue === 'clear') clearEverything();
  confirmClear.returnValue = '';
});
function clearEverything() {
  clearTables();
  if (dlg.open) dlg.close();
  goHome();
  showTablesMsg([{ ok: true, text: 'All added PDFs were cleared. Add the monthly PDFs again to check a statement.' }]);
}

// ---------------------------------------------------------------- offline + install
$('#footer').textContent = `Expense Checker ${APP_VERSION} · Air Canada–CUPE Collective Agreement (April 1, 2025) · runs entirely on this device`;

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      const show = () => ($('#offline-badge').hidden = false);
      if (reg.active) show();
      navigator.serviceWorker.ready.then(show);
    })
    .catch((e) => console.warn('Offline mode unavailable:', e));
} else if (location.protocol === 'file:') {
  $('#offline-badge').hidden = false;
}

// "Install on your phone": shown on the web site (not in the single desktop file) until the app is installed.
const installCard = $('#install');
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function showPhone(kind) {
  for (const b of document.querySelectorAll('.phone-tabs button')) b.setAttribute('aria-pressed', String(b.dataset.phone === kind));
  for (const ol of document.querySelectorAll('.phone-steps')) ol.hidden = ol.dataset.phone !== kind;
}
for (const b of document.querySelectorAll('.phone-tabs button')) b.addEventListener('click', () => showPhone(b.dataset.phone));

if (/^https?:$/.test(location.protocol) && !standalone) {
  installCard.hidden = false;
  showPhone(isAndroid ? 'android' : 'ios');
  const address = `${location.host}${location.pathname.replace(/index\.html$/, '')}`;
  for (const el of document.querySelectorAll('.install-host')) el.textContent = location.host;
  for (const el of document.querySelectorAll('.install-address')) el.textContent = address.replace(/\/$/, '');
  // "Copy the address" (iPhone step 1): to paste it in Safari when the page was opened from another app
  for (const b of document.querySelectorAll('[data-copy-address]')) {
    b.addEventListener('click', async () => {
      const link = `${location.protocol}//${address}`;
      const label = b.querySelector('span');
      try {
        await navigator.clipboard.writeText(link);
        label.textContent = 'Copied: paste it in Safari';
        setTimeout(() => (label.textContent = 'Copy the address'), 3000);
      } catch {
        window.prompt('Copy this address, then paste it in Safari:', link);
      }
    });
  }
  if (!isIOS && !isAndroid) {
    // on a computer: tell where to go on the phone
    $('#install-url-text').textContent = address;
    $('#install-url').hidden = false;
  }
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome / Edge / Samsung Internet can install directly: offer a one-tap button above the guide
  e.preventDefault();
  deferredInstall = e;
  $('#install-now').hidden = false;
  installCard.hidden = false;
});
$('#install-btn').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => null);
  deferredInstall = null;
  $('#install-now').hidden = true;
});
window.addEventListener('appinstalled', () => {
  installCard.hidden = true;
});

// Installed desktop app: "Open with > Expense Checker" on a PDF
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files && params.files.length) handleFile(await params.files[0].getFile());
  });
}

// expose for debugging in the console only
globalThis.__expenseChecker = { state, fmtClock };
