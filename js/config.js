// Where the app is published (GitHub Pages, see tools/deploy.mjs).
export const SITE_URL = 'https://vincemtl.github.io/expense-checker/';

// The on/off switch read by every copy of the app (tools/status.mjs changes it). The web app reads its own copy;
// the single desktop file (opened from disk) reads the published one.
export const STATUS_URL =
  globalThis.location && /^https?:$/.test(globalThis.location.protocol) ? new URL('status.json', globalThis.location.href).href : `${SITE_URL}status.json`;
