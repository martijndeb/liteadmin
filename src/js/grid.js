import { el, isJsonish, jsonDialog } from './util.js';

export function renderGrid({ columns, rows, sort, onSort, rowActions, links }) {
  const thead = el('tr', {}, [
    rowActions ? el('th', { 'aria-label': 'actions' }) : null,
    ...columns.map(c => {
      const isSort = sort && sort.col === c;
      const th = el('th', {
        scope: 'col',
        tabindex: onSort ? '0' : null,
        role: onSort ? 'button' : null,
        'aria-sort': isSort ? (sort.dir === 'desc' ? 'descending' : 'ascending') : null,
        title: c,
      }, [el('span', { text: c }), onSort ? el('span', { class: 'sort-ind' }) : null]);
      if (onSort) {
        th.addEventListener('click', () => onSort(c));
        th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(c); } });
      }
      return th;
    }),
  ]);

  const body = el('tbody', {}, rows.map((row, ri) => el('tr', {}, [
    rowActions ? el('td', {}, [rowActions(row, ri)]) : null,
    ...row.map((val, ci) => {
      const isNull = val === null || val === undefined;
      const json = !isNull && isJsonish(val);
      const link = !isNull && links && links[columns[ci]];
      const td = el('td', { class: isNull ? 'null' : (link ? 'fk-link' : (json ? 'json-cell' : null)), title: isNull ? 'NULL' : String(val) });
      td.textContent = isNull ? 'NULL' : (val instanceof Uint8Array ? `[BLOB ${val.length}]` : String(val));
      if (link) { td.tabIndex = 0; td.addEventListener('click', () => links[columns[ci]](val)); td.addEventListener('keydown', e => { if (e.key === 'Enter') links[columns[ci]](val); }); }
      else if (json) { td.tabIndex = 0; td.addEventListener('click', () => jsonDialog(val)); td.addEventListener('keydown', e => { if (e.key === 'Enter') jsonDialog(val); }); }
      return td;
    }),
  ])));

  const table = el('table', { class: 'datagrid' }, [el('thead', {}, [thead]), body]);
  return el('div', { class: 'grid-wrap' }, [table]);
}
