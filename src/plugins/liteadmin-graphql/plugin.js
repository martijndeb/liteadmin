import { createEditor } from '../../js/editor.js';

export function register(api) {
  const { el, clear, toast, download } = api;

  api.addStartCard({
    icon: 'hub',
    title: api.label,
    subtitle: 'Query exposed tables with GraphQL',
    onOpen: () => consoleDialog(),
  });

  async function consoleDialog() {
    let dbs;
    try { dbs = (await api.call('databases')).databases; } catch (e) { return toast(e.message, true); }

    const sel = el('select', { 'aria-label': 'Database' }, dbs.map(d => el('option', { value: d.slug, text: d.label + (d.readonly ? ' (read-only)' : '') })));
    const endpoint = el('code', { class: 'small-text' });
    const queryHost = el('div', { class: 'editor-host', style: 'height:18rem' });
    const varsHost = el('div', { class: 'editor-host', style: 'height:6rem;min-height:6rem' });
    const resultHost = el('div', { class: 'editor-host', style: 'height:calc(24rem + 2.6rem)' });
    let qEd = null, vEd = null, rEd = null, sdl = '';

    const dlg = el('dialog', { class: 'large fit', 'aria-label': api.label }, [
      el('h5', { text: api.label }),
      el('p', { class: 'small-text', text: 'Tables exposed in the REST API panel are served at /graphql/<database>. Send an API key ' +
        '(X-Api-Key or Authorization: Bearer); any key may query, mutations need a read+write key. This console runs as you, the admin. ' +
        'Introspection is not supported — the schema is published as SDL instead.' }),
      dbs.length ? null : el('article', { class: 'border no-elevate' }, [el('div', { class: 'row' }, [el('i', { text: 'info' }),
        el('span', { text: 'No tables are exposed yet. Select some in the REST API panel first.' })])]),
      el('nav', { class: 'wrap toolbar' }, [
        el('div', { class: 'field label suffix border' }, [sel, el('label', { text: 'Database' })]),
        endpoint,
        el('div', { class: 'max' }),
        el('button', { class: 'border small', onClick: viewSchema }, [el('i', { text: 'schema' }), el('span', { text: 'Schema' })]),
        el('button', { class: 'border small', onClick: () => download(sel.value + '.schema.graphql', sdl, 'application/graphql') }, [el('i', { text: 'download' }), el('span', { text: 'SDL' })]),
        el('button', { class: 'small', onClick: run }, [el('i', { text: 'play_arrow' }), el('span', { text: 'Run' })]),
      ]),
      el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(22rem,1fr));gap:1rem' }, [
        el('div', {}, [el('h6', { class: 'small', text: 'Query' }), queryHost, el('h6', { class: 'small', text: 'Variables (JSON)' }), varsHost]),
        el('div', {}, [el('h6', { class: 'small', text: 'Response' }), resultHost]),
      ]),
      el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: 'Close', onClick: () => dlg.close() })]),
    ]);
    dlg.addEventListener('close', () => { [qEd, vEd, rEd].forEach(e => e && e.dispose()); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    if (!dbs.length) return;

    qEd = await createEditor(queryHost, '', 14, { language: 'graphql', minimap: false });
    vEd = await createEditor(varsHost, '{}', 14, { language: 'json', minimap: false, lineNumbers: 'off' });
    rEd = await createEditor(resultHost, '', 14, { language: 'json', readOnly: true });
    qEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

    async function loadSchema(fillExample) {
      endpoint.textContent = '/graphql/' + sel.value;
      try {
        const r = await api.call('schema', { db: sel.value });
        sdl = r.sdl;
        if (fillExample) qEd.setValue(r.example);
      } catch (e) { toast(e.message, true); }
    }

    async function run() {
      let variables;
      try { variables = JSON.parse(vEd.getValue() || '{}'); } catch (_) { return toast('Variables must be valid JSON', true); }
      rEd.setValue('…');
      try {
        const r = await api.call('execute', { db: sel.value, query: qEd.getValue(), variables });
        rEd.setValue(JSON.stringify(r.response, null, 2));
      } catch (e) { rEd.setValue(JSON.stringify({ errors: [{ message: e.message }] }, null, 2)); }
    }

    function viewSchema() {
      rEd.setValue(sdl);
      monaco.editor.setModelLanguage(rEd.getModel(), 'graphql');
      const back = rEd.onDidChangeModelContent(() => { back.dispose(); monaco.editor.setModelLanguage(rEd.getModel(), 'json'); });
    }

    sel.addEventListener('change', () => loadSchema(true));
    loadSchema(true);
  }
}
