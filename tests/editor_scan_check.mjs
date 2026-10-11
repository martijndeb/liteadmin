// Self-check for the SQL scanning helpers behind the editor's lenses, inlay hints
// and schema diff. Run: node tests/editor_scan_check.mjs
import assert from 'node:assert/strict';
globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { blank, statements, formatDdl } = await import('../src/js/editor.js');

const sql = "SELECT ';' AS a; -- c;\nINSERT INTO t VALUES (1, 'x;y');\n\n  ;";
assert.equal(blank(sql).length, sql.length);
assert.deepEqual(statements(sql).map(s => s.text), ["SELECT ';' AS a", "-- c;\nINSERT INTO t VALUES (1, 'x;y')"]);
for (const s of statements(sql)) assert.equal(sql.slice(s.start, s.end), s.text);
assert.deepEqual(statements('-- only a comment'), []);

assert.equal(formatDdl('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT DEFAULT \'a,b\', CHECK (n IN (1,2))) STRICT'),
  "CREATE TABLE t (\n  id INTEGER PRIMARY KEY,\n  n TEXT DEFAULT 'a,b',\n  CHECK (n IN (1,2))\n) STRICT;");
assert.equal(formatDdl('CREATE INDEX i ON t (a, b)'), 'CREATE INDEX i ON t (a, b);');
console.log('editor scan ok');
