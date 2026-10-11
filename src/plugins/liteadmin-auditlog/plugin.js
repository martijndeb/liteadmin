import { toCsv, debounce, confirmDialog } from '../../js/util.js';

const PAGE = 100;

export function register(api) {
  const { el, clear, toast, download } = api;

  api.addStartCard({
    icon: 'policy',
    title: api.label,
    subtitle: 'Every write, who made it and from where',
    onOpen: () => logDialog(),
  });

  const fmtTime = ts => new Date(ts * 1000).toLocaleString();
  // Logged SQL and values are user-controlled; stop spreadsheets reading them as formulas.
  const cell = v => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);

  function logDialog() {
    const q = el('input', { type: 'search', placeholder: 'Search SQL, data, actor, action…', 'aria-label': 'Search' });
    const source = el('select', { 'aria-label': 'Source' }, [el('option', { value: '', text: 'All sources' })]);
    const db = el('select', { 'aria-label': 'Database' }, [el('option', { value: '', text: 'All databases' })]);
    const status = el('select', { 'aria-label': 'Status' }, [
      el('option', { value: '', text: 'Any status' }), el('option', { value: '1', text: 'Succeeded' }), el('option', { value: '0', text: 'Failed' }),
    ]);
    const summary = el('p', { class: 'small-text' });
    const body = el('div', { class: 'grid-wrap' });
    const more = el('button', { class: 'border small', onClick: () => load(true) }, [el('i', { text: 'expand_more' }), el('span', { text: 'Load more' })]);
    const days = el('input', { type: 'number', min: '1', value: '90', style: 'width:6rem', 'aria-label': 'Days to keep' });
    let entries = [];

    const dlg = el('dialog', { class: 'large fit', 'aria-label': api.label }, [
      el('h5', { text: api.label }),
      el('p', { class: 'small-text', text: 'Writes to server databases — SQL editor, REST, GraphQL — and admin actions, newest first. ' +
        'Each entry is chained to the previous one by hash; Verify detects edited or removed entries. ' +
        'Changes made to local (in-browser) databases never reach the server and are not logged.' }),
      el('nav', { class: 'wrap toolbar' }, [
        el('div', { class: 'field small prefix border max' }, [el('i', { text: 'search' }), q]),
        el('div', { class: 'field small border' }, [source]),
        el('div', { class: 'field small border' }, [db]),
        el('div', { class: 'field small border' }, [status]),
      ]),
      summary,
      body,
      el('nav', { class: 'wrap toolbar' }, [
        more,
        el('div', { class: 'max' }),
        el('button', { class: 'border small', onClick: verify }, [el('i', { text: 'verified' }), el('span', { text: 'Verify chain' })]),
        el('button', { class: 'border small', onClick: () => exportAs('csv') }, [el('i', { text: 'download' }), el('span', { text: 'CSV' })]),
        el('button', { class: 'border small', onClick: () => exportAs('json') }, [el('i', { text: 'download' }), el('span', { text: 'JSON' })]),
      ]),
      el('nav', { class: 'wrap toolbar' }, [
        el('span', { class: 'small-text', text: 'Delete entries older than' }), days, el('span', { class: 'small-text', text: 'days' }),
        el('button', { class: 'border small', onClick: prune }, [el('i', { text: 'auto_delete' }), el('span', { text: 'Prune' })]),
      ]),
      el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: 'Close', onClick: () => dlg.close() })]),
    ]);
    dlg.addEventListener('close', () => dlg.remove());

    function fill(select, values, label) {
      const cur = select.value;
      clear(select);
      select.append(el('option', { value: '', text: label }), ...values.map(v => el('option', { value: v, text: v })));
      select.value = values.includes(cur) ? cur : '';
    }

    function row(e) {
      const tr = el('tr', { class: e.ok ? '' : 'failed', tabindex: '0', title: 'Show details' }, [
        el('td', { text: fmtTime(e.ts) }),
        el('td', { text: e.actor || '—' }),
        el('td', { text: e.source || '' }),
        el('td', { text: e.action || '' }),
        el('td', { text: [e.db, e.target, e.row_id].filter(Boolean).join(' / ') || '—' }),
        el('td', { text: e.changes == null ? '' : String(e.changes) }),
        el('td', {}, [el('i', { text: e.ok ? 'check_circle' : 'error', title: e.ok ? 'Succeeded' : 'Failed', class: e.ok ? '' : 'error-text' })]),
      ]);
      const open = () => detailDialog(e);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', ev => { if (ev.key === 'Enter') open(); });
      return tr;
    }

    function render() {
      clear(body);
      if (!entries.length) { body.append(el('p', { class: 'small-text', text: 'No entries.' })); return; }
      body.append(el('table', { class: 'datagrid' }, [
        el('thead', {}, [el('tr', {}, ['Time', 'Actor', 'Source', 'Action', 'Target', 'Rows', ''].map(h => el('th', { scope: 'col', text: h })))]),
        el('tbody', {}, entries.map(row)),
      ]));
    }

    async function load(append = false) {
      const params = { q: q.value.trim(), source: source.value, db: db.value, ok: status.value, limit: PAGE };
      if (append && entries.length) params.before = entries[entries.length - 1].id;
      let res;
      try { res = await api.call('list', params); } catch (e) { return toast(e.message, true); }
      entries = append ? entries.concat(res.entries) : res.entries;
      fill(source, res.sources || [], 'All sources');
      fill(db, res.dbs || [], 'All databases');
      summary.textContent = `Showing ${entries.length} of ${res.total} entries`;
      more.disabled = res.entries.length < PAGE;
      render();
    }

    async function verify() {
      try {
        const r = await api.call('verify');
        toast(r.intact ? `Chain intact — ${r.checked} entries verified` : `Chain broken at entry #${r.broken_at}: ${r.reason}`, !r.intact);
      } catch (e) { toast(e.message, true); }
    }

    async function prune() {
      const n = parseInt(days.value, 10);
      if (!(n >= 1)) return toast('Keep at least 1 day', true);
      if (!(await confirmDialog(`Delete audit entries older than ${n} days? The prune itself is logged.`))) return;
      try { const r = await api.call('prune', { days: n }); toast(`${r.deleted} entries deleted`); load(); }
      catch (e) { toast(e.message, true); }
    }

    function exportAs(fmt) {
      if (!entries.length) return toast('Nothing to export', true);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      if (fmt === 'json') return download(`auditlog-${stamp}.json`, JSON.stringify(entries, null, 2), 'application/json');
      const cols = ['id', 'ts', 'actor', 'ip', 'source', 'action', 'db', 'target', 'row_id', 'sql', 'detail', 'changes', 'ok', 'error'];
      download(`auditlog-${stamp}.csv`, toCsv(['time', ...cols], entries.map(e => [new Date(e.ts * 1000).toISOString(), ...cols.map(c => cell(e[c]))])), 'text/csv');
    }

    [source, db, status].forEach(s => s.addEventListener('change', () => load()));
    q.addEventListener('input', debounce(() => load(), 250));
    document.body.append(dlg);
    dlg.showModal();
    load();
  }

  function detailDialog(e) {
    let detail = e.detail;
    if (detail) try { detail = JSON.stringify(JSON.parse(detail), null, 2); } catch (_) {}
    const kv = [
      ['Entry', '#' + e.id], ['Time', fmtTime(e.ts)], ['Actor', e.actor], ['IP address', e.ip], ['Source', e.source],
      ['Action', e.action], ['Database', e.db], ['Table', e.target], ['Row', e.row_id],
      ['Rows changed', e.changes], ['Status', e.ok ? 'Succeeded' : 'Failed'], ['Error', e.error],
    ].filter(([, v]) => v != null && v !== '');
    const dlg = el('dialog', { class: 'medium fit', 'aria-label': 'Audit entry' }, [
      el('h5', { text: 'Audit entry #' + e.id }),
      el('div', { class: 'kv' }, kv.flatMap(([k, v]) => [el('b', { text: k }), el('span', { text: String(v) })])),
      e.sql ? el('pre', { class: 'code-block scroll', text: e.sql }) : null,
      detail ? el('pre', { class: 'code-block scroll', text: detail }) : null,
      el('nav', { class: 'right-align' }, [el('button', { text: 'Close', onClick: () => dlg.close() })]),
    ]);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }
}
