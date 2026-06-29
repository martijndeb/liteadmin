const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}

const W = 210, HEAD = 28, ROW = 19, MAXROWS = 14, GAPX = 56, GAPY = 44, PAD = 16;

export function erSvg(tables) {
  if (!tables.length) return s('svg', { width: 0, height: 0 });
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  const boxH = t => HEAD + Math.min(t.columns.length, MAXROWS) * ROW + 8 + (t.columns.length > MAXROWS ? ROW : 0);
  const grid = [];
  tables.forEach((t, i) => { const r = Math.floor(i / cols); (grid[r] = grid[r] || []).push({ t, i }); });
  const pos = {};
  let y = PAD;
  for (const r of grid) {
    const rh = Math.max(...r.map(o => boxH(o.t)));
    for (const o of r) pos[o.t.name] = { x: PAD + (o.i % cols) * (W + GAPX), y, w: W, h: boxH(o.t) };
    y += rh + GAPY;
  }
  const width = PAD * 2 + cols * W + (cols - 1) * GAPX;
  const height = y;
  const root = s('svg', { class: 'er-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  const anchor = (from, to) => {
    const fx = from.x + from.w / 2, fy = from.y + from.h / 2, tx = to.x + to.w / 2, ty = to.y + to.h / 2;
    const dx = tx - fx, dy = ty - fy;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: fx + (dx > 0 ? from.w / 2 : -from.w / 2), y: fy };
    return { x: fx, y: fy + (dy > 0 ? from.h / 2 : -from.h / 2) };
  };
  for (const t of tables) for (const fk of t.fks) {
    const a = pos[t.name], b = pos[fk.table];
    if (!a || !b) continue;
    const p1 = anchor(a, b), p2 = anchor(b, a);
    root.append(s('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'er-edge' }));
    root.append(s('circle', { cx: p2.x, cy: p2.y, r: 4, class: 'er-end' }));
    root.append(s('circle', { cx: p1.x, cy: p1.y, r: 2.5, class: 'er-start' }));
  }
  for (const t of tables) {
    const p = pos[t.name];
    const g = s('g', {});
    g.append(s('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 8, class: 'er-box' }));
    g.append(s('path', { d: `M${p.x + 8} ${p.y} h${p.w - 16} a8 8 0 0 1 8 8 v${HEAD - 8} h${-p.w} v${-(HEAD - 8)} a8 8 0 0 1 8 -8 z`, class: 'er-head' }));
    g.append(s('text', { x: p.x + 10, y: p.y + 19, class: 'er-title' }, [t.name]));
    const shown = t.columns.slice(0, MAXROWS);
    shown.forEach((c, i) => {
      const ty = p.y + HEAD + 14 + i * ROW;
      g.append(s('text', { x: p.x + 10, y: ty, class: 'er-col' + (c.pk ? ' pk' : '') }, [c.name]));
      if (c.pk || c.fk) g.append(s('text', { x: p.x + p.w - 8, y: ty, class: 'er-tag', 'text-anchor': 'end' }, [c.pk ? 'PK' : 'FK']));
    });
    if (t.columns.length > MAXROWS) g.append(s('text', { x: p.x + 10, y: p.y + HEAD + 14 + MAXROWS * ROW, class: 'er-more' }, [`… +${t.columns.length - MAXROWS}`]));
    root.append(g);
  }
  return root;
}

function mId(name) { return /^[A-Za-z_]\w*$/.test(name) ? name : '"' + String(name).replace(/"/g, '') + '"'; }
function mType(c) { return ((c.type || 'text').replace(/[^A-Za-z0-9_]/g, '') || 'text'); }

export function erMermaid(tables) {
  const names = new Set(tables.map(t => t.name));
  const lines = ['erDiagram'];
  for (const t of tables) {
    lines.push(`  ${mId(t.name)} {`);
    for (const c of t.columns) lines.push(`    ${mType(c)} ${mId(c.name)}${c.pk ? ' PK' : (c.fk ? ' FK' : '')}`);
    lines.push('  }');
  }
  for (const t of tables) for (const fk of t.fks) {
    if (!names.has(fk.table)) continue;
    lines.push(`  ${mId(fk.table)} ||--o{ ${mId(t.name)} : "${fk.from}"`);
  }
  return lines.join('\n');
}
