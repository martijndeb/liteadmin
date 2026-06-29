import { el, clear, toast, qid, debounce, confirmDialog, fmtBytes, isJsonish, formatJson, download, toCsv, parseCsv, toSqlInserts, toJsonRows, sqlLiteral } from '../util.js';
import { barChart, lineChart } from '../chart.js';
import { erSvg, erMermaid } from '../erdiagram.js';
import { t } from '../i18n.js';
import { prefs, history } from '../store.js';
import { setSchema, createEditor, colorizeSql } from '../editor.js';
import { renderGrid } from '../grid.js';
import { MAINTENANCE } from '../connection.js';
import { Api } from '../api.js';
import { topBar } from './chrome.js';

const TYPES = ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'];

export async function renderWorkspace(root, ctx) {
  const conn = ctx.getConnection();
  const ws = { root, ctx, conn, tables: [], filter: '', table: null, tab: 'browse', columnsMap: {}, browse: null, sqlText: '' };
  clear(root);

  const filterInput = el('input', { type: 'search', placeholder: t('rail.search'), 'aria-label': t('rail.search') });
  filterInput.addEventListener('input', debounce(() => { ws.filter = filterInput.value.toLowerCase(); renderRail(ws); }, 150));

  ws.railList = el('div', { class: 'table-list' });
  const rail = el('nav', { class: 'rail', 'aria-label': t('rail.tables') }, [
    el('div', { class: 'rail-head' }, [el('div', { class: 'field small prefix round border' }, [el('i', { text: 'search' }), filterInput])]),
    ws.railList,
  ]);

  ws.body = el('div', { class: 'work-body', id: 'main', tabindex: '-1', role: 'tabpanel' });
  ws.tabsBar = el('div', { class: 'tabs-bar', role: 'tablist' });
  const work = el('main', { class: 'work' }, [ws.tabsBar, ws.body]);

  ws.shell = el('div', { class: 'app-shell' }, [rail, work]);
  const toggleRail = () => ws.shell.classList.toggle('show-rail');

  try { ws.info = await conn.dbInfo(); } catch (_) { ws.info = null; }

  ws.walChipEl = walChip(ws.info);
  const extra = [ws.walChipEl, el('span', { class: 'chip small', text: conn.meta.label })].filter(Boolean);
  if (conn.kind === 'local') extra.unshift(el('button', { class: 'circle transparent', 'aria-label': t('db.save'), onClick: () => saveLocal(ws) }, [el('i', { text: 'save' })]));

  root.append(topBar(ctx, { title: conn.meta.label, onMenu: toggleRail, extra }), ws.shell);

  buildTabs(ws);
  await refreshTables(ws);
  const first = ws.tables.find(x => !x.internal);
  ws.table = first ? first.name : null;
  renderRail(ws);
  selectTab(ws, ws.table ? 'browse' : 'sql');
}

function buildTabs(ws) {
  const defs = [
    ['browse', 'table_rows', t('tab.browse')],
    ['structure', 'schema', t('tab.structure')],
    ['sql', 'code', t('tab.sql')],
    ['create', 'add_box', t('tab.create')],
    ['database', 'database', t('tab.database')],
    ['history', 'history', t('tab.history')],
  ];
  ws.tabEls = {};
  for (const [id, icon, label] of defs) {
    const a = el('a', { role: 'tab', tabindex: '0', 'aria-selected': 'false' }, [el('i', { text: icon }), el('span', { text: label })]);
    a.addEventListener('click', () => selectTab(ws, id));
    a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(ws, id); } });
    ws.tabEls[id] = a;
    ws.tabsBar.append(a);
  }
}

function selectTab(ws, id) {
  ws.tab = id;
  if (ws.editor) { ws.editor.dispose(); ws.editor = null; }
  for (const [k, a] of Object.entries(ws.tabEls)) {
    const on = k === id;
    a.classList.toggle('active', on);
    a.setAttribute('aria-selected', String(on));
  }
  clear(ws.body);
  ({ browse: browseTab, structure: structureTab, sql: sqlTab, create: createTab, database: databaseTab, history: historyTab }[id])(ws);
}

async function refreshTables(ws) {
  try { ws.tables = await ws.conn.tables(); } catch (e) { toast(e.message, true); ws.tables = []; }
  setSchema(ws.tables.map(x => x.name), ws.columnsMap);
  renderRail(ws);
}

function renderRail(ws) {
  clear(ws.railList);
  const f = ws.filter;
  const visible = ws.tables.filter(x => !x.internal && (!f || x.name.toLowerCase().includes(f)));
  if (!visible.length) { ws.railList.append(el('p', { class: 'small-text center-align', text: '—' })); return; }
  const icons = { table: 'table_rows', view: 'visibility', virtual: 'category' };
  for (const x of visible) {
    const a = el('a', { class: 'wave' + (x.name === ws.table ? ' active' : ''), role: 'button', tabindex: '0', title: x.name + ' · ' + x.type }, [
      el('i', { text: icons[x.type] || 'table_rows' }),
      el('span', { class: 'max', text: x.name }),
    ]);
    const go = () => { ws.table = x.name; ws.browse = null; ws.fkFilter = null; renderRail(ws); selectTab(ws, 'browse'); ws.shell.classList.remove('show-rail'); };
    a.addEventListener('click', go);
    a.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    ws.railList.append(a);
  }
}

async function loadSchema(ws, table) {
  const schema = await ws.conn.schema(table);
  ws.columnsMap[table] = schema.columns.map(c => c.name);
  setSchema(ws.tables.map(x => x.name), ws.columnsMap);
  return schema;
}

async function ensureColumns(ws) {
  const todo = ws.tables.filter(x => !x.internal && !ws.columnsMap[x.name]);
  await Promise.all(todo.map(async x => {
    try { ws.columnsMap[x.name] = (await ws.conn.schema(x.name)).columns.map(c => c.name); } catch (_) {}
  }));
  setSchema(ws.tables.map(x => x.name), ws.columnsMap);
}

async function browseTab(ws) {
  if (!ws.table) { ws.body.append(hint(t('tab.browse'))); return; }
  const st = ws.browse || (ws.browse = { offset: 0, order: null, dir: 'asc' });
  ws.body.append(el('progress', { class: 'circle' }));
  try {
    const schema = await loadSchema(ws, ws.table);
    const pageSize = prefs.get('pageSize');
    const fk = (ws.fkFilter && ws.fkFilter.table === ws.table) ? ws.fkFilter : null;
    let data;
    if (fk) {
      const where = `WHERE ${qid(fk.col)} = ?`;
      const order = st.order ? ` ORDER BY ${qid(st.order)} ${st.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
      const total = (await ws.conn.query(`SELECT COUNT(*) FROM ${qid(ws.table)} ${where}`, { params: [fk.val], limit: 1 })).rows[0][0];
      const res = await ws.conn.query(`SELECT * FROM ${qid(ws.table)} ${where}${order} LIMIT ${pageSize} OFFSET ${st.offset}`, { params: [fk.val], limit: pageSize });
      data = { columns: res.columns, rows: res.rows, total, offset: st.offset, limit: pageSize };
    } else {
      data = await ws.conn.browse(ws.table, { limit: pageSize, offset: st.offset, order: st.order, dir: st.dir });
    }
    const pk = schema.columns.filter(c => c.pk > 0).map(c => c.name);
    const editable = pk.length > 0 && !ws.conn.readonly;
    const from = data.total ? st.offset + 1 : 0;
    const to = Math.min(st.offset + data.rows.length, data.total);

    const links = {};
    for (const f of schema.foreign_keys) if (f.from && f.table) links[f.from] = val => openFk(ws, f.table, f.to, val);

    const toolbar = el('nav', { class: 'wrap toolbar' }, [
      el('button', { class: 'small border', onClick: () => browseTab(ws) }, [el('i', { text: 'refresh' }), el('span', { text: t('browse.refresh') })]),
      el('button', { class: 'small border', onClick: () => searchDialog(ws, schema) }, [el('i', { text: 'search' }), el('span', { text: t('search.title') })]),
      el('button', { class: 'small border', onClick: () => exportDialog(ws, ws.table) }, [el('i', { text: 'file_download' }), el('span', { text: t('io.export') })]),
      editable ? el('button', { class: 'small border', onClick: () => importDialog(ws, ws.table) }, [el('i', { text: 'file_upload' }), el('span', { text: t('io.import') })]) : null,
      editable ? el('button', { class: 'small', onClick: () => rowDialog(ws, schema, null) }, [el('i', { text: 'add' }), el('span', { text: t('browse.insert') })]) : null,
      fk ? el('button', { class: 'chip small', onClick: () => { ws.fkFilter = null; st.offset = 0; browseTab(ws); } }, [el('i', { text: 'filter_alt' }), el('span', { text: `${fk.col} = ${fk.val}` }), el('i', { text: 'close' })]) : null,
      el('div', { class: 'max' }),
      el('span', { class: 'small-text', text: `${from}–${to} / ${data.total} ${t('browse.rows')}` }),
      el('button', { class: 'circle small transparent', 'aria-label': t('browse.prev'), disabled: st.offset <= 0, onClick: () => { st.offset = Math.max(0, st.offset - pageSize); browseTab(ws); } }, [el('i', { text: 'chevron_left' })]),
      el('button', { class: 'circle small transparent', 'aria-label': t('browse.next'), disabled: to >= data.total, onClick: () => { st.offset += pageSize; browseTab(ws); } }, [el('i', { text: 'chevron_right' })]),
    ]);

    const onSort = col => { st.order = col; st.dir = (st.order === col && st.dir === 'asc') ? 'desc' : 'asc'; st.offset = 0; browseTab(ws); };
    const rowActions = editable ? (row) => el('nav', { class: 'no-space' }, [
      el('button', { class: 'circle small transparent', 'aria-label': 'Edit', onClick: () => rowDialog(ws, schema, row) }, [el('i', { text: 'edit' })]),
      el('button', { class: 'circle small transparent', 'aria-label': 'Delete', onClick: () => deleteRow(ws, schema, pk, row) }, [el('i', { text: 'delete' })]),
    ]) : null;

    clear(ws.body);
    ws.body.append(toolbar, data.rows.length
      ? renderGrid({ columns: data.columns, rows: data.rows, sort: { col: st.order, dir: st.dir }, onSort, rowActions, links })
      : el('p', { class: 'small-text', text: t('browse.empty') }));
  } catch (e) { clear(ws.body); ws.body.append(errorBox(e)); }
}

function openFk(ws, refTable, refCol, val) {
  if (!ws.tables.find(x => x.name === refTable)) return toast(t('compare.none'), true);
  ws.table = refTable;
  ws.browse = { offset: 0, order: null, dir: 'asc' };
  ws.fkFilter = { table: refTable, col: refCol, val };
  renderRail(ws);
  selectTab(ws, 'browse');
}

function rowDialog(ws, schema, row) {
  const cols = schema.columns;
  const inputs = cols.map((c, i) => {
    const val = row ? row[i] : null;
    const json = /json/i.test(c.type || '') || (val != null && isJsonish(val));
    const input = json
      ? el('textarea', { rows: '4', class: 'mono', value: val == null ? '' : String(val), placeholder: val === null ? 'NULL' : '' })
      : el('input', { type: 'text', value: val == null ? '' : String(val), placeholder: val === null ? 'NULL' : '' });
    return { c, input, json };
  });
  const dlg = el('dialog', { class: 'right', 'aria-label': row ? 'Edit row' : 'Insert row' }, [
    el('h5', { text: row ? 'Edit row' : 'Insert row' }),
    el('p', { class: 'small-text', text: 'Empty field = NULL' }),
    ...inputs.map(({ c, input, json }) => el('div', { class: 'field label border' + (json ? ' textarea' : '') }, [
      input,
      el('label', { text: `${c.name} (${c.type || 'any'})` }),
      json ? el('button', { class: 'chip tiny', type: 'button', onClick: () => { if (input.value.trim()) input.value = formatJson(input.value); } }, [el('span', { text: t('json.format') })]) : null,
    ].filter(Boolean))),
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'border', text: t('common.cancel'), onClick: () => dlg.remove() }),
      el('button', { text: t('common.save'), onClick: () => saveRow() }),
    ]),
  ]);
  async function saveRow() {
    for (const { c, input, json } of inputs) {
      if (json && input.value.trim() !== '') {
        try { JSON.parse(input.value); } catch (_) { return toast(t('json.invalid', { col: c.name }), true); }
      }
    }
    try {
      const tbl = qid(ws.table);
      if (row) {
        const pkCols = schema.columns.filter(c => c.pk > 0);
        const sets = inputs.map(({ c }) => `${qid(c.name)}=?`).join(',');
        const where = pkCols.map(c => `${qid(c.name)}=?`).join(' AND ');
        const params = inputs.map(({ input }) => input.value === '' ? null : input.value)
          .concat(pkCols.map(c => row[schema.columns.indexOf(c)]));
        await ws.conn.exec(`UPDATE ${tbl} SET ${sets} WHERE ${where}`, params);
      } else {
        const names = inputs.map(({ c }) => qid(c.name)).join(',');
        const ph = inputs.map(() => '?').join(',');
        const params = inputs.map(({ input }) => input.value === '' ? null : input.value);
        await ws.conn.exec(`INSERT INTO ${tbl} (${names}) VALUES (${ph})`, params);
      }
      dlg.remove(); browseTab(ws);
    } catch (e) { toast(e.message, true); }
  }
  document.body.append(dlg); dlg.showModal();
}

async function deleteRow(ws, schema, pk, row) {
  if (prefs.get('confirmDestructive') && !(await confirmDialog(t('common.confirm')))) return;
  try {
    const where = pk.map(n => `${qid(n)}=?`).join(' AND ');
    const params = pk.map(n => row[schema.columns.findIndex(c => c.name === n)]);
    await ws.conn.exec(`DELETE FROM ${qid(ws.table)} WHERE ${where}`, params);
    browseTab(ws);
  } catch (e) { toast(e.message, true); }
}

const SEARCH_OPS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IS NULL', 'IS NOT NULL'];

function searchDialog(ws, schema) {
  const cols = schema.columns.map(c => c.name);
  const condHost = el('div', { class: 'cond-list' });
  const conds = [];
  const matchSel = el('select', {}, [
    el('option', { value: 'AND', text: t('search.all') }),
    el('option', { value: 'OR', text: t('search.any') }),
  ]);
  const sqlPre = el('pre', { class: 'code-block sql-hl' });
  const out = el('div', {});

  function build() {
    const params = [];
    const parts = conds.map(c => {
      const id = qid(c.col.value), op = c.op.value;
      if (op === 'IS NULL' || op === 'IS NOT NULL') return `${id} ${op}`;
      params.push(c.val.value);
      return `${id} ${op} ?`;
    });
    const where = parts.length ? ' WHERE ' + parts.join(` ${matchSel.value} `) : '';
    return { sql: `SELECT * FROM ${qid(ws.table)}${where}`, params };
  }
  function update() { setSqlBlock(sqlPre, build().sql); }

  function addCond() {
    const col = el('select', {}, cols.map(c => el('option', { value: c, text: c })));
    const op = el('select', {}, SEARCH_OPS.map(o => el('option', { value: o, text: o })));
    const val = el('input', { type: 'text', placeholder: t('search.value'), 'aria-label': t('search.value') });
    const valWrap = el('div', { class: 'field border small max' }, [val]);
    const node = el('div', { class: 'cond-row' }, [
      el('div', { class: 'field border small' }, [col]),
      el('div', { class: 'field border small' }, [op]),
      valWrap,
      el('button', { class: 'circle small transparent', 'aria-label': t('common.cancel'), onClick: () => { const i = conds.indexOf(entry); if (i >= 0) conds.splice(i, 1); node.remove(); update(); } }, [el('i', { text: 'close' })]),
    ]);
    const entry = { col, op, val };
    conds.push(entry);
    const sync = () => { const nul = op.value === 'IS NULL' || op.value === 'IS NOT NULL'; valWrap.style.visibility = nul ? 'hidden' : ''; update(); };
    op.addEventListener('change', sync);
    [col, val].forEach(x => x.addEventListener('input', update));
    condHost.append(node);
    sync();
  }

  async function run() {
    const { sql, params } = build();
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      const res = await ws.conn.query(sql, { params, limit: prefs.get('pageSize') });
      clear(out);
      out.append(
        el('p', { class: 'small-text', text: `${res.rows.length} ${t('browse.rows')} · ${res.elapsed} ${t('sql.elapsed')}` + (res.truncated ? ' · ' + t('sql.truncated', { n: res.limit }) : '') }),
        res.rows.length ? renderGrid({ columns: res.columns, rows: res.rows }) : muted(t('browse.empty')),
      );
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }

  matchSel.addEventListener('change', update);
  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('search.title') }, [
    el('h5', { text: t('search.title') + ' — ' + ws.table }),
    condHost,
    el('nav', { class: 'wrap' }, [
      el('button', { class: 'small border', onClick: addCond }, [el('i', { text: 'add' }), el('span', { text: t('search.addCondition') })]),
      el('div', { class: 'field label suffix border small' }, [matchSel, el('label', { text: t('search.match') })]),
    ]),
    el('div', { class: 'v-space' }),
    sqlPre,
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'border', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(build().sql); toast(t('advice.copied')); } }, [el('i', { text: 'content_copy' }), el('span', { text: t('advice.copy') })]),
      el('button', { onClick: run }, [el('i', { text: 'search' }), el('span', { text: t('search.run') })]),
    ]),
    out,
  ]);
  document.body.append(dlg); dlg.showModal();
  addCond();
  update();
}

async function structureTab(ws) {
  if (!ws.table) { ws.body.append(hint(t('tab.structure'))); return; }
  ws.body.append(el('progress', { class: 'circle' }));
  try {
    const s = await loadSchema(ws, ws.table);
    const editable = !ws.conn.readonly;
    const tableType = (ws.tables.find(x => x.name === ws.table) || {}).type || 'table';
    const isTable = tableType === 'table';
    const dropLabel = tableType === 'view' ? t('structure.dropView') : tableType === 'virtual' ? t('structure.dropVirtual') : t('structure.dropTable');
    let rowCount = null;
    try { rowCount = (await ws.conn.query(`SELECT COUNT(*) FROM ${qid(ws.table)}`, { limit: 1 })).rows[0][0]; } catch (_) {}
    let sizeBytes = null;
    try { sizeBytes = (await ws.conn.query('SELECT SUM(pgsize) FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name = ?)', { params: [ws.table], limit: 1 })).rows[0][0]; } catch (_) {}
    const metricChip = (icon, label) => el('span', { class: 'chip small' }, [el('i', { text: icon }), el('span', { text: label })]);
    const ftsVer = ftsVersionOf(s.sql);
    const genExprs = parseGeneratedExprs(s.sql);
    const hasGen = s.columns.some(c => c.generated);
    const colRows = s.columns.map(c => [c.name, c.type || '', c.notnull ? '✓' : '', c.default == null ? '' : String(c.default), c.pk ? '✓' : '', c.generated ? `${c.generated}: ${genExprs[c.name.toLowerCase()] || ''}` : '']);
    const idxRows = s.indexes.map(i => [i.name, i.columns.join(', '), i.unique ? '✓' : '', i.origin]);
    const fkRows = s.foreign_keys.map(f => [f.from, `${f.table}(${f.to})`, f.on_update, f.on_delete]);

    const colActions = editable && isTable ? row => el('nav', { class: 'no-space' }, [
      el('button', { class: 'circle small transparent', 'aria-label': t('structure.editColumn'), onClick: () => editColumnDialog(ws, row[0], row[1], !!row[5]) }, [el('i', { text: 'edit' })]),
      el('button', { class: 'circle small transparent', 'aria-label': t('structure.dropColumn'), onClick: () => dropColumn(ws, row[0]) }, [el('i', { text: 'delete' })]),
    ]) : null;
    const idxActions = editable ? row => row[3] === 'c'
      ? el('button', { class: 'circle small transparent', 'aria-label': t('structure.dropIndex'), onClick: () => dropIndex(ws, row[0]) }, [el('i', { text: 'delete' })])
      : el('span', { class: 'small-text', text: '—' }) : null;

    clear(ws.body);
    ws.body.append(...[
      el('nav', { class: 'wrap toolbar' }, [
        editable && isTable ? el('button', { class: 'small border', onClick: () => renameTable(ws) }, [el('i', { text: 'drive_file_rename_outline' }), el('span', { text: t('structure.renameTable') })]) : null,
        editable && isTable ? el('button', { class: 'small border', onClick: () => addColumnDialog(ws) }, [el('i', { text: 'add' }), el('span', { text: t('structure.addColumn') })]) : null,
        editable && isTable ? el('button', { class: 'small border', onClick: () => addIndexDialog(ws) }, [el('i', { text: 'add' }), el('span', { text: t('structure.addIndex') })]) : null,
        editable && isTable ? el('button', { class: 'small border', onClick: () => copyTableDialog(ws) }, [el('i', { text: 'content_copy' }), el('span', { text: t('structure.copyTable') })]) : null,
        el('button', { class: 'small border', onClick: () => compareTableDialog(ws) }, [el('i', { text: 'difference' }), el('span', { text: t('compare.table') })]),
        el('button', { class: 'small border', onClick: () => profilerDialog(ws, ws.table) }, [el('i', { text: 'analytics' }), el('span', { text: t('profile.title') })]),
        editable && isTable ? el('button', { class: 'small border', onClick: () => analyzeTable(ws) }, [el('i', { text: 'query_stats' }), el('span', { text: t('structure.analyzeTable') })]) : null,
        editable && isTable ? el('button', { class: 'small border', onClick: () => reindexTable(ws) }, [el('i', { text: 'autorenew' }), el('span', { text: t('structure.reindexTable') })]) : null,
        isTable && s.foreign_keys.length ? el('button', { class: 'small border', onClick: () => fkCheckTable(ws) }, [el('i', { text: 'fact_check' }), el('span', { text: t('structure.fkCheck') })]) : null,
        editable && isTable && !s.strict ? el('button', { class: 'small border', onClick: () => convertToStrict(ws) }, [el('i', { text: 'shield' }), el('span', { text: t('strict.convert') })]) : null,
        ftsVer ? el('button', { class: 'small', onClick: () => ftsSearchDialog(ws, ftsVer) }, [el('i', { text: 'search' }), el('span', { text: t('fts.search') })]) : null,
        editable && ftsVer ? el('button', { class: 'small border', onClick: () => ftsCommand(ws, 'rebuild', 'fts.rebuilt') }, [el('i', { text: 'sync' }), el('span', { text: t('fts.rebuild') })]) : null,
        editable && ftsVer === '5' ? el('button', { class: 'small border', onClick: () => ftsCommand(ws, 'optimize', 'fts.optimized') }, [el('i', { text: 'compress' }), el('span', { text: t('fts.optimize') })]) : null,
        editable && ftsVer === '5' ? el('button', { class: 'small border', onClick: () => ftsCommand(ws, 'integrity-check', 'fts.ok') }, [el('i', { text: 'verified' }), el('span', { text: t('fts.integrity') })]) : null,
        ftsVer ? el('button', { class: 'small border', type: 'button', onClick: () => ftsHelpDialog() }, [el('i', { text: 'help' }), el('span', { text: t('fts.help') })]) : null,
      ].filter(Boolean)),
      el('nav', { class: 'wrap metrics-row' }, [
        metricChip('table_rows', `${rowCount == null ? '—' : rowCount} ${t('profile.rows')}`),
        metricChip('view_column', `${s.columns.length} ${t('structure.columns').toLowerCase()}`),
        metricChip('key', `${s.indexes.length} ${t('structure.indexes').toLowerCase()}`),
        metricChip('link', `${s.foreign_keys.length} ${t('structure.foreignKeys').toLowerCase()}`),
        sizeBytes != null ? metricChip('storage', `≈ ${fmtBytes(sizeBytes)}`) : null,
        s.strict ? metricChip('shield', 'STRICT') : null,
        s.without_rowid ? metricChip('table_chart', 'WITHOUT ROWID') : null,
        ftsVer ? metricChip('search', 'FTS' + ftsVer) : null,
      ].filter(Boolean)),
      section(t('structure.columns'), renderGrid({ columns: [t('structure.name'), t('structure.type'), t('structure.notnull'), t('structure.default'), t('structure.pk'), ...(hasGen ? [t('gen.generated')] : [])], rows: hasGen ? colRows : colRows.map(r => r.slice(0, 5)), rowActions: colActions })),
      section(t('structure.indexes'), idxRows.length ? renderGrid({ columns: [t('structure.name'), 'columns', t('structure.unique'), 'origin'], rows: idxRows, rowActions: idxActions }) : muted(t('structure.none'))),
      section(t('structure.foreignKeys'), fkRows.length ? renderGrid({ columns: ['from', 'references', 'on update', 'on delete'], rows: fkRows }) : muted(t('structure.none'))),
      section(t('structure.definition'), sqlBlock(s.sql || '', 'scroll')),
      editable ? el('nav', { class: 'wrap' }, [
        isTable ? el('button', { class: 'small border error', onClick: () => truncateTable(ws) }, [el('i', { text: 'cleaning_services' }), el('span', { text: t('structure.truncate') })]) : null,
        el('button', { class: 'small error', onClick: () => dropTable(ws) }, [el('i', { text: 'delete' }), el('span', { text: dropLabel })]),
      ].filter(Boolean)) : null,
    ].filter(Boolean));
  } catch (e) { clear(ws.body); ws.body.append(errorBox(e)); }
}

function reloadStructure(ws) { renderRail(ws); selectTab(ws, 'structure'); }

async function truncateTable(ws) {
  if (prefs.get('confirmDestructive') && !(await confirmDialog(t('structure.confirmTruncate', { name: ws.table })))) return;
  try {
    const hasSeq = (await ws.conn.query("SELECT count(*) FROM sqlite_master WHERE name='sqlite_sequence'", { limit: 1 })).rows[0][0];
    const stmts = [`DELETE FROM ${qid(ws.table)}`];
    if (hasSeq) stmts.push(`DELETE FROM sqlite_sequence WHERE name=${sqlLiteral(ws.table)}`);
    await ws.conn.transaction(stmts.join(';\n') + ';');
    toast(t('structure.truncated'));
    ws.browse = null; reloadStructure(ws);
  } catch (e) { toast(e.message, true); }
}

async function analyzeTable(ws) {
  try { const r = await ws.conn.exec(`ANALYZE ${qid(ws.table)}`); toast(`${t('structure.analyzed')} · ${r.elapsed ?? 0} ${t('sql.elapsed')}`); reloadStructure(ws); } catch (e) { toast(e.message, true); }
}

async function reindexTable(ws) {
  try { const r = await ws.conn.exec(`REINDEX ${qid(ws.table)}`); toast(`${t('structure.reindexed')} · ${r.elapsed ?? 0} ${t('sql.elapsed')}`); } catch (e) { toast(e.message, true); }
}

async function fkCheckTable(ws) {
  const loading = loadingDialog(t('common.loading'));
  try {
    const r = await ws.conn.query(`PRAGMA foreign_key_check(${qid(ws.table)})`, { limit: 2000 });
    loading.remove();
    const ok = !r.rows || !r.rows.length;
    const dlg = el('dialog', { class: (ok ? 'small' : 'large') + ' fit', 'aria-label': t('structure.fkCheck') }, [
      el('h5', { text: t('structure.fkCheck') + ' — ' + ws.table }),
      ok
        ? el('p', { class: 'row' }, [el('i', { class: 'fk-ok', text: 'check_circle' }), el('span', { text: t('structure.fkOk') })])
        : el('p', { class: 'small-text error-text', text: t('structure.fkViolations', { n: r.rows.length }) }),
      ok ? null : renderGrid({ columns: r.columns, rows: r.rows }),
      el('nav', { class: 'right-align' }, [el('button', { class: 'border', type: 'button', text: t('prefs.close'), onClick: () => dlg.remove() })]),
    ].filter(Boolean));
    document.body.append(dlg); dlg.showModal();
  } catch (e) { loading.remove(); toast(e.message, true); }
}

async function dropTable(ws) {
  const type = (ws.tables.find(x => x.name === ws.table) || {}).type || 'table';
  if (prefs.get('confirmDestructive') && !(await confirmDialog(t('structure.confirmDrop', { name: ws.table })))) return;
  try {
    await ws.conn.exec(`DROP ${type === 'view' ? 'VIEW' : 'TABLE'} ${qid(ws.table)}`);
    ws.table = null; await refreshTables(ws); selectTab(ws, 'sql');
  } catch (e) { toast(e.message, true); }
}

async function renameTable(ws) {
  const name = await inputDialog(t('structure.renameTable'), t('common.name'), ws.table);
  if (!name || name === ws.table) return;
  try {
    await ws.conn.exec(`ALTER TABLE ${qid(ws.table)} RENAME TO ${qid(name)}`);
    ws.table = name; ws.browse = null; await refreshTables(ws); reloadStructure(ws);
  } catch (e) { toast(e.message, true); }
}

function editColumnDialog(ws, col, curType, isGenerated) {
  const nameInput = el('input', { type: 'text', value: col });
  const opts = [...TYPES, 'ANY'];
  if (curType && !opts.some(x => x.toUpperCase() === curType.toUpperCase())) opts.unshift(curType);
  const typeSel = el('select', {}, opts.map(x => el('option', { value: x, text: x, selected: x.toUpperCase() === (curType || '').toUpperCase() })));
  openDialog(t('structure.editColumn'), [
    el('div', { class: 'field label border' }, [nameInput, el('label', { text: t('common.name') })]),
    isGenerated ? null : el('div', { class: 'field label suffix border' }, [typeSel, el('label', { text: t('create.colType') })]),
    el('p', { class: 'small-text', text: isGenerated ? t('structure.genNoType') : t('structure.retypeNote') }),
  ].filter(Boolean), async () => {
    const newName = nameInput.value.trim();
    if (!newName) { toast(t('create.needName'), true); return false; }
    const newType = typeSel.value;
    const nameChanged = newName !== col;
    const typeChanged = !isGenerated && newType.toUpperCase() !== (curType || '').toUpperCase();
    if (!nameChanged && !typeChanged) return;
    try {
      if (typeChanged) {
        const schema = await ws.conn.schema(ws.table);
        const stmts = rebuildStatements(ws.table, schema, { colMap: { [col.toLowerCase()]: { type: newType } } });
        await ws.conn.transaction(stmts.join(';\n') + ';', { fkOff: true });
      }
      if (nameChanged) {
        await ws.conn.exec(`ALTER TABLE ${qid(ws.table)} RENAME COLUMN ${qid(col)} TO ${qid(newName)}`);
      }
      ws.browse = null; await refreshTables(ws); reloadStructure(ws);
    } catch (e) { toast(e.message, true); return false; }
  });
}

async function renameColumn(ws, col) {
  const name = await inputDialog(t('structure.renameColumn'), t('common.name'), col);
  if (!name || name === col) return;
  try {
    await ws.conn.exec(`ALTER TABLE ${qid(ws.table)} RENAME COLUMN ${qid(col)} TO ${qid(name)}`);
    ws.browse = null; await refreshTables(ws); reloadStructure(ws);
  } catch (e) { toast(e.message, true); }
}

async function dropColumn(ws, col) {
  if (prefs.get('confirmDestructive') && !(await confirmDialog(t('structure.confirmDropColumn', { name: col })))) return;
  try {
    await ws.conn.exec(`ALTER TABLE ${qid(ws.table)} DROP COLUMN ${qid(col)}`);
    ws.browse = null; await refreshTables(ws); reloadStructure(ws);
  } catch (e) { toast(e.message, true); }
}

function addColumnDialog(ws) {
  const name = el('input', { type: 'text', 'aria-label': t('create.colName') });
  const type = el('select', { 'aria-label': t('create.colType') }, [...TYPES, 'ANY'].map(x => el('option', { value: x, text: x })));
  const nn = el('input', { type: 'checkbox' });
  const def = el('input', { type: 'text', 'aria-label': t('structure.default') });
  const gen = el('input', { type: 'checkbox' });
  const expr = el('input', { type: 'text', placeholder: 'a + b', 'aria-label': t('gen.expression') });
  const kind = el('select', {}, [el('option', { value: 'VIRTUAL', text: t('gen.virtual') }), el('option', { value: 'STORED', text: t('gen.stored') })]);
  const genBox = el('div', { class: 'gen-detail' }, [
    el('div', { class: 'field label border max' }, [expr, el('label', { text: t('gen.expression') })]),
    el('div', { class: 'field label suffix border' }, [kind, el('label', { text: t('gen.generated') })]),
  ]);
  const sync = () => { genBox.style.display = gen.checked ? '' : 'none'; nn.disabled = def.disabled = gen.checked; };
  gen.addEventListener('change', sync); sync();
  openDialog(t('structure.addColumn'), [
    el('div', { class: 'field label border' }, [name, el('label', { text: t('create.colName') })]),
    el('div', { class: 'field label suffix border' }, [type, el('label', { text: t('create.colType') })]),
    el('label', { class: 'checkbox' }, [nn, el('span', { text: t('structure.notnull') })]),
    el('div', { class: 'field label border' }, [def, el('label', { text: t('structure.default') })]),
    el('div', { class: 'v-space' }),
    el('label', { class: 'checkbox' }, [gen, el('span', { text: t('gen.generated') })]),
    genBox,
  ], async () => {
    const n = name.value.trim();
    if (!n) { toast(t('create.needName'), true); return false; }
    let sql;
    if (gen.checked) {
      const e = expr.value.trim();
      if (!e) { toast(t('gen.expression'), true); return false; }
      sql = `ALTER TABLE ${qid(ws.table)} ADD COLUMN ${qid(n)} ${type.value} GENERATED ALWAYS AS (${e}) ${kind.value}`;
    } else {
      sql = `ALTER TABLE ${qid(ws.table)} ADD COLUMN ${qid(n)} ${type.value}`;
      if (nn.checked) sql += ' NOT NULL';
      if (def.value.trim() !== '') sql += ' DEFAULT ' + def.value.trim();
    }
    try { await ws.conn.exec(sql); ws.browse = null; await refreshTables(ws); reloadStructure(ws); }
    catch (e) { toast(e.message, true); return false; }
  });
}

async function addIndexDialog(ws) {
  let schema;
  try { schema = await ws.conn.schema(ws.table); } catch (e) { return toast(e.message, true); }
  const checks = schema.columns.map(c => ({ c: c.name, cb: el('input', { type: 'checkbox', value: c.name }) }));
  const unique = el('input', { type: 'checkbox' });
  const nameInput = el('input', { type: 'text', 'aria-label': t('structure.indexName') });
  const suggest = () => {
    const sel = checks.filter(x => x.cb.checked).map(x => x.c);
    nameInput.value = sel.length ? `idx_${ws.table}_${sel.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_') : '';
  };
  checks.forEach(x => x.cb.addEventListener('change', suggest));
  openDialog(t('structure.addIndex'), [
    el('p', { class: 'small-text', text: t('structure.indexColumns') }),
    el('nav', { class: 'wrap' }, checks.map(x => el('label', { class: 'checkbox' }, [x.cb, el('span', { text: x.c })]))),
    el('label', { class: 'checkbox' }, [unique, el('span', { text: t('structure.unique') })]),
    el('div', { class: 'v-space' }),
    el('div', { class: 'field label border' }, [nameInput, el('label', { text: t('structure.indexName') })]),
  ], async () => {
    const sel = checks.filter(x => x.cb.checked).map(x => x.c);
    const nm = nameInput.value.trim();
    if (!sel.length || !nm) { toast(t('structure.indexNeed'), true); return false; }
    const sql = `CREATE ${unique.checked ? 'UNIQUE ' : ''}INDEX ${qid(nm)} ON ${qid(ws.table)} (${sel.map(qid).join(', ')})`;
    try { await ws.conn.exec(sql); await refreshTables(ws); reloadStructure(ws); }
    catch (e) { toast(e.message, true); return false; }
  });
}

async function dropIndex(ws, name) {
  if (prefs.get('confirmDestructive') && !(await confirmDialog(t('structure.confirmDropIndex', { name })))) return;
  try { await ws.conn.exec(`DROP INDEX ${qid(name)}`); await refreshTables(ws); reloadStructure(ws); }
  catch (e) { toast(e.message, true); }
}

async function copyTableDialog(ws) {
  const src = ws.table;
  let schema;
  try { schema = await ws.conn.schema(src); } catch (e) { return toast(e.message, true); }
  const nameInput = el('input', { type: 'text', value: src + '_copy' });
  const withData = el('input', { type: 'checkbox', checked: true });
  openDialog(t('structure.copyTable') + ' — ' + src, [
    el('div', { class: 'field label border' }, [nameInput, el('label', { text: t('copy.newName') })]),
    el('label', { class: 'checkbox' }, [withData, el('span', { text: t('copy.withData') })]),
    el('p', { class: 'small-text', text: t('copy.constraintsNote') }),
  ], async () => {
    const dst = nameInput.value.trim();
    if (!dst || dst === src) { toast(t('create.needName'), true); return false; }
    try {
      const pkCols = schema.columns.filter(c => c.pk).map(c => c.name);
      const defs = schema.columns.map(c => {
        let s = qid(c.name) + ' ' + (c.type || '');
        if (pkCols.length === 1 && c.pk) s += ' PRIMARY KEY';
        if (c.notnull) s += ' NOT NULL';
        if (c.default != null) s += ' DEFAULT ' + c.default;
        return s.trim();
      });
      if (pkCols.length > 1) defs.push(`PRIMARY KEY (${pkCols.map(qid).join(', ')})`);
      const stmts = [`CREATE TABLE ${qid(dst)} (\n  ${defs.join(',\n  ')}\n)`];
      if (withData.checked) stmts.push(`INSERT INTO ${qid(dst)} SELECT * FROM ${qid(src)}`);
      for (const ix of schema.indexes.filter(i => i.origin === 'c')) {
        const nm = `${ix.name}_copy`.replace(/[^A-Za-z0-9_]/g, '_');
        stmts.push(indexCreate(dst, { ...ix, name: nm }).replace(/;$/, ''));
      }
      await ws.conn.transaction(`${stmts.join(';\n')};`);
      toast(t('copy.done'));
      await refreshTables(ws);
      ws.table = dst; ws.browse = null; renderRail(ws); selectTab(ws, 'structure');
    } catch (e) { toast(e.message, true); return false; }
  });
}

function columnDef(c) {
  let s = qid(c.name) + ' ' + (c.type || '');
  if (c.notnull) s += ' NOT NULL';
  if (c.default != null) s += ' DEFAULT ' + c.default;
  return s.trim();
}
function indexCreate(table, ix) {
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${qid(ix.name)} ON ${qid(table)} (${ix.columns.map(qid).join(', ')});`;
}
function serverReader(dbKey) {
  return {
    async tables() { return (await Api.proxy('tables', { db: dbKey })).tables; },
    async schema(table) { return Api.proxy('schema', { db: dbKey, table }); },
    async query(sql, o) { return Api.proxy('query', { db: dbKey, sql, ...(o || {}) }); },
  };
}
async function countOn(reader, table) {
  try {
    const res = await reader.query(`SELECT COUNT(*) FROM ${qid(table)}`, { limit: 1 });
    return res.rows && res.rows.length ? res.rows[0][0] : null;
  } catch (_) { return null; }
}
function fmtN(n) { return n == null ? '—' : String(n); }

async function diffDatabases(src, target) {
  const [srcTables, tgtTables] = await Promise.all([src.tables(), target.tables()]);
  const srcReal = srcTables.filter(x => !x.internal);
  const tgtReal = tgtTables.filter(x => !x.internal);
  const tgtNames = new Set(tgtReal.map(x => x.name.toLowerCase()));
  const srcNames = new Set(srcReal.map(x => x.name.toLowerCase()));
  const onlyInSrc = srcReal.filter(x => !tgtNames.has(x.name.toLowerCase()));
  const onlyInTgt = tgtReal.filter(x => !srcNames.has(x.name.toLowerCase()));
  const shared = srcReal.filter(x => tgtNames.has(x.name.toLowerCase()));

  const sql = [], colReports = [], rowCounts = [];
  for (const tdef of onlyInSrc) {
    const s = await src.schema(tdef.name);
    if (s.sql) sql.push(s.sql.trim().replace(/;?\s*$/, ';'));
    for (const ix of s.indexes.filter(i => i.origin === 'c')) sql.push(indexCreate(tdef.name, ix));
  }
  for (const tdef of shared) {
    const [sa, sb] = await Promise.all([src.schema(tdef.name), target.schema(tdef.name)]);
    const bcols = new Map(sb.columns.map(c => [c.name.toLowerCase(), c]));
    const missingCols = sa.columns.filter(c => !bcols.has(c.name.toLowerCase()));
    for (const c of missingCols) sql.push(`ALTER TABLE ${qid(tdef.name)} ADD COLUMN ${columnDef(c)};`);
    const typeDiffs = sa.columns.filter(c => bcols.has(c.name.toLowerCase()) && (bcols.get(c.name.toLowerCase()).type || '') !== (c.type || ''));
    for (const c of typeDiffs) sql.push(`-- ${tdef.name}.${c.name}: ${bcols.get(c.name.toLowerCase()).type || '?'} -> ${c.type || '?'} (change manually)`);
    const bidx = new Set(sb.indexes.map(i => i.name.toLowerCase()));
    const missingIdx = sa.indexes.filter(i => i.origin === 'c' && !bidx.has(i.name.toLowerCase()));
    for (const ix of missingIdx) sql.push(indexCreate(tdef.name, ix));
    if (missingCols.length || missingIdx.length || typeDiffs.length) colReports.push({ table: tdef.name, missingCols: missingCols.map(c => c.name), missingIdx: missingIdx.map(i => i.name), typeDiffs: typeDiffs.map(c => c.name) });
    const [ca, cb] = await Promise.all([countOn(src, tdef.name), countOn(target, tdef.name)]);
    rowCounts.push({ table: tdef.name, a: ca, b: cb });
  }
  return { onlyInSrc, onlyInTgt, colReports, rowCounts, migration: sql.join('\n') };
}

function dbDiffView(r, applyFn) {
  const wrap = el('div', {});
  const noDiff = !r.onlyInSrc.length && !r.colReports.length;
  if (r.onlyInSrc.length) wrap.append(section(t('compare.missingTable'), el('div', { class: 'wrap' }, r.onlyInSrc.map(x => el('span', { class: 'chip', text: x.name })))));
  if (r.onlyInTgt.length) wrap.append(section(t('compare.onlyInTarget'), el('div', { class: 'wrap' }, r.onlyInTgt.map(x => el('span', { class: 'chip', text: x.name })))));
  if (r.colReports.length) wrap.append(section(t('compare.colDiffs'), el('div', { class: 'task-list' }, r.colReports.map(c => el('div', { class: 'task-row' }, [
    el('i', { class: 'task-status', text: 'edit' }),
    el('div', { class: 'task-text' }, [
      el('b', { text: c.table }),
      el('span', { class: 'small-text', text: [
        c.missingCols.length ? t('compare.missingColumn') + ': ' + c.missingCols.join(', ') : '',
        c.missingIdx.length ? t('compare.missingIndex') + ': ' + c.missingIdx.join(', ') : '',
        c.typeDiffs.length ? t('compare.typeDiff') + ': ' + c.typeDiffs.join(', ') : '',
      ].filter(Boolean).join(' · ') }),
    ]),
    el('span'),
  ])))));
  if (r.rowCounts.length) wrap.append(section(t('compare.rowCounts'), renderGrid({ columns: [t('structure.name'), t('compare.source'), t('compare.target')], rows: r.rowCounts.map(x => [x.table, fmtN(x.a), fmtN(x.b)]) })));
  if (noDiff) { wrap.append(muted(t('compare.identical'))); return wrap; }
  if (r.migration.trim()) wrap.append(section(t('compare.migrationSql'), el('div', {}, [
    sqlBlock(r.migration, 'scroll'),
    el('nav', { class: 'right-align toolbar' }, [
      el('button', { class: 'small border', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(r.migration); toast(t('advice.copied')); } }, [el('i', { text: 'content_copy' }), el('span', { text: t('advice.copy') })]),
      el('button', { class: 'small', onClick: applyFn }, [el('i', { text: 'play_arrow' }), el('span', { text: t('compare.apply') })]),
    ]),
  ])));
  return wrap;
}

async function compareDatabaseDialog(ws) {
  let dbs;
  try { dbs = (await Api.proxy('databases')).databases; } catch (e) { return toast(e.message, true); }
  const targets = dbs.filter(d => d.key !== ws.conn.id && d.exists);
  if (!targets.length) return toast(t('compare.none'), true);
  const sel = el('select', {}, targets.map(d => el('option', { value: d.key, text: d.label })));
  const out = el('div', {});
  let lastSql = '';
  async function run() {
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      const result = await diffDatabases(ws.conn, serverReader(sel.value));
      lastSql = result.migration;
      clear(out); out.append(dbDiffView(result, applyMigration));
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }
  async function applyMigration() {
    if (!lastSql.trim()) return;
    const label = sel.options[sel.selectedIndex].text;
    if (prefs.get('confirmDestructive') && !(await confirmDialog(t('compare.applyConfirm', { db: label })))) return;
    try { await Api.proxy('exec', { db: sel.value, sql: lastSql, tx: true }); toast(t('compare.applied')); run(); }
    catch (e) { toast(e.message, true); }
  }
  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('compare.title') }, [
    el('h5', { text: t('compare.title') + ' — ' + ws.conn.meta.label }),
    el('p', { class: 'small-text', text: t('compare.intro') }),
    el('nav', { class: 'wrap toolbar' }, [
      el('div', { class: 'field label suffix border max' }, [sel, el('label', { text: t('compare.target') })]),
      el('button', { onClick: run }, [el('i', { text: 'difference' }), el('span', { text: t('compare.title') })]),
    ]),
    out,
    el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: t('prefs.close'), onClick: () => dlg.remove() })]),
  ]);
  document.body.append(dlg); dlg.showModal();
}

function tableDiffView(nameA, nameB, a, b) {
  const wrap = el('div', {});
  const ac = new Map(a.columns.map(c => [c.name.toLowerCase(), c]));
  const bc = new Map(b.columns.map(c => [c.name.toLowerCase(), c]));
  const onlyA = a.columns.filter(c => !bc.has(c.name.toLowerCase())).map(c => c.name);
  const onlyB = b.columns.filter(c => !ac.has(c.name.toLowerCase())).map(c => c.name);
  const typeDiff = a.columns.filter(c => bc.has(c.name.toLowerCase()) && (bc.get(c.name.toLowerCase()).type || '') !== (c.type || ''))
    .map(c => `${c.name} (${bc.get(c.name.toLowerCase()).type || '?'} → ${c.type || '?'})`);
  const ai = new Set(a.indexes.map(i => i.name.toLowerCase()));
  const bi = new Set(b.indexes.map(i => i.name.toLowerCase()));
  const idxOnlyA = a.indexes.filter(i => !bi.has(i.name.toLowerCase())).map(i => i.name);
  const idxOnlyB = b.indexes.filter(i => !ai.has(i.name.toLowerCase())).map(i => i.name);
  if (!onlyA.length && !onlyB.length && !typeDiff.length && !idxOnlyA.length && !idxOnlyB.length) { wrap.append(muted(t('compare.identical'))); return wrap; }
  const rows = [
    [`${t('compare.missingColumn')} (${nameB})`, onlyA.join(', ') || '—'],
    [`${t('compare.missingColumn')} (${nameA})`, onlyB.join(', ') || '—'],
    [t('compare.typeDiff'), typeDiff.join(', ') || '—'],
    [`${t('compare.missingIndex')} (${nameB})`, idxOnlyA.join(', ') || '—'],
    [`${t('compare.missingIndex')} (${nameA})`, idxOnlyB.join(', ') || '—'],
  ];
  wrap.append(el('div', { class: 'kv' }, rows.flatMap(([k, v]) => [el('b', { text: k }), el('span', { text: v })])));
  return wrap;
}

async function compareTableDialog(ws) {
  const others = ws.tables.filter(x => !x.internal && x.name !== ws.table);
  if (!others.length) return toast(t('compare.none'), true);
  const sel = el('select', {}, others.map(x => el('option', { value: x.name, text: x.name })));
  const out = el('div', {});
  async function run() {
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      const [a, b] = await Promise.all([ws.conn.schema(ws.table), ws.conn.schema(sel.value)]);
      clear(out); out.append(tableDiffView(ws.table, sel.value, a, b));
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }
  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('compare.table') }, [
    el('h5', { text: t('compare.table') + ' — ' + ws.table }),
    el('nav', { class: 'wrap toolbar' }, [
      el('div', { class: 'field label suffix border max' }, [sel, el('label', { text: t('compare.withTable') })]),
      el('button', { onClick: run }, [el('i', { text: 'difference' }), el('span', { text: t('compare.title') })]),
    ]),
    out,
    el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: t('prefs.close'), onClick: () => dlg.remove() })]),
  ]);
  document.body.append(dlg); dlg.showModal();
  run();
}

function wizardButtons(ws, getSql, out, getDlg) {
  return el('nav', { class: 'right-align toolbar' }, [
    el('button', { class: 'border', onClick: () => { const sql = getSql(); if (!sql) return toast(t('create.needName'), true); ws.sqlText = sql.replace(/;\s*$/, ''); getDlg().remove(); selectTab(ws, 'sql'); } }, [el('i', { text: 'edit' }), el('span', { text: t('window.toEditor') })]),
    el('button', { onClick: async () => {
      const sql = getSql(); if (!sql) return toast(t('create.needName'), true);
      clear(out); out.append(el('progress', { class: 'circle' }));
      try {
        const r = await ws.conn.query(sql, { limit: prefs.get('pageSize') });
        clear(out); out.append(
          el('p', { class: 'small-text', text: `${r.rows.length} ${t('browse.rows')} · ${r.elapsed} ${t('sql.elapsed')}` }),
          r.rows.length ? renderGrid({ columns: r.columns, rows: r.rows }) : muted(t('browse.empty')),
        );
      } catch (e) { clear(out); out.append(errorBox(e)); }
    } }, [el('i', { text: 'play_arrow' }), el('span', { text: t('window.preview') })]),
  ]);
}

async function windowWizard(ws) {
  const tables = ws.tables.filter(x => !x.internal);
  if (!tables.length) return toast(t('compare.none'), true);
  const tableSel = el('select', {}, tables.map(x => el('option', { value: x.name, text: x.name, selected: x.name === ws.table })));
  const fnSel = el('select', {}, ['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'LAG', 'LEAD'].map(f => el('option', { value: f, text: f })));
  const aliasInput = el('input', { type: 'text', value: 'win' });
  const dirSel = el('select', {}, ['ASC', 'DESC'].map(d => el('option', { value: d, text: d })));
  const argHost = el('div', {});
  const partHost = el('nav', { class: 'wrap' });
  const orderHost = el('nav', { class: 'wrap' });
  const sqlPre = el('pre', { class: 'code-block sql-hl' });
  const out = el('div', {});
  let argSel = null, partE = [], orderE = [];

  const noArg = () => ['ROW_NUMBER', 'RANK', 'DENSE_RANK'].includes(fnSel.value);
  function build() {
    const part = partE.filter(e => e.cb.checked).map(e => e.c);
    const ord = orderE.filter(e => e.cb.checked).map(e => e.c);
    const arg = noArg() ? '' : (argSel ? argSel.value : '');
    if (!noArg() && !arg) return '';
    const over = [];
    if (part.length) over.push('PARTITION BY ' + part.map(qid).join(', '));
    if (ord.length) over.push('ORDER BY ' + ord.map(c => qid(c) + ' ' + dirSel.value).join(', '));
    const alias = qid(aliasInput.value.trim() || 'win');
    return `SELECT *, ${fnSel.value}(${arg ? qid(arg) : ''}) OVER (${over.join(' ')}) AS ${alias}\nFROM ${qid(tableSel.value)};`;
  }
  function update() { argHost.style.display = noArg() ? 'none' : ''; setSqlBlock(sqlPre, build() || '—'); }
  async function loadCols() {
    let cols = [];
    try { cols = (await ws.conn.schema(tableSel.value)).columns.map(c => c.name); } catch (_) {}
    argSel = el('select', {}, cols.map(c => el('option', { value: c, text: c })));
    argSel.addEventListener('change', update);
    clear(argHost); argHost.append(el('div', { class: 'field label suffix border' }, [argSel, el('label', { text: t('window.arg') })]));
    partE = cols.map(c => ({ c, cb: el('input', { type: 'checkbox' }) }));
    orderE = cols.map(c => ({ c, cb: el('input', { type: 'checkbox' }) }));
    clear(partHost); partE.forEach(e => { e.cb.addEventListener('change', update); partHost.append(el('label', { class: 'checkbox' }, [e.cb, el('span', { text: e.c })])); });
    clear(orderHost); orderE.forEach(e => { e.cb.addEventListener('change', update); orderHost.append(el('label', { class: 'checkbox' }, [e.cb, el('span', { text: e.c })])); });
    update();
  }
  tableSel.addEventListener('change', loadCols);
  fnSel.addEventListener('change', update);
  aliasInput.addEventListener('input', update);
  dirSel.addEventListener('change', update);

  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('window.title') }, [
    el('h5', { text: t('window.title') }),
    el('nav', { class: 'wrap toolbar wizard-bar' }, [
      el('div', { class: 'field label suffix border' }, [tableSel, el('label', { text: t('window.table') })]),
      el('div', { class: 'field label suffix border' }, [fnSel, el('label', { text: t('window.fn') })]),
      el('div', { class: 'field label border' }, [aliasInput, el('label', { text: t('window.alias') })]),
    ]),
    argHost,
    el('p', { class: 'small-text', text: t('window.partition') }), partHost,
    el('p', { class: 'small-text', text: t('window.orderBy') }),
    el('nav', { class: 'wrap' }, [orderHost, el('div', { class: 'field label suffix border' }, [dirSel, el('label', { text: t('window.direction') })])]),
    el('div', { class: 'v-space' }),
    sqlPre,
    wizardButtons(ws, build, out, () => dlg),
    out,
  ]);
  document.body.append(dlg); dlg.showModal();
  await loadCols();
}

async function jsonWizard(ws) {
  const tables = ws.tables.filter(x => !x.internal);
  if (!tables.length) return toast(t('compare.none'), true);
  const tableSel = el('select', {}, tables.map(x => el('option', { value: x.name, text: x.name, selected: x.name === ws.table })));
  const colHost = el('div', {});
  const pathInput = el('input', { type: 'text', value: '$', placeholder: '$.path' });
  const modeSel = el('select', {}, [el('option', { value: 'extract', text: t('jsonq.extract') }), el('option', { value: 'expand', text: t('jsonq.expand') })]);
  const sqlPre = el('pre', { class: 'code-block sql-hl' });
  const out = el('div', {});
  let colSel = null;

  const safePath = p => /^[$A-Za-z0-9_.[\]*'#-]*$/.test(p);
  function build() {
    const tbl = tableSel.value, col = colSel ? colSel.value : '', path = pathInput.value.trim() || '$';
    if (!col || !safePath(path)) return '';
    const pl = path.replace(/'/g, "''");
    if (modeSel.value === 'expand') return `SELECT t.*, je.key, je.value\nFROM ${qid(tbl)} t, json_each(t.${qid(col)}, '${pl}') je;`;
    return `SELECT *, json_extract(${qid(col)}, '${pl}') AS value\nFROM ${qid(tbl)};`;
  }
  function update() { setSqlBlock(sqlPre, build() || '—'); }
  async function loadCols() {
    let cols = [];
    try { cols = (await ws.conn.schema(tableSel.value)).columns.map(c => c.name); } catch (_) {}
    colSel = el('select', {}, cols.map(c => el('option', { value: c, text: c })));
    colSel.addEventListener('change', update);
    clear(colHost); colHost.append(el('div', { class: 'field label suffix border' }, [colSel, el('label', { text: t('jsonq.column') })]));
    update();
  }
  tableSel.addEventListener('change', loadCols);
  pathInput.addEventListener('input', update);
  modeSel.addEventListener('change', update);

  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('jsonq.title') }, [
    el('h5', { text: t('jsonq.title') }),
    el('nav', { class: 'wrap toolbar wizard-bar' }, [
      el('div', { class: 'field label suffix border' }, [tableSel, el('label', { text: t('window.table') })]),
      colHost,
      el('div', { class: 'field label suffix border' }, [modeSel, el('label', { text: t('jsonq.mode') })]),
    ]),
    el('div', { class: 'field label border' }, [pathInput, el('label', { text: t('jsonq.path') })]),
    el('div', { class: 'v-space' }),
    sqlPre,
    wizardButtons(ws, build, out, () => dlg),
    out,
  ]);
  document.body.append(dlg); dlg.showModal();
  await loadCols();
}

function downloadExport(columns, rows, name, format) {
  if (format === 'csv') download(name + '.csv', toCsv(columns, rows), 'text/csv');
  else if (format === 'json') download(name + '.json', toJsonRows(columns, rows), 'application/json');
  else download(name + '.sql', toSqlInserts(name, columns, rows), 'application/sql');
}
function exportButtons(columns, rows, name) {
  return el('nav', { class: 'wrap toolbar' }, [
    el('span', { class: 'small-text', text: t('io.export') + ':' }),
    el('button', { class: 'small border', onClick: () => downloadExport(columns, rows, name, 'csv') }, [el('span', { text: t('io.csv') })]),
    el('button', { class: 'small border', onClick: () => downloadExport(columns, rows, name, 'json') }, [el('span', { text: t('io.json') })]),
    el('button', { class: 'small border', onClick: () => downloadExport(columns, rows, name, 'sql') }, [el('span', { text: t('io.sql') })]),
  ]);
}
async function exportDialog(ws, table) {
  if (!table) return;
  const loading = loadingDialog(t('common.loading'));
  try {
    const res = await ws.conn.query(`SELECT * FROM ${qid(table)}`, { limit: 1000000 });
    loading.remove();
    const dlg = el('dialog', { class: 'small fit', 'aria-label': t('io.export') }, [
      el('h5', { text: t('io.export') + ' — ' + table }),
      el('p', { class: 'small-text', text: `${res.rows.length} ${t('browse.rows')}` + (res.truncated ? ' · ' + t('io.truncated') : '') }),
      exportButtons(res.columns, res.rows, table),
      el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: t('prefs.close'), onClick: () => dlg.remove() })]),
    ]);
    document.body.append(dlg); dlg.showModal();
  } catch (e) { loading.remove(); toast(e.message, true); }
}

async function importDialog(ws, table) {
  if (!table) return;
  let cols = [];
  try { cols = (await ws.conn.schema(table)).columns.map(c => c.name); } catch (e) { return toast(e.message, true); }
  const fileInput = el('input', { type: 'file', accept: '.csv,.json,.txt' });
  const fileBtn = el('button', { class: 'border', type: 'button' }, [el('i', { text: 'attach_file' }), el('span', { text: t('io.file') }), fileInput]);
  const info = el('div', {});
  let parsed = null;

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    const text = await f.text();
    try {
      if (/\.json$/i.test(f.name) || text.trim()[0] === '[') {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) throw new Error('Expected a JSON array of objects');
        const keys = [...new Set(arr.flatMap(o => Object.keys(o || {})))];
        parsed = { columns: keys, rows: arr.map(o => keys.map(k => (o == null ? null : (o[k] ?? null)))) };
      } else {
        parsed = parseCsv(text);
      }
    } catch (e) { parsed = null; clear(info); info.append(errorBox(e)); return; }
    const lc = cols.map(c => c.toLowerCase());
    parsed._match = parsed.columns.map(c => { const i = lc.indexOf(String(c).toLowerCase()); return i >= 0 ? cols[i] : null; });
    const matched = parsed._match.filter(Boolean).length;
    clear(info);
    info.append(el('p', { class: 'small-text', text: `${parsed.rows.length} ${t('browse.rows')} · ${matched}/${parsed.columns.length} ${t('io.matched')}` }));
    if (!matched) info.append(el('p', { class: 'small-text error-text', text: t('io.noMatch') }));
  });

  openDialog(t('io.import') + ' — ' + table, [
    el('p', { class: 'small-text', text: t('io.importHint') }),
    el('nav', {}, [fileBtn]),
    info,
  ], async () => {
    if (!parsed || !parsed.rows.length) { toast(t('io.noMatch'), true); return false; }
    const useIdx = [], useCols = [];
    parsed._match.forEach((m, i) => { if (m) { useIdx.push(i); useCols.push(m); } });
    if (!useCols.length) { toast(t('io.noMatch'), true); return false; }
    const rows = parsed.rows.map(r => useIdx.map(i => {
      let v = r[i];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      return (v === '' || v === undefined) ? null : v;
    }));
    try {
      await ws.conn.transaction(toSqlInserts(table, useCols, rows));
      toast(t('io.imported', { n: rows.length }));
      browseTab(ws);
    } catch (e) { toast(e.message, true); return false; }
  }, { saveLabel: t('io.import') });
}

async function profilerDialog(ws, table) {
  if (!table) return;
  const loading = loadingDialog(t('common.loading'));
  try {
    const schema = await ws.conn.schema(table);
    const total = (await ws.conn.query(`SELECT COUNT(*) FROM ${qid(table)}`, { limit: 1 })).rows[0][0];
    const statRows = [];
    for (const c of schema.columns) {
      const numeric = /INT|REAL|NUM|DEC|FLOA|DOUB/i.test(c.type || '');
      const id = qid(c.name);
      let r = [null, null, null, null, null];
      try { r = (await ws.conn.query(`SELECT COUNT(DISTINCT ${id}), SUM(CASE WHEN ${id} IS NULL THEN 1 ELSE 0 END), MIN(${id}), MAX(${id}), ${numeric ? `AVG(${id})` : 'NULL'} FROM ${qid(table)}`, { limit: 1 })).rows[0]; } catch (_) {}
      const avg = r[4] == null ? '' : (typeof r[4] === 'number' ? r[4].toFixed(2) : String(r[4]));
      let top = '';
      try {
        const tr = await ws.conn.query(`SELECT ${id} v, COUNT(*) c FROM ${qid(table)} WHERE ${id} IS NOT NULL GROUP BY ${id} ORDER BY c DESC LIMIT 5`, { limit: 5 });
        top = tr.rows.slice(0, 3).map(x => `${profVal(x[0])} (${x[1]})`).join(', ');
      } catch (_) {}
      statRows.push([c.name, c.type || '', cellStr(r[0]), cellStr(r[1]), cellStr(r[2]), cellStr(r[3]), avg, top]);
    }
    loading.remove();
    const dlg = el('dialog', { class: 'large fit', 'aria-label': t('profile.title') }, [
      el('h5', { text: t('profile.title') + ' — ' + table }),
      el('p', { class: 'small-text', text: `${total} ${t('profile.rows')}` }),
      renderGrid({ columns: [t('structure.name'), t('structure.type'), t('profile.distinct'), t('profile.nulls'), 'min', 'max', t('profile.avg'), t('profile.top')], rows: statRows }),
      el('nav', { class: 'right-align' }, [el('button', { class: 'border', text: t('prefs.close'), onClick: () => dlg.remove() })]),
    ]);
    document.body.append(dlg); dlg.showModal();
  } catch (e) { loading.remove(); toast(e.message, true); }
}
function cellStr(v) { return v == null ? '' : String(v); }
function profVal(v) {
  if (v == null) return 'NULL';
  if (v instanceof Uint8Array) return '[blob]';
  const s = String(v);
  return s.length > 18 ? s.slice(0, 17) + '…' : s;
}

async function aggregateWizard(ws) {
  const tables = ws.tables.filter(x => !x.internal);
  if (!tables.length) return toast(t('compare.none'), true);
  const tableSel = el('select', {}, tables.map(x => el('option', { value: x.name, text: x.name, selected: x.name === ws.table })));
  const fnSel = el('select', {}, ['COUNT(*)', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].map(f => el('option', { value: f, text: f })));
  const measureHost = el('div', {});
  const groupHost = el('nav', { class: 'wrap' });
  const limitInput = el('input', { type: 'number', value: '20', min: '1' });
  const sqlPre = el('pre', { class: 'code-block sql-hl' });
  const out = el('div', {});
  let measureSel = null, groupE = [];

  const needsCol = () => fnSel.value !== 'COUNT(*)';
  function build() {
    const groups = groupE.filter(e => e.cb.checked).map(e => e.c);
    if (!groups.length) return '';
    const agg = fnSel.value === 'COUNT(*)' ? 'COUNT(*)' : (measureSel && measureSel.value ? `${fnSel.value}(${qid(measureSel.value)})` : '');
    if (!agg) return '';
    const lim = Math.max(1, +limitInput.value || 20);
    return `SELECT ${groups.map(qid).join(', ')}, ${agg} AS value\nFROM ${qid(tableSel.value)}\nGROUP BY ${groups.map(qid).join(', ')}\nORDER BY value DESC\nLIMIT ${lim};`;
  }
  function update() { measureHost.style.display = needsCol() ? '' : 'none'; setSqlBlock(sqlPre, build() || '—'); }
  async function loadCols() {
    let cols = [];
    try { cols = (await ws.conn.schema(tableSel.value)).columns.map(c => c.name); } catch (_) {}
    measureSel = el('select', {}, cols.map(c => el('option', { value: c, text: c })));
    measureSel.addEventListener('change', update);
    clear(measureHost); measureHost.append(el('div', { class: 'field label suffix border' }, [measureSel, el('label', { text: t('agg.measure') })]));
    groupE = cols.map(c => ({ c, cb: el('input', { type: 'checkbox' }) }));
    clear(groupHost); groupE.forEach(e => { e.cb.addEventListener('change', update); groupHost.append(el('label', { class: 'checkbox' }, [e.cb, el('span', { text: e.c })])); });
    update();
  }
  tableSel.addEventListener('change', loadCols);
  fnSel.addEventListener('change', update);
  limitInput.addEventListener('input', update);

  async function runChart() {
    const sql = build(); if (!sql) return toast(t('agg.needGroup'), true);
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      const r = await ws.conn.query(sql, { limit: 1000 });
      clear(out);
      const labels = r.rows.map(row => row.slice(0, -1).join(' / '));
      const values = r.rows.map(row => Number(row[row.length - 1]) || 0);
      out.append(
        el('p', { class: 'small-text', text: `${r.rows.length} ${t('browse.rows')} · ${r.elapsed} ${t('sql.elapsed')}` }),
        r.rows.length ? el('div', { class: 'chart-wrap' }, [barChart({ labels, values })]) : null,
        r.rows.length ? renderGrid({ columns: r.columns, rows: r.rows }) : muted(t('browse.empty')),
      );
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }

  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('agg.title') }, [
    el('h5', { text: t('agg.title') }),
    el('nav', { class: 'wrap toolbar wizard-bar' }, [
      el('div', { class: 'field label suffix border' }, [tableSel, el('label', { text: t('window.table') })]),
      el('div', { class: 'field label suffix border' }, [fnSel, el('label', { text: t('agg.fn') })]),
      measureHost,
      el('div', { class: 'field label border' }, [limitInput, el('label', { text: t('agg.limit') })]),
    ]),
    el('p', { class: 'small-text', text: t('agg.groupBy') }), groupHost,
    el('div', { class: 'v-space' }),
    sqlPre,
    el('nav', { class: 'right-align toolbar' }, [
      el('button', { class: 'border', onClick: () => { const sql = build(); if (!sql) return toast(t('agg.needGroup'), true); ws.sqlText = sql.replace(/;\s*$/, ''); dlg.remove(); selectTab(ws, 'sql'); } }, [el('i', { text: 'edit' }), el('span', { text: t('window.toEditor') })]),
      el('button', { onClick: runChart }, [el('i', { text: 'play_arrow' }), el('span', { text: t('window.preview') })]),
    ]),
    out,
  ]);
  document.body.append(dlg); dlg.showModal();
  await loadCols();
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function indexSuggestions(ws, sql, tables) {
  const out = [];
  const selPart = (sql.match(/SELECT\s+([\s\S]*?)\bFROM\b/i) || [, ''])[1];
  const selectStar = /(^|\s|,)\*(\s|$|,)/.test(selPart);
  for (const tbl of tables) {
    let schema; try { schema = await ws.conn.schema(tbl); } catch (_) { continue; }
    const lead = new Set(schema.indexes.map(i => (i.columns[0] || '').toLowerCase()));
    const pk = new Set(schema.columns.filter(c => c.pk).map(c => c.name.toLowerCase()));
    const selCols = selectStar ? [] : schema.columns.filter(c => new RegExp(`\\b${escapeRe(c.name)}\\b`, 'i').test(selPart)).map(c => c.name);
    for (const c of schema.columns) {
      const lc = c.name.toLowerCase();
      if (lead.has(lc) || pk.has(lc)) continue;
      const cn = escapeRe(c.name);
      const cmp = new RegExp(`(?:\\b|\\.)${cn}\\s*(=|<|>|<=|>=|\\bIN\\b|\\bLIKE\\b|\\bBETWEEN\\b)`, 'i');
      const ord = new RegExp(`ORDER\\s+BY[^;]*\\b${cn}\\b`, 'i');
      const join = new RegExp(`\\bON\\b[^;]*\\b${cn}\\b`, 'i');
      if (!(cmp.test(sql) || ord.test(sql) || join.test(sql))) continue;
      out.push({ table: tbl, column: c.name, sql: `CREATE INDEX ${qid('idx_' + tbl + '_' + c.name)} ON ${qid(tbl)} (${qid(c.name)});` });
      const extra = selCols.filter(n => n.toLowerCase() !== lc).slice(0, 3);
      if (extra.length) {
        const colsList = [c.name, ...extra];
        out.push({ table: tbl, column: colsList.join(', '), covering: true, sql: `CREATE INDEX ${qid('idx_' + tbl + '_' + c.name + '_cov')} ON ${qid(tbl)} (${colsList.map(qid).join(', ')});` });
      }
    }
  }
  return out;
}

function indexSuggestionCard(ws, sg, out) {
  return el('div', { class: 'advice-card' }, [
    el('div', { class: 'advice-head' }, [el('i', { text: 'add_circle' }), el('b', { text: `${sg.table} (${sg.column})` }), sg.covering ? el('span', { class: 'chip tiny', text: t('explain.covering') }) : null].filter(Boolean)),
    sqlBlock(sg.sql),
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'small border', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(sg.sql); toast(t('advice.copied')); } }, [el('i', { text: 'content_copy' }), el('span', { text: t('advice.copy') })]),
      ws.conn.readonly ? null : el('button', { class: 'small', onClick: async () => {
        if (prefs.get('confirmDestructive') && !(await confirmDialog(sg.sql))) return;
        try { await ws.conn.exec(sg.sql); toast(t('advice.applied')); await refreshTables(ws); explainPlan(ws, out); } catch (e) { toast(e.message, true); }
      } }, [el('i', { text: 'check' }), el('span', { text: t('advice.apply') })]),
    ].filter(Boolean)),
  ]);
}

const VDBE_CAT = {
  OpenRead: 'open', OpenWrite: 'open', ReopenIdx: 'open', OpenPseudo: 'open',
  Rewind: 'scan', Next: 'scan', Prev: 'scan', Last: 'scan', VNext: 'scan', VFilter: 'scan', SorterNext: 'scan',
  SorterOpen: 'sort', Sort: 'sort', SorterSort: 'sort', SorterInsert: 'sort',
  OpenAutoindex: 'autoindex',
  OpenEphemeral: 'ephemeral',
  SeekRowid: 'seek', SeekGE: 'seek', SeekGT: 'seek', SeekLE: 'seek', SeekLT: 'seek',
  NotExists: 'seek', NotFound: 'seek', Found: 'seek', IdxGE: 'seek', IdxGT: 'seek', IdxLE: 'seek', IdxLT: 'seek',
  ResultRow: 'result',
};
const VDBE_INFO = {
  open: ['explain.opOpen', ''], scan: ['explain.opScan', ''],
  sort: ['explain.opSort', 'warn'], autoindex: ['explain.opAutoindex', 'warn'], ephemeral: ['explain.opEphemeral', 'warn'],
  seek: ['explain.opSeek', 'good'], result: ['explain.opResult', 'good'],
};

function bytecodeView(columns, rows) {
  const iAddr = columns.indexOf('addr'), iOp = columns.indexOf('opcode'), iCmt = columns.indexOf('comment');
  let warns = 0;
  const body = rows.map(r => {
    const op = String(r[iOp] == null ? '' : r[iOp]);
    const cat = VDBE_CAT[op];
    const inf = cat ? VDBE_INFO[cat] : null;
    const sev = inf ? inf[1] : '';
    if (sev === 'warn') warns++;
    const note = inf ? t(inf[0]) : '';
    const detail = (iCmt >= 0 && r[iCmt] != null && r[iCmt] !== '') ? String(r[iCmt]) : r.slice(2, 7).join(' ').trim();
    return el('tr', { class: sev === 'warn' ? 'bc-warn' : '' }, [
      el('td', { text: String(r[iAddr]) }),
      el('td', { text: op }),
      el('td', { class: 'small-text', text: detail }),
      el('td', {}, note ? [el('span', { class: 'bc-note ' + sev }, [el('i', { text: sev === 'warn' ? 'warning' : (sev === 'good' ? 'bolt' : 'chevron_right') }), el('span', { text: note })])] : []),
    ]);
  });
  const head = el('tr', {}, ['addr', 'opcode', 'detail', t('explain.analysis')].map(h => el('th', { scope: 'col', text: h })));
  const table = el('table', { class: 'datagrid bytecode' }, [el('thead', {}, [head]), el('tbody', {}, body)]);
  return el('div', {}, [
    el('p', { class: 'small-text' + (warns ? ' error-text' : ''), text: warns ? t('explain.bnFound', { n: warns }) : t('explain.bnNone') }),
    el('div', { class: 'grid-wrap' }, [table]),
  ]);
}

async function explainPlan(ws, out) {
  const sql = ((ws.editor && ws.editor.getValue()) || '').trim();
  if (!sql) return;
  clear(out); out.append(el('progress', { class: 'circle' }));
  try {
    const r = await ws.conn.query('EXPLAIN QUERY PLAN ' + sql, { limit: 2000 });
    const byParent = {};
    for (const row of r.rows) { const id = row[0], parent = row[1], detail = row[3]; (byParent[parent] = byParent[parent] || []).push({ id, detail }); }
    const list = el('div', { class: 'plan-tree' });
    let warn = 0, tempBtree = false; const scans = [];
    (function walk(parent, depth) {
      for (const node of (byParent[parent] || [])) {
        const d = node.detail;
        const full = /\bSCAN\b/.test(d) && !/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/.test(d);
        if (full) { warn++; const m = d.match(/SCAN (\w+)/); if (m) scans.push(m[1]); }
        if (/USE TEMP B-TREE/.test(d)) tempBtree = true;
        list.append(el('div', { class: 'plan-row' + (full ? ' warn' : ''), style: `padding-left:${depth * 1.4 + 0.2}rem` }, [
          el('i', { text: full ? 'warning' : (/\bSEARCH\b/.test(d) ? 'bolt' : 'subdirectory_arrow_right') }),
          el('span', { text: d }),
        ]));
        walk(node.id, depth + 1);
      }
    })(0, 0);

    const fromMatch = sql.match(/\bFROM\s+["'`]?(\w+)["'`]?/i);
    const singleTable = fromMatch && !/\bJOIN\b/i.test(sql) && !/\bFROM\s+[^;]*,/i.test(sql) ? fromMatch[1] : null;

    const hints = [];
    if (tempBtree) hints.push({ text: t('explain.tempBtree') });
    if (/\bSELECT\s+\*/i.test(sql)) hints.push({ text: t('explain.selectStar'), fix: singleTable ? async () => {
      try { const sc = await ws.conn.schema(singleTable); ws.editor.setValue(sql.replace(/SELECT\s+\*/i, 'SELECT ' + sc.columns.map(c => qid(c.name)).join(', '))); explainPlan(ws, out); } catch (e) { toast(e.message, true); }
    } : null });
    if (/^\s*SELECT/i.test(sql) && !/\bLIMIT\b/i.test(sql)) hints.push({ text: t('explain.noLimit'), fix: () => { ws.editor.setValue(sql.replace(/;?\s*$/, '') + '\nLIMIT 100;'); explainPlan(ws, out); } });
    if (/LIKE\s+'%/i.test(sql)) hints.push({ text: t('explain.likeWild') });
    if (/\b(lower|upper|date|datetime|substr|trim|replace|cast)\s*\([^)]*\)\s*(=|<|>|<=|>=|LIKE)/i.test(sql)) hints.push({ text: t('explain.nonSargable') });
    if (/\bWHERE\b[\s\S]*\bOR\b/i.test(sql)) hints.push({ text: t('explain.orUsage') });
    const uniqScans = [...new Set(scans)];
    if (uniqScans.length >= 2) hints.push({ text: t('explain.multiScan') });
    let statCount = null;
    try { const s1 = await ws.conn.query("SELECT count(*) FROM sqlite_master WHERE name='sqlite_stat1'", { limit: 1 }); statCount = s1.rows[0][0] ? (await ws.conn.query('SELECT count(*) FROM sqlite_stat1', { limit: 1 })).rows[0][0] : 0; } catch (_) {}
    if (statCount === 0 && warn && !ws.conn.readonly) hints.push({ text: t('explain.staleStats'), fix: async () => { try { await ws.conn.exec('ANALYZE'); toast(t('advice.applied')); explainPlan(ws, out); } catch (e) { toast(e.message, true); } } });

    const suggestions = await indexSuggestions(ws, sql, uniqScans);

    clear(out);
    out.append(el('p', { class: 'small-text' + (warn ? ' error-text' : ''), text: warn ? t('explain.fullScan', { n: warn }) : t('explain.usesIndex') }), list);
    if (hints.length) out.append(section(t('explain.hints'), el('div', { class: 'task-list' }, hints.map(h => el('div', { class: 'task-row' }, [
      el('i', { class: 'task-status', text: 'tips_and_updates' }),
      el('div', { class: 'task-text max' }, [el('span', { class: 'small-text', text: h.text })]),
      h.fix ? el('button', { class: 'small', onClick: () => h.fix() }, [el('i', { text: 'auto_fix_high' }), el('span', { text: t('explain.fixThis') })]) : el('span'),
    ])))));
    if (suggestions.length) out.append(section(t('explain.suggestIndex'), el('div', {}, suggestions.map(sg => indexSuggestionCard(ws, sg, out)))));
    if (ws.fullExplainChk && ws.fullExplainChk.checked) {
      try {
        const fe = await ws.conn.query('EXPLAIN ' + sql, { limit: 5000 });
        out.append(section(t('explain.fullExplain'), el('div', {}, [
          el('details', { class: 'help-note' }, [el('summary', { text: t('explain.bytecodeHelpTitle') }), el('div', { class: 'fts-help', text: t('explain.bytecodeHelp') })]),
          fe.rows.length ? bytecodeView(fe.columns, fe.rows) : muted(t('browse.empty')),
        ])));
      } catch (_) {}
    }
  } catch (e) { clear(out); out.append(errorBox(e)); }
}

async function benchmarkQuery(ws, out) {
  const sql = ((ws.editor && ws.editor.getValue()) || '').trim();
  if (!sql) return;
  const N = 5;
  clear(out); out.append(el('progress', { class: 'circle' }));
  try {
    const times = [];
    for (let i = 0; i < N; i++) { const r = await ws.conn.query(sql, { limit: prefs.get('pageSize') }); times.push(r.elapsed || 0); }
    const min = Math.min(...times), max = Math.max(...times), avg = times.reduce((a, b) => a + b, 0) / times.length;
    clear(out);
    out.append(el('p', { class: 'small-text', text: `${t('sql.benchmark')}: ${N}× · min ${min} · avg ${avg.toFixed(1)} · max ${max} ${t('sql.elapsed')}` }));
  } catch (e) { clear(out); out.append(errorBox(e)); }
}

async function autoPlan(ws, sql) {
  try {
    const r = await ws.conn.query('EXPLAIN QUERY PLAN ' + sql, { limit: 500 });
    const scans = [];
    for (const row of r.rows) { const d = row[3]; if (/\bSCAN\b/.test(d) && !/USING (COVERING )?INDEX|INTEGER PRIMARY KEY/.test(d)) { const m = d.match(/SCAN (\w+)/); if (m) scans.push(m[1]); } }
    return scans.length
      ? el('p', { class: 'small-text error-text', text: '⚠ ' + t('explain.planScan', { t: [...new Set(scans)].join(', ') }) })
      : el('p', { class: 'small-text', text: '⚡ ' + t('explain.planOk') });
  } catch (_) { return null; }
}

async function erDiagramDialog(ws) {
  const loading = loadingDialog(t('common.loading'));
  try {
    const defs = ws.tables.filter(x => !x.internal && x.type !== 'view');
    if (!defs.length) { loading.remove(); return toast(t('compare.none'), true); }
    const tables = [];
    for (const d of defs) {
      const s = await ws.conn.schema(d.name);
      const fkCols = new Set(s.foreign_keys.map(f => f.from));
      tables.push({
        name: d.name,
        columns: s.columns.map(c => ({ name: c.name, type: c.type, pk: !!c.pk, fk: fkCols.has(c.name) })),
        fks: s.foreign_keys.map(f => ({ from: f.from, table: f.table, to: f.to })),
      });
    }
    loading.remove();
    const mermaid = erMermaid(tables);
    const dlg = el('dialog', { class: 'large fit', 'aria-label': t('er.title') }, [
      el('h5', { text: t('er.title') }),
      el('div', { class: 'er-wrap' }, [erSvg(tables)]),
      el('nav', { class: 'right-align toolbar' }, [
        el('button', { class: 'small border', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(mermaid); toast(t('advice.copied')); } }, [el('i', { text: 'content_copy' }), el('span', { text: t('er.copyMermaid') })]),
        el('button', { class: 'border', text: t('prefs.close'), onClick: () => dlg.remove() }),
      ]),
    ]);
    document.body.append(dlg); dlg.showModal();
  } catch (e) { loading.remove(); toast(e.message, true); }
}

async function timeseriesWizard(ws) {
  const tables = ws.tables.filter(x => !x.internal);
  if (!tables.length) return toast(t('compare.none'), true);
  const tableSel = el('select', {}, tables.map(x => el('option', { value: x.name, text: x.name, selected: x.name === ws.table })));
  const dateHost = el('div', {});
  const bucketSel = el('select', {}, [['day', t('ts.day')], ['week', t('ts.week')], ['month', t('ts.month')], ['year', t('ts.year')]].map(([v, lbl]) => el('option', { value: v, text: lbl })));
  const fnSel = el('select', {}, ['COUNT(*)', 'SUM', 'AVG', 'MIN', 'MAX'].map(f => el('option', { value: f, text: f })));
  const measureHost = el('div', {});
  const sqlPre = el('pre', { class: 'code-block sql-hl' });
  const out = el('div', {});
  let dateSel = null, measureSel = null;

  const FMT = { day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m', year: '%Y' };
  const needsCol = () => fnSel.value !== 'COUNT(*)';
  function build() {
    if (!dateSel || !dateSel.value) return '';
    const agg = fnSel.value === 'COUNT(*)' ? 'COUNT(*)' : (measureSel && measureSel.value ? `${fnSel.value}(${qid(measureSel.value)})` : '');
    if (!agg) return '';
    const bucket = `strftime('${FMT[bucketSel.value]}', ${qid(dateSel.value)})`;
    return `SELECT ${bucket} AS bucket, ${agg} AS value\nFROM ${qid(tableSel.value)}\nWHERE ${qid(dateSel.value)} IS NOT NULL\nGROUP BY bucket\nORDER BY bucket;`;
  }
  function update() { measureHost.style.display = needsCol() ? '' : 'none'; setSqlBlock(sqlPre, build() || '—'); }
  async function loadCols() {
    let cols = [];
    try { cols = (await ws.conn.schema(tableSel.value)).columns.map(c => c.name); } catch (_) {}
    dateSel = el('select', {}, cols.map(c => el('option', { value: c, text: c })));
    dateSel.addEventListener('change', update);
    clear(dateHost); dateHost.append(el('div', { class: 'field label suffix border' }, [dateSel, el('label', { text: t('ts.dateCol') })]));
    measureSel = el('select', {}, cols.map(c => el('option', { value: c, text: c })));
    measureSel.addEventListener('change', update);
    clear(measureHost); measureHost.append(el('div', { class: 'field label suffix border' }, [measureSel, el('label', { text: t('agg.measure') })]));
    update();
  }
  tableSel.addEventListener('change', loadCols);
  [bucketSel, fnSel].forEach(x => x.addEventListener('change', update));

  async function runChart() {
    const sql = build(); if (!sql) return toast(t('agg.needGroup'), true);
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      const r = await ws.conn.query(sql, { limit: 2000 });
      clear(out);
      out.append(
        el('p', { class: 'small-text', text: `${r.rows.length} ${t('browse.rows')} · ${r.elapsed} ${t('sql.elapsed')}` }),
        r.rows.length ? el('div', { class: 'chart-wrap' }, [lineChart({ labels: r.rows.map(x => x[0]), values: r.rows.map(x => Number(x[1]) || 0) })]) : null,
        r.rows.length ? renderGrid({ columns: r.columns, rows: r.rows }) : muted(t('browse.empty')),
      );
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }

  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('ts.title') }, [
    el('h5', { text: t('ts.title') }),
    el('nav', { class: 'wrap toolbar wizard-bar' }, [
      el('div', { class: 'field label suffix border' }, [tableSel, el('label', { text: t('window.table') })]),
      dateHost,
      el('div', { class: 'field label suffix border' }, [bucketSel, el('label', { text: t('ts.bucket') })]),
      el('div', { class: 'field label suffix border' }, [fnSel, el('label', { text: t('agg.fn') })]),
      measureHost,
    ]),
    el('div', { class: 'v-space' }),
    sqlPre,
    el('nav', { class: 'right-align toolbar' }, [
      el('button', { class: 'border', onClick: () => { const sql = build(); if (!sql) return toast(t('agg.needGroup'), true); ws.sqlText = sql.replace(/;\s*$/, ''); dlg.remove(); selectTab(ws, 'sql'); } }, [el('i', { text: 'edit' }), el('span', { text: t('window.toEditor') })]),
      el('button', { onClick: runChart }, [el('i', { text: 'play_arrow' }), el('span', { text: t('window.preview') })]),
    ]),
    out,
  ]);
  document.body.append(dlg); dlg.showModal();
  await loadCols();
}

async function sqlTab(ws) {
  const host = el('div', { class: 'editor-host' });
  const out = el('div', {});
  const runBtn = el('button', { class: 'small' }, [el('i', { text: 'play_arrow' }), el('span', { text: t('sql.run') })]);
  const scriptBtn = el('button', { class: 'small border' }, [el('i', { text: 'playlist_play' }), el('span', { text: t('sql.runScript') })]);
  const clearBtn = el('button', { class: 'small border', onClick: () => { ws.editor && ws.editor.setValue(''); ws.sqlText = ''; } }, [el('i', { text: 'clear' }), el('span', { text: t('sql.clear') })]);
  const txChk = el('input', { type: 'checkbox', checked: true });
  const autoChk = el('input', { type: 'checkbox' });
  const fullChk = el('input', { type: 'checkbox' });
  ws.fullExplainChk = fullChk;
  const explainBtn = el('button', { class: 'small border', onClick: () => explainPlan(ws, out) }, [el('i', { text: 'account_tree' }), el('span', { text: t('explain.title') })]);
  const benchBtn = el('button', { class: 'small border', onClick: () => benchmarkQuery(ws, out) }, [el('i', { text: 'speed' }), el('span', { text: t('sql.benchmark') })]);
  const aggBtn = el('button', { class: 'small border', onClick: () => aggregateWizard(ws) }, [el('i', { text: 'bar_chart' }), el('span', { text: t('agg.title') })]);
  const tsBtn = el('button', { class: 'small border', onClick: () => timeseriesWizard(ws) }, [el('i', { text: 'timeline' }), el('span', { text: t('ts.title') })]);
  const winBtn = el('button', { class: 'small border', onClick: () => windowWizard(ws) }, [el('i', { text: 'view_column' }), el('span', { text: t('window.title') })]);
  const jsonBtn = el('button', { class: 'small border', onClick: () => jsonWizard(ws) }, [el('i', { text: 'data_object' }), el('span', { text: t('jsonq.title') })]);

  ws.body.append(
    el('nav', { class: 'wrap toolbar' }, [runBtn, scriptBtn, clearBtn, explainBtn, benchBtn, el('div', { class: 'max' }), aggBtn, tsBtn, winBtn, jsonBtn]),
    el('nav', { class: 'wrap toolbar' }, [
      el('label', { class: 'checkbox' }, [txChk, el('span', { text: t('sql.wrapTx') })]),
      el('label', { class: 'checkbox' }, [autoChk, el('span', { text: t('explain.auto') })]),
      el('label', { class: 'checkbox' }, [fullChk, el('span', { text: t('explain.fullExplain') })]),
    ]),
    host, el('div', { class: 'v-space' }), out,
  );

  ws.editor = await createEditor(host, ws.sqlText, prefs.get('fontSize'));
  ws.editor.onDidChangeModelContent(() => { ws.sqlText = ws.editor.getValue(); });
  ensureColumns(ws);
  ws.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run(false));

  runBtn.addEventListener('click', () => run(false));
  scriptBtn.addEventListener('click', () => run(true));

  async function run(script) {
    const sql = (ws.editor.getValue() || '').trim();
    if (!sql) return;
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      let res;
      if (script) {
        const wrap = txChk.checked && !/\bVACUUM\b/i.test(sql);
        if (txChk.checked && !wrap) toast(t('sql.txSkipped'));
        res = wrap ? await ws.conn.transaction(sql) : await ws.conn.exec(sql);
      } else {
        res = await ws.conn.query(sql, { limit: prefs.get('pageSize') });
      }
      history.add(sql, ws.conn.meta.label);
      clear(out);
      if (res.columns) {
        out.append(
          el('p', { class: 'small-text', text: `${res.rows.length} ${t('browse.rows')} · ${res.elapsed} ${t('sql.elapsed')}` + (res.truncated ? ' · ' + t('sql.truncated', { n: res.limit }) : '') }),
          res.rows.length ? exportButtons(res.columns, res.rows, ws.table || 'query_result') : null,
          res.rows.length ? renderGrid({ columns: res.columns, rows: res.rows }) : muted(t('browse.empty')),
        );
        if (autoChk.checked) autoPlan(ws, sql).then(b => { if (b && out.isConnected) out.insertBefore(b, out.firstChild); });
        if (!script) refreshTables(ws);
      } else {
        out.append(el('p', { class: 'small-text', text: `${res.changes} ${t('sql.rowsAffected')} · ${res.elapsed} ${t('sql.elapsed')}` }));
        refreshTables(ws);
      }
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }
}

const STRICT_TYPES = ['INTEGER', 'INT', 'REAL', 'TEXT', 'BLOB', 'ANY'];

function ftsVersions(ws) {
  const opts = (ws.info && ws.info.compile_options) || [];
  const v = [];
  if (opts.includes('ENABLE_FTS5')) v.push('5');
  if (opts.includes('ENABLE_FTS4') || opts.includes('ENABLE_FTS3')) { v.push('4', '3'); }
  return v;
}
function ftsVersionOf(sql) { const m = (sql || '').match(/USING\s+fts(3|4|5)\b/i); return m ? m[1] : null; }

function parseGeneratedExprs(sql) {
  const out = {};
  if (!sql) return out;
  const open = sql.indexOf('(');
  if (open < 0) return out;
  let depth = 0, body = '';
  for (let i = open; i < sql.length; i++) { const ch = sql[i]; if (ch === '(') { depth++; if (depth === 1) continue; } else if (ch === ')') { depth--; if (depth === 0) break; } body += ch; }
  const parts = []; depth = 0; let cur = '', q = null;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const m = p.match(/\bAS\s*\(/i); if (!m) continue;
    const nm = p.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/); if (!nm) continue;
    const name = nm[1] || nm[2] || nm[3] || nm[4];
    let i = m.index + m[0].length, d = 1, expr = '';
    for (; i < p.length; i++) { const ch = p[i]; if (ch === '(') d++; else if (ch === ')') { d--; if (d === 0) break; } expr += ch; }
    out[name.toLowerCase()] = expr.trim();
  }
  return out;
}

function buildStrictDefs(schema, genExprs) {
  const pkCols = schema.columns.filter(c => c.pk).map(c => c.name);
  const defs = schema.columns.map(c => {
    const u = (c.type || '').toUpperCase();
    const type = STRICT_TYPES.includes(u) ? u : 'ANY';
    if (c.generated) return `${qid(c.name)} ${type} GENERATED ALWAYS AS (${genExprs[c.name.toLowerCase()] || '0'}) ${c.generated.toUpperCase()}`;
    let s = `${qid(c.name)} ${type}`;
    if (pkCols.length === 1 && c.pk) s += ' PRIMARY KEY';
    if (c.notnull) s += ' NOT NULL';
    if (c.default != null) s += ' DEFAULT ' + c.default;
    return s;
  });
  if (pkCols.length > 1) defs.push(`PRIMARY KEY (${pkCols.map(qid).join(', ')})`);
  const groups = {};
  for (const fk of (schema.foreign_keys || [])) {
    const g = groups[fk.id] || (groups[fk.id] = { table: fk.table, from: [], to: [], on_update: fk.on_update, on_delete: fk.on_delete });
    g.from.push(fk.from); g.to.push(fk.to);
  }
  for (const g of Object.values(groups)) {
    let f = `FOREIGN KEY (${g.from.map(qid).join(', ')}) REFERENCES ${qid(g.table)} (${g.to.map(qid).join(', ')})`;
    if (g.on_update && g.on_update !== 'NO ACTION') f += ` ON UPDATE ${g.on_update}`;
    if (g.on_delete && g.on_delete !== 'NO ACTION') f += ` ON DELETE ${g.on_delete}`;
    defs.push(f);
  }
  return defs;
}

function rebuildStatements(table, schema, opts = {}) {
  const strict = opts.strict !== undefined ? opts.strict : !!schema.strict;
  const colMap = opts.colMap || {};
  const genExprs = parseGeneratedExprs(schema.sql);
  const ren = name => { const o = colMap[name.toLowerCase()]; return (o && o.name) ? o.name : name; };
  const pkCols = schema.columns.filter(c => c.pk).map(c => c.name);
  const defs = schema.columns.map(c => {
    const o = colMap[c.name.toLowerCase()] || {};
    const nm = o.name || c.name;
    let type = o.type != null ? o.type : (c.type || '');
    if (strict) { const u = (type || '').toUpperCase(); type = STRICT_TYPES.includes(u) ? u : 'ANY'; }
    if (c.generated) return `${qid(nm)} ${type} GENERATED ALWAYS AS (${genExprs[c.name.toLowerCase()] || '0'}) ${c.generated.toUpperCase()}`.replace(/ {2,}/g, ' ');
    let s = `${qid(nm)} ${type}`.trim();
    if (pkCols.length === 1 && c.pk) s += ' PRIMARY KEY';
    if (c.notnull) s += ' NOT NULL';
    if (c.default != null) s += ' DEFAULT ' + c.default;
    return s;
  });
  if (pkCols.length > 1) defs.push(`PRIMARY KEY (${pkCols.map(c => qid(ren(c))).join(', ')})`);
  const groups = {};
  for (const fk of (schema.foreign_keys || [])) {
    const g = groups[fk.id] || (groups[fk.id] = { table: fk.table, from: [], to: [], on_update: fk.on_update, on_delete: fk.on_delete });
    g.from.push(ren(fk.from)); g.to.push(fk.to);
  }
  for (const g of Object.values(groups)) {
    let f = `FOREIGN KEY (${g.from.map(qid).join(', ')}) REFERENCES ${qid(g.table)} (${g.to.map(qid).join(', ')})`;
    if (g.on_update && g.on_update !== 'NO ACTION') f += ` ON UPDATE ${g.on_update}`;
    if (g.on_delete && g.on_delete !== 'NO ACTION') f += ` ON DELETE ${g.on_delete}`;
    defs.push(f);
  }
  const tail = ')' + (strict ? ' STRICT' : '') + (schema.without_rowid ? (strict ? ', WITHOUT ROWID' : ' WITHOUT ROWID') : '');
  const tmp = table + '__rebuild';
  const nonGen = schema.columns.filter(c => !c.generated);
  const newCols = nonGen.map(c => qid(ren(c.name)));
  const oldCols = nonGen.map(c => qid(c.name));
  const idx = schema.indexes.filter(i => i.origin === 'c').map(ix =>
    `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${qid(ix.name)} ON ${qid(table)} (${ix.columns.map(cn => qid(ren(cn))).join(', ')})`);
  return [
    `CREATE TABLE ${qid(tmp)} (\n  ${defs.join(',\n  ')}\n${tail}`,
    `INSERT INTO ${qid(tmp)} (${newCols.join(', ')}) SELECT ${oldCols.join(', ')} FROM ${qid(table)}`,
    `DROP TABLE ${qid(table)}`,
    `ALTER TABLE ${qid(tmp)} RENAME TO ${qid(table)}`,
    ...idx,
  ];
}

async function convertToStrict(ws) {
  let schema; try { schema = await ws.conn.schema(ws.table); } catch (e) { return toast(e.message, true); }
  if (schema.strict) return toast(t('strict.already'));
  if (prefs.get('confirmDestructive') && !(await confirmDialog(t('strict.confirmConvert', { name: ws.table })))) return;
  const tmp = ws.table + '__strict';
  const genExprs = parseGeneratedExprs(schema.sql);
  const defs = buildStrictDefs(schema, genExprs);
  const dataCols = schema.columns.filter(c => !c.generated).map(c => qid(c.name));
  const idx = schema.indexes.filter(i => i.origin === 'c').map(ix => indexCreate(ws.table, ix).replace(/;$/, ''));
  const wr = schema.without_rowid ? ', WITHOUT ROWID' : '';
  const stmts = [
    `CREATE TABLE ${qid(tmp)} (\n  ${defs.join(',\n  ')}\n) STRICT${wr}`,
    `INSERT INTO ${qid(tmp)} (${dataCols.join(', ')}) SELECT ${dataCols.join(', ')} FROM ${qid(ws.table)}`,
    `DROP TABLE ${qid(ws.table)}`,
    `ALTER TABLE ${qid(tmp)} RENAME TO ${qid(ws.table)}`,
    ...idx,
  ];
  try { await ws.conn.transaction(stmts.join(';\n') + ';', { fkOff: true }); toast(t('strict.converted')); ws.browse = null; reloadStructure(ws); }
  catch (e) { toast(e.message, true); }
}

async function ftsCommand(ws, cmd, okKey) {
  try { await ws.conn.exec(`INSERT INTO ${qid(ws.table)}(${qid(ws.table)}) VALUES('${cmd}')`); toast(t(okKey)); }
  catch (e) { toast(e.message, true); }
}

function ftsSearchDialog(ws, ver) {
  const input = el('input', { type: 'text', placeholder: 'quick OR "brown fox"', 'aria-label': t('fts.match') });
  const out = el('div', {});
  async function run() {
    const q = input.value.trim(); if (!q) return;
    clear(out); out.append(el('progress', { class: 'circle' }));
    try {
      const rank = ver === '5' ? ', rank' : '';
      const order = ver === '5' ? ' ORDER BY rank' : '';
      const res = await ws.conn.query(`SELECT *${rank} FROM ${qid(ws.table)} WHERE ${qid(ws.table)} MATCH ?${order}`, { params: [q], limit: prefs.get('pageSize') });
      clear(out);
      out.append(el('p', { class: 'small-text', text: `${res.rows.length} ${t('browse.rows')} · ${res.elapsed} ${t('sql.elapsed')}` }), res.rows.length ? renderGrid({ columns: res.columns, rows: res.rows }) : muted(t('browse.empty')));
    } catch (e) { clear(out); out.append(errorBox(e)); }
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  const dlg = el('dialog', { class: 'large fit', 'aria-label': t('fts.search') }, [
    el('h5', { text: t('fts.search') + ' — ' + ws.table }),
    el('p', { class: 'small-text', text: t('fts.matchHint') }),
    el('nav', { class: 'wrap toolbar' }, [
      el('div', { class: 'field label border max' }, [input, el('label', { text: t('fts.match') })]),
      el('button', { onClick: run }, [el('i', { text: 'search' }), el('span', { text: t('fts.search') })]),
    ]),
    out,
    el('nav', { class: 'right-align' }, [el('button', { class: 'border', type: 'button', text: t('prefs.close'), onClick: () => dlg.remove() })]),
  ]);
  document.body.append(dlg); dlg.showModal();
  setTimeout(() => input.focus(), 30);
}

function ftsHelpDialog() {
  const dlg = el('dialog', { class: 'medium fit', 'aria-label': t('fts.help') }, [
    el('h5', { text: t('fts.help') }),
    el('div', { class: 'fts-help', text: t('fts.helpBody') }),
    el('nav', { class: 'right-align' }, [el('button', { class: 'border', type: 'button', text: t('prefs.close'), onClick: () => dlg.remove() })]),
  ]);
  document.body.append(dlg); dlg.showModal();
}

function createTab(ws) {
  const nameInput = el('input', { type: 'text', 'aria-label': t('create.tableName') });
  const rowsHost = el('div', {});
  const preview = el('pre', { class: 'code-block sql-hl' });
  const rows = [];
  const strictChk = el('input', { type: 'checkbox' });
  const wrowidChk = el('input', { type: 'checkbox' });

  const ftsVers = ftsVersions(ws);
  const kindOpts = [
    el('option', { value: 'table', text: t('create.kindTable') }),
    el('option', { value: 'view', text: t('create.kindView') }),
    el('option', { value: 'virtual', text: t('create.kindVirtual') }),
  ];
  if (ftsVers.length) kindOpts.push(el('option', { value: 'fts', text: t('fts.title') }));
  const kindSel = el('select', { 'aria-label': t('create.kind') }, kindOpts);

  const viewSql = el('textarea', { rows: '5', placeholder: 'SELECT …', 'aria-label': t('create.viewSelect') });
  const moduleInput = el('input', { type: 'text', placeholder: 'rtree', 'aria-label': t('create.module') });
  const moduleArgs = el('input', { type: 'text', placeholder: 'col1, col2', 'aria-label': t('create.moduleArgs') });

  const ftsVerSel = el('select', {}, ftsVers.map(v => el('option', { value: v, text: 'fts' + v })));
  const ftsCols = el('input', { type: 'text', placeholder: 'title, body', 'aria-label': t('fts.columns') });
  const ftsTok = el('select', {});
  const ftsContent = el('input', { type: 'text', 'aria-label': t('fts.content') });
  const ftsRowid = el('input', { type: 'text', 'aria-label': t('fts.contentRowid') });
  const ftsPrefix = el('input', { type: 'text', placeholder: '2 3', 'aria-label': t('fts.prefix') });
  function fillTok() {
    const toks = ftsVerSel.value === '5' ? ['', 'unicode61', 'porter', 'ascii', 'trigram'] : ['', 'simple', 'porter', 'unicode61'];
    clear(ftsTok); toks.forEach(x => ftsTok.append(el('option', { value: x, text: x || '(default)' })));
  }
  fillTok();

  function colRow() {
    const name = el('input', { type: 'text', placeholder: t('create.colName'), 'aria-label': t('create.colName') });
    const type = el('select', { 'aria-label': t('create.colType') }, [...TYPES, 'ANY'].map(x => el('option', { value: x, text: x })));
    const nn = el('input', { type: 'checkbox', 'aria-label': t('structure.notnull') });
    const pk = el('input', { type: 'checkbox', 'aria-label': t('structure.pk') });
    const ai = el('input', { type: 'checkbox', 'aria-label': t('create.autoinc') });
    const gen = el('input', { type: 'checkbox', 'aria-label': t('gen.generated') });
    const def = el('input', { type: 'text', placeholder: t('structure.default'), 'aria-label': t('structure.default') });
    const expr = el('input', { type: 'text', placeholder: t('gen.expression'), 'aria-label': t('gen.expression') });
    const kind = el('select', {}, [el('option', { value: 'VIRTUAL', text: t('gen.virtual') }), el('option', { value: 'STORED', text: t('gen.stored') })]);
    const rm = el('button', { class: 'circle small transparent', 'aria-label': 'Remove', onClick: () => { const i = rows.indexOf(entry); rows.splice(i, 1); node.remove(); update(); } }, [el('i', { text: 'close' })]);
    const detail = el('div', { class: 'gen-detail' }, [
      el('div', { class: 'field border small max' }, [expr]),
      el('div', { class: 'field border small suffix' }, [kind]),
    ]);
    const node = el('div', { class: 'col-rowwrap' }, [
      el('div', { class: 'col-row' }, [
        el('div', { class: 'field border small' }, [name]),
        el('div', { class: 'field border small suffix' }, [type]),
        el('label', { class: 'checkbox' }, [nn, el('span', { text: 'NN' })]),
        el('label', { class: 'checkbox' }, [pk, el('span', { text: 'PK' })]),
        el('label', { class: 'checkbox' }, [ai, el('span', { text: 'AI' })]),
        el('label', { class: 'checkbox' }, [gen, el('span', { text: t('gen.gen') })]),
        el('div', { class: 'field border small' }, [def]),
        rm,
      ]),
      detail,
    ]);
    const entry = { name, type, nn, pk, ai, gen, def, expr, kind };
    const syncRow = () => { detail.style.display = gen.checked ? '' : 'none'; };
    gen.addEventListener('change', () => { syncRow(); update(); });
    syncRow();
    rows.push(entry);
    [name, type, nn, pk, ai, def, expr].forEach(i => i.addEventListener('input', update));
    kind.addEventListener('change', update);
    rowsHost.append(node);
    update();
  }

  function buildSql() {
    const tbl = nameInput.value.trim();
    if (!tbl) return '';
    if (kindSel.value === 'view') { const sel = viewSql.value.trim(); return sel ? `CREATE VIEW ${qid(tbl)} AS ${sel};` : ''; }
    if (kindSel.value === 'virtual') { const mod = moduleInput.value.trim(); return mod ? `CREATE VIRTUAL TABLE ${qid(tbl)} USING ${mod}(${moduleArgs.value.trim()});` : ''; }
    if (kindSel.value === 'fts') {
      const cols = ftsCols.value.trim(); if (!cols) return '';
      const v = ftsVerSel.value, args = [cols];
      if (ftsTok.value) args.push(v === '5' ? `tokenize = '${ftsTok.value}'` : `tokenize=${ftsTok.value}`);
      if (ftsContent.value.trim()) args.push(v === '5' ? `content='${ftsContent.value.trim()}'` : `content="${ftsContent.value.trim()}"`);
      if (v === '5' && ftsRowid.value.trim()) args.push(`content_rowid='${ftsRowid.value.trim()}'`);
      if (v === '5' && ftsPrefix.value.trim()) args.push(`prefix='${ftsPrefix.value.trim()}'`);
      return `CREATE VIRTUAL TABLE ${qid(tbl)} USING fts${v}(${args.join(', ')});`;
    }
    const defs = rows.map(r => {
      const n = r.name.value.trim(); if (!n) return null;
      if (r.gen.checked) { const e = r.expr.value.trim(); if (!e) return null; return `${qid(n)} ${r.type.value} GENERATED ALWAYS AS (${e}) ${r.kind.value}`; }
      let s = qid(n) + ' ' + r.type.value;
      if (r.pk.checked) s += ' PRIMARY KEY' + (r.ai.checked && r.type.value === 'INTEGER' ? ' AUTOINCREMENT' : '');
      if (r.nn.checked) s += ' NOT NULL';
      if (r.def.value.trim() !== '') s += ' DEFAULT ' + r.def.value.trim();
      return s;
    }).filter(Boolean);
    if (!defs.length) return '';
    const strict = strictChk.checked, wr = wrowidChk.checked;
    const tail = ')' + (strict ? ' STRICT' : '') + (wr ? (strict ? ', WITHOUT ROWID' : ' WITHOUT ROWID') : '');
    return `CREATE TABLE ${qid(tbl)} (\n  ${defs.join(',\n  ')}\n${tail};`;
  }
  function update() { setSqlBlock(preview, buildSql() || '— ' + t('create.needName')); }

  const tableGroup = el('div', {}, [
    el('h6', { class: 'small', text: t('structure.columns') }),
    rowsHost,
    el('button', { class: 'small border', onClick: colRow }, [el('i', { text: 'add' }), el('span', { text: t('create.addColumn') })]),
    el('div', { class: 'v-space' }),
    el('nav', { class: 'wrap' }, [
      el('label', { class: 'checkbox' }, [strictChk, el('span', { text: t('strict.strict') })]),
      el('label', { class: 'checkbox' }, [wrowidChk, el('span', { text: t('strict.withoutRowid') })]),
    ]),
  ]);
  const viewGroup = el('div', {}, [el('div', { class: 'field label border textarea' }, [viewSql, el('label', { text: t('create.viewSelect') })])]);
  const virtualGroup = el('div', {}, [
    el('div', { class: 'field label border' }, [moduleInput, el('label', { text: t('create.module') })]),
    el('div', { class: 'field label border' }, [moduleArgs, el('label', { text: t('create.moduleArgs') })]),
  ]);
  const ftsGroup = el('div', {}, [
    el('nav', { class: 'wrap toolbar wizard-bar' }, [
      el('div', { class: 'field label suffix border' }, [ftsVerSel, el('label', { text: t('fts.version') })]),
      el('div', { class: 'field label border max' }, [ftsCols, el('label', { text: t('fts.columns') })]),
      el('div', { class: 'field label suffix border' }, [ftsTok, el('label', { text: t('fts.tokenizer') })]),
    ]),
    el('nav', { class: 'wrap toolbar wizard-bar' }, [
      el('div', { class: 'field label border' }, [ftsContent, el('label', { text: t('fts.content') })]),
      el('div', { class: 'field label border' }, [ftsRowid, el('label', { text: t('fts.contentRowid') })]),
      el('div', { class: 'field label border' }, [ftsPrefix, el('label', { text: t('fts.prefix') })]),
    ]),
    el('button', { class: 'small border', type: 'button', onClick: () => ftsHelpDialog() }, [el('i', { text: 'help' }), el('span', { text: t('fts.help') })]),
  ]);

  function syncKind() {
    const k = kindSel.value;
    tableGroup.style.display = k === 'table' ? '' : 'none';
    viewGroup.style.display = k === 'view' ? '' : 'none';
    virtualGroup.style.display = k === 'virtual' ? '' : 'none';
    ftsGroup.style.display = k === 'fts' ? '' : 'none';
    update();
  }
  kindSel.addEventListener('change', syncKind);
  ftsVerSel.addEventListener('change', () => { fillTok(); update(); });
  [viewSql, moduleInput, moduleArgs, ftsCols, ftsContent, ftsRowid, ftsPrefix].forEach(i => i.addEventListener('input', update));
  [strictChk, wrowidChk, ftsTok].forEach(i => i.addEventListener('change', update));

  ws.body.append(
    el('nav', { class: 'wrap toolbar' }, [el('div', { class: 'field label suffix border' }, [kindSel, el('label', { text: t('create.kind') })])]),
    el('div', { class: 'field label border' }, [nameInput, el('label', { text: t('create.tableName') })]),
    el('div', { class: 'v-space' }),
    tableGroup, viewGroup, virtualGroup, ftsGroup,
    el('div', { class: 'v-space large' }),
    el('p', { class: 'small-text', text: t('create.preview') }),
    preview,
    el('div', { class: 'v-space' }),
    el('button', { class: 'fill', onClick: create }, [el('i', { text: 'check' }), el('span', { text: t('create.create') })]),
  );
  colRow();
  syncKind();

  async function create() {
    if (kindSel.value === 'table' && strictChk.checked) {
      for (const r of rows) { const n = r.name.value.trim(); if (n && !r.gen.checked && !STRICT_TYPES.includes(r.type.value.toUpperCase())) return toast(t('strict.typeNote'), true); }
    }
    const sql = buildSql();
    if (!sql) return toast(t('create.needName'), true);
    try {
      await ws.conn.exec(sql);
      const name = nameInput.value.trim();
      await refreshTables(ws);
      ws.table = name; renderRail(ws); selectTab(ws, 'structure');
    } catch (e) { toast(e.message, true); }
  }
}

async function databaseTab(ws) {
  ws.body.append(el('progress', { class: 'circle' }));
  try { ws.info = await ws.conn.dbInfo(); } catch (_) {}
  const info = ws.info || {};
  const userTables = ws.tables.filter(x => !x.internal).length;
  clear(ws.body);

  const kv = [
    [t('common.name'), ws.conn.meta.label],
    ['Type', ws.conn.kind],
    [t('db.journalMode'), journalLabel(info.journal_mode)],
    [t('db.tables'), String(userTables)],
    [t('db.size'), info.size == null ? '—' : fmtBytes(info.size)],
    [t('db.pageSize'), info.page_size ? fmtBytes(info.page_size) : '—'],
    [t('db.pages'), info.page_count != null ? String(info.page_count) : '—'],
    [t('db.freePages'), info.freelist_count != null ? String(info.freelist_count) : '—'],
    [t('db.autoVacuum'), autoVacuumLabel(info.auto_vacuum)],
    ['SQLite', info.sqlite_version || '—'],
  ];
  const quickIds = ['vacuum', 'analyze', 'reindex', 'integrity', 'checkpoint'];

  ws.body.append(...[
    section(t('db.info'), el('div', { class: 'kv' }, kv.flatMap(([k, v]) => [el('b', { text: k }), el('span', { text: String(v) })]))),
    el('nav', { class: 'wrap toolbar' }, [
      ws.conn.readonly ? null : el('button', { onClick: () => maintenanceDialog(ws) }, [el('i', { text: 'auto_fix_high' }), el('span', { text: t('db.optimize') })]),
      el('button', { class: 'border', onClick: () => indexAdvisor(ws) }, [el('i', { text: 'lightbulb' }), el('span', { text: t('db.indexAdvice') })]),
      ws.conn.kind === 'server' ? el('button', { class: 'border', onClick: () => compareDatabaseDialog(ws) }, [el('i', { text: 'difference' }), el('span', { text: t('compare.title') })]) : null,
      el('button', { class: 'border', onClick: () => erDiagramDialog(ws) }, [el('i', { text: 'account_tree' }), el('span', { text: t('er.title') })]),
      el('button', { class: 'border', onClick: () => exportSchema(ws) }, [el('i', { text: 'schema' }), el('span', { text: t('db.exportSchema') })]),
      el('button', { class: 'border', onClick: () => generateOpenApi(ws) }, [el('i', { text: 'api' }), el('span', { text: t('db.swagger') })]),
      el('button', { class: 'border', onClick: () => backup(ws) }, [el('i', { text: 'download' }), el('span', { text: t('db.backup') })]),
      ws.conn.kind === 'local' ? el('button', { class: 'border', onClick: () => saveLocal(ws) }, [el('i', { text: 'save' }), el('span', { text: t('db.save') })]) : null,
    ].filter(Boolean)),
    ws.conn.readonly ? null : section(t('db.quickMaintenance'), el('nav', { class: 'wrap' },
      MAINTENANCE.filter(tk => quickIds.includes(tk.id) && !(tk.serverOnly && ws.conn.kind === 'local'))
        .map(tk => el('button', { class: 'small border', title: t('maint.' + tk.id + '.desc'), onClick: () => runSingleTask(ws, tk) }, [el('i', { text: tk.icon }), el('span', { text: t('maint.' + tk.id) })])))),
    maintLogPanel(ws),
    extensionsSection(info, ws.conn.kind),
    ws.conn.kind === 'local' && ws.conn.dirty ? el('p', { class: 'small-text error-text', text: t('db.unsaved') }) : null,
  ].filter(Boolean));
}

function extensionsSection(info, kind) {
  const exts = info.extensions || [];
  const opts = info.compile_options || [];
  const body = el('div', {});
  if (exts.length) {
    body.append(el('div', { class: 'task-list' }, exts.map(x => el('div', { class: 'task-row' }, [
      el('i', { class: 'task-status ' + (x.loaded ? 'ok' : 'fail'), text: x.loaded ? 'check_circle' : 'error' }),
      el('div', { class: 'task-text' }, [el('b', { text: x.name }), x.error ? el('span', { class: 'small-text', text: x.error }) : null].filter(Boolean)),
      el('span'),
    ]))));
  } else {
    body.append(muted(kind === 'local' ? t('db.extensionsLocal') : t('db.extensionsNone')));
  }
  if (opts.length) {
    body.append(el('details', { class: 'compile-opts' }, [
      el('summary', { text: t('db.compileOptions') + ` (${opts.length})` }),
      el('div', { class: 'chip-wrap' }, opts.map(o => el('span', { class: 'chip tiny', text: o }))),
    ]));
  }
  return section(t('db.extensions'), body);
}

function maintLogPanel(ws) {
  const log = ws.maintLog || [];
  const list = el('div', { class: 'maint-log' });
  if (!log.length) list.append(muted(t('db.logEmpty')));
  else for (const e of log) list.append(el('div', { class: 'log-row' }, [
    el('i', { class: 'task-status ' + (e.ok ? 'ok' : 'fail'), text: e.ok ? 'check_circle' : 'error' }),
    el('div', { class: 'task-text' }, [
      el('b', { text: e.label }),
      el('span', { class: 'small-text', text: `${e.output} · ${e.elapsed} ${t('sql.elapsed')} · ${new Date(e.ts).toLocaleTimeString()}` }),
    ]),
  ]));
  const head = el('div', { class: 'row' }, [
    el('h6', { class: 'small max', text: t('db.maintLog') }),
    el('button', { class: 'small border', disabled: !log.length, onClick: () => { ws.maintLog = []; databaseTab(ws); } }, [el('i', { text: 'delete_sweep' }), el('span', { text: t('db.clearLog') })]),
  ]);
  return el('section', { class: 'section' }, [head, list]);
}

function logMaint(ws, label, res) {
  (ws.maintLog || (ws.maintLog = [])).unshift({ label, ok: res.ok, output: res.output, elapsed: res.elapsed, ts: Date.now() });
  ws.maintLog = ws.maintLog.slice(0, 25);
}

async function runSingleTask(ws, task) {
  const loading = loadingDialog(t('maint.' + task.id));
  const r = await ws.conn.runTask(task);
  loading.remove();
  const label = t('maint.' + task.id);
  logMaint(ws, label, r);
  if (r.ok) toast(`${label}: ${r.output} · ${r.elapsed} ${t('sql.elapsed')}`);
  else toast(`${label}: ${r.output}`, true);
  await databaseTab(ws);
  updateWalChip(ws);
}

function maintenanceDialog(ws) {
  const info = ws.info || {};
  const settingDefs = ws.conn.kind === 'server' ? [
    { id: 'journalWal', icon: 'bolt', on: String(info.journal_mode).toLowerCase() === 'wal',
      task: on => ({ kind: 'query', sql: `PRAGMA journal_mode=${on ? 'WAL' : 'DELETE'}`, report: r => r.rows && r.rows.length ? String(r.rows[0][0]) : 'done' }) },
    { id: 'autoVacuum', icon: 'compress', on: info.auto_vacuum !== 0 && info.auto_vacuum != null,
      task: on => ({ kind: 'exec', sql: `PRAGMA auto_vacuum=${on ? 'FULL' : 'NONE'}; VACUUM` }) },
  ] : [];
  const settings = settingDefs.map(s => {
    const cb = el('input', { type: 'checkbox', checked: s.on });
    const status = el('i', { class: 'task-status' });
    const row = el('div', { class: 'task-row' }, [
      el('label', { class: 'checkbox' }, [cb, el('span')]),
      el('div', { class: 'task-text' }, [
        el('b', { text: t('settings.' + s.id) }),
        el('span', { class: 'small-text', text: t('settings.' + s.id + '.desc') }),
      ]),
      status,
    ]);
    return { s, cb, status, row };
  });

  const tasks = MAINTENANCE.filter(tk => !(tk.serverOnly && ws.conn.kind === 'local'));
  const rows = tasks.map(tk => {
    const cb = el('input', { type: 'checkbox', checked: !!tk.default });
    const status = el('i', { class: 'task-status' });
    const row = el('div', { class: 'task-row' }, [
      el('label', { class: 'checkbox' }, [cb, el('span')]),
      el('div', { class: 'task-text' }, [
        el('b', { text: t('maint.' + tk.id) }),
        el('span', { class: 'small-text', text: t('maint.' + tk.id + '.desc') }),
      ]),
      status,
    ]);
    return { tk, cb, status, row };
  });

  const suggestions = computeSuggestions(ws);
  const output = el('div', {});
  const runBtn = el('button', { onClick: runAll }, [el('i', { text: 'play_arrow' }), el('span', { text: t('maint.runSelected') })]);

  const dlg = el('dialog', { class: 'medium fit', 'aria-label': t('db.optimizeTitle') }, [
    el('h5', { text: t('db.optimizeTitle') }),
    el('p', { class: 'small-text', text: t('maint.intro') }),
    suggestions.length ? el('div', { class: 'task-list' }, suggestions.map(s => el('div', { class: 'task-row' }, [
      el('i', { class: 'task-status', text: s.icon }),
      el('div', { class: 'task-text' }, [el('span', { class: 'small-text', text: s.text })]),
      el('span'),
    ]))) : null,
    settings.length ? el('h6', { class: 'small', text: t('settings.title') }) : null,
    settings.length ? el('div', { class: 'task-list' }, settings.map(r => r.row)) : null,
    settings.length ? el('h6', { class: 'small', text: t('maint.actionsTitle') }) : null,
    el('div', { class: 'task-list' }, rows.map(r => r.row)),
    output,
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'border', text: t('prefs.close'), onClick: () => dlg.remove() }),
      runBtn,
    ]),
  ].filter(Boolean));
  document.body.append(dlg); dlg.showModal();

  async function runOne(r, taskOrFactory, label) {
    r.row.classList.add('is-running');
    r.status.className = 'task-status'; r.status.textContent = 'hourglass_top';
    const res = await ws.conn.runTask(taskOrFactory);
    r.row.classList.remove('is-running');
    r.status.className = 'task-status ' + (res.ok ? 'ok' : 'fail');
    r.status.textContent = res.ok ? 'check_circle' : 'error';
    r.row.title = `${res.output} · ${res.elapsed} ${t('sql.elapsed')}`;
    logMaint(ws, label, res);
    return res.ok;
  }

  async function runAll() {
    const changedSettings = settings.filter(r => r.cb.checked !== r.s.on);
    const selected = rows.filter(r => r.cb.checked);
    if (!changedSettings.length && !selected.length) return;
    runBtn.disabled = true;
    clear(output);
    const t0 = performance.now();
    let failed = 0;
    for (const r of changedSettings) {
      const ok = await runOne(r, r.s.task(r.cb.checked), t('settings.' + r.s.id));
      if (ok) r.s.on = r.cb.checked; else failed++;
    }
    for (const r of selected) {
      const ok = await runOne(r, r.tk, t('maint.' + r.tk.id));
      if (!ok) failed++;
    }
    runBtn.disabled = false;
    const ms = Math.round(performance.now() - t0);
    output.append(el('p', { class: 'small-text' + (failed ? ' error-text' : ''), text: failed ? t('maint.doneErrors', { n: failed }) : t('maint.doneOk', { ms }) }));
    try { ws.info = await ws.conn.dbInfo(); } catch (_) {}
    updateWalChip(ws);
    toast(failed ? t('maint.doneErrors', { n: failed }) : t('db.optimizeDone'), !!failed);
  }
}

async function indexAdvisor(ws) {
  const loading = loadingDialog(t('db.indexAdviceRun'));
  let advices = [];
  try { advices = await computeIndexAdvice(ws); } catch (e) { loading.remove(); return toast(e.message, true); }
  loading.remove();

  const body = advices.length ? advices.map(a => adviceCard(ws, a)) : [el('p', { class: 'small-text', text: t('db.indexAdviceNone') })];
  const dlg = el('dialog', { class: 'medium fit', 'aria-label': t('db.indexAdvice') }, [
    el('h5', { text: t('db.indexAdvice') }),
    el('p', { class: 'small-text', text: t('db.indexAdviceIntro') }),
    el('div', { class: 'v-space' }),
    ...body,
    el('nav', { class: 'right-align' }, [el('button', { text: t('prefs.close'), onClick: () => dlg.remove() })]),
  ]);
  document.body.append(dlg); dlg.showModal();
}

async function computeIndexAdvice(ws) {
  const tables = ws.tables.filter(x => !x.internal && x.type === 'table');
  const out = [];
  for (const tbl of tables) {
    let s; try { s = await ws.conn.schema(tbl.name); } catch (_) { continue; }
    const leadIndexed = new Set();
    for (const ix of s.indexes) if (ix.columns[0]) leadIndexed.add(ix.columns[0].toLowerCase());
    const pkCols = s.columns.filter(c => c.pk > 0).map(c => c.name.toLowerCase());
    for (const fk of s.foreign_keys) {
      const col = fk.from; if (!col) continue;
      const lc = col.toLowerCase();
      if (leadIndexed.has(lc) || pkCols.includes(lc)) continue;
      out.push({
        table: tbl.name, columns: [col], reason: t('advice.fk', { ref: fk.table }),
        sql: `CREATE INDEX ${qid('idx_' + tbl.name + '_' + col)} ON ${qid(tbl.name)} (${qid(col)});`,
      });
    }
    const seen = {};
    for (const ix of s.indexes) {
      if (ix.origin !== 'c') continue;
      const key = ix.columns.join(',').toLowerCase();
      if (seen[key]) out.push({ table: tbl.name, columns: ix.columns, reason: t('advice.dup', { other: seen[key] }), sql: `DROP INDEX ${qid(ix.name)};`, drop: true });
      else seen[key] = ix.name;
    }
  }
  return out;
}

function adviceCard(ws, a) {
  return el('div', { class: 'advice-card' }, [
    el('div', { class: 'advice-head' }, [el('i', { text: a.drop ? 'remove_circle' : 'add_circle' }), el('b', { text: `${a.table} (${a.columns.join(', ')})` })]),
    el('span', { class: 'small-text', text: a.reason }),
    sqlBlock(a.sql),
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'small border', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(a.sql); toast(t('advice.copied')); } }, [el('i', { text: 'content_copy' }), el('span', { text: t('advice.copy') })]),
      ws.conn.readonly ? null : el('button', { class: 'small', onClick: async ev => {
        try { await ws.conn.exec(a.sql); toast(t('advice.applied')); await refreshTables(ws); ev.target.closest('.advice-card').remove(); }
        catch (e) { toast(e.message, true); }
      } }, [el('i', { text: 'check' }), el('span', { text: t('advice.apply') })]),
    ].filter(Boolean)),
  ]);
}

function computeSuggestions(ws) {
  const info = ws.info || {};
  const s = [];
  if (ws.conn.kind === 'server' && info.journal_mode && String(info.journal_mode).toLowerCase() !== 'wal')
    s.push({ icon: 'bolt', text: t('suggest.wal') });
  if (info.freelist_count > 0 && info.page_count && info.freelist_count / info.page_count > 0.1)
    s.push({ icon: 'compress', text: t('suggest.vacuum', { n: info.freelist_count }) });
  if (info.auto_vacuum === 0)
    s.push({ icon: 'info', text: t('suggest.autovacuum') });
  return s;
}

async function backup(ws) { try { await ws.conn.backup(); } catch (e) { toast(e.message, true); } }
async function saveLocal(ws) { try { await ws.conn.save(); toast(t('common.save')); } catch (e) { toast(e.message, true); } }

async function exportSchema(ws) {
  try {
    const res = await ws.conn.query(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
      "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name",
      { limit: 100000 });
    const ddl = res.rows.map(r => String(r[0]).trim().replace(/;?\s*$/, ';')).join('\n\n') + '\n';
    download((ws.conn.meta.label || 'schema') + '.schema.sql', ddl, 'application/sql');
    toast(t('db.schemaExported'));
  } catch (e) { toast(e.message, true); }
}

function openApiType(ty) {
  const u = (ty || '').toUpperCase();
  if (u.includes('INT')) return { type: 'integer' };
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(u)) return { type: 'number' };
  if (u.includes('BLOB')) return { type: 'string', format: 'byte' };
  return { type: 'string' };
}

async function generateOpenApi(ws) {
  const loading = loadingDialog(t('db.swaggerRun'));
  try {
    const tables = ws.tables.filter(x => !x.internal && (x.type === 'table' || x.type === 'view'));
    const schemas = {}, paths = {};
    for (const tdef of tables) {
      const s = await ws.conn.schema(tdef.name);
      const props = {}, required = [];
      for (const c of s.columns) { props[c.name] = openApiType(c.type); if (c.notnull && c.default == null && !c.pk) required.push(c.name); }
      schemas[tdef.name] = { type: 'object', properties: props, ...(required.length ? { required } : {}) };
      const ref = { $ref: `#/components/schemas/${tdef.name}` };
      const pk = s.columns.filter(c => c.pk);
      const isTable = tdef.type === 'table';
      paths[`/${tdef.name}`] = {
        get: { tags: [tdef.name], summary: `List ${tdef.name}`, parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: ref } } } } } },
        ...(isTable ? { post: { tags: [tdef.name], summary: `Create ${tdef.name}`, requestBody: { required: true, content: { 'application/json': { schema: ref } } }, responses: { 201: { description: 'Created', content: { 'application/json': { schema: ref } } } } } } : {}),
      };
      if (isTable && pk.length === 1) {
        const p = pk[0].name;
        paths[`/${tdef.name}/{${p}}`] = {
          parameters: [{ name: p, in: 'path', required: true, schema: openApiType(pk[0].type) }],
          get: { tags: [tdef.name], summary: `Get ${tdef.name} by ${p}`, responses: { 200: { description: 'OK', content: { 'application/json': { schema: ref } } }, 404: { description: 'Not found' } } },
          put: { tags: [tdef.name], summary: `Update ${tdef.name}`, requestBody: { required: true, content: { 'application/json': { schema: ref } } }, responses: { 200: { description: 'OK', content: { 'application/json': { schema: ref } } } } },
          delete: { tags: [tdef.name], summary: `Delete ${tdef.name}`, responses: { 204: { description: 'Deleted' } } },
        };
      }
    }
    const spec = {
      openapi: '3.0.3',
      info: { title: `${ws.conn.meta.label} REST API`, version: '1.0.0', description: 'Auto-generated from the SQLite schema by LiteAdmin.' },
      servers: [{ url: '/api' }],
      tags: tables.map(x => ({ name: x.name })),
      paths,
      components: { schemas },
    };
    loading.remove();
    download((ws.conn.meta.label || 'api') + '.openapi.json', JSON.stringify(spec, null, 2), 'application/json');
    toast(t('db.swaggerDone'));
  } catch (e) { loading.remove(); toast(e.message, true); }
}

function historyTab(ws) {
  const list = history.list();
  ws.body.append(el('nav', { class: 'right-align toolbar' }, [
    el('button', { class: 'small border', disabled: !list.length, onClick: () => { history.clear(); selectTab(ws, 'history'); } }, [el('i', { text: 'delete_sweep' }), el('span', { text: t('sql.clear') })]),
  ]));
  if (!list.length) { ws.body.append(muted(t('start.noRecent'))); return; }
  for (const h of list) {
    const item = el('article', { class: 'history-item round border wave', role: 'button', tabindex: '0' }, [
      el('code', { text: h.sql }),
      el('div', { class: 'small-text', text: new Date(h.ts).toLocaleString() + ' · ' + h.db }),
    ]);
    const load = () => { ws.sqlText = h.sql; selectTab(ws, 'sql'); };
    item.addEventListener('click', load);
    item.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    ws.body.append(item);
  }
}

function section(title, content) { return el('section', { class: 'section' }, [el('h6', { class: 'small', text: title }), content]); }
function hint(label) { return el('p', { class: 'small-text center-align', text: label }); }
function muted(text) { return el('p', { class: 'small-text', text }); }
function errorBox(e) { return el('div', { class: 'error round padding', role: 'alert' }, [el('i', { text: 'error' }), ' ', String(e.message || e)]); }

function setSqlBlock(host, text) {
  const tok = (host._tok = (host._tok || 0) + 1);
  host.textContent = text || '';
  colorizeSql(text || '').then(html => { if (html != null && host._tok === tok) host.innerHTML = html; });
}
function sqlBlock(text, cls) {
  const host = el('pre', { class: 'code-block sql-hl' + (cls ? ' ' + cls : '') });
  setSqlBlock(host, text || '');
  return host;
}

function journalLabel(m) { return m ? String(m).toUpperCase() : '—'; }
function autoVacuumLabel(v) { return ({ 0: 'NONE', 1: 'FULL', 2: 'INCREMENTAL' })[v] || '—'; }

function walChip(info) {
  if (!info || !info.journal_mode) return null;
  const wal = String(info.journal_mode).toLowerCase() === 'wal';
  return el('span', { class: 'chip small' + (wal ? ' primary' : ''), title: t('db.journalMode'), text: wal ? 'WAL' : journalLabel(info.journal_mode) });
}
function updateWalChip(ws) {
  if (!ws.walChipEl) return;
  const fresh = walChip(ws.info);
  if (fresh) { ws.walChipEl.replaceWith(fresh); ws.walChipEl = fresh; }
}

function loadingDialog(text) {
  const dlg = el('dialog', { class: 'small' }, [el('div', { class: 'row' }, [el('progress', { class: 'circle' }), el('span', { text })])]);
  document.body.append(dlg); dlg.showModal();
  return dlg;
}

function openDialog(title, content, onSave, opts = {}) {
  const dlg = el('dialog', { class: (opts.cls || 'small') + ' fit', 'aria-label': title }, [
    el('h5', { text: title }),
    ...content,
    el('nav', { class: 'right-align' }, [
      el('button', { class: 'border', type: 'button', text: t('common.cancel'), onClick: () => dlg.remove() }),
      el('button', { type: 'button', text: opts.saveLabel || t('common.save'), onClick: async () => { const r = await onSave(); if (r !== false) dlg.remove(); } }),
    ]),
  ]);
  document.body.append(dlg); dlg.showModal();
  return dlg;
}

function inputDialog(title, label, value = '') {
  return new Promise(resolve => {
    const input = el('input', { type: 'text', value });
    let done = false;
    const finish = v => { if (done) return; done = true; dlg.remove(); resolve(v); };
    const dlg = el('dialog', { class: 'small fit', 'aria-label': title }, [
      el('h5', { text: title }),
      el('div', { class: 'field label border' }, [input, el('label', { text: label })]),
      el('nav', { class: 'right-align' }, [
        el('button', { class: 'border', text: t('common.cancel'), onClick: () => finish(null) }),
        el('button', { text: t('common.save'), onClick: () => finish(input.value.trim() || null) }),
      ]),
    ]);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(input.value.trim() || null); });
    document.body.append(dlg); dlg.showModal();
    setTimeout(() => input.focus(), 30);
  });
}
