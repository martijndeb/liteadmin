let dict = {};

export const SUPPORTED = ['en', 'nl', 'de', 'fy', 'sv'];
export const LANG_NAMES = { en: 'English', nl: 'Nederlands', de: 'Deutsch', fy: 'Frysk', sv: 'Svenska' };

export function detectLang() {
  const cands = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
  for (const c of cands) {
    const base = String(c).toLowerCase().split('-')[0];
    if (SUPPORTED.includes(base)) return base;
  }
  return null;
}

export async function loadLang(lang) {
  try {
    const r = await fetch(`i18n/${lang}.json`, { cache: 'no-cache' });
    if (r.ok) dict = await r.json();
  } catch (_) { dict = {}; }
}

export function t(key, vars) {
  let s = dict[key] != null ? dict[key] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
