import { Api } from './api.js';
import { loadLang, detectLang } from './i18n.js';
import { applyTheme, onThemeChange, prefs } from './store.js';
import { setEditorTheme } from './editor.js';
import { toast } from './util.js';
import { renderLogin, renderSetup } from './views/login.js';
import { renderStartup } from './views/startup.js';
import { renderWorkspace } from './views/workspace.js';

const root = document.getElementById('app');
let connection = null;
let current = 'login';

const routes = { login: renderLogin, setup: renderSetup, start: renderStartup, work: renderWorkspace };

export function effectiveLang() {
  return prefs.get('lang') || detectLang() || Api.app.lang || 'en';
}

const ctx = {
  navigate(name) { current = name; routes[name](root, ctx); },
  rerender() { routes[current](root, ctx); },
  getConnection() { return connection; },
  openConnection(c) { connection = c; current = 'work'; routes.work(root, ctx); },
  async logout() { try { await Api.logout(); } catch (_) {} connection = null; current = 'login'; routes.login(root, ctx); },
};

async function boot() {
  try {
    const sess = await Api.session();
    await loadLang(effectiveLang());
    onThemeChange(mode => setEditorTheme(mode === 'dark'));
    setTimeout(applyTheme, 0);
    ctx.navigate(sess.needs_setup ? 'setup' : (sess.authed ? 'start' : 'login'));
  } catch (e) {
    toast('Cannot reach server: ' + e.message, true);
    await loadLang(effectiveLang());
    ctx.navigate('login');
  }
}

function installDialogDismiss() {
  let downOnBackdrop = false;
  document.addEventListener('mousedown', e => { downOnBackdrop = e.target instanceof HTMLDialogElement; });
  document.addEventListener('click', e => {
    const d = e.target;
    if (!downOnBackdrop || !(d instanceof HTMLDialogElement) || !d.open) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
  document.addEventListener('close', e => {
    if (e.target instanceof HTMLDialogElement && e.target.isConnected) e.target.remove();
  }, true);
}

installDialogDismiss();
boot();
