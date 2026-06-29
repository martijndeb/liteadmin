import { el, clear, toast } from '../util.js';
import { t } from '../i18n.js';
import { Api } from '../api.js';
import { recent } from '../store.js';
import { openServer, openLocal, saveHandle, loadHandle } from '../connection.js';
import { topBar } from './chrome.js';

export async function renderStartup(root, ctx) {
  clear(root);
  const body = el('div', { class: 'work-body start' });
  root.append(topBar(ctx, { title: t('start.title'), home: false }), el('main', { id: 'main', class: 'work' }, [body]));
  body.append(el('progress', { class: 'circle' }));

  let databases = [];
  try { databases = (await Api.proxy('databases')).databases; }
  catch (e) { toast(e.message, true); }
  const byKey = Object.fromEntries(databases.map(d => [d.key, d]));

  clear(body);
  body.append(hero(databases), serverSection(ctx, databases), localSection(ctx), recentSection(ctx, byKey));
}

function hero(databases) {
  return el('section', { class: 'start-hero' }, [
    el('div', { class: 'start-hero-icon' }, [el('i', { text: 'database' })]),
    el('div', { class: 'max' }, [
      el('h4', { class: 'start-hero-title', text: Api.app.name || 'LiteAdmin' }),
      el('p', { class: 'start-hero-sub', text: t('app.tagline') }),
    ]),
    databases.length ? el('span', { class: 'chip', text: t('start.dbCount', { n: databases.length }) }) : null,
  ].filter(Boolean));
}

function serverSection(ctx, databases) {
  const grid = el('div', { class: 'grid' });
  if (!databases.length) grid.append(el('p', { class: 'small-text', text: t('start.empty') }));
  for (const db of databases) {
    grid.append(el('article', { class: 's12 m6 l4 round border db-card' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'db-card-avatar' }, [el('i', { text: db.managed ? 'folder_managed' : 'database' })]),
        el('div', { class: 'max' }, [
          el('h6', { text: db.label }),
          el('div', { class: 'small-text' }, [
            db.readonly ? el('span', { class: 'chip tiny', text: t('start.readonly') }) : null,
            !db.exists ? el('span', { class: 'chip tiny error', text: t('start.missing') }) : null,
            db.managed && db.exists && !db.readonly ? el('span', { class: 'chip tiny', text: t('start.managed') }) : null,
          ]),
        ]),
      ]),
      el('nav', { class: 'right-align' }, [
        el('button', { class: 'small', disabled: !db.exists, onClick: () => openServerDb(ctx, db) }, [el('i', { text: 'login' }), el('span', { text: t('start.open') })]),
      ]),
    ]));
  }
  return el('section', { class: 'start-section' }, [el('h6', { text: t('start.server') }), grid,
    Api.canCreateDb ? el('button', { class: 'border small', onClick: () => createServerDb(ctx) }, [el('i', { text: 'add' }), el('span', { text: t('start.newServer') })]) : null,
  ].filter(Boolean));
}

function localSection(ctx) {
  return el('section', { class: 'start-section' }, [
    el('h6', { text: t('start.local') }),
    el('nav', { class: 'wrap' }, [
      el('button', { class: 'border', onClick: () => openLocalFile(ctx) }, [el('i', { text: 'folder_open' }), el('span', { text: t('start.openFile') })]),
      el('button', { class: 'border', onClick: () => newLocalDb(ctx) }, [el('i', { text: 'note_add' }), el('span', { text: t('start.newLocal') })]),
    ]),
  ]);
}

function recentSection(ctx, byKey) {
  const list = recent.list();
  const items = list.length ? list.map(e => el('a', { class: 'row wave round' }, [
    el('i', { text: e.kind === 'server' ? 'database' : 'sd_card' }),
    el('div', { class: 'max' }, [el('div', { text: e.label }), el('div', { class: 'small-text', text: e.kind })]),
    el('button', { class: 'circle transparent small', 'aria-label': 'Remove', onClick: ev => { ev.stopPropagation(); recent.remove(e.kind, e.id); renderStartup(document.getElementById('app'), ctx); } }, [el('i', { text: 'close' })]),
  ])) : [el('p', { class: 'small-text', text: t('start.noRecent') })];

  items.forEach((node, i) => {
    if (node.tagName !== 'A') return;
    node.tabIndex = 0; node.setAttribute('role', 'button');
    const e = list[i];
    const go = () => e.kind === 'server' ? openServerDb(ctx, byKey[e.id] || { key: e.id, label: e.label, exists: true }) : reopenLocal(ctx, e);
    node.addEventListener('click', go);
    node.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  });
  return el('section', { class: 'start-section' }, [el('h6', { text: t('start.recent') }), el('div', { class: 'start-recent' }, items)]);
}

async function openServerDb(ctx, db) {
  try {
    const conn = await openServer({ id: db.key, label: db.label, readonly: db.readonly });
    recent.add({ kind: 'server', id: db.key, label: db.label });
    ctx.openConnection(conn);
  } catch (e) { toast(e.message, true); }
}

async function createServerDb(ctx) {
  const name = prompt(t('start.newServer') + ' — ' + t('common.name'));
  if (!name) return;
  try {
    const r = await Api.proxy('create_database', { name });
    const conn = await openServer({ id: r.key, label: r.label, readonly: false });
    recent.add({ kind: 'server', id: r.key, label: r.label });
    ctx.openConnection(conn);
  } catch (e) { toast(e.message, true); }
}

async function openLocalFile(ctx) {
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'SQLite', accept: { 'application/octet-stream': ['.sqlite', '.db', '.sqlite3'] } }] });
      const file = await handle.getFile();
      const bytes = await file.arrayBuffer();
      const id = 'local:' + file.name;
      const conn = await openLocal({ id, label: file.name }, bytes, handle);
      await saveHandle(id, handle);
      recent.add({ kind: 'local', id, label: file.name });
      ctx.openConnection(conn);
    } else {
      const input = el('input', { type: 'file', accept: '.sqlite,.db,.sqlite3' });
      input.addEventListener('change', async () => {
        const file = input.files[0]; if (!file) return;
        const bytes = await file.arrayBuffer();
        const id = 'local:' + file.name;
        const conn = await openLocal({ id, label: file.name }, bytes, null);
        recent.add({ kind: 'local', id, label: file.name });
        ctx.openConnection(conn);
      });
      input.click();
    }
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
}

async function newLocalDb(ctx) {
  const name = prompt(t('start.newLocal') + ' — ' + t('common.name'), 'database.sqlite');
  if (!name) return;
  try {
    let handle = null;
    if (window.showSaveFilePicker) {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'SQLite', accept: { 'application/octet-stream': ['.sqlite'] } }] });
    }
    const id = 'local:' + name;
    const conn = await openLocal({ id, label: name }, null, handle);
    if (handle) { await conn.persist(); await saveHandle(id, handle); }
    recent.add({ kind: 'local', id, label: name });
    ctx.openConnection(conn);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
}

async function reopenLocal(ctx, entry) {
  try {
    const handle = await loadHandle(entry.id);
    if (handle && handle.queryPermission) {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const file = await handle.getFile();
        const conn = await openLocal({ id: entry.id, label: entry.label }, await file.arrayBuffer(), handle);
        recent.add({ kind: 'local', id: entry.id, label: entry.label });
        return ctx.openConnection(conn);
      }
    }
    toast('Please pick the file again', true);
    openLocalFile(ctx);
  } catch (e) { toast(e.message, true); }
}
