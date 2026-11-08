// Readers for the two monthly reference PDFs:
//  - the "Meal Allowances" table (rates per station, in Canadian funds), and
//  - the "What's New" bulletin, section "Report Times" (flights with an earlier report time).
// Both work on the positioned words produced by pdftext.js, so they run in the browser and in Node.

import { eqpMatches } from './contract.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december)';
const MONEY = /^-?\$?\d{1,4}\.\d{2}$/;
const STATION = /^[A-Z]{3}$/;

const lineText = (l) => l.words.map((w) => w.t).join(' ');
const allText = (doc) => doc.pages.flatMap((p) => p.lines.map(lineText)).join('\n');
const toPeriod = (month, year) => `${year}${String(MONTHS.indexOf(month.toLowerCase()) + 1).padStart(2, '0')}`;
const money = (t) => Number(t.replace(/[$,]/g, ''));

export const periodLabel = (p) => {
  const m = Number(String(p).slice(4, 6));
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${String(p).slice(0, 4)}` : String(p || '');
};

function periodFromName(name) {
  const s = String(name || '');
  let m = s.match(/(20\d\d)[-_ ]?(0[1-9]|1[0-2])(?!\d)/);
  if (m) return `${m[1]}${m[2]}`;
  m = s.match(new RegExp(`${MONTH_RE}[-_ ]*(20\\d\\d)`, 'i'));
  if (m) return toPeriod(m[1], m[2]);
  return null;
}

/** 'meals', 'report' or null (anything else, e.g. a Crew Pay Details statement). */
export function detectKind(doc) {
  const text = allText(doc);
  if (/Meal\s+Allowances/i.test(text) && /Breakfast/.test(text) && /Snack/.test(text) && /Station/.test(text)) return 'meals';
  if (/Report\s+Times?/i.test(text) && /earlier\s+report\s+time/i.test(text)) return 'report';
  return null;
}

// ------------------------------------------------------------------ Meal Allowances table
export function parseMealTable(doc, fileName = '') {
  const text = allText(doc);
  const mt = text.match(new RegExp(`${MONTH_RE}\\s+(20\\d\\d)\\s+Meal\\s+Allowances`, 'i'));
  const period = mt ? toPeriod(mt[1], mt[2]) : periodFromName(fileName);
  const rows = [];
  for (const page of doc.pages) {
    const header = page.lines.find((l) => l.words.some((w) => w.t === 'Location') && l.words.some((w) => w.t === 'Breakfast'));
    if (!header) continue;
    const col = {};
    for (const w of header.words) if (['Location', 'Country', 'Station', 'Breakfast', 'Lunch', 'Dinner', 'Snack', 'Total'].includes(w.t)) col[w.t] = w.x0;
    if (col.Country === undefined || col.Breakfast === undefined || col.Snack === undefined) continue;
    const mealCols = [['B', col.Breakfast], ['L', col.Lunch], ['D', col.Dinner], ['S', col.Snack]].filter(([, x]) => x !== undefined);
    const right = col.Total !== undefined ? col.Total - 4 : col.Snack + 30;
    for (const line of page.lines) {
      if (line.y <= header.y + 1) continue;
      const ws = line.words;
      const name = ws.filter((w) => w.x0 < col.Country - 4).map((w) => w.t).join(' ').trim();
      const country = ws.find((w) => Math.abs(w.x0 - col.Country) < 14 && /^[A-Z]{2}$/.test(w.t));
      const station = ws.find((w) => col.Station !== undefined && Math.abs(w.x0 - col.Station) < 14 && /^([A-Z]{3}|\*)$/.test(w.t));
      if (!name || !country) continue;
      const row = { name, country: country.t, station: station ? station.t : '*', codes: [], bracelet: ws.some((w) => /^BRACELET$/i.test(w.t)) };
      for (const m of name.matchAll(/\(([^)]*)\)?/g)) for (const c of m[1].match(/[A-Z]{3}/g) || []) if (!row.codes.includes(c)) row.codes.push(c);
      if (STATION.test(row.station) && !row.codes.includes(row.station)) row.codes.push(row.station);
      for (const w of ws) {
        if (!MONEY.test(w.t) || w.x0 < col.Breakfast - 12 || w.x0 >= right) continue;
        const [k] = mealCols.reduce((best, c) => (Math.abs(c[1] - w.x0) < Math.abs(best[1] - w.x0) ? c : best));
        if (row[k] === undefined) row[k] = money(w.t);
      }
      const hasAll = ['B', 'L', 'D', 'S'].every((k) => typeof row[k] === 'number');
      if (!hasAll && !row.bracelet) continue;
      if (row.bracelet) for (const k of ['B', 'L', 'D', 'S']) if (row[k] === undefined) row[k] = null;
      rows.push(row);
    }
  }
  const ca = rows.find((r) => r.country === 'CA' && r.station === '*');
  const us = rows.find((r) => r.country === 'US' && r.station === '*');
  const errors = [];
  if (!period) errors.push('The month of this Meal Allowances table could not be found.');
  if (rows.length < 10 || !ca) errors.push('The rows of this Meal Allowances table could not be read.');
  return { kind: 'meals', period, fileName, rows, canada: ca || null, us: us || null, errors };
}

/**
 * Rate rows that apply to an airport, best first: the station's own row, then a row naming the
 * airport in brackets, then the country-wide row ("Canada", "U.S.", "Mexico - Other", "Germany (...)").
 * Rows with amounts come before "bracelet provided" rows.
 */
export function mealRateOptions(table, code, iso) {
  if (!table) return [];
  const c = String(code || '').toUpperCase();
  let rows = table.rows.filter((r) => r.station === c);
  if (!rows.length) rows = table.rows.filter((r) => r.codes.includes(c));
  let approx = false;
  if (!rows.length && iso) {
    const star = table.rows.filter((r) => r.country === iso && r.station === '*');
    rows = star.filter((r) => !r.codes.length || /other/i.test(r.name));
    if (!rows.length && star.length === 1) {
      rows = star;
      approx = true;
    }
  }
  return rows
    .map((r) => ({ name: r.name, bracelet: r.bracelet, approx, B: r.B, L: r.L, D: r.D, ND: r.D, S: r.S }))
    .sort((a, b) => Number(a.bracelet) - Number(b.bracelet));
}

// ------------------------------------------------------------------ What's New: Report Times
export function parseReportTimes(doc, fileName = '') {
  const text = allText(doc);
  const mt = text.match(new RegExp(`${MONTH_RE}\\s+(20\\d\\d)\\s*:\\s*What`, 'i'));
  const period = mt ? toPeriod(mt[1], mt[2]) : periodFromName(fileName);
  const rows = [];
  for (const page of doc.pages) {
    const lines = page.lines;
    const heading = lines.find((l) => l.words.some((w, i) => w.t === 'Report' && l.words[i + 1] && /^Times?\/?$/.test(l.words[i + 1].t)));
    if (!heading) continue;
    const hdr = lines.find((l) => l.y > heading.y && l.y < heading.y + 120 && l.words.some((w) => /^Dep\/?$/.test(w.t)) && l.words.some((w) => /^Arr\/?$/.test(w.t)));
    if (!hdr) continue;
    const xOf = (re, ln) => {
      const w = ln.words.find((x) => re.test(x.t));
      return w ? w.x0 : null;
    };
    const depX = xOf(/^Dep\/?$/, hdr);
    const arrX = xOf(/^Arr\/?$/, hdr);
    const flightX = xOf(/^Flight$/, hdr) ?? depX - 50;
    let reportX = null;
    for (const l of lines) {
      if (Math.abs(l.y - hdr.y) > 16) continue;
      for (const w of l.words) if (w.t === 'Report' && w.x0 > arrX && (reportX === null || w.x0 < reportX)) reportX = w.x0;
    }
    if (depX === null || arrX === null || reportX === null) continue;
    const mid = (depX + arrX) / 2;
    const left = Math.min(flightX, depX - 60) - 40;
    const right = reportX + 100;
    const words = page.words.filter((w) => w.y > hdr.y + 2 && w.x0 >= left && w.x0 < right);

    // one anchor per table row: the departure station(s)
    const deps = words.filter((w) => STATION.test(w.t) && w.x0 >= depX - 30 && w.x0 < mid).sort((a, b) => a.y - b.y);
    const anchors = [];
    for (const w of deps) {
      const last = anchors[anchors.length - 1];
      if (last && Math.abs(w.y - last.y) <= 3) last.deps.push(w.t);
      else anchors.push({ y: w.y, deps: [w.t], flights: [], arrs: [], timeLines: new Map() });
    }
    const table = [];
    for (const a of anchors) {
      if (table.length && a.y - table[table.length - 1].y > 45) break; // end of the table
      table.push(a);
    }
    for (const w of words) {
      if (!table.length || w.y > table[table.length - 1].y + 11) continue;
      const a = table.reduce((best, x) => (Math.abs(x.y - w.y) < Math.abs(best.y - w.y) ? x : best));
      if (Math.abs(a.y - w.y) > 10.5) continue;
      if (/^\d{1,4}$/.test(w.t) && w.x0 < depX - 5) a.flights.push(String(Number(w.t)));
      else if (STATION.test(w.t) && w.x0 >= mid && w.x0 < reportX - 5) a.arrs.push(w.t);
      else if (w.x0 >= reportX - 20) {
        const k = Math.round(w.y);
        if (!a.timeLines.has(k)) a.timeLines.set(k, []);
        a.timeLines.get(k).push(w);
      }
    }
    for (const a of table) {
      const times = [];
      for (const ws of [...a.timeLines.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1])) {
        const s = ws.sort((x, y) => x.x0 - y.x0).map((w) => w.t).join(' ');
        for (const m of s.matchAll(/(\d{1,2})\s*(?::|h)\s*(\d{2})\s*(?:\(([^)]*)\))?/g)) times.push({ min: Number(m[1]) * 60 + Number(m[2]), eqp: m[3] ? m[3].trim() : null });
      }
      if (!a.flights.length || !times.length) continue;
      rows.push({ flights: [...new Set(a.flights)], deps: a.deps, arrs: [...new Set(a.arrs)], times });
    }
  }
  const errors = [];
  if (!period) errors.push('The month of this bulletin could not be found.');
  if (!rows.length) errors.push('The "Report Times" table of this bulletin could not be read.');
  return { kind: 'report', period, fileName, rows, errors };
}

/** Earlier report time for an operating leg, or null. */
export function reportTimeFor(rt, leg) {
  if (!rt || !leg || !leg.flt) return null;
  const flt = String(Number(String(leg.flt).replace(/\D/g, '')));
  for (const r of rt.rows) {
    if (!r.flights.includes(flt)) continue;
    if (r.deps.length && !r.deps.includes(leg.org)) continue;
    if (r.arrs.length && !r.arrs.includes(leg.dst)) continue;
    let opts = r.times;
    if (opts.length > 1 || opts[0].eqp) {
      const m = opts.filter((t) => !t.eqp || eqpMatches(t.eqp, leg.eqp));
      if (m.length) opts = m;
    }
    const best = opts.reduce((a, b) => (b.min > a.min ? b : a));
    return { min: best.min, eqp: best.eqp, row: r };
  }
  return null;
}
