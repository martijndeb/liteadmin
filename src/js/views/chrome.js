import { el, toast } from '../util.js';
import { t, loadLang, SUPPORTED, LANG_NAMES, detectLang } from '../i18n.js';
import { Api } from '../api.js';
import { prefs, applyTheme, accentColor, setAccent, DEFAULT_ACCENT } from '../store.js';

export function topBar(ctx, { title, onMenu, extra, home = true } = {}) {
  return el('header', { class: 'primary-container' }, [
    el('nav', {}, [
      onMenu ? el('button', { class: 's m', 'aria-label': 'Menu', onClick: onMenu }, [el('i', { text: 'menu' })]) : null,
      home ? el('button', { class: 'circle transparent', 'aria-label': t('nav.home'), onClick: () => ctx.navigate('start') }, [el('i', { text: 'storage' })]) : null,
      el('h6', { class: 'max', text: title || Api.app.name }),
      ...(extra || []),
      el('button', { class: 'circle transparent', 'aria-label': t('nav.preferences'), onClick: () => openPreferences(ctx) }, [el('i', { text: 'settings' })]),
      el('button', { class: 'circle transparent', 'aria-label': t('nav.logout'), onClick: () => ctx.logout() }, [el('i', { text: 'logout' })]),
    ]),
  ]);
}

export function openPreferences(ctx) {
  const themeSel = el('select', {}, ['auto', 'light', 'dark'].map(v =>
    el('option', { value: v, selected: prefs.get('theme') === v, text: t('prefs.theme' + v[0].toUpperCase() + v.slice(1)) })));
  const curLang = prefs.get('lang') || detectLang() || Api.app.lang || 'en';
  const langSel = el('select', {}, SUPPORTED.map(v =>
    el('option', { value: v, selected: curLang === v, text: LANG_NAMES[v] || v })));
  const pageSize = el('input', { type: 'number', min: '5', max: '1000', value: prefs.get('pageSize') });
  const fontSize = el('input', { type: 'number', min: '8', max: '32', value: prefs.get('fontSize') });
  const confirmChk = el('input', { type: 'checkbox', checked: prefs.get('confirmDestructive') });

  const dot = el('span', { class: 'accent-dot' });
  const hexLabel = el('span', { text: accentColor() });
  const accentInput = el('input', { type: 'color', value: accentColor(), 'aria-label': t('prefs.accent') });
  dot.style.background = accentColor();
  const accentBtn = el('button', { class: 'border', type: 'button' }, [dot, hexLabel, accentInput]);
  const resetBtn = el('button', { class: 'border', type: 'button', onClick: () => { setAccent(null); dot.style.background = DEFAULT_ACCENT; hexLabel.textContent = DEFAULT_ACCENT; accentInput.value = DEFAULT_ACCENT; } }, [el('i', { text: 'restart_alt' }), el('span', { text: t('prefs.accentReset') })]);
  accentInput.addEventListener('input', () => { dot.style.background = accentInput.value; hexLabel.textContent = accentInput.value; setAccent(accentInput.value); });

  const dlg = el('dialog', { class: 'right', 'aria-label': t('prefs.title') }, [
    el('h5', { text: t('prefs.title') }),
    el('div', { class: 'field label suffix border' }, [langSel, el('label', { text: t('prefs.language') })]),
    el('div', { class: 'field label suffix border' }, [themeSel, el('label', { text: t('prefs.theme') })]),
    el('label', { class: 'small-text', text: t('prefs.accent') }),
    el('nav', { class: 'wrap' }, [accentBtn, resetBtn]),
    el('div', { class: 'field label border' }, [pageSize, el('label', { text: t('prefs.pageSize') })]),
    el('div', { class: 'field label border' }, [fontSize, el('label', { text: t('prefs.fontSize') })]),
    el('label', { class: 'checkbox' }, [confirmChk, el('span', { text: t('prefs.confirmDestructive') })]),
    el('div', { class: 'v-space large' }),
    el('h6', { class: 'small', text: t('prefs.account') }),
    Api.configWritable ? null : el('p', { class: 'small-text error-text', text: t('prefs.configReadonly') }),
    el('button', { class: 'border', type: 'button', disabled: !Api.configWritable, onClick: () => changePasswordDialog() }, [el('i', { text: 'password' }), el('span', { text: t('prefs.changePassword') })]),
    el('div', { class: 'v-space' }),
    el('nav', { class: 'right-align' }, [
      el('button', { text: t('prefs.close'), onClick: () => dlg.remove() }),
    ]),
  ].filter(Boolean));

  langSel.addEventListener('change', async () => {
    prefs.set('lang', langSel.value);
    await loadLang(langSel.value);
    dlg.remove();
    if (ctx && ctx.rerender) ctx.rerender();
  });
  themeSel.addEventListener('change', () => { prefs.set('theme', themeSel.value); applyTheme(); });
  pageSize.addEventListener('change', () => prefs.set('pageSize', Math.max(5, +pageSize.value || 50)));
  fontSize.addEventListener('change', () => prefs.set('fontSize', Math.max(8, +fontSize.value || 14)));
  confirmChk.addEventListener('change', () => prefs.set('confirmDestructive', confirmChk.checked));

  document.body.append(dlg);
  dlg.showModal();
}

function changePasswordDialog() {
  const cur = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': t('pw.current') });
  const nw = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': t('pw.new') });
  const conf = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': t('pw.confirm') });
  const dlg = el('dialog', { class: 'small fit', 'aria-label': t('prefs.changePassword') }, [
    el('h5', { text: t('prefs.changePassword') }),
    el('div', { class: 'field label border' }, [cur, el('label', { text: t('pw.current') })]),
    el('div', { class: 'field label border' }, [nw, el('label', { text: t('pw.new') })]),
    el('div', { class: 'field label border' }, [conf, el('label', { text: t('pw.confirm') })]),
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'border', type: 'button', text: t('common.cancel'), onClick: () => dlg.remove() }),
      el('button', { type: 'button', text: t('common.save'), onClick: save }),
    ]),
  ]);
  async function save() {
    if (!nw.value) return toast(t('pw.new'), true);
    if (nw.value !== conf.value) return toast(t('setup.mismatch'), true);
    try { await Api.changePassword(cur.value, nw.value); toast(t('pw.changed')); dlg.remove(); }
    catch (e) { toast(e.message, true); }
  }
  document.body.append(dlg);
  dlg.showModal();
  setTimeout(() => cur.focus(), 30);
}
