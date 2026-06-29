let monacoReady = null;
const schema = { tables: [], columns: {}, allColumns: [] };

const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
  'CREATE VIRTUAL TABLE', 'CREATE INDEX', 'CREATE VIEW', 'DROP TABLE', 'ALTER TABLE', 'VALUES',
  'SET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET',
  'HAVING', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'PRIMARY KEY', 'FOREIGN KEY',
  'REFERENCES', 'UNIQUE', 'DEFAULT', 'AUTOINCREMENT', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK'];

export function setSchema(tables, columnsMap) {
  schema.tables = tables || [];
  schema.columns = columnsMap || {};
  schema.allColumns = [...new Set(Object.values(schema.columns).flat())];
}

export function initMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise(resolve => {
    window.require.config({ paths: { vs: 'vendor/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: [' ', '.', '('],
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          const C = monaco.languages.CompletionItemKind;
          const suggestions = [];
          for (const tbl of schema.tables) suggestions.push({ label: tbl, kind: C.Struct, insertText: tbl, detail: 'table', range });
          for (const col of schema.allColumns) suggestions.push({ label: col, kind: C.Field, insertText: col, detail: 'column', range });
          for (const kw of KEYWORDS) suggestions.push({ label: kw, kind: C.Keyword, insertText: kw, range });
          return { suggestions };
        },
      });
      resolve(window.monaco);
    });
  });
  return monacoReady;
}

export async function createEditor(host, value, fontSize) {
  await initMonaco();
  const editor = monaco.editor.create(host, {
    value: value || '',
    language: 'sql',
    theme: document.documentElement.style.colorScheme === 'dark' ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: fontSize || 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    tabSize: 2,
    lineNumbers: 'off',
    lineNumbersMinChars: 0,
    lineDecorationsWidth: 0,
    glyphMargin: false,
    folding: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    fixedOverflowWidgets: true,
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    tabCompletion: 'on',
    padding: { top: 10, bottom: 10 },
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => editor.trigger('keyboard', 'editor.action.triggerSuggest', {}));
  return editor;
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
