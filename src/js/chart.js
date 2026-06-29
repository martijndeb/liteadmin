const SVGNS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}

export function barChart({ labels, values, height = 240 }) {
  const n = values.length;
  if (!n) return svg('svg', { width: 0, height: 0 });
  const padL = 48, padB = 64, padT = 12, padR = 12;
  const barGap = 8;
  const innerH = height - padB - padT;
  const width = Math.max(360, n * 56 + padL + padR);
  const innerW = width - padL - padR;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = (max - min) || 1;
  const y0 = padT + (max / span) * innerH;
  const bw = Math.max(6, innerW / n - barGap);

  const root = svg('svg', { class: 'bar-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  root.append(svg('line', { x1: padL, y1: y0, x2: width - padR, y2: y0, class: 'axis' }));
  root.append(svg('text', { x: padL - 6, y: padT + 4, class: 'tick', 'text-anchor': 'end' }, [fmt(max)]));
  root.append(svg('text', { x: padL - 6, y: y0 + 4, class: 'tick', 'text-anchor': 'end' }, ['0']));

  values.forEach((v, i) => {
    const x = padL + i * (innerW / n) + barGap / 2;
    const h = Math.abs(v) / span * innerH;
    const y = v >= 0 ? y0 - h : y0;
    root.append(svg('rect', { x, y, width: bw, height: Math.max(1, h), rx: 4, class: 'bar' }));
    root.append(svg('text', { x: x + bw / 2, y: (v >= 0 ? y - 4 : y + h + 12), class: 'val', 'text-anchor': 'middle' }, [fmt(v)]));
    const lbl = String(labels[i] == null ? '' : labels[i]);
    root.append(svg('text', { x: x + bw / 2, y: height - padB + 16, class: 'label', 'text-anchor': 'end', transform: `rotate(-40 ${x + bw / 2} ${height - padB + 16})` }, [lbl.length > 18 ? lbl.slice(0, 17) + '…' : lbl]));
  });
  return root;
}

export function lineChart({ labels, values, height = 240 }) {
  const n = values.length;
  if (!n) return svg('svg', { width: 0, height: 0 });
  const padL = 48, padB = 64, padT = 12, padR = 16;
  const innerH = height - padB - padT;
  const width = Math.max(360, n * 48 + padL + padR);
  const innerW = width - padL - padR;
  const max = Math.max(0, ...values), min = Math.min(0, ...values);
  const span = (max - min) || 1;
  const xAt = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = v => padT + (max - v) / span * innerH;

  const root = svg('svg', { class: 'line-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const y0 = yAt(0);
  root.append(svg('line', { x1: padL, y1: y0, x2: width - padR, y2: y0, class: 'axis' }));
  root.append(svg('text', { x: padL - 6, y: padT + 4, class: 'tick', 'text-anchor': 'end' }, [fmt(max)]));
  root.append(svg('text', { x: padL - 6, y: y0 + 4, class: 'tick', 'text-anchor': 'end' }, ['0']));

  const pts = values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
  root.append(svg('polyline', { points: pts, class: 'line' }));
  values.forEach((v, i) => {
    root.append(svg('circle', { cx: xAt(i), cy: yAt(v), r: 3, class: 'dot' }));
    const step = Math.ceil(n / 12);
    if (i % step === 0) {
      const lbl = String(labels[i] == null ? '' : labels[i]);
      root.append(svg('text', { x: xAt(i), y: height - padB + 16, class: 'label', 'text-anchor': 'end', transform: `rotate(-40 ${xAt(i)} ${height - padB + 16})` }, [lbl.length > 16 ? lbl.slice(0, 15) + '…' : lbl]));
    }
  });
  return root;
}

function fmt(v) {
  if (v == null || isNaN(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
