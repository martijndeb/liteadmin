import { createEditor } from '../../js/editor.js';

export function register(api) {
  const { el, clear, toast, download } = api;

  api.addStartCard({
    icon: 'api',
    title: api.label,
    subtitle: 'Serve selected databases and tables as a CRUD REST API',
    onOpen: () => panelDialog(),
  });

  // Reach the plugin's own front controller (never the rewritten /api/ path,
  // which can fall through to the SPA and return the HTML shell instead of JSON).
  function specUrl(subPath) {
    const u = new URL('api.php', import.meta.url);
    u.searchParams.set('_path', subPath);
    return u.href;
  }

  // Fetch an OpenAPI document (admin session travels in the cookie). Guard against
  // a non-JSON response (e.g. an HTML shell) so we never view/download markup.
  async function fetchSpec(subPath) {
    const r = await fetch(specUrl(subPath), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = await r.text();
    if (!r.ok) {
      let msg = r.statusText || 'Request failed';
      try { msg = JSON.parse(body).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    try { return JSON.stringify(JSON.parse(body), null, 2); }
    catch (_) { throw new Error('Unexpected response — is the plugin enabled?'); }
  }

  async function downloadSpec(subPath, filename) {
    try { download(filename, await fetchSpec(subPath), 'application/json'); }
    catch (e) { toast(e.message, true); }
  }

  // View the OpenAPI JSON in a Monaco editor, matching the app's code viewer.
  async function viewSpec(title, subPath, filename) {
    let content;
    try { content = await fetchSpec(subPath); } catch (e) { return toast(e.message, true); }

    const host = el('div', { class: 'viewer-editor' });
    let editor = null;
    const val = () => (editor ? editor.getValue() : content);
    const dlg = el('dialog', { class: 'large fit viewer-dialog', 'aria-label': title }, [
      el('h5', { text: title }),
      host,
      el('nav', { class: 'right-align' }, [
        el('button', { class: 'border', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(val()); toast('Copied'); } }, [el('i', { text: 'content_copy' }), el('span', { text: 'Copy' })]),
        el('button', { class: 'border', onClick: () => download(filename, val(), 'application/json') }, [el('i', { text: 'download' }), el('span', { text: 'Download' })]),
        el('button', { onClick: () => dlg.close() }, [el('span', { text: 'Close' })]),
      ]),
    ]);
    dlg.addEventListener('close', () => { if (editor) { editor.dispose(); editor = null; } dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    try { editor = await createEditor(host, content, 14, { language: 'json', wordWrap: 'on' }); }
    catch (_) { host.append(el('pre', { class: 'code-block scroll', text: content })); }
  }

  // View + download buttons for a given OpenAPI sub-path (after /api).
  function specControls(subPath, filename) {
    return [
      el('button', { class: 'border small', onClick: () => viewSpec(filename, subPath, filename) }, [el('i', { text: 'code' }), el('span', { text: 'View' })]),
      el('button', { class: 'border small', onClick: () => downloadSpec(subPath, filename) }, [el('i', { text: 'download' }), el('span', { text: 'Download' })]),
    ];
  }

  function panelDialog() {
    const body = el('div', {});
    const dlg = el('dialog', { class: 'large fit', 'aria-label': api.label }, [
      el('h5', { text: api.label }),
      el('p', { class: 'small-text', text: 'Tables you select here are served as a CRUD REST API at ' +
        '/api/<database>/<table>, authenticated with an API key (X-Api-Key or Authorization: Bearer). ' +
        'A read key may GET; only a read+write key may POST/PUT/PATCH/DELETE. Any database with at ' +
        'least one selected table is served; each database’s OpenAPI document is linked below. ' +
        'Nothing is served until you select it and save.' }),
      el('nav', { class: 'wrap' }, [
        el('button', { class: 'border small', onClick: () => setAll(true) }, [el('i', { text: 'select_all' }), el('span', { text: 'Select all' })]),
        el('button', { class: 'border small', onClick: () => setAll(false) }, [el('i', { text: 'deselect' }), el('span', { text: 'Deselect all' })]),
        el('div', { class: 'max' }),
        el('button', { onClick: save }, [el('i', { text: 'save' }), el('span', { text: 'Save' })]),
      ]),
      // Combined OpenAPI across all databases.
      el('article', { class: 'round border', style: 'margin:.5rem 0' }, [
        el('div', { class: 'row' }, [
          el('b', { text: 'All databases' }),
          el('div', { class: 'max' }),
          el('code', { class: 'small-text', text: '/api/openapi.json' }),
          ...specControls('openapi.json', 'openapi-all.json'),
        ]),
      ]),
      body,
      el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: 'Close', onClick: () => dlg.remove() })]),
    ]);

    // boxes: [{ el: <input>, db: dbKey, table: name }]
    let boxes = [];
    function setAll(on) { for (const b of boxes) b.el.checked = on; }

    async function refresh() {
      clear(body);
      boxes = [];
      let data;
      try { data = await api.call('panel'); } catch (e) { toast(e.message, true); return; }
      const dbs = data.databases || [];
      if (!dbs.length) { body.append(el('p', { class: 'small-text', text: 'No databases configured.' })); return; }

      for (const db of dbs) {
        const rows = [];
        if (!db.exists) {
          rows.push(el('div', { class: 'small-text', text: 'Database file is missing.' }));
        } else if (!db.tables.length) {
          rows.push(el('div', { class: 'small-text', text: 'No tables.' }));
        } else {
          for (const t of db.tables) {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = !!t.exposed;
            boxes.push({ el: cb, db: db.key, table: t.name });
            rows.push(el('label', { class: 'checkbox' }, [cb, el('span', { text: t.name })]));
          }
        }
        body.append(el('article', { class: 'round border', style: 'margin:.5rem 0' }, [
          el('div', { class: 'row' }, [
            el('b', { text: db.label }),
            db.readonly ? el('span', { class: 'chip tiny', text: 'read-only' }) : null,
            el('div', { class: 'max' }),
            el('code', { class: 'small-text', text: '/api/' + db.slug + '/' }),
            ...specControls(db.slug + '/openapi.json', 'openapi-' + db.slug + '.json'),
          ]),
          el('div', { class: 'wrap', style: 'gap:.35rem 1rem;margin-top:.4rem' }, rows),
        ]));
      }
    }

    async function save() {
      const databases = {};
      for (const b of boxes) {
        if (!b.el.checked) continue;
        (databases[b.db] ||= []).push(b.table);
      }
      try {
        await api.call('save', { databases });
        toast('Saved');
      } catch (e) { toast(e.message, true); }
    }

    document.body.append(dlg);
    dlg.showModal();
    refresh();
  }
}
