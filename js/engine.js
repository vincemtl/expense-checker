// Verification engine: rebuilds duty periods / layovers from the flight details and checks the
// expenses Rainmaker paid against the contract rules (contract.js).
//
// Time model: every instant is expressed in minutes on the Home Base clock, counted from 00:00 on
// the 1st of the statement month ("abs" minutes). Station clock offsets relative to Home Base are
// derived from the PDF itself: (STA - STD) - SkdDur = offset(DST) - offset(ORG).

import { MEALS, MEAL_NAMES, MEAL_PERIODS, RATE_TABLE, ratesForPeriod, withNightDinner, ALLOWANCES, REPORT_RULES, DUTY_RULES, EQP_GROUP_LABEL, eqpGroup, LOU43 } from './contract.js';
import { countryOf, countryName, isDomestic } from './stations.js';
import { toMinutes, toNumber, MEAL_COLS } from './parser.js';
import { mealRateOptions, reportTimeFor, periodLabel } from './tables.js';

const DAY = 1440;
const DUTY_TYPES = /^(LEG|DH|STAND|STBY|SBY)/;
const NOT_FLOWN = new Set(['PP', 'SICK', 'DISPLACED', 'DROP', 'DROPPED', 'MISSED', 'MISS', 'CNX', 'CANCEL', 'CANCELLED', 'VAC', 'VACATION', 'LOA', 'NOSHOW', 'REMOVED']);

export const DEFAULT_OPTIONS = {
  tables: null, // { meals, refMeals, report } imported by the user: tablestore.tablesFor(period)
  layoverGapMin: ALLOWANCES.CICO_MIN_MINUTES, // ground time at an outstation that makes a layover
  homeBreakMin: 240, // ground time at Home Base that ends a duty period
};
const isDom = (code) => isDomestic(code) === true;

// ---------- small helpers ----------
const round2 = (v) => Math.round(v * 100 + 1e-9) / 100;
const money = (v) => (v === null || v === undefined ? '—' : `$${v.toFixed(2)}`);
const pad = (n) => String(n).padStart(2, '0');
const mod = (a, n) => ((a % n) + n) % n;
export const fmtClock = (min) => `${pad(Math.floor(mod(min, DAY) / 60))}:${pad(mod(min, DAY) % 60)}`;
const fmtDur = (min) => `${Math.floor(min / 60)}h${pad(Math.round(min % 60))}`;
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

function merge(intervals) {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const within = (ivs, a, b) => ivs.some(([s, e]) => s <= a && b <= e);
const containing = (ivs, t) => ivs.find(([s, e]) => s <= t && t <= e) || null;

function dateFromIdx(period, idx) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(4, 6));
  return new Date(Date.UTC(y, m - 1, 1 + idx));
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(dt) {
  return `${WD[dt.getUTCDay()]} ${MO[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

// ---------- station clocks ----------
function stationOffsets(allLegs, home) {
  const edges = new Map();
  const add = (a, b, d) => {
    const k = `${a}>${b}`;
    if (!edges.has(k)) edges.set(k, new Map());
    const m = edges.get(k);
    m.set(d, (m.get(d) || 0) + 1);
  };
  const delta = (t0, t1, dur) => {
    if (t0 === null || t1 === null || dur === null || dur <= 0) return null;
    let d = mod(t1 - t0 - dur, DAY);
    if (d > 720) d -= DAY;
    return Math.round(d / 15) * 15;
  };
  for (const g of allLegs) {
    if (!g.org || !g.dst || g.org === g.dst) continue;
    let d = delta(toMinutes(g.std), toMinutes(g.sta), toMinutes(g.skdDur));
    if (d === null) d = delta(toMinutes(g.atd), toMinutes(g.ata), toMinutes(g.actDur));
    if (d === null) continue;
    add(g.org, g.dst, d);
    add(g.dst, g.org, -d);
  }
  const best = (k) => {
    const m = edges.get(k);
    if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const off = new Map([[home, 0]]);
  const queue = [home];
  while (queue.length) {
    const a = queue.shift();
    for (const k of edges.keys()) {
      const [x, y] = k.split('>');
      if (x !== a || off.has(y)) continue;
      off.set(y, off.get(a) + best(k));
      queue.push(y);
    }
  }
  return off;
}

// ---------- legs ----------
const legKey = (g) => [g.type, g.flt, g.org, g.dst, g.std, g.sta].join('|');
const isDutyLeg = (g) => DUTY_TYPES.test(g.type) && g.org && g.dst && toMinutes(g.std) !== null;
export const isFlown = (g) =>
  !String(g.dd || '')
    .toUpperCase()
    .split(/[,\s]+/)
    .some((t) => NOT_FLOWN.has(t));

function placeLegs(days, off, home, opts) {
  const o = (s) => (off.has(s) ? off.get(s) : 0);
  const placed = [];
  const nearest = (t, ref) => t + DAY * Math.round((ref - t) / DAY);

  const chainEnd = (p) => {
    const after = placed.filter((q) => q.depAct >= p.depAct).sort((a, b) => a.depAct - b.depAct);
    let end = p.arrAct;
    let st = p.dst;
    for (const q of after) {
      if (q === p) continue;
      const thr = st === home ? opts.homeBreakMin : opts.layoverGapMin;
      if (q.depAct - end >= thr) break;
      end = Math.max(end, q.arrAct);
      st = q.dst;
    }
    return end + REPORT_RULES.release;
  };

  for (const day of days) {
    for (const g of day.legs) {
      if (!isDutyLeg(g) || !isFlown(g)) continue;
      const key = legKey(g);
      const last = placed.length ? placed.reduce((a, b) => (b.depAct > a.depAct ? b : a)) : null;
      const isStand = g.org === g.dst || /^ST/.test(g.type);
      let dup = null;
      for (const p of placed) {
        if (p.key !== key || p.lastListDay < day.idx - 2) continue;
        const discontinuous = last && last.dst !== g.org;
        if (p.depDay >= day.idx || chainEnd(p) >= day.idx * DAY || discontinuous) {
          dup = p;
          break;
        }
      }
      if (dup) {
        dup.lastListDay = day.idx;
        dup.listDays.push(day.idx);
        continue;
      }
      const std = toMinutes(g.std);
      const sta = toMinutes(g.sta);
      const prevArr = last ? last.arrSched : -Infinity;
      let ld = null;
      for (let k = day.idx - 1; k <= day.idx + 3; k++) {
        const dep = k * DAY + std - o(g.org);
        if (Math.floor(dep / DAY) < day.idx) continue;
        if (dep < prevArr) continue;
        ld = k;
        break;
      }
      if (ld === null) ld = day.idx;
      const depSched = ld * DAY + std - o(g.org);
      const durS = toMinutes(g.skdDur);
      let arrSched;
      if (!isStand && durS !== null && durS > 0) arrSched = depSched + durS;
      else {
        arrSched = ld * DAY + (sta === null ? std : sta) - o(g.dst);
        while (arrSched < depSched) arrSched += DAY;
      }
      const atd = toMinutes(g.atd);
      const ata = toMinutes(g.ata);
      const durA = toMinutes(g.actDur);
      let depAct = atd !== null ? nearest(atd - o(g.org), depSched) : depSched;
      let arrAct;
      if (ata !== null) arrAct = nearest(ata - o(g.dst), arrSched + (depAct - depSched));
      else if (durA !== null && atd !== null) arrAct = depAct + durA;
      else arrAct = depAct + (arrSched - depSched);
      if (arrAct < depAct) arrAct = depAct + (durA !== null ? durA : arrSched - depSched);
      placed.push({
        key,
        g,
        type: g.type,
        flt: g.flt,
        org: g.org,
        dst: g.dst,
        isStand,
        eqp: g.eqp || '',
        isDeadhead: /^DH/.test(g.type) || g.dhd === 'D',
        overseas: !isDom(g.org) || !isDom(g.dst),
        depDay: ld,
        listDays: [day.idx],
        lastListDay: day.idx,
        pairing: day.pairing,
        depSched,
        arrSched,
        depAct,
        arrAct,
        hasActual: atd !== null,
      });
    }
  }
  return placed.sort((a, b) => a.depSched - b.depSched);
}

// ---------- report (check-in) and release ----------
// B5.02.01 Duty Period - Definition, extended by a pre-duty report of up to 30 minutes (B5.03.01).
function reportFor(leg, home, rt) {
  const R = REPORT_RULES;
  if (leg.isStand) return { min: 0, why: `airport standby report time at ${leg.org} (B5.02.01)` };
  const atHome = leg.org === home;
  if (leg.isDeadhead) {
    return atHome
      ? { min: R.home.deadhead, why: `deadhead at Home Base, ${R.home.deadhead} minutes prior to scheduled departure (B5.02.01)` }
      : { min: R.away.deadhead, why: 'deadhead away from Home Base, scheduled departure of the deadhead flight (B5.02.01)' };
  }
  const grp = eqpGroup(leg.eqp);
  const base = DUTY_RULES.operational;
  let min = Math.min((atHome ? R.home : R.away)[grp], base + DUTY_RULES.preDutyMax);
  const plane = `${EQP_GROUP_LABEL[grp]}${leg.eqp ? ` (${leg.eqp})` : ''}`;
  let why =
    min > base
      ? `${fmtDur(min)} before scheduled departure: 1:00 (B5.02.01) + ${min - base} min company report time for a ${plane} ${atHome ? 'at Home Base' : 'away from Home Base'} (B5.03.01)`
      : `1:00 hour prior to scheduled departure (B5.02.01), ${plane}`;
  const ext = reportTimeFor(rt, leg);
  if (ext && ext.min > min) {
    min = Math.min(ext.min, base + DUTY_RULES.preDutyMax);
    why = `${fmtDur(min)} before scheduled departure: flight ${leg.flt} ${leg.org}-${leg.dst} has an earlier report time in the What's New bulletin (${periodLabel(rt.period)}), B5.02.01 + B5.03.01`;
  }
  return { min, why };
}

function releaseFor(leg) {
  if (leg.isStand) return { min: 0, why: 'airport release (B5.02.01)' };
  if (leg.isDeadhead) return { min: REPORT_RULES.releaseDeadhead, why: 'actual arrival of the deadhead flight (B5.02.01)' };
  return { min: REPORT_RULES.release, why: '00:15 after arrival of the flight (B5.02.01)' };
}

// ---------- duty periods, layovers and location timeline ----------
function buildTimeline(legs, basis, home, off, opts, startAbs) {
  const dep = (l) => (basis === 'sched' ? l.depSched : l.depAct);
  const arr = (l) => (basis === 'sched' ? l.arrSched : l.arrAct);
  const sorted = [...legs].sort((a, b) => dep(a) - dep(b));
  const duties = [];
  let cur = null;
  for (const l of sorted) {
    if (cur) {
      const prev = cur.legs[cur.legs.length - 1];
      const gap = dep(l) - arr(prev);
      const thr = prev.dst === home ? opts.homeBreakMin : opts.layoverGapMin;
      if (gap >= thr || (prev.dst !== l.org && gap > 180)) cur = null;
    }
    if (!cur) {
      cur = { legs: [] };
      duties.push(cur);
    }
    cur.legs.push(l);
  }
  for (const d of duties) {
    const f = d.legs[0];
    const z = d.legs[d.legs.length - 1];
    d.first = f;
    d.last = z;
    const rep = reportFor(f, home, opts.tables && opts.tables.report);
    const rel = releaseFor(z);
    d.start = Math.min(f.depSched, dep(f)) - rep.min;
    d.end = arr(z) + rel.min;
    d.reportWhy = rep.why;
    d.releaseWhy = rel.why;
    d.originHome = f.org === home;
    d.terminateHome = z.dst === home;
    d.overseas = d.legs.some((l) => l.overseas);
  }
  const layovers = [];
  for (let i = 0; i < duties.length; i++) {
    const a = duties[i];
    const b = duties[i + 1];
    const st = a.last.dst;
    if (st === home) continue;
    if (b && b.first.org === st) {
      layovers.push({ station: st, start: a.end, end: b.start, arr: arr(a.last), dep: dep(b.first), open: false, inLeg: a.last, outLeg: b.first });
    } else if (!b) {
      layovers.push({ station: st, start: a.end, end: a.end + 2 * DAY, arr: arr(a.last), dep: null, open: true, inLeg: a.last, outLeg: null });
    }
  }
  if (duties.length && duties[0].first.org !== home) {
    const d0 = duties[0];
    layovers.unshift({ station: d0.first.org, start: Math.min(startAbs, d0.start), end: d0.start, arr: null, dep: dep(d0.first), open: true, carryIn: true, inLeg: null, outLeg: d0.first });
  }

  const segs = [];
  for (const d of duties) {
    let t = d.start;
    let st = d.first.org;
    for (const l of d.legs) {
      if (dep(l) > t) segs.push({ kind: 'ground', station: st, start: t, end: dep(l), duty: d });
      if (l.isStand) segs.push({ kind: 'ground', station: l.org, start: dep(l), end: arr(l), duty: d, stand: true });
      else segs.push({ kind: 'flight', org: l.org, dst: l.dst, start: dep(l), end: arr(l), duty: d, leg: l });
      t = Math.max(t, arr(l));
      st = l.dst;
    }
    if (d.end > t) segs.push({ kind: 'ground', station: st, start: t, end: d.end, duty: d });
  }
  for (const lo of layovers) if (lo.end > lo.start) segs.push({ kind: 'layover', station: lo.station, start: lo.start, end: lo.end, layover: lo });
  segs.sort((a, b) => a.start - b.start);

  return {
    basis,
    duties,
    layovers,
    segs,
    coverage: merge([...duties.map((d) => [d.start, d.end]), ...layovers.map((l) => [l.start, l.end])]),
    dutyCov: merge(duties.map((d) => [d.start, d.end])),
    flightCov: merge(segs.filter((s) => s.kind === 'flight').map((s) => [s.start, s.end])),
  };
}

// 7.02: no meal for scheduled departures from / arrivals at Home Base during the meal period,
// when originating / terminating a duty period at Home Base. Home Base clock = offset 0.
function homeExclusions(tl, home) {
  const out = [];
  const add = (t, kind, leg) => {
    for (const M of MEALS) {
      const [s, e] = MEAL_PERIODS[M][kind];
      const base = Math.floor(t / DAY);
      for (const k of [base - 1, base]) {
        const ws = k * DAY + s;
        const we = k * DAY + e;
        if (t >= ws && t <= we) {
          const verb = kind === 'dep' ? `departure from ${home}` : `arrival at ${home}`;
          out.push({
            M,
            start: ws,
            end: we,
            why: `Scheduled ${verb} at ${fmtClock(t)} (${leg.isDeadhead ? 'deadhead ' : 'flight '}${leg.flt}) falls in the ${MEAL_NAMES[M].toLowerCase()} period ${fmtClock(s)}-${fmtClock(e)}, ${kind === 'dep' ? 'originating' : 'terminating'} a duty period at Home Base (7.02).`,
          });
        }
      }
    }
  };
  for (const d of tl.duties) {
    if (d.originHome) add(d.first.depSched, 'dep', d.first);
    if (d.terminateHome) add(d.last.arrSched, 'arr', d.last);
  }
  return out;
}

function describeSeg(seg) {
  if (seg.kind === 'flight') return `in flight ${seg.org}→${seg.dst} (${seg.leg.isDeadhead ? 'deadhead ' : ''}${seg.leg.flt})`;
  if (seg.kind === 'layover') return `on layover in ${seg.station}`;
  if (seg.stand) return `on standby at ${seg.station}`;
  return `on duty at ${seg.station}`;
}

function mealCandidates(tl, excl, off, home) {
  const o = (s) => (off.has(s) ? off.get(s) : 0);
  const cands = [];
  for (const seg of tl.segs) {
    if (seg.kind === 'layover' && !isDom(seg.station)) continue; // overseas layover: LOU 43 (lou43Clusters)
    const zoneStations = seg.kind === 'flight' ? [seg.org, seg.dst] : [seg.station];
    const zones = [];
    for (const st of zoneStations) if (!zones.some((z) => z.off === o(st))) zones.push({ off: o(st), station: st });
    for (const z of zones) {
      for (const M of MEALS) {
        const P = MEAL_PERIODS[M];
        const wins = [['dep', P.dep]];
        // the 1700-1830 arrival dinner period does not apply overseas
        const overseasHere = !isDom(z.station) || (seg.duty && seg.duty.overseas);
        if ((P.arr[0] !== P.dep[0] || P.arr[1] !== P.dep[1]) && !(M === 'D' && overseasHere)) wins.push(['arr', P.arr]);
        const from = Math.floor((seg.start + z.off) / DAY) - 1;
        const to = Math.floor((seg.end + z.off) / DAY) + 1;
        for (let ld = from; ld <= to; ld++) {
          for (const [wk, w] of wins) {
            const ws = ld * DAY + w[0] - z.off;
            const we = ld * DAY + w[1] - z.off;
            if (ws < seg.start || ws >= seg.end) continue;
            const reasons = [];
            const cov = M === 'ND' ? tl.dutyCov : tl.coverage;
            const covered = within(cov, ws, we);
            if (!covered) {
              const iv = containing(cov, ws);
              if (M === 'ND' && within(tl.coverage, ws, we))
                reasons.push('Not on duty for the whole period. 7.02.01 gives the 0300 dinner for a night flight, and layover meal allowances are breakfast, lunch, dinner and snack (LOU 43, para. 5), so it is not expected on a layover.');
              else if (iv) reasons.push(`Not on duty or layover for the whole period: ${iv[1] < we ? `released at ${fmtClock(iv[1] + z.off)} ${z.station} time` : 'coverage gap'}.`);
              else reasons.push('Not on duty or on layover during this period.');
            }
            const ex = excl.find((e) => e.M === M && overlaps(e.start, e.end, ws, we));
            if (ex) reasons.push(ex.why);
            const overseasDuty = tl.duties.find((d) => d.overseas && overlaps(d.start, d.end, ws, we));
            if (overseasDuty) {
              const sts = [...new Set(overseasDuty.legs.flatMap((l) => [l.org, l.dst]))];
              const out = sts.filter((s) => !isDom(s));
              reasons.push(
                `Overseas duty period (${sts.join('-')}; ${out.join(', ')} ${out.length > 1 ? 'are' : 'is'} outside the red line of Appendix I, 1.02.08 and B5.02.02). ` +
                  'The Canada / United States allowance is paid in lieu of boarded meals only for a domestic duty day (7.02 Note 2).',
              );
            }
            // 7.02 Note 2: snacks are provided on board and not paid; a legal layover snack is a layover meal (7.02, LOU 43 para. 5).
            let weak = null;
            if (M === 'S' && !reasons.length) {
              const onLayover = tl.layovers.some((lo) => overlaps(lo.start, lo.end, ws, we));
              if (!onLayover) {
                if (within(tl.flightCov, ws, we)) reasons.push('The whole snack period is in flight: "Snacks (2300-0100) will continue to be provided on board and will not be paid" (7.02 Note 2).');
                else
                  weak =
                    'Not on a legal layover during the snack period: "Snacks (2300-0100) will continue to be provided on board and will not be paid" (7.02 Note 2). ' +
                    'Part of the period is on the ground, and Rainmaker usually pays it in that case.';
              }
            }
            const station = seg.kind === 'flight' ? seg.org : seg.station;
            const primaryZone = seg.kind === 'flight' ? o(seg.org) : o(seg.station);
            cands.push({
              M,
              basis: tl.basis,
              wk,
              ws,
              we,
              zone: z,
              ld,
              seg,
              payable: reasons.length === 0,
              weak,
              excluded: !!ex,
              reasons,
              station,
              primary: wk === 'dep' && z.off === primaryZone,
              flt: seg.kind === 'flight' ? seg.leg.flt : null,
              tl,
              home,
              o,
            });
          }
        }
      }
    }
  }
  return cands;
}

function clusterMeals(cands) {
  const byM = new Map();
  for (const c of cands) {
    if (!byM.has(c.M)) byM.set(c.M, []);
    byM.get(c.M).push(c);
  }
  const clusters = [];
  for (const [M, list] of byM) {
    list.sort((a, b) => a.ws - b.ws);
    let cur = null;
    for (const c of list) {
      if (cur && c.ws - cur.anchor < 600) cur.cands.push(c);
      else {
        cur = { M, anchor: c.ws, cands: [c] };
        clusters.push(cur);
      }
    }
  }
  for (const cl of clusters) {
    // A Home Base departure/arrival exclusion names this meal explicitly: it applies whatever clock is used.
    const excluded = cl.cands.find((c) => c.excluded);
    if (excluded) {
      cl.primary = excluded;
      cl.status = 'none';
      cl.dayIdx = excluded.ld;
      cl.station = excluded.station;
      cl.alt = null;
      continue;
    }
    const pick =
      cl.cands.find((c) => c.primary && c.basis === 'actual') ||
      cl.cands.find((c) => c.primary && c.basis === 'sched') ||
      cl.cands.find((c) => c.basis === 'actual') ||
      cl.cands[0];
    cl.primary = pick;
    const payable = cl.cands.filter((c) => c.payable);
    cl.status = pick.payable && !pick.weak ? 'expected' : payable.length ? 'possible' : 'none';
    cl.dayIdx = pick.ld;
    cl.alt = payable.find((c) => c !== pick && !c.weak) || payable.find((c) => c !== pick) || (pick.payable ? pick : null);
    cl.station = pick.payable ? pick.station : cl.alt ? cl.alt.station : pick.station;
  }
  return clusters.sort((a, b) => a.anchor - b.anchor);
}

// LOU 43 para. 5: meal allowances at an overseas layover point, by scheduled arrival / departure time
// (local time at the layover point). A departure delay adds the meals that result from it (para. 11 a iii).
function lou43Clusters(tl, off, firstDay, lastDay) {
  const o = (s) => (off.has(s) ? off.get(s) : 0);
  const out = [];
  for (const lo of tl.layovers) {
    if (isDom(lo.station)) continue;
    const z = o(lo.station);
    let arr = null;
    let dep = null;
    if (lo.inLeg && !lo.carryIn) {
      const a = lo.inLeg.arrSched + z;
      const t = mod(a, DAY);
      const rule = LOU43.arrival.find((r) => t < r.before);
      const legMin = lo.inLeg.arrSched - lo.inLeg.depSched;
      let meals = rule.meals;
      let why = `Scheduled arrival ${fmtClock(t)} ${lo.station} time on flight ${lo.inLeg.flt} (${rule.text})`;
      if (rule === LOU43.arrival[0] && legMin >= LOU43.longLegMin) {
        meals = meals.filter((m) => m !== 'B');
        why += `; the flight leg is ${fmtDur(legMin)}, not less than 10 hours, so breakfast is not included (LOU 43, para. 5 *)`;
      }
      arr = { day: Math.floor(a / DAY), meals, why: `${why}: ${meals.join('')} on the day of arrival (LOU 43, para. 5).` };
    }
    if (lo.outLeg && !lo.open) {
      const sched = lo.outLeg.depSched;
      const delayed = lo.outLeg.depAct > sched + 1;
      const d = Math.max(sched, lo.outLeg.depAct) + z;
      let t = mod(d, DAY);
      let day = Math.floor(d / DAY);
      if (t < 60) {
        t += DAY; // 00:00-01:00 is the end of the "22:00 to 01:00" band of the previous day
        day -= 1;
      }
      const rule = LOU43.departure.find((r) => t >= r.from && t < r.to);
      const meals = rule ? rule.meals : [];
      const when = delayed ? `Departure delayed to ${fmtClock(d)} (scheduled ${fmtClock(sched + z)})` : `Scheduled departure ${fmtClock(sched + z)}`;
      dep = {
        day,
        meals,
        why: `${when} ${lo.station} time on flight ${lo.outLeg.flt} (${rule ? rule.text : 'departure before 07:00'}): ${meals.length ? meals.join('') : 'no meal'} on the day of departure (LOU 43, para. 5${delayed ? ' and 11 (a) iii' : ''}).`,
      };
    }
    const full = (k, text) => ({ day: k, meals: LOU43.fullDay, why: [text || `Full layover day in ${lo.station}: BLDS (LOU 43, para. 5, NOTE).`] });
    const entries = [];
    if (arr && dep && arr.day === dep.day) {
      entries.push({ day: arr.day, meals: arr.meals.filter((m) => dep.meals.includes(m)), why: [arr.why, dep.why, 'Arrival and departure on the same day: the meals in both lists.'] });
    } else {
      if (arr) entries.push({ day: arr.day, meals: arr.meals, why: [arr.why] });
      const from = arr ? arr.day + 1 : firstDay;
      const to = dep ? dep.day - 1 : lastDay;
      for (let k = from; k <= to; k++) entries.push(full(k, !arr ? `Layover in ${lo.station} continuing from the previous statement: BLDS (LOU 43, para. 5, NOTE).` : !dep ? `Layover in ${lo.station} continuing past this statement: BLDS (LOU 43, para. 5, NOTE).` : null));
      if (dep) entries.push({ day: dep.day, meals: dep.meals, why: [dep.why] });
    }
    for (const e of entries) {
      for (const M of e.meals) {
        out.push({
          M,
          anchor: e.day * DAY + MEAL_PERIODS[M].dep[0] - z,
          dayIdx: e.day,
          status: 'expected',
          station: lo.station,
          lou43: true,
          alt: null,
          primary: { flt: null, station: lo.station, seg: { kind: 'layover', station: lo.station }, reasons: [] },
          lines: [`Overseas layover in ${lo.station}.`, ...e.why, `Meal allowance of the layover point ${lo.station} (LOU 43, para. 2 and 3).`],
        });
      }
    }
  }
  return out;
}

function windowText(c) {
  const s = fmtClock(c.ws + c.zone.off);
  const e = fmtClock(c.we + c.zone.off);
  return `${s}-${e} ${c.zone.station} time`;
}

// Duty periods / layovers around a meal period, in words.
function contextLines(c) {
  const tl = c.tl;
  const out = [];
  const span = (a, b) => `${fmtClock(a)}-${fmtClock(b)}${Math.floor(b / DAY) > Math.floor(a / DAY) ? ' (next day)' : ''}`;
  for (const d of tl.duties) {
    if (!overlaps(d.start, d.end, c.ws, c.we)) continue;
    const legs = d.legs.map((l) => (l.isStand ? `standby at ${l.org}` : `${l.isDeadhead ? 'deadhead ' : ''}${l.flt} ${l.org}-${l.dst}`)).join(', ');
    out.push(`Duty period ${span(d.start, d.end)} ${c.home} time, ${tl.basis === 'actual' ? 'actual' : 'scheduled'} times: ${legs}. Report: ${d.reportWhy}. Release: ${d.releaseWhy}.`);
  }
  for (const lo of tl.layovers) {
    if (!overlaps(lo.start, lo.end, c.ws, c.we)) continue;
    const z = c.o(lo.station);
    out.push(lo.arr !== null && lo.dep !== null ? `Layover in ${lo.station}: arrived ${fmtClock(lo.arr + z)}, departed ${fmtClock(lo.dep + z)} (${lo.station} time).` : `Layover in ${lo.station} (continues outside this statement).`);
  }
  return out;
}

function explainCluster(cl) {
  if (cl.lou43) return [...cl.lines];
  const p = cl.primary;
  const lines = [];
  if (cl.status === 'expected') {
    lines.push(`${MEAL_NAMES[cl.M]} period ${windowText(p)}: ${describeSeg(p.seg)}, on duty or on a legal layover during the entire recognized meal period (7.02, 7.02.01).`);
    lines.push(...contextLines(p));
  } else if (cl.status === 'possible' && cl.alt === p) {
    lines.push(`${MEAL_NAMES[cl.M]} period ${windowText(p)}: ${describeSeg(p.seg)}.`, p.weak);
    lines.push(...contextLines(p));
  } else if (cl.status === 'possible') {
    const a = cl.alt;
    const how = [];
    if (a.wk !== p.wk) how.push(a.wk === 'arr' ? 'the arrival meal period' : 'the departure meal period');
    if (a.zone.off !== p.zone.off) how.push(`${a.zone.station} local time`);
    if (a.basis !== p.basis) how.push(a.basis === 'actual' ? 'actual flight times' : 'scheduled flight times');
    lines.push(`Payable when using ${how.join(', ') || 'another reading'}: ${MEAL_NAMES[cl.M].toLowerCase()} period ${windowText(a)}, ${describeSeg(a.seg)}.`);
    if (a.weak) lines.push(a.weak);
    lines.push(`Main reading (${windowText(p)}): ${p.reasons.join(' ') || p.weak}`);
    lines.push(...contextLines(a));
  } else {
    lines.push(`${MEAL_NAMES[cl.M]} period ${windowText(p)}: ${p.reasons.join(' ')}`);
    lines.push(...contextLines(p));
  }
  const bases = new Set(cl.cands.filter((c) => c.payable).map((c) => c.basis));
  if (cl.status !== 'none' && bases.size === 1) {
    lines.push(bases.has('actual') ? 'Only payable with the actual (delayed) times.' : 'Only payable with the scheduled times.');
  }
  return lines;
}

// ---------- CICO ----------
function cicoCandidates(tls, off, opts) {
  const o = (s) => (off.has(s) ? off.get(s) : 0);
  const list = [];
  for (const tl of tls) {
    for (const lo of tl.layovers) {
      if (lo.carryIn) continue;
      const len = lo.dep !== null && lo.arr !== null ? lo.dep - lo.arr : null;
      list.push({
        basis: tl.basis,
        station: lo.station,
        arr: lo.arr,
        len,
        open: lo.open,
        ok: len === null ? null : len > opts.layoverGapMin,
        ld: Math.floor((lo.arr + o(lo.station)) / DAY),
      });
    }
  }
  const clusters = [];
  for (const c of list.sort((a, b) => a.arr - b.arr)) {
    const cl = clusters.find((k) => k.station === c.station && Math.abs(k.anchor - c.arr) < 360);
    if (cl) cl.cands.push(c);
    else clusters.push({ station: c.station, anchor: c.arr, cands: [c] });
  }
  for (const cl of clusters) {
    const p = cl.cands.find((c) => c.basis === 'actual') || cl.cands[0];
    cl.primary = p;
    cl.dayIdx = p.ld;
    if (p.open) cl.status = 'possible';
    else if (cl.cands.every((c) => c.ok)) cl.status = 'expected';
    else if (cl.cands.some((c) => c.ok)) cl.status = 'possible';
    else cl.status = 'none';
    cl.text = p.open
      ? `Layover in ${cl.station} continues past the end of this statement.`
      : `Layover in ${cl.station}: ${fmtDur(p.len)} between arrival and departure (${cl.status === 'none' ? 'not more than' : 'more than'} 7 hours).`;
  }
  return clusters;
}

// ---------- main ----------
export function verify(st, userOpts = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...userOpts };
  const home = st.meta.domicile || 'YUL';
  const period = st.meta.period;
  // ---- rates: the month's Meal Allowances chart; the 7.02.02 column from March 2026; before March 2026 the
  //      Canada rates of the month's chart (or of the nearest chart before March 2026 when it is missing)
  const mealTable = opts.tables && opts.tables.meals && opts.tables.meals.period === period ? opts.tables.meals : null;
  const tableName = mealTable ? `${periodLabel(period)} Meal Allowances table` : null;
  const contractRates = ratesForPeriod(period);
  const refChart = mealTable || (opts.tables && opts.tables.refMeals) || null;
  let rates = contractRates;
  if (!rates && refChart && refChart.canada) {
    const c = refChart.canada;
    const own = refChart === mealTable;
    rates = withNightDinner({
      key: 'CHART',
      label: `${periodLabel(refChart.period)} Meal Allowances table`,
      chartPeriod: refChart.period,
      fromOtherMonth: !own,
      B: c.B,
      L: c.L,
      D: c.D,
      S: c.S,
    });
  }
  if (!rates) rates = { ...withNightDinner(RATE_TABLE[0]), key: 'FBMFR-ASSUMED', label: `7.02.02 ${RATE_TABLE[0].label}` };
  const allLegs = st.days.flatMap((d) => d.legs);
  const off = stationOffsets(allLegs, home);
  const legs = placeLegs(st.days, off, home, opts);
  const startAbs = st.days.length ? st.days[0].idx * DAY : 0;
  const tlS = buildTimeline(legs, 'sched', home, off, opts, startAbs);
  const tlA = buildTimeline(legs, 'actual', home, off, opts, startAbs);
  const excl = homeExclusions(tlS, home);
  const cands = [...mealCandidates(tlA, excl, off, home), ...mealCandidates(tlS, excl, off, home)];
  const firstDay = st.days.length ? st.days[0].idx : 0;
  const lastDay = st.days.length ? st.days[st.days.length - 1].idx : 0;
  const clusters = [...clusterMeals(cands), ...lou43Clusters(tlS, off, firstDay, lastDay)].sort((a, b) => a.anchor - b.anchor);

  // 7.02.03 minimum: the Canada allowance in effect (7.02.02 column, or the chart's Canada row before March 2026)
  const floorKnown = !!mealTable && rates.key !== 'FBMFR-ASSUMED';
  // price(station, M) -> { amount, label, options: [{ amount, name, bracelet }], bracelet, unpriced }
  const priceCache = new Map();
  const price = (station, M) => {
    const k = `${station}|${M}`;
    if (priceCache.has(k)) return priceCache.get(k);
    const iso = countryOf(station);
    let res;
    if (mealTable) {
      const rows = mealRateOptions(mealTable, station, iso);
      if (!rows.length) res = { amount: null, label: station, options: [], unpriced: true, note: `${station} is not in the ${tableName}.` };
      else {
        const options = rows.map((r) => ({ amount: r.bracelet ? 0 : r[M], name: r.name, bracelet: r.bracelet }));
        res = { amount: options[0].amount, label: rows[0].name, options, bracelet: rows[0].bracelet, approx: rows[0].approx };
        // 7.02.03: allowances at other locations shall not be less than the 7.02.02 Canada/United States allowances
        if (floorKnown && !res.bracelet && iso !== 'CA' && iso !== 'US' && res.amount !== null && res.amount < rates[M] - 0.005) {
          res.tableAmount = res.amount;
          res.amount = rates[M];
        }
      }
    } else if (iso === 'CA') res = { amount: rates[M], label: 'Canada', options: [] };
    else if (iso === 'US') res = { amount: null, label: 'U.S.', options: [], unpriced: true, note: `U.S. meals are checked with the ${periodLabel(period)} Meal Allowances table: add it (Add Meal Expenses and Report Time PDFs).` };
    else res = { amount: null, label: countryName(iso), options: [], unpriced: true, note: `Add the ${periodLabel(period)} Meal Allowances table (Add Meal Expenses and Report Time PDFs) to check the ${station} rate.` };
    priceCache.set(k, res);
    return res;
  };
  // the country-wide rate (Canada / U.S.), used to recognise a meal paid at the other country's rate
  const countryPrice = (iso, M) => {
    if (mealTable) {
      const r = mealTable.rows.find((x) => x.country === iso && x.station === '*' && !x.bracelet);
      return r ? { amount: r[M === 'ND' ? 'D' : M], label: r.name, options: [] } : null;
    }
    if (iso === 'CA') return { amount: rates[M], label: 'Canada', options: [] };
    return null;
  };
  const priceNote = (pr, amt) => {
    if (mealTable && pr.tableAmount !== undefined) return `${pr.label}: the table gives ${money(pr.tableAmount)}, below the 7.02.02 amount ${money(amt)}, which is the minimum (7.02.03)`;
    if (mealTable) return `${pr.label} rate ${money(amt)} (${tableName})${pr.approx ? ', country rate used for this airport' : ''}`;
    return `${pr.label} rate ${money(amt)} (${rates.label})`;
  };

  const dayByIdx = new Map(st.days.map((d) => [d.idx, d]));
  const noDetail = new Set(
    st.days.filter((d) => d.pairing && d.legs.length === 0 && Object.values(d.values).some((v) => v)).map((d) => d.idx),
  );
  const items = [];
  const label = (idx) => fmtDate(dateFromIdx(period, idx));

  // ---- meals ----
  const expectedCl = clusters.filter((c) => c.status !== 'none');
  const noneCl = clusters.filter((c) => c.status === 'none');
  const used = new Set();
  const paid = [];
  for (const d of st.days) for (const M of MEAL_COLS) if (d.expenses[M] > 0) paid.push({ day: d, M, amount: d.expenses[M] });

  for (const p of paid) {
    const idx = p.day.idx;
    let match = expectedCl.find((c) => !used.has(c) && c.M === p.M && c.dayIdx === idx);
    if (!match) match = expectedCl.find((c) => !used.has(c) && c.M === p.M && Math.abs(c.dayIdx - idx) === 1);
    const base = { date: label(idx), dayIdx: idx, dayKey: p.day.key, M: p.M, meal: MEAL_NAMES[p.M], paid: p.amount, pairing: p.day.pairing };
    if (!match) {
      if (noDetail.has(idx)) {
        items.push({ ...base, expected: null, status: 'unverified', severity: 'info', title: 'Not verified', lines: ['No flight details are shown for this day in Rainmaker (usually a trip that starts or ends outside this statement), so this allowance cannot be checked.'] });
        continue;
      }
      const why = noneCl.find((c) => c.M === p.M && Math.abs(c.dayIdx - idx) <= 1);
      items.push({
        ...base,
        expected: 0,
        status: 'unexpected',
        severity: 'warn',
        title: 'Paid, but the contract conditions are not met',
        lines: why ? explainCluster(why) : ['No duty period or layover covers this meal period in the flight details.'],
      });
      continue;
    }
    used.add(match);
    const group = [match];
    const pr = price(match.station, p.M);
    let expAmt = pr.amount;
    // two meals of the same kind on one day are paid as one amount
    while (expAmt !== null && p.amount > expAmt + 0.015) {
      const more = expectedCl.find((c) => !used.has(c) && c.M === p.M && Math.abs(c.dayIdx - idx) <= 1);
      if (!more) break;
      used.add(more);
      group.push(more);
      const a = price(more.station, p.M).amount;
      if (a === null) {
        expAmt = null;
        break;
      }
      expAmt = round2(expAmt + a);
    }
    const lines = group.flatMap(explainCluster);
    const item = { ...base, expected: expAmt, rateLabel: pr.label, station: match.station, flt: match.primary.flt, lines };
    if (match.dayIdx !== idx) lines.push(`Rainmaker shows it on ${label(idx)}; the meal period starts on ${label(match.dayIdx)} local time.`);
    const interp = match.status === 'possible' ? 'Paid (depends on interpretation)' : 'Paid correctly';
    if (expAmt === null) {
      Object.assign(item, { status: 'unpriced', severity: 'info', title: 'Paid (rate not available)', note: pr.note });
      items.push(item);
      continue;
    }
    if (Math.abs(p.amount - expAmt) < 0.015) {
      Object.assign(item, { status: 'ok', severity: 'ok', title: interp, note: priceNote(pr, expAmt) });
      items.push(item);
      continue;
    }
    // paid the table amount where the table is below the 7.02.02 minimum
    if (group.length === 1 && pr.tableAmount !== undefined && Math.abs(p.amount - pr.tableAmount) < 0.015) {
      Object.assign(item, {
        status: 'below-min',
        severity: 'warn',
        title: 'Paid below the contract minimum',
        note: `${pr.label}: paid the table amount ${money(pr.tableAmount)}; 7.02.03 says it "shall not be less than" the 7.02.02 amount ${money(expAmt)} (difference ${money(round2(expAmt - p.amount))}).`,
      });
      items.push(item);
      continue;
    }
    // another row for the same station (e.g. Cancun airport hotel vs downtown)
    const sameStation = group.length === 1 ? pr.options.find((o) => !o.bracelet && Math.abs(o.amount - p.amount) < 0.015) : null;
    if (sameStation) {
      Object.assign(item, { status: 'ok', severity: 'ok', title: interp, expected: sameStation.amount, note: `${sameStation.name} rate ${money(sameStation.amount)}${tableName ? ` (${tableName})` : ''}` });
      items.push(item);
      continue;
    }
    if (pr.bracelet && group.length === 1) {
      Object.assign(item, { status: 'unexpected', severity: 'warn', title: 'Paid, but a bracelet is provided', note: `${pr.label}: "bracelet provided" in the ${tableName}, so no allowance applies.` });
      items.push(item);
      continue;
    }
    // amount differs: paid at the rate of another station of the same flight / layover?
    if (group.length === 1) {
      const seg = match.primary.seg;
      const others = [...new Set([seg.kind === 'flight' ? seg.dst : null, home].filter((s) => s && s !== match.station))].map((s) => price(s, p.M));
      others.push(countryPrice('CA', p.M), countryPrice('US', p.M));
      const alt = others.filter(Boolean).map((x) => ({ pr: x })).find((x) => x.pr.amount !== null && x.pr.label !== pr.label && Math.abs(x.pr.amount - p.amount) < 0.015);
      if (alt) {
        const where = seg.kind === 'flight' ? `in flight from ${seg.org}` : `in ${match.station}`;
        Object.assign(item, {
          status: 'currency',
          severity: 'warn',
          title: `Paid at the ${alt.pr.label === 'U.S.' ? 'U.S.' : alt.pr.label === 'Canada' ? 'Canadian' : alt.pr.label} rate`,
          note: `The meal period starts ${where} (${pr.label}), so ${money(expAmt)} would apply (difference ${money(round2(expAmt - p.amount))}).`,
        });
        items.push(item);
        continue;
      }
    }
    // amount differs: another contract column?
    const col = mealTable
      ? null
      : RATE_TABLE.map(withNightDinner).find((r) => r.key !== rates.key && Math.abs(r[p.M] - p.amount) < 0.015);
    Object.assign(item, {
      status: col ? 'wrong-rate' : 'amount',
      severity: 'error',
      title: col ? `Paid at the "${col.label}" rate` : 'Amount differs from the rate',
      note: `${mealTable ? `${tableName}, ${pr.label}` : `Amount for ${periodLabel(period)} (${rates.label})`}: ${money(expAmt)}. Difference ${money(round2(expAmt - p.amount))}.`,
    });
    items.push(item);
  }

  for (const c of expectedCl) {
    if (used.has(c)) continue;
    if (!dayByIdx.has(c.dayIdx) && !dayByIdx.has(c.dayIdx - 1)) continue; // outside this statement
    const pr = price(c.station, c.M);
    if (pr.options.length && pr.options.every((o) => o.bracelet)) continue; // bracelet provided: nothing owed
    const hotelDepends = pr.options.some((o) => o.bracelet);
    const amt = pr.amount;
    const certain = c.status === 'expected' && !hotelDepends;
    let note = amt !== null ? priceNote(pr, amt) : pr.note;
    if (hotelDepends) note += `. Depends on the hotel: ${pr.options.filter((o) => o.bracelet).map((o) => o.name).join(', ')} has a bracelet instead.`;
    items.push({
      date: label(c.dayIdx),
      dayIdx: c.dayIdx,
      dayKey: dayByIdx.get(c.dayIdx)?.key,
      M: c.M,
      meal: MEAL_NAMES[c.M],
      paid: 0,
      expected: amt,
      rateLabel: pr.label,
      station: c.station,
      flt: c.primary.flt,
      pairing: dayByIdx.get(c.dayIdx)?.pairing || '',
      status: certain ? 'missing' : 'review',
      severity: certain ? 'error' : 'warn',
      title: certain ? 'Not paid' : 'Possibly owed',
      note,
      lines: explainCluster(c),
    });
  }

  // cross-reference: same flight, same meal, paid at another rate on another day
  for (const it of items.filter((i) => i.status === 'currency' && i.flt)) {
    const twin = items.find((j) => j !== it && j.M === it.M && j.flt === it.flt && j.status === 'ok' && j.rateLabel === it.rateLabel);
    if (twin) it.lines.push(`On ${twin.date} the same ${it.meal.toLowerCase()} on flight ${it.flt} was paid at the ${twin.rateLabel} rate (${money(twin.paid)}).`);
  }

  // ---- CICO ----
  const cico = cicoCandidates([tlA, tlS], off, opts);
  const cicoPaid = [];
  for (const d of st.days) if (d.expenses.CICO > 0) cicoPaid.push({ day: d, amount: d.expenses.CICO, count: Math.max(1, Math.round(d.expenses.CICO / ALLOWANCES.CICO)) });
  const cUsed = new Set();
  for (const p of cicoPaid) {
    const idx = p.day.idx;
    const matched = [];
    for (let k = 0; k < p.count; k++) {
      const m =
        cico.find((c) => !cUsed.has(c) && c.status !== 'none' && c.dayIdx === idx) ||
        cico.find((c) => !cUsed.has(c) && c.status !== 'none' && Math.abs(c.dayIdx - idx) === 1);
      if (!m) break;
      cUsed.add(m);
      matched.push(m);
    }
    const base = { date: label(idx), dayIdx: idx, dayKey: p.day.key, M: 'CICO', meal: 'CICO gratuity', paid: p.amount, pairing: p.day.pairing };
    const exp = round2(matched.length * ALLOWANCES.CICO);
    if (!matched.length) {
      items.push({
        ...base,
        expected: noDetail.has(idx) ? null : 0,
        status: noDetail.has(idx) ? 'unverified' : 'unexpected',
        severity: noDetail.has(idx) ? 'info' : 'warn',
        title: noDetail.has(idx) ? 'Not verified' : 'Paid, but no layover over 7 hours found',
        lines: noDetail.has(idx) ? ['No flight details are shown for this day.'] : cico.filter((c) => Math.abs(c.dayIdx - idx) <= 1).map((c) => c.text),
      });
    } else if (Math.abs(exp - p.amount) < 0.015) {
      items.push({ ...base, expected: exp, status: 'ok', severity: 'ok', title: 'Paid correctly', note: `${money(ALLOWANCES.CICO)} per layover (7.04)`, lines: matched.map((m) => m.text) });
    } else {
      items.push({ ...base, expected: exp, status: 'amount', severity: 'error', title: 'Amount differs from the contract', note: `Expected ${money(exp)} (${matched.length} × ${money(ALLOWANCES.CICO)}).`, lines: matched.map((m) => m.text) });
    }
  }
  for (const c of cico) {
    if (cUsed.has(c) || c.status === 'none') continue;
    if (!dayByIdx.has(c.dayIdx)) continue;
    const certain = c.status === 'expected';
    items.push({
      date: label(c.dayIdx),
      dayIdx: c.dayIdx,
      dayKey: dayByIdx.get(c.dayIdx)?.key,
      M: 'CICO',
      meal: 'CICO gratuity',
      paid: 0,
      expected: ALLOWANCES.CICO,
      pairing: dayByIdx.get(c.dayIdx)?.pairing || '',
      status: certain ? 'missing' : 'review',
      severity: certain ? 'error' : 'warn',
      title: certain ? 'Not paid' : 'Possibly owed',
      note: `${money(ALLOWANCES.CICO)} check-in/check-out gratuity (7.04)`,
      lines: [c.text],
    });
  }

  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  const mealOrder = { B: 0, L: 1, D: 2, ND: 3, S: 4, CICO: 5 };
  items.sort((a, b) => a.dayIdx - b.dayIdx || mealOrder[a.M] - mealOrder[b.M]);
  items.forEach((it, i) => (it.id = `i${i}`));

  // ---- other allowances ----
  const other = [];
  const rt = st.reportTotals || {};
  const hasCredit = st.days.some((d) => d.expenses.CAD > 0);
  if (rt.CLEAN !== undefined) {
    const v = toNumber(rt.CLEAN);
    other.push({
      id: 'clean',
      title: 'Uniform cleaning allowance (7.03.03)',
      paid: v,
      expected: ALLOWANCES.CLEAN,
      severity: Math.abs(v - ALLOWANCES.CLEAN) < 0.015 ? 'ok' : 'error',
      text: Math.abs(v - ALLOWANCES.CLEAN) < 0.015 ? 'Paid $45.00 for the block month.' : `Paid ${money(v)}; the contract amount is $45.00 per block month.`,
    });
  } else {
    other.push({
      id: 'clean',
      title: 'Uniform cleaning allowance (7.03.03)',
      paid: 0,
      expected: hasCredit ? ALLOWANCES.CLEAN : 0,
      severity: hasCredit ? 'error' : 'ok',
      text: hasCredit ? 'Not found in Report Totals > Allowances, but there are pay credits this month, so $45.00 is expected.' : 'No pay credits this month, so no cleaning allowance is due.',
    });
  }
  const hasJuly1 = st.days.some((d) => d.date && d.date.getUTCMonth() === 6 && d.date.getUTCDate() === 1);
  if (rt.SHOES !== undefined) {
    const v = toNumber(rt.SHOES);
    other.push({
      id: 'shoes',
      title: 'Footwear allowance (7.03.04)',
      paid: v,
      expected: ALLOWANCES.SHOES,
      severity: Math.abs(v - ALLOWANCES.SHOES) < 0.015 ? 'ok' : 'error',
      text: Math.abs(v - ALLOWANCES.SHOES) < 0.015 ? 'Paid $120.00 (yearly, July 1st).' : `Paid ${money(v)}; the contract amount is $120.00 per year.`,
    });
  } else if (hasJuly1) {
    other.push({ id: 'shoes', title: 'Footwear allowance (7.03.04)', paid: 0, expected: ALLOWANCES.SHOES, severity: 'warn', text: 'This statement includes July 1st but no SHOES allowance was found. $120.00 is paid on July 1st each year: check this or the next statement.' });
  }
  other.push({ id: 'visa', title: 'Visas, departure taxes and passports (7.05, 7.06)', paid: null, expected: null, severity: 'info', text: 'These are reimbursed from receipts and are not shown on the Crew Pay Details report, so they are not checked.' });
  const bldsText = (x) => `breakfast ${money(x.B)}, lunch ${money(x.L)}, dinner ${money(x.D)}, snack ${money(x.S)}`;
  if (contractRates && mealTable && mealTable.canada) {
    // the Canada row of the monthly chart must equal the 7.02.02 column for the period
    const diff = ['B', 'L', 'D', 'S'].filter((k) => Math.abs(mealTable.canada[k] - rates[k]) >= 0.015);
    other.push({
      id: 'table',
      title: 'Canada rates in the monthly table (7.02.02)',
      paid: null,
      expected: null,
      severity: diff.length ? 'warn' : 'ok',
      text: diff.length
        ? `The ${tableName} differs from the 7.02.02 column "${rates.label}" for ${diff.map((k) => `${MEAL_NAMES[k].toLowerCase()} (${money(mealTable.canada[k])} vs ${money(rates[k])})`).join(', ')}. The table amounts were used.`
        : `The ${tableName} matches the 7.02.02 column "${rates.label}".`,
    });
  } else if (!contractRates) {
    const own = rates.key === 'CHART' && !rates.fromOtherMonth;
    other.push({
      id: 'table',
      title: 'Canada rates before March 2026',
      paid: null,
      expected: null,
      severity: own ? 'ok' : 'warn',
      text: own
        ? `The 7.02.02 table of the agreement starts with the first block month following ratification (March 2026), so the Canada rates of the ${tableName} are used: ${bldsText(rates)}.`
        : rates.key === 'CHART'
          ? `No Meal Allowances table for ${periodLabel(period)}: the Canada rates of the ${periodLabel(rates.chartPeriod)} table are used (${bldsText(rates)}). U.S. meals and layover rates outside Canada cannot be checked. Add the ${periodLabel(period)} table (Add Meal Expenses and Report Time PDFs) for an exact check.`
          : `No Meal Allowances table from before March 2026 is loaded, so the agreement's first 7.02.02 column is used (${bldsText(rates)}). It may be higher than the rates in effect in ${periodLabel(period)}: add that month’s table (Add Meal Expenses and Report Time PDFs).`,
    });
  }

  // ---- totals reconciliation ----
  const recon = [];
  const present = [...MEAL_COLS, 'CICO'].filter((c) => st.totals[c] !== undefined);
  for (const c of present) {
    const sum = round2(st.days.reduce((s, d) => s + (d.expenses[c] || 0), 0));
    const tot = toNumber(st.totals[c]);
    recon.push({ col: c, label: c === 'CICO' ? 'CICO' : MEAL_NAMES[c], sum, total: tot, ok: Math.abs(sum - tot) < 0.015 });
  }
  if (st.totals.EXP !== undefined && present.length) {
    // In the expanded view EXP is the total of its sub-columns (B, L, D, S, ND, CICO...)
    const sum = round2(present.reduce((s, c) => s + toNumber(st.totals[c]), 0));
    const tot = toNumber(st.totals.EXP);
    recon.push({ col: 'EXP', label: 'All expenses (EXP)', sum, total: tot, ok: Math.abs(sum - tot) < 0.015 });
  }

  // ---- summary ----
  const cnt = { ok: 0, error: 0, warn: 0, info: 0 };
  for (const it of [...items, ...other]) cnt[it.severity] += 1;
  const paidTotal = round2(items.reduce((s, i) => s + (i.paid || 0), 0));
  const owed = round2(items.filter((i) => (i.severity === 'error' || i.severity === 'warn') && i.expected !== null).reduce((s, i) => s + Math.max(0, i.expected - (i.paid || 0)), 0));
  const over = round2(items.filter((i) => i.status === 'unexpected').reduce((s, i) => s + i.paid, 0));
  const certainOwed = round2(items.filter((i) => i.severity === 'error' && i.expected !== null).reduce((s, i) => s + Math.max(0, i.expected - (i.paid || 0)), 0));

  const stations = [...off.entries()].map(([code, o]) => ({ code, offset: o, country: countryOf(code), domestic: isDomestic(code) })).sort((a, b) => a.code.localeCompare(b.code));
  const usedStations = new Set(legs.flatMap((l) => [l.org, l.dst]));
  const unknownOffsets = [...usedStations].filter((s) => !off.has(s));

  const dayRows = st.days.map((d) => {
    const flown = d.legs.filter((g) => isDutyLeg(g) && isFlown(g));
    const route = [];
    for (const g of flown) {
      if (!route.length || route[route.length - 1] !== g.org) route.push(g.org);
      route.push(g.dst);
    }
    return {
      key: d.key,
      idx: d.idx,
      date: label(d.idx),
      src: d.src,
      pairing: d.pairing,
      route: route.join('–'),
      legs: d.legs.map((g) => ({ ...g, flown: isDutyLeg(g) ? isFlown(g) : null })),
      expenses: d.expenses,
      noDetail: noDetail.has(d.idx),
    };
  });

  return {
    meta: st.meta,
    home,
    rates,
    tables: {
      meals: mealTable ? { period: mealTable.period, source: mealTable.source || '', fileName: mealTable.fileName, canada: mealTable.canada, us: mealTable.us } : null,
      report: opts.tables && opts.tables.report ? { period: opts.tables.report.period, source: opts.tables.report.source || '', fileName: opts.tables.report.fileName, fallback: !!opts.tables.report.fallbackFor, rows: opts.tables.report.rows.length } : null,
    },
    options: opts,
    items,
    other,
    recon,
    days: dayRows,
    stations: stations.filter((s) => usedStations.has(s.code) || s.code === home),
    unknownOffsets,
    overseasStations: [...usedStations].filter((s) => !isDom(s)),
    unknownStations: [...usedStations].filter((s) => isDomestic(s) === null),
    summary: {
      counts: cnt,
      paidTotal,
      owed,
      certainOwed,
      over,
      verdict: cnt.error ? 'error' : cnt.warn ? 'warn' : 'ok',
    },
    debug: { legs, clusters, cico, tlA, tlS, excl },
  };
}
