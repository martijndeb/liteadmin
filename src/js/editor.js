import { history } from './store.js';

let monacoReady = null;
// tables: names; cols: table -> [{ name, type, pk, notnull, generated }]
const schema = { tables: [], cols: {} };
// model uri -> [{ title, run(sql) }] code lenses shown above every statement
const lensHandlers = new Map();

const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
  'CREATE VIRTUAL TABLE', 'CREATE INDEX', 'CREATE VIEW', 'CREATE TRIGGER', 'DROP TABLE', 'ALTER TABLE', 'VALUES',
  'SET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'CROSS JOIN', 'ON', 'USING', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET',
  'HAVING', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'DEFAULT', 'AUTOINCREMENT', 'STRICT', 'WITHOUT ROWID',
  'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'OVER', 'PARTITION BY', 'PRAGMA', 'EXPLAIN QUERY PLAN',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'ASC', 'DESC'];

// name: [params, doc]
const FUNCS = {
  abs: ['X', 'Absolute value of X.'], avg: ['X', 'Average of non-NULL X in the group.'],
  coalesce: ['X, Y, ...', 'First non-NULL argument.'], count: ['X', 'Number of non-NULL X (or rows with *).'],
  date: ['time-value, modifier, ...', 'Date as YYYY-MM-DD.'], datetime: ['time-value, modifier, ...', 'Date and time as YYYY-MM-DD HH:MM:SS.'],
  time: ['time-value, modifier, ...', 'Time as HH:MM:SS.'], julianday: ['time-value, modifier, ...', 'Julian day number.'],
  unixepoch: ['time-value, modifier, ...', 'Seconds since 1970-01-01.'], strftime: ['format, time-value, modifier, ...', 'Formatted date/time.'],
  group_concat: ['X, separator', 'Concatenation of non-NULL X.'], string_agg: ['X, separator', 'Concatenation of non-NULL X.'],
  ifnull: ['X, Y', 'X unless NULL, then Y.'], iif: ['cond, X, Y', 'X when cond is true, else Y.'], nullif: ['X, Y', 'NULL when X = Y, else X.'],
  instr: ['X, Y', '1-based position of Y in X, 0 if absent.'], length: ['X', 'Characters in X (bytes for a BLOB).'],
  lower: ['X', 'Lower-case X.'], upper: ['X', 'Upper-case X.'], trim: ['X, Y', 'X with Y (default spaces) stripped from both ends.'],
  ltrim: ['X, Y', 'X with Y stripped from the left.'], rtrim: ['X, Y', 'X with Y stripped from the right.'],
  replace: ['X, Y, Z', 'X with every Y replaced by Z.'], substr: ['X, start, length', 'Substring of X (1-based).'],
  printf: ['format, ...', 'printf-style formatting.'], format: ['format, ...', 'printf-style formatting.'],
  round: ['X, digits', 'X rounded to digits places.'], max: ['X, ...', 'Maximum (aggregate with one argument).'],
  min: ['X, ...', 'Minimum (aggregate with one argument).'], sum: ['X', 'Sum of non-NULL X (NULL if none).'],
  total: ['X', 'Sum of non-NULL X as REAL (0.0 if none).'], typeof: ['X', "Storage class of X: 'null', 'integer', 'real', 'text' or 'blob'."],
  random: ['', 'Pseudo-random 64-bit integer.'], hex: ['X', 'Upper-case hex of X.'], quote: ['X', 'X as an SQL literal.'],
  cast: ['X AS type', 'Convert X to type.'], json: ['X', 'Minified JSON.'], json_extract: ['json, path, ...', 'Value(s) at path.'],
  json_object: ['label, value, ...', 'JSON object from pairs.'], json_array: ['value, ...', 'JSON array.'],
  json_each: ['json, path', 'Table of the elements at path.'], json_group_array: ['X', 'Aggregate X into a JSON array.'],
  json_group_object: ['name, value', 'Aggregate pairs into a JSON object.'], json_set: ['json, path, value, ...', 'Set values at paths.'],
  row_number: ['', 'Row number within the partition.'], rank: ['', 'Rank with gaps.'], dense_rank: ['', 'Rank without gaps.'],
  lag: ['expr, offset, default', 'expr from an earlier row.'], lead: ['expr, offset, default', 'expr from a later row.'],
  first_value: ['expr', 'expr from the first row of the frame.'], last_value: ['expr', 'expr from the last row of the frame.'],
  ntile: ['N', 'Bucket number 1..N.'], last_insert_rowid: ['', 'Rowid of the last insert.'], changes: ['', 'Rows changed by the last statement.'],
};

export function setSchema(tables, columnsMap) {
  schema.tables = tables || [];
  schema.cols = {};
  for (const [tbl, cols] of Object.entries(columnsMap || {})) schema.cols[tbl] = cols.map(c => typeof c === 'string' ? { name: c } : c);
}

/* ---- SQL scanning ------------------------------------------------------ */

const STR_RE = /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
// Same-length copy with string/identifier literals as x's and comments as spaces,
// so offsets line up with the original and scans never trip on quoted text.
export function blank(sql) {
  return sql.replace(STR_RE, m => (m[0] === '-' || m[0] === '/' ? ' ' : 'x').repeat(m.length));
}

/** Statements with their offsets in the text: [{ text, start, end }]. */
export function statements(sql) {
  const b = blank(sql), out = [];
  let start = 0;
  for (let i = 0; i <= b.length; i++) {
    if (i < b.length && b[i] !== ';') continue;
    const text = sql.slice(start, i);
    const lead = text.length - text.trimStart().length;
    if (text.trim() && blank(text).trim()) out.push({ text: text.trim(), start: start + lead, end: start + text.trimEnd().length });
    start = i + 1;
  }
  return out;
}

function unquote(id) { return /^["`[]/.test(id) ? id.slice(1, -1).replace(/""/g, '"') : id; }
function findTable(name) { const n = unquote(name).toLowerCase(); return schema.tables.find(t => t.toLowerCase() === n); }
function colsOf(table) { const t = table && findTable(table); return (t && schema.cols[t]) || []; }

const NOT_ALIAS = new Set(['where', 'on', 'using', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'full', 'group', 'order',
  'limit', 'set', 'values', 'select', 'union', 'except', 'intersect', 'having', 'window', 'returning', 'default', 'as', 'indexed', 'not']);
const ID = '("(?:[^"]|"")*"|`[^`]*`|\\[[^\\]]*\\]|[\\w$]+)';

/** alias/table (lower-case) -> table name, for every table referenced in a statement. */
function tableRefs(stmt) {
  const refs = new Map();
  const re = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:${ID}\\s*\\.\\s*)?${ID}(?:\\s+(?:AS\\s+)?([\\w$]+))?`, 'gi');
  for (const m of stmt.matchAll(re)) {
    const t = findTable(m[2]);
    if (!t) continue;
    refs.set(t.toLowerCase(), t);
    if (m[3] && !NOT_ALIAS.has(m[3].toLowerCase())) refs.set(m[3].toLowerCase(), t);
  }
  return refs;
}

function stmtAt(model, position) {
  const text = model.getValue(), off = model.getOffsetAt(position);
  const st = statements(text).find(s => off >= s.start && off <= s.end + 1);
  const start = st ? st.start : off;
  return { stmt: st ? st.text : '', before: text.slice(Math.min(start, off), off) };
}

/** Split blanked text between parens at top-level commas: [{ start, end }] offsets into b. */
function splitArgs(b, open) {
  const args = [];
  let depth = 0, s = open + 1;
  for (let i = open + 1; i < b.length; i++) {
    const c = b[i];
    if (c === '(') depth++;
    else if (c === ')' && depth-- === 0) { args.push({ start: s, end: i }); return { args, close: i }; }
    else if (c === ',' && depth === 0) { args.push({ start: s, end: i }); s = i + 1; }
  }
  return { args, close: -1 };
}

function colDetail(c) { return [c.type || 'ANY', c.pk ? 'PK' : '', c.notnull ? 'NOT NULL' : '', c.generated ? 'GENERATED' : ''].filter(Boolean).join(' '); }

/** Pretty-print DDL so each column/constraint of a CREATE TABLE sits on its own line (diff-friendly). */
export function formatDdl(sql) {
  sql = String(sql || '').trim().replace(/;?\s*$/, '');
  const b = blank(sql);
  const open = b.indexOf('(');
  if (!/^CREATE\s+(TEMP\w*\s+)?TABLE\b/i.test(b) || open < 0) return sql + ';';
  const { args, close } = splitArgs(b, open);
  if (close < 0) return sql + ';';
  const body = args.map(a => '  ' + sql.slice(a.start, a.end).trim().replace(/\s*\n\s*/g, ' ')).join(',\n');
  return sql.slice(0, open).trimEnd() + ' (\n' + body + '\n)' + sql.slice(close + 1) + ';';
}

/* ---- language features -------------------------------------------------- */

function registerSqlFeatures() {
  const L = monaco.languages, C = L.CompletionItemKind, Snip = L.CompletionItemInsertTextRule.InsertAsSnippet;

  L.registerCompletionItemProvider('sql', {
    triggerCharacters: [' ', '.', '(', ','],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const { stmt, before } = stmtAt(model, position);
      const b = blank(before);
      const refs = tableRefs(stmt);
      const col = (c, t, sort) => ({ label: { label: c.name, description: t }, kind: C.Field, insertText: /^[A-Za-z_][\w$]*$/.test(c.name) ? c.name : `"${c.name}"`, detail: colDetail(c), sortText: sort + c.name, range });

      // alias.<cursor> → that table's columns only
      const dot = b.match(/([\w$]+)\s*\.\s*[\w$]*$/);
      if (dot) {
        const t = refs.get(dot[1].toLowerCase()) || findTable(dot[1]);
        if (t) return { suggestions: colsOf(t).map(c => col(c, t, '0')) };
      }
      const tableItem = t => ({ label: t, kind: C.Struct, insertText: /^[A-Za-z_][\w$]*$/.test(t) ? t : `"${t}"`, detail: `${colsOf(t).length || ''} columns`.trim(), sortText: '1' + t, range });
      // after FROM/JOIN/INTO/UPDATE/TABLE → tables
      if (/\b(FROM|JOIN|INTO|UPDATE|TABLE|ON\s+[\w$]*\s*$)\s+[\w$]*$/i.test(b) && !/\bON\s+[\w$]+\s+[\w$]*$/i.test(b)) {
        return { suggestions: schema.tables.map(tableItem) };
      }
      const suggestions = [];
      const seen = new Set();
      for (const t of new Set(refs.values())) for (const c of colsOf(t)) {
        if (seen.has(c.name)) continue; seen.add(c.name);
        suggestions.push(col(c, t, '0'));
      }
      for (const t of schema.tables) suggestions.push(tableItem(t));
      for (const [f, [params, doc]] of Object.entries(FUNCS)) {
        suggestions.push({ label: { label: f, detail: `(${params})` }, kind: C.Function, insertText: params ? `${f}($0)` : `${f}()`, insertTextRules: Snip,
          documentation: doc, sortText: '2' + f, range, command: params ? { id: 'editor.action.triggerParameterHints', title: '' } : undefined });
      }
      for (const kw of KEYWORDS) suggestions.push({ label: kw, kind: C.Keyword, insertText: kw, sortText: '3' + kw, range });
      // statement templates at the start of a statement
      if (!b.trim() || /^[\w$]*$/.test(b.trim())) {
        const snip = (label, text, doc) => suggestions.push({ label, kind: C.Snippet, insertText: text, insertTextRules: Snip, documentation: doc, sortText: '4' + label, range });
        snip('select', 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:1 = 1}\nLIMIT ${4:100}', 'SELECT … FROM … WHERE … LIMIT');
        snip('with', 'WITH ${1:cte} AS (\n  ${2:SELECT 1}\n)\nSELECT * FROM ${1:cte}', 'Common table expression');
        snip('create table', 'CREATE TABLE ${1:name} (\n  id INTEGER PRIMARY KEY,\n  ${2:col} ${3:TEXT}$0\n) STRICT', 'CREATE TABLE … STRICT');
        snip('create index', 'CREATE INDEX ${1:idx_name} ON ${2:table} (${3:col})', 'CREATE INDEX');
        for (const t of schema.tables) {
          const cs = colsOf(t).filter(c => !c.generated);
          if (!cs.length) continue;
          snip(`insert ${t}`, `INSERT INTO ${t} (${cs.map(c => c.name).join(', ')})\nVALUES (${cs.map((c, i) => '${' + (i + 1) + ':' + c.name + '}').join(', ')})`, `INSERT with every column of ${t}`);
          snip(`update ${t}`, `UPDATE ${t}\nSET \${1:${cs[0].name}} = \${2:value}\nWHERE \${3:${(cs.find(c => c.pk) || cs[0]).name}} = \${4:id}`, `UPDATE ${t}`);
        }
      }
      return { suggestions };
    },
  });

  L.registerHoverProvider('sql', {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const range = new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
      const name = w.word, lower = name.toLowerCase();
      const t = findTable(name);
      if (t) {
        const cs = colsOf(t);
        return { range, contents: [{ value: `**${t}** — table` }, { value: cs.length ? cs.map(c => `- \`${c.name}\` ${colDetail(c)}`).join('\n') : '_columns not loaded_' }] };
      }
      const line = model.getLineContent(position.lineNumber);
      if (FUNCS[lower] && line.slice(w.endColumn - 1).trimStart().startsWith('(')) {
        return { range, contents: [{ value: '```sql\n' + `${lower}(${FUNCS[lower][0]})` + '\n```' }, { value: FUNCS[lower][1] }] };
      }
      const { stmt } = stmtAt(model, position);
      const prefix = line.slice(0, w.startColumn - 1).match(/([\w$]+)\s*\.\s*$/);
      const refs = tableRefs(stmt);
      const tables = prefix ? [refs.get(prefix[1].toLowerCase()) || findTable(prefix[1])].filter(Boolean) : [...new Set(refs.values())];
      for (const tb of tables) {
        const c = colsOf(tb).find(c => c.name.toLowerCase() === lower);
        if (c) return { range, contents: [{ value: `**${tb}.${c.name}**` }, { value: '`' + colDetail(c) + '`' }] };
      }
      return null;
    },
  });

  L.registerSignatureHelpProvider('sql', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const { before } = stmtAt(model, position);
      const b = blank(before);
      let depth = 0, commas = 0;
      for (let i = b.length - 1; i >= 0; i--) {
        const c = b[i];
        if (c === ')') depth++;
        else if (c === ',' && depth === 0) commas++;
        else if (c === '(' && depth-- === 0) {
          const f = (b.slice(0, i).match(/([\w$]+)\s*$/) || [])[1];
          const def = f && FUNCS[f.toLowerCase()];
          if (!def) return null;
          const params = def[0].split(/\s*,\s*/).filter(Boolean);
          return { value: { signatures: [{ label: `${f.toLowerCase()}(${def[0]})`, documentation: def[1], parameters: params.map(p => ({ label: p })) }],
            activeSignature: 0, activeParameter: Math.min(commas, Math.max(params.length - 1, 0)) }, dispose() {} };
        }
      }
      return null;
    },
  });

  // Ghost text: finish the statement from query history when what's typed is a prefix of one.
  L.registerInlineCompletionsProvider('sql', {
    provideInlineCompletions(model, position) {
      const { before } = stmtAt(model, position);
      if (before.trim().length < 3 || model.getLineContent(position.lineNumber).length >= position.column) return { items: [] };
      const lower = before.toLowerCase();
      const items = [];
      for (const h of history.list()) {
        if (h.sql.length > before.length && h.sql.toLowerCase().startsWith(lower)) {
          items.push({ insertText: h.sql.slice(before.length), range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) });
          if (items.length >= 5) break;
        }
      }
      return { items };
    },
    disposeInlineCompletions() {},
    freeInlineCompletions() {},
  });

  // Inlay hints: column names before INSERT values, parameter names in function calls.
  L.registerInlayHintsProvider('sql', {
    provideInlayHints(model) {
      const text = model.getValue();
      const hints = [];
      const hint = (off, label) => hints.push({ label: label + ':', position: model.getPositionAt(off), kind: L.InlayHintKind.Parameter, paddingRight: true });
      const firstNonSpace = (b, a) => { let i = a.start; while (i < a.end && /\s/.test(b[i])) i++; return i < a.end ? i : -1; };
      for (const st of statements(text)) {
        const b = blank(text.slice(0, st.end));
        const seg = b.slice(st.start);
        const ins = seg.match(new RegExp(`^\\s*(?:INSERT|REPLACE)(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+(?:${ID}\\s*\\.\\s*)?${ID}(?:\\s+AS\\s+[\\w$]+)?\\s*(\\()?`, 'i'));
        if (ins) {
          const realName = text.substr(st.start + ins.index + ins[0].indexOf(ins[2], ins[0].search(/INTO/i)), ins[2].length);
          let names = colsOf(realName).filter(c => !c.generated).map(c => c.name);
          let from = st.start + ins[0].length;
          if (ins[3]) {
            const { args, close } = splitArgs(b, from - 1);
            if (close < 0) continue;
            names = args.map(a => unquote(text.slice(a.start, a.end).trim()));
            from = close + 1;
          }
          const vm = b.slice(from).match(/^\s*VALUES\s*/i);
          if (vm && names.length) {
            let i = from + vm[0].length;
            while (b[i] === '(') {
              const { args, close } = splitArgs(b, i);
              if (close < 0) break;
              args.forEach((a, k) => { const p = firstNonSpace(b, a); if (p >= 0 && names[k]) hint(p, names[k]); });
              i = close + 1;
              while (/[\s,]/.test(b[i] || '')) i++;
            }
          }
        }
        for (const m of seg.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
          const def = FUNCS[m[1].toLowerCase()];
          if (!def) continue;
          const params = def[0].split(/\s*,\s*/).filter(p => p && p !== '...');
          if (params.length < 2) continue;
          const { args } = splitArgs(b, st.start + m.index + m[0].length - 1);
          args.forEach((a, k) => { const p = firstNonSpace(b, a); if (p >= 0 && params[k] && !params[k].includes(' ')) hint(p, params[k]); });
        }
      }
      return { hints, dispose() {} };
    },
  });

  // Code lenses: Run / Explain above every statement of editors that registered handlers.
  monaco.editor.registerCommand('liteadmin.lens', (_, uri, idx, sql) => {
    const h = lensHandlers.get(uri);
    if (h && h[idx]) h[idx].run(sql);
  });
  L.registerCodeLensProvider('sql', {
    provideCodeLenses(model) {
      const handlers = lensHandlers.get(model.uri.toString());
      if (!handlers) return { lenses: [], dispose() {} };
      const lenses = [];
      for (const st of statements(model.getValue())) {
        const line = model.getPositionAt(st.start).lineNumber;
        const range = { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
        handlers.forEach((h, i) => {
          if (h.when && !h.when(st.text)) return;
          lenses.push({ range, command: { id: 'liteadmin.lens', title: h.title, arguments: [model.uri.toString(), i, st.text] } });
        });
      }
      return { lenses, dispose() {} };
    },
  });
}

/* ---- editors ----------------------------------------------------------- */

const theme = () => document.documentElement.style.colorScheme === 'dark' ? 'vs-dark' : 'vs';
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
// Block-rendered navigator; the slider only shows on hover so it stays quiet in short queries.
const MINIMAP = enabled => ({ enabled, renderCharacters: false, showSlider: 'mouseover', maxColumn: 80 });

export function initMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise(resolve => {
    // Monaco ships a German UI bundle; the other app languages fall back to English.
    const nls = document.documentElement.lang === 'de' ? { 'vs/nls': { availableLanguages: { '*': 'de' } } } : {};
    window.require.config({ paths: { vs: 'vendor/vs' }, ...nls });
    window.require(['vs/editor/editor.main'], () => {
      registerSqlFeatures();
      resolve(window.monaco);
    });
  });
  return monacoReady;
}

/**
 * opts.lenses: [{ title, run(sql), when?(sql) }] — code lenses above each statement.
 */
export async function createEditor(host, value, fontSize, opts = {}) {
  await initMonaco();
  const language = opts.language || 'sql';
  if (language === 'json') {
    try { (monaco.json || monaco.languages.json).jsonDefaults.setDiagnosticsOptions({ validate: false, enableSchemaRequest: false }); } catch (_) {}
  }
  const lineNumbers = opts.lineNumbers || 'on';
  const numbered = lineNumbers !== 'off';
  const folding = opts.folding ?? true;
  const editor = monaco.editor.create(host, {
    value: value || '',
    language,
    theme: theme(),
    automaticLayout: true,
    minimap: MINIMAP(opts.minimap ?? true),
    fontSize: fontSize || 14,
    fontFamily: FONT,
    scrollBeyondLastLine: false,
    wordWrap: opts.wordWrap || 'on',
    tabSize: 2,
    readOnly: !!opts.readOnly,
    lineNumbers,
    lineNumbersMinChars: numbered ? 3 : 0,
    lineDecorationsWidth: numbered ? 8 : 0,
    glyphMargin: false,
    folding,
    showFoldingControls: 'mouseover',
    renderLineHighlight: numbered ? 'line' : 'none',
    overviewRulerLanes: folding ? 2 : 0,
    hideCursorInOverviewRuler: true,
    fixedOverflowWidgets: true,
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    suggest: { showStatusBar: true, preview: true, localityBonus: true },
    inlineSuggest: { enabled: true, mode: 'prefix' },
    parameterHints: { enabled: true, cycle: true },
    inlayHints: { enabled: 'on', fontSize: Math.max((fontSize || 14) - 3, 9) },
    codeLens: !!opts.lenses,
    bracketPairColorization: { enabled: true },
    tabCompletion: 'on',
    padding: { top: 10, bottom: 10 },
  });
  if (opts.lenses) {
    const uri = editor.getModel().uri.toString();
    lensHandlers.set(uri, opts.lenses);
    editor.onDidDispose(() => lensHandlers.delete(uri));
  }
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => editor.trigger('keyboard', 'editor.action.triggerSuggest', {}));
  return editor;
}

/**
 * Side-by-side diff of two SQL texts. The right side stays editable and the diff
 * recomputes as you type; set() swaps both texts in place (e.g. on a new selection).
 */
export async function createDiffEditor(host, original, modified, fontSize) {
  await initMonaco();
  const editor = monaco.editor.createDiffEditor(host, {
    theme: theme(),
    automaticLayout: true,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: false,
    originalEditable: false,
    ignoreTrimWhitespace: false,
    renderOverviewRuler: true,
    minimap: MINIMAP(true),
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    fontSize: fontSize || 14,
    fontFamily: FONT,
    hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
  });
  const models = { original: monaco.editor.createModel(original || '', 'sql'), modified: monaco.editor.createModel(modified || '', 'sql') };
  editor.setModel(models);
  return {
    editor,
    set(a, b) { models.original.setValue(a || ''); models.modified.setValue(b || ''); },
    dispose() { editor.dispose(); models.original.dispose(); models.modified.dispose(); },
  };
}

export function setEditorTheme(dark) {
  if (window.monaco) monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
}

export async function colorizeSql(text) {
  try {
    await initMonaco();
    const dark = document.documentElement.style.colorScheme === 'dark';
    monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
    return await monaco.editor.colorize(text || '', 'sql', { tabSize: 2 });
  } catch (_) { return null; }
}
