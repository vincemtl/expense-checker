// Rules from the "Collective Agreement between Air Canada and CUPE, effective April 01 2025"
// (Collective-Agreement-between-Air-Canada-and-CUPE-Effective-April-01-2025-FINAL.pdf).
// Article numbers and PDF page numbers refer to that document.
// All times are local clock times expressed in minutes after midnight.
// A window whose end is past 24:00 (the snack, 2300-0100) simply uses an end > 1440.

export const MEALS = ['B', 'L', 'D', 'ND', 'S'];

export const MEAL_NAMES = {
  B: 'Breakfast',
  L: 'Lunch',
  D: 'Dinner',
  ND: 'Night dinner',
  S: 'Snack',
};

const hm = (s) => {
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2));
  return h * 60 + m;
};

// 7.02.01 Recognized Meal Periods (Departure / Arrival columns).
// "ND" is the 0300 meal that the contract lists as "Dinner" and Rainmaker shows in the ND column.
export const MEAL_PERIODS = {
  ND: { dep: [hm('0300'), hm('0530')], arr: [hm('0300'), hm('0430')], label: 'Dinner 0300-0530 (arrival 0300-0430, night flight)' },
  B: { dep: [hm('0800'), hm('0930')], arr: [hm('0800'), hm('0930')], label: 'Breakfast 0800-0930' },
  L: { dep: [hm('1230'), hm('1330')], arr: [hm('1230'), hm('1330')], label: 'Lunch 1230-1330' },
  D: { dep: [hm('1800'), hm('1930')], arr: [hm('1700'), hm('1830')], label: 'Dinner 1800-1930 (arrival 1700-1830, except overseas)' },
  S: { dep: [hm('2300'), hm('2300') + 120], arr: [hm('2300'), hm('2300') + 120], label: 'Snack 2300-0100' },
};

// 7.02.02 Canada / United States meal allowances (PDF p. 21).
// The United States allowance is the same figure in U.S. funds, shown in Canadian funds
// at the official exchange rate in effect at the beginning of the preceding block month.
// The agreement does not name the "first block month following ratification". The monthly Meal Allowances
// charts show these rates from March 2026, so the 7.02.02 table is applied from that block month; earlier
// months take their Canada rates from the monthly table the user imported (tablestore.selectTables -> refMeals).
export const FIRST_CONTRACT_PERIOD = 202603;
export const RATE_TABLE = [
  { key: 'FBMFR', label: 'First block month following ratification', from: FIRST_CONTRACT_PERIOD, B: 19.57, L: 22.17, D: 43.91, S: 11.47 },
  { key: '2026', label: 'April 1, 2026', from: 202604, B: 20.16, L: 22.84, D: 45.23, S: 11.81 },
  { key: '2027', label: 'April 1, 2027', from: 202704, B: 20.66, L: 23.41, D: 46.36, S: 12.11 },
  { key: '2028', label: 'April 1, 2028', from: 202804, B: 21.23, L: 24.05, D: 47.63, S: 12.44 },
];

/** 7.02.02 column in effect for a Rainmaker period such as "202606", or null before March 2026. */
export function ratesForPeriod(period) {
  const p = Number(period);
  let chosen = null;
  for (const r of RATE_TABLE) {
    if (Number.isFinite(p) && p >= r.from) chosen = r;
  }
  return chosen ? withNightDinner(chosen) : null;
}

export function withNightDinner(r) {
  return { ...r, ND: r.D };
}

// B5.02.01 Duty Period - Definition (PDF p. 186):
//   operational flight: 1:00 hour prior to scheduled departure -> 00:15 after arrival of flight
//   deadhead: at Home Base 30 minutes prior to scheduled departure; away from Home Base the scheduled
//             departure of the designated deadhead flight -> actual arrival of the deadhead flight
// B5.03.01 (PDF p. 188): an employee may be required to report up to 30 minutes prior to any duty period.
// The company report times by aircraft type and the What's New "earlier report time" list are such
// pre-duty reports (all within 1:00 + 0:30).
export const DUTY_RULES = { operational: 60, preDutyMax: 30, deadheadHome: 30, deadheadAway: 0, release: 15, releaseDeadhead: 0 };

// Company report times by aircraft type (minutes before scheduled departure), supplied by the user;
// the part above 1:00 is the B5.03.01 pre-duty report.
export const REPORT_RULES = {
  home: { NB: 60, '767/788': 70, 'A330/789/772': 75, '773': 80, '77P': 85, deadhead: DUTY_RULES.deadheadHome },
  away: { NB: 60, '767/788': 60, 'A330/789/772': 60, '773': 60, '77P': 70, deadhead: DUTY_RULES.deadheadAway },
  release: DUTY_RULES.release,
  releaseDeadhead: DUTY_RULES.releaseDeadhead,
};

export const EQP_GROUP_LABEL = { NB: 'narrowbody', '767/788': '767/788', 'A330/789/772': 'A330/789/772', '773': '777-300', '77P': '77P' };

/** Equipment code from Rainmaker (223, 7M8, 321, 333, 789, 77W...) -> report-time group. */
export function eqpGroup(eqp) {
  const e = String(eqp || '').toUpperCase().trim();
  if (e === '77P') return '77P';
  if (/^(773|77W|777-3)$/.test(e)) return '773';
  if (/^(33\d|330|789|772|77L|781|78J|78X|787-9|787-10|777-2)$/.test(e)) return 'A330/789/772';
  if (/^(76\d|767|788|787-8)$/.test(e)) return '767/788';
  return 'NB';
}

/** Is a bulletin qualifier such as "737", "330", "788,330", "NB" or "WB" about this equipment? */
export function eqpMatches(qualifier, eqp) {
  const q = String(qualifier || '').toUpperCase();
  const e = String(eqp || '').toUpperCase();
  const wide = eqpGroup(e) !== 'NB';
  return q
    .split(/[\s,/]+/)
    .filter(Boolean)
    .some((t) => {
      if (t === 'NB') return !wide;
      if (t === 'WB') return wide;
      if (t === e) return true;
      if (/^73/.test(t)) return /^(73|7M)/.test(e);
      if (/^33/.test(t)) return /^33/.test(e);
      if (/^78/.test(t)) return t === e || (t === '787' && /^78/.test(e));
      if (/^77/.test(t)) return eqpGroup(t) === eqpGroup(e);
      return false;
    });
}

export const ALLOWANCES = {
  CICO: 5.05, // 7.04 check-in/check-out gratuity, layover or station stop > 7 h with accommodation
  CICO_MIN_MINUTES: 7 * 60,
  CLEAN: 45.0, // 7.03.03 uniform cleaning allowance, per block month
  SHOES: 120.0, // 7.03.04 footwear allowance, paid July 1st each year
};

// LOU 43 Meal Entitlements, para. 5 (PDF p. 111): meal allowances at an overseas layover point.
// Times are local at the layover point, in minutes after midnight.
export const LOU43 = {
  arrival: [
    { before: 750, meals: ['B', 'L', 'D', 'S'], text: 'arrival before 12:30' }, // * BLDS provided the flight leg is less than 10 hours
    { before: 811, meals: ['L', 'D', 'S'], text: 'arrival between 12:30 and 13:30' },
    { before: Infinity, meals: ['D', 'S'], text: 'arrival after 13:30' },
  ],
  longLegMin: 600, // "*... provided the flight leg is less than 10 hours"
  departure: [
    { from: 420, to: 690, meals: ['B'], text: 'departure between 07:00 and 11:29' },
    { from: 690, to: 1020, meals: ['B', 'L'], text: 'departure between 11:30 and 16:59' },
    { from: 1020, to: 1320, meals: ['B', 'L', 'D'], text: 'departure between 17:00 and 21:59' },
    { from: 1320, to: 1501, meals: ['B', 'L', 'D', 'S'], text: 'departure between 22:00 and 01:00' },
  ],
  fullDay: ['B', 'L', 'D', 'S'], // NOTE: all other layover days
};

// The articles the check relies on, quoted from the Collective Agreement (shown in the app).
// page = page of the PDF file; use = how the app applies the article.
export const AGREEMENT = 'Collective Agreement between Air Canada and CUPE, effective April 01, 2025';
export const RULE_TEXT = [
  {
    ref: '7.02',
    page: 21,
    title: 'Meal Allowances',
    text:
      'Meals will be provided or meal allowances paid only where an employee is on duty or on a legal layover during an entire recognized meal period. ' +
      'No meal or meal allowance will be provided for scheduled flight departures from Home Base and scheduled flight arrivals at Home Base during recognized meal periods ' +
      'when originating or terminating a duty period at Home Base. No meals or meal allowances will be provided outside the recognized meal periods.',
  },
  {
    ref: '7.02 Note 2',
    page: 21,
    title: 'Domestic duty day / Snacks',
    text:
      'Effective the first block month following ratification of the Collective Agreement following the Collective Agreement that expired on March 31, 2015, ' +
      'for Domestic duty day, the Canada / United States meal allowances will be paid in lieu of providing boarded meals where meals would normally have been ' +
      'provided on flights, and in accordance with Article 7.02.02. Snacks (2300-0100) will continue to be provided on board and will not be paid.',
  },
  {
    ref: '7.02.01',
    page: 21,
    title: 'Recognized Meal Periods',
    text:
      'Departures / Arrivals: Dinner 0300 to 0530 / 0300 to 0430 (Night Flight) · Breakfast 0800 to 0930 / 0800 to 0930 · Lunch 1230 to 1330 / 1230 to 1330 · ' +
      'Dinner 1800 to 1930 / 1700 to 1830 (except overseas) · Snack 2300 to 0100 / 2300 to 0100.',
  },
  {
    ref: '7.02.02',
    page: 21,
    title: 'Canada/United States Meal Allowances',
    text:
      'First Block Month Following Ratification / April 1, 2026 / April 1, 2027 / April 1, 2028 (see the table below). ' +
      'The United States meal allowance will be in U.S. funds and indicated on the pairing in Canadian funds at the official rate of exchange in effect ' +
      'at the beginning of the preceding block month.',
    use: 'Applied from March 2026, the first block month whose Meal Allowances table shows these rates. Earlier months use the Canada rates of their monthly ' +
      'Meal Allowances table (or of the nearest table before March 2026 when that month’s table is missing).',
  },
  {
    ref: '7.02.03',
    page: 21,
    title: 'Other Locations',
    text:
      'The meal allowances for all other locations shall be established by the Company following consultation with the Union, to cover the reasonable cost of meals ' +
      'at those locations. Meal allowances at these locations will be adjusted when there is a five (5) percent change on the basis of six (6) month running average ' +
      'plus or minus. However, such meal allowances shall not be less than those provided for under Article 7.02.02 Canada/United States meal allowances.',
    use: 'These are the station rates of the monthly Meal Allowances table.',
  },
  {
    ref: '1.02.08 / Appendix I',
    page: 5,
    title: 'Overseas Operation',
    text:
      'Any operation conducted from any point on the North American Continent to any landing point more than five hundred (500) miles outside the boundary of said ' +
      'North American Continent [...]. All points and places shown as outside the red line on this map shall be deemed to be more than five hundred (500) miles outside ' +
      'the boundary of the Continent and all points shown as inside the red line on the said map shall be deemed to be within five hundred (500) miles of the boundary ' +
      'of the Continent. (APPENDIX I)',
    use: 'Inside the line (Appendix I, PDF p. 215): Canada, U.S. mainland and Alaska, Mexico, Central America to Costa Rica, Cuba, Jamaica, Bahamas, Bermuda. ' +
      'Outside: Hawaii, Dominican Republic, Haiti, Puerto Rico, Turks & Caicos, the Lesser Antilles, Panama, South America, Europe, Africa, Asia, Pacific.',
  },
  {
    ref: 'B5.02.02',
    page: 186,
    title: 'Domestic and overseas duty period',
    text:
      'A domestic duty period is defined as any duty period which contains a flight(s) originating and/or terminating within the North American Continent and including ' +
      'flights originating and/or terminating within five hundred (500) miles of the North American Continent. [...] The overseas duty period is defined as any duty ' +
      'period which contains an overseas flight or part thereof.',
  },
  {
    ref: 'LOU 43',
    page: 111,
    title: 'Meal Entitlements (Overseas Operations)',
    text:
      '2. When a flight arrives at a layover point during a recognized meal period, the cabin personnel operating the flight will receive the meal allowance of the layover point. ' +
      '5. Arrival before 12:30*: BLDS · Arrival between 12:30 and 13:30: LDS · Arrival after 13:30: DS. Departures between 07:00 to 11:29: B · 11:30 to 16:59: BL · ' +
      '17:00 to 21:59: BLD · 22:00 to 01:00: BLDS. *BLDS for the day of arrival provided the flight leg is less than 10 hours. ' +
      'NOTE: On all other layover days (excludes arrival and departure days from layover point), cabin personnel will receive BLDS. ' +
      '11 (a) iii) When a flight is delayed from a layover point, cabin personnel will be paid for all layover meals allowances that result from the delay at the layover point.',
    use: 'Applied to layovers at overseas stations, using scheduled arrival and departure times (departure delays included).',
  },
  {
    ref: 'B5.02.01',
    page: 186,
    title: 'Duty Period - Definition',
    text:
      'Operational Flights: commences 1:00 hour prior to scheduled departure or rescheduled departure if notified prior to arrival at airport; terminates 00:15 hours after arrival of flight. ' +
      'Deadhead: At Home Base: 30 minutes prior to scheduled departure of designated deadhead flight. Away from Home Base: Scheduled departure of designated deadhead flight; ' +
      'terminates at the actual arrival of deadhead flight. Airport Standby: Airport Report Time; terminates at airport release.',
  },
  {
    ref: 'B5.03.01',
    page: 188,
    title: 'Ground Duty - Pre/Post Duty Period',
    text: 'An employee may be required to report for duty up to thirty (30) minutes prior to any duty period.',
    use: 'Company report times (not printed in the agreement) applied within this limit: at Home Base 767/788 1:10, A330/789/772 1:15, 777-300 1:20, 77P 1:25; ' +
      'away from Home Base 77P 1:10; and the flights listed with an earlier report time in the monthly What’s New bulletin.',
  },
  {
    ref: '7.03.03',
    page: 22,
    title: 'Uniform Cleaning',
    text:
      'Cabin Personnel shall receive a uniform cleaning allowance of forty-five ($45.00) per month. To qualify for this allowance, Cabin Personnel must be actively on the payroll ' +
      'at least one day in that block month.',
  },
  { ref: '7.03.04', page: 22, title: 'Footwear Allowance', text: 'Cabin Personnel shall receive a footwear allowance of one hundred and twenty dollars ($120.00) per year to be paid on July 1st of each year.' },
  {
    ref: '7.04',
    page: 22,
    title: 'Check-in/Check-out Gratuity Allowance',
    text: 'A check-in/check-out gratuity allowance of five dollars and five cents ($5.05) will be paid during a legal layover or station stops in excess of seven (7) hours where accommodation is provided.',
  },
  {
    ref: '7.05 / 7.06',
    page: 22,
    title: 'Visas / Passports',
    text:
      '7.05 Cabin personnel shall, upon submitting a receipt, be reimbursed for the full cost of any and all visas and departure taxes that are required to perform cabin ' +
      'personnel duties when operating or deadheading. 7.06 Cabin Personnel who renew their passports [...] shall, upon the submission of the necessary passport and ' +
      'photograph receipt(s), including any urgent processing fees, will be reimbursed.',
    use: 'Not shown on the Crew Pay Details report, so not checked.',
  },
];
