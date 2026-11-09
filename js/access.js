// Online check-in and remote on/off switch.
//
//  - The app must reach its web site at least once every MAX_OFFLINE_DAYS days; after that it locks until the
//    device connects again.
//  - The site's status.json can switch every copy off ("kill switch"). A copy that has seen "off" stays locked,
//    even offline, until a later check sees "on" again.
//
// Only status.json is downloaded; nothing about the user or their PDFs is sent. Everything is kept on the device.
import { STATUS_URL } from './config.js';

export const MAX_OFFLINE_DAYS = 30;
export const WARN_DAYS = 7; // show a reminder when fewer days than this are left
const DAY_MS = 86400000;
const CLOCK_SLACK_MS = 10 * 60000;
const KEY = 'expense-checker-access-v1';

/**
 * Pure decision, used by the app and the tests.
 *   stored: { lastOk, lastSeen, disabled, message } saved on the device
 *   now:    current time (ms)
 *   online: the status.json object when the site was reached, or null
 * Returns { stored: <new stored state>, result: { state: 'ok'|'warn'|'blocked'|'disabled', daysLeft, reason, message, lastOk } }
 */
export function decide(stored, now, online) {
  const s = { ...(stored || {}) };
  const clockBack = !online && s.lastSeen && now < s.lastSeen - CLOCK_SLACK_MS; // device clock moved back
  if (online) {
    s.lastOk = now;
    s.lastSeen = now;
    s.disabled = online.enabled === false;
    s.message = typeof online.message === 'string' ? online.message : '';
  } else {
    s.lastSeen = Math.max(s.lastSeen || 0, now);
  }
  let result;
  if (s.disabled) result = { state: 'disabled', message: s.message || '' };
  else if (online) result = { state: 'ok', daysLeft: MAX_OFFLINE_DAYS };
  else if (!s.lastOk) result = { state: 'blocked', reason: 'never' };
  else if (clockBack) result = { state: 'blocked', reason: 'clock' };
  else {
    const left = MAX_OFFLINE_DAYS - (now - s.lastOk) / DAY_MS;
    result = left <= 0 ? { state: 'blocked', reason: 'expired' } : { state: left <= WARN_DAYS ? 'warn' : 'ok', daysLeft: Math.ceil(left) };
  }
  result.lastOk = s.lastOk || null;
  return { stored: s, result };
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the check is redone at every start */
  }
}

/** Downloads status.json; null when the site cannot be reached or the answer is not valid. */
export async function fetchStatus(url = STATUS_URL, timeoutMs = 8000) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j === 'object' && typeof j.enabled === 'boolean' ? j : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What the device knows without going online (used at start-up and before each check). */
export function localAccess() {
  return decide(load(), Date.now(), null).result;
}

/** Contacts the site, records the result and returns the access state (plus online: true/false). */
export async function checkAccess() {
  const online = await fetchStatus();
  const { stored, result } = decide(load(), Date.now(), online);
  save(stored);
  return { ...result, online: !!online };
}
