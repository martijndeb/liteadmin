export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function qid(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(message, error = false) {
  const bar = document.getElementById('snackbar');
  bar.className = 'snackbar show' + (error ? ' error' : '');
  bar.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { bar.className = 'snackbar'; }, error ? 6000 : 3000);
}

export function download(filename, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function csvField(v) {
  if (v == null) return '';
  if (v instanceof Uint8Array) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(columns, rows) {
  const lines = [columns.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function parseCsv(text) {
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  const s = text.replace(/\r\n?/g, '\n');
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
  if (!nonEmpty.length) return { columns: [], rows: [] };
  return { columns: nonEmpty[0], rows: nonEmpty.slice(1) };
}

export function sqlLiteral(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Uint8Array) { let h = ''; for (const b of v) h += b.toString(16).padStart(2, '0'); return "X'" + h + "'"; }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function toSqlInserts(table, columns, rows) {
  const cols = '(' + columns.map(qid).join(', ') + ')';
  return rows.map(r => `INSERT INTO ${qid(table)} ${cols} VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n') + '\n';
}

export function toJsonRows(columns, rows) {
  return JSON.stringify(rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i] instanceof Uint8Array ? null : r[i]]))), null, 2);
}

export function isJsonish(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 2 || !/^[[{]/.test(s)) return false;
  try { const p = JSON.parse(s); return typeof p === 'object' && p !== null; } catch (_) { return false; }
}

export function formatJson(v) {
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch (_) { return String(v); }
}

export function jsonDialog(text, title = 'JSON') {
  const dlg = el('dialog', { class: 'medium fit', 'aria-label': title }, [
    el('h5', { text: title }),
    el('pre', { class: 'code-block scroll' }, [el('code', { text: formatJson(text) })]),
    el('nav', { class: 'right-align' }, [el('button', { text: 'Close', onClick: () => dlg.remove() })]),
  ]);
  document.body.append(dlg); dlg.showModal();
  return dlg;
}

export async function confirmDialog(message) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'small', 'aria-modal': 'true' }, [
      el('p', { text: message }),
      el('nav', { class: 'right-align' }, [
        el('button', { class: 'border', text: 'Cancel', onClick: () => { dlg.remove(); resolve(false); } }),
        el('button', { text: 'OK', onClick: () => { dlg.remove(); resolve(true); } }),
      ]),
    ]);
    document.body.append(dlg);
    dlg.showModal();
  });
}
