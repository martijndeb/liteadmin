const PREFS_KEY = 'liteadmin.prefs';
const RECENT_KEY = 'liteadmin.recent';
const HISTORY_KEY = 'liteadmin.history';

const defaults = { theme: 'auto', pageSize: 50, fontSize: 14, confirmDestructive: true, lang: null, accent: null };

function read(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || 'null') }; }
  catch (_) { return { ...fallback }; }
}
function readArr(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (_) { return []; }
}

export const prefs = {
  data: read(PREFS_KEY, defaults),
  get(k) { return this.data[k]; },
  set(k, v) { this.data[k] = v; localStorage.setItem(PREFS_KEY, JSON.stringify(this.data)); },
};

export const recent = {
  list() { return readArr(RECENT_KEY); },
  add(entry) {
    const list = this.list().filter(e => !(e.kind === entry.kind && e.id === entry.id));
    list.unshift({ ...entry, ts: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)));
  },
  remove(kind, id) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(this.list().filter(e => !(e.kind === kind && e.id === id))));
  },
};

export const history = {
  list() { return readArr(HISTORY_KEY); },
  add(sql, db) {
    const trimmed = sql.trim();
    if (!trimmed) return;
    const list = this.list().filter(e => e.sql !== trimmed);
    list.unshift({ sql: trimmed, db, ts: Date.now() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 100)));
  },
  clear() { localStorage.removeItem(HISTORY_KEY); },
};

const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function effectiveMode() {
  const pref = prefs.get('theme');
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark && systemDark.matches ? 'dark' : 'light';
}

let themeListeners = [];
export function onThemeChange(fn) { themeListeners.push(fn); }

export const DEFAULT_ACCENT = '#fdbe02';
export function accentColor() { return prefs.get('accent') || DEFAULT_ACCENT; }

let lastSeed = null;
function applySeed() {
  if (!window.ui || !window.materialDynamicColors) return Promise.resolve();
  const seed = accentColor();
  if (seed === lastSeed) return Promise.resolve();
  lastSeed = seed;
  return Promise.resolve(window.ui('theme', seed)).catch(() => {});
}

export function applyTheme() {
  const mode = effectiveMode();
  document.documentElement.style.colorScheme = mode;
  applySeed().then(() => { if (window.ui) window.ui('mode', mode); });
  themeListeners.forEach(fn => fn(mode));
  return mode;
}

export function setAccent(hex) {
  if (hex) prefs.set('accent', hex); else { prefs.data.accent = null; localStorage.setItem('liteadmin.prefs', JSON.stringify(prefs.data)); }
  applyTheme();
}

if (systemDark) systemDark.addEventListener('change', () => { if (prefs.get('theme') === 'auto') applyTheme(); });
