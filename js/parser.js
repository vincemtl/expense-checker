// Parses a Rainmaker "Crew Pay Details" PDF (already split into positioned lines by pdftext.js).

export const MEAL_COLS = ['B', 'L', 'D', 'ND', 'S'];
export const EXPENSE_COLS = ['B', 'L', 'D', 'ND', 'S', 'CICO'];

const NUM = /^-?\d[\d,]*(\.\d+)?$/;
const HHMM = /^-?\d{1,3}:\d{2}$/;

export function toNumber(s) {
  if (s === undefined || s === null || s === '') return 0;
  const v = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : 0;
}

/** "07:10" -> 430 (minutes); returns null for blanks or junk. */
export function toMinutes(s) {
  if (!s) return null;
  const m = /^(-?)(\d{1,3}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] ? -v : v;
}

function nearestColumn(cols, xc, maxDist = 45) {
  let best = null;
  let bestD = Infinity;
  for (const c of cols) {
    const d = Math.abs(c.xc - xc);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= maxDist ? best : null;
}

function assign(cols, words, maxDist) {
  const out = {};
  for (const w of words) {
    const c = nearestColumn(cols, w.xc, maxDist);
    if (!c) continue;
    out[c.name] = out[c.name] ? `${out[c.name]} ${w.t}` : w.t;
  }
  return out;
}

const META_LABELS = {
  'Position:': 'position',
  'Period:': 'period',
  'Domicile:': 'domicile',
  'Status:': 'status',
};

function parseMeta(lines) {
  const meta = { employee: '', position: '', period: '', domicile: '', status: '', lineType: '' };
  for (const l of lines) {
    const ws = l.words;
    for (let i = 0; i < ws.length; i++) {
      const t = ws[i].t;
      if (t === 'Employee:' && !meta.employee) {
        meta.employee = ws.slice(i + 1).map((w) => w.t).join(' ');
      } else if (META_LABELS[t] && !meta[META_LABELS[t]] && ws[i + 1]) {
        meta[META_LABELS[t]] = ws[i + 1].t;
      } else if (t === 'Type:' && i > 0 && ws[i - 1].t === 'Line' && ws[i + 1] && !meta.lineType) {
        meta.lineType = ws.slice(i + 1, i + 3).map((w) => w.t).filter((x) => !x.endsWith(':')).join(' ');
      }
    }
    if (meta.employee && meta.period && meta.domicile && meta.position && meta.status) break;
  }
  return meta;
}

function isMainHeader(l) {
  const t = l.words.map((w) => w.t);
  return t[0] === 'Day' && t[1] === 'Src' && t[2] === 'Details';
}

function isDetailHeader(l) {
  const t = l.words.map((w) => w.t);
  return t[0] === 'Details' && t[1] === 'Flt' && t.includes('ORG');
}

function isBucketHeader(l) {
  const t = l.words.map((w) => w.t);
  return t[0] === 'Pay' && t[1] === 'Bucket';
}

function buildHeader(lines, idx) {
  const base = lines[idx];
  const cols = [];
  const near = lines.filter((l) => l.page === base.page && Math.abs(l.y - base.y) <= 7.5);
  const words = near.flatMap((l) => l.words).sort((a, b) => a.x0 - b.x0);
  let pq = null;
  for (const w of words) {
    if (w.t === 'Pay' || w.t === 'Queries') {
      if (!pq) {
        pq = { name: 'PQ', xc: w.xc };
        cols.push(pq);
      }
      continue;
    }
    if (cols.some((c) => c.name === w.t)) continue;
    cols.push({ name: w.t, xc: w.xc });
  }
  return { page: base.page, y: base.y, cols, names: cols.map((c) => c.name) };
}

function parseDate(period, dayNums) {
  // Assign a calendar date to each day row. Day numbers increase; a drop (30 -> 1) means next month.
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(4, 6));
  if (!y || !m) return dayNums.map(() => null);
  let monthOffset = 0;
  if (dayNums.length > 1 && dayNums[0] >= 25 && dayNums[1] < dayNums[0]) monthOffset = -1;
  const out = [];
  let prev = null;
  for (const d of dayNums) {
    if (prev !== null && d < prev) monthOffset += 1;
    const dt = new Date(Date.UTC(y, m - 1 + monthOffset, d));
    out.push(dt);
    prev = d;
  }
  return out;
}

export function dateKey(dt) {
  return dt.toISOString().slice(0, 10);
}

/** Days between the 1st of the period month and dt (UTC dates). */
export function dayIndex(period, dt) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(4, 6));
  return Math.round((dt.getTime() - Date.UTC(y, m - 1, 1)) / 86400000);
}

function parseReportTotals(lines, startIdx) {
  const out = {};
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    const ws = l.words;
    const srcIdx = [];
    ws.forEach((w, k) => {
      if (w.t === 'Src' && ws[k + 1]) srcIdx.push(k);
    });
    if (!srcIdx.length) continue;
    const next = lines.slice(i + 1).find((n) => n.page === l.page && n.y > l.y + 2);
    if (!next) continue;
    srcIdx.forEach((k, j) => {
      const label = ws[k + 1].t;
      const left = ws[k].x0 - 3;
      const right = j + 1 < srcIdx.length ? ws[srcIdx[j + 1]].x0 - 3 : Infinity;
      const cands = next.words.filter((w) => w.x0 >= left && w.x0 < right && (NUM.test(w.t) || HHMM.test(w.t)));
      if (!cands.length) return;
      // the first numeric value after the Src code ("S"/"M") is the amount; later ones are comment counts
      const val = cands.sort((a, b) => a.x0 - b.x0)[0];
      if (out[label] === undefined) out[label] = val.t;
    });
  }
  return out;
}

export function parseStatement(doc) {
  const pages = doc.pages;
  const lines = pages.flatMap((p) => p.lines);
  const meta = parseMeta(lines);
  meta.title = doc.title || '';

  const pageInfo = pages.map((p) => ({ page: p.number, width: p.width, height: p.height, landscape: p.width > p.height }));

  const headerIdx = lines.findIndex(isMainHeader);
  const result = {
    meta,
    pageInfo,
    header: null,
    days: [],
    totals: {},
    reportTotals: {},
    detailHeaderCount: 0,
    errors: [],
  };
  if (headerIdx < 0) {
    result.errors.push('The Crew Pay Details table (Day / Src / Details header) was not found in this PDF.');
    return result;
  }
  const header = buildHeader(lines, headerIdx);
  result.header = header;
  const col = (name) => header.cols.find((c) => c.name === name);
  const dayX = col('Day').xc;
  const srcX = col('Src').xc;
  const valueCols = header.cols.filter((c) => c.name !== 'Day' && c.name !== 'Src');

  let day = null;
  let mode = 'none';
  let detailCols = null;
  let reportIdx = -1;
  const rawDays = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (header.page === l.page && Math.abs(l.y - header.y) <= 7.5) continue; // other words of the header
    const ws = l.words;
    const t0 = ws[0].t;

    if (t0 === 'Report' && ws[1] && ws[1].t === 'Totals') {
      reportIdx = i;
      break;
    }
    if (isMainHeader(l)) {
      // repeated header at the bottom of the table
      mode = 'none';
      continue;
    }
    // Totals row ("Total" in the Day column, not "Total Time:")
    if (t0 === 'Total' && Math.abs(ws[0].xc - dayX) < 15 && !(ws[1] && ws[1].t === 'Time:')) {
      if (!Object.keys(result.totals).length) {
        const near = lines.filter((n) => n.page === l.page && Math.abs(n.y - l.y) <= 7.5);
        const own = assign(valueCols, ws.slice(1), 30);
        const others = {};
        for (const n of near) {
          if (n === l) continue;
          Object.assign(others, assign(valueCols, n.words, 30));
        }
        result.totals = { ...others, ...own };
      }
      mode = 'none';
      day = null;
      continue;
    }
    // Day row
    if (/^\d{1,2}$/.test(t0) && Math.abs(ws[0].xc - dayX) < 12 && ws[1] && /^[A-Z]$/.test(ws[1].t) && Math.abs(ws[1].xc - srcX) < 12) {
      const values = assign(valueCols, ws.slice(2), 40);
      day = {
        dayNum: Number(t0),
        src: ws[1].t,
        pairing: values.Details || '',
        eqp: values.EQP || '',
        values,
        legs: [],
        detailBlocks: 0,
        totalMoney: null,
        page: l.page,
      };
      rawDays.push(day);
      mode = 'none';
      continue;
    }
    // Grey history rows (Src letter without a day number) belong to manual adjustments: ignore
    if (/^[A-Z]$/.test(t0) && Math.abs(ws[0].xc - srcX) < 12) {
      mode = 'none';
      continue;
    }
    if (!day) continue;

    if (isDetailHeader(l)) {
      detailCols = ws.map((w) => ({ name: w.t, xc: w.xc }));
      result.detailHeaderCount += 1;
      day.detailBlocks += 1;
      mode = 'detail';
      continue;
    }
    if (isBucketHeader(l)) {
      mode = 'bucket';
      continue;
    }
    if (t0 === 'Total' && ws[1] && ws[1].t === 'Time:') {
      const k = ws.findIndex((w) => w.t === 'Money:');
      if (k >= 0 && ws[k + 1]) day.totalMoney = toNumber(ws[k + 1].t);
      mode = 'none';
      continue;
    }
    if (mode === 'detail' && detailCols) {
      const v = assign(detailCols, ws, 30);
      if (!v.Details) continue;
      day.legs.push({
        type: v.Details,
        flt: v.Flt || '',
        seq: v.Seq || '',
        eqp: v.Eqp || '',
        dhd: v.DHD || '',
        dd: (v.DD || '').replace(/\s*,\s*/g, ','),
        org: v.ORG || '',
        dst: v.DST || '',
        pos: v.POS || '',
        std: v.STD || '',
        sta: v.STA || '',
        atd: v.ATD || '',
        ata: v.ATA || '',
        skdDur: v.SkdDur || '',
        actDur: v.ActDur || '',
        time: v.Time || '',
        money: v.Money ? toNumber(v.Money) : null,
      });
      mode = 'afterLeg';
      continue;
    }
  }

  // Dates
  const dates = parseDate(meta.period, rawDays.map((d) => d.dayNum));
  rawDays.forEach((d, k) => {
    d.date = dates[k];
    d.key = d.date ? dateKey(d.date) : `day-${d.dayNum}`;
    d.idx = d.date ? dayIndex(meta.period, d.date) : d.dayNum - 1;
    d.expenses = {};
    for (const c of [...EXPENSE_COLS, 'EXP', 'CAD']) d.expenses[c] = toNumber(d.values[c]);
  });
  result.days = rawDays;
  if (reportIdx >= 0) result.reportTotals = parseReportTotals(lines, reportIdx + 1);
  return result;
}

/**
 * Checks that the PDF was produced the way the checker needs it:
 *  1. printed in landscape,
 *  2. "+" pressed (expanded columns: B, L, D, S, ND, CICO visible, nothing cut off),
 *  3. More > Details pressed (flight-by-flight detail rows).
 */
export function precheck(st) {
  const checks = [];
  const portrait = st.pageInfo.filter((p) => !p.landscape);
  checks.push({
    id: 'landscape',
    label: 'Printed in landscape',
    ok: st.pageInfo.length > 0 && portrait.length === 0,
    detail: portrait.length
      ? `${portrait.length} of ${st.pageInfo.length} page(s) are portrait. Portrait printing cuts off the right-hand columns.`
      : `All ${st.pageInfo.length} pages are landscape.`,
    fix: 'In the print dialog, set Layout (Orientation) to Landscape before saving as PDF.',
  });

  const names = st.header ? st.header.names : [];
  const meals = ['B', 'L', 'D', 'S', 'ND', 'CICO'].filter((c) => names.includes(c));
  const expTotal = toNumber(st.totals.EXP);
  const subCols = ['FC', 'DPG', 'RS', 'FM', 'SKP', 'CBT', 'DOT'].filter((c) => names.includes(c));
  const plusOk = meals.length > 0 || (expTotal === 0 && subCols.length > 0);
  checks.push({
    id: 'plus',
    label: '"+" pressed (all columns expanded)',
    ok: !!st.header && plusOk,
    detail: !st.header
      ? 'The Crew Pay Details table was not found.'
      : plusOk
        ? `Expense columns found: ${meals.join(', ') || 'none (no expenses this month)'}.`
        : 'Only the collapsed EXP total is shown. Breakfast, lunch, dinner, snack and CICO columns are hidden.',
    fix: 'Press the "+" button above the table so every column group (FLT, DSP, EXP...) is expanded.',
  });

  const pairingDays = st.days.filter((d) => d.pairing && !/^0?\.?0*$/.test(d.pairing));
  const withDetail = st.days.filter((d) => d.detailBlocks > 0);
  const detailsOk = st.detailHeaderCount > 0 || pairingDays.length === 0;
  checks.push({
    id: 'details',
    label: 'More > Details pressed (flight details shown)',
    ok: !!st.header && detailsOk,
    detail: detailsOk
      ? `Flight details shown for ${withDetail.length} of ${pairingDays.length} day(s) with an assignment.`
      : 'No flight-by-flight detail rows found. Without them, departure and arrival times cannot be checked.',
    fix: 'Choose More > Details so each day shows its flights (ORG, DST, STD, STA, ATD, ATA...).',
  });

  const hasCad = names.includes('CAD');
  checks.push({
    id: 'columns',
    label: 'No columns cut off',
    ok: !!st.header && hasCad,
    detail: hasCad ? 'The right-most CAD column is present.' : 'The CAD column (and possibly S, ND, CICO) is missing: the page is cut off.',
    fix: 'Print in landscape (and keep the scale at "Default" / "Fit to page width").',
  });

  return { ok: checks.every((c) => c.ok), checks };
}
