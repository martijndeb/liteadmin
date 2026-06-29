import { el, clear, toast } from '../util.js';
import { t } from '../i18n.js';
import { Api } from '../api.js';

export function renderLogin(root, ctx) {
  clear(root);
  const user = el('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, 'aria-label': t('login.username') });
  const pass = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': t('login.password') });

  const form = el('form', { class: 'auth-card' }, [
    el('article', { class: 'round' }, [
      el('div', { class: 'auth-head' }, [
        el('div', { class: 'auth-badge' }, [el('i', { text: 'database' })]),
        el('h5', { text: Api.app.name }),
        el('p', { class: 'small-text', text: t('app.tagline') }),
      ]),
      el('div', { class: 'v-space' }),
      el('div', { class: 'field label border' }, [user, el('label', { text: t('login.username') })]),
      el('div', { class: 'field label border' }, [pass, el('label', { text: t('login.password') })]),
      el('button', { class: 'responsive', type: 'submit' }, [el('i', { text: 'login' }), el('span', { text: t('login.submit') })]),
    ]),
  ]);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await Api.login(user.value, pass.value);
      ctx.navigate('start');
    } catch (_) { toast(t('login.error'), true); pass.focus(); }
  });

  root.append(el('main', { id: 'main', class: 'center-screen' }, [form]));
  user.focus();
}

export function renderSetup(root, ctx) {
  clear(root);
  const pass = el('input', { type: 'password', autocomplete: 'new-password', required: true, 'aria-label': t('setup.password') });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: true, 'aria-label': t('setup.confirm') });
  const writable = Api.configWritable;

  const submitBtn = el('button', { class: 'responsive', type: 'submit', disabled: !writable }, [el('i', { text: 'lock' }), el('span', { text: t('setup.submit') })]);

  const form = el('form', { class: 'auth-card' }, [
    el('article', { class: 'round' }, [
      el('div', { class: 'auth-head' }, [
        el('div', { class: 'auth-badge' }, [el('i', { text: 'lock' })]),
        el('h5', { text: t('setup.title') }),
        el('p', { class: 'small-text', text: t('setup.intro') }),
      ]),
      el('div', { class: 'v-space' }),
      writable ? null : el('p', { class: 'small-text error-text', text: t('setup.notWritable') }),
      el('div', { class: 'field label border' }, [pass, el('label', { text: t('setup.password') })]),
      el('div', { class: 'field label border' }, [confirm, el('label', { text: t('setup.confirm') })]),
      submitBtn,
    ].filter(Boolean)),
  ]);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!pass.value) return toast(t('setup.password'), true);
    if (pass.value !== confirm.value) return toast(t('setup.mismatch'), true);
    try {
      await Api.setup(pass.value);
      toast(t('setup.done'));
      ctx.navigate('start');
    } catch (err) { toast(err.message, true); }
  });

  root.append(el('main', { id: 'main', class: 'center-screen' }, [form]));
  if (writable) pass.focus();
}
