import { Api } from './api.js';
import { qid, download } from './util.js';

let sqlPromise = null;
function getSql() {
  if (!sqlPromise) sqlPromise = window.initSqlJs({ locateFile: f => 'vendor/' + f });
  return sqlPromise;
}

function rowsToObjects(res) {
  if (!res || !res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

export const MAINTENANCE = [
  { id: 'integrity', icon: 'verified', kind: 'query', sql: 'PRAGMA integrity_check', default: true,
    report: r => r.rows && r.rows.length ? r.rows.map(x => x[0]).join('; ') : 'ok' },
  { id: 'fkcheck', icon: 'link', kind: 'query', sql: 'PRAGMA foreign_key_check', default: true,
    report: r => r.rows && r.rows.length ? `${r.rows.length} violation(s)` : 'ok' },
  { id: 'optimize', icon: 'tune', kind: 'exec', sql: 'PRAGMA optimize', default: true },
  { id: 'analyze', icon: 'analytics', kind: 'exec', sql: 'ANALYZE', default: true },
  { id: 'reindex', icon: 'autorenew', kind: 'exec', sql: 'REINDEX', default: false },
  { id: 'vacuum', icon: 'compress', kind: 'exec', sql: 'VACUUM', default: true },
  { id: 'checkpoint', icon: 'save', kind: 'query', sql: 'PRAGMA wal_checkpoint(TRUNCATE)', default: false, serverOnly: true,
    report: () => 'done' },
];

async function runTaskOn(conn, task) {
  const t0 = performance.now();
  try {
    let output;
    if (task.kind === 'query') {
      const r = await conn.query(task.sql, { limit: 500 });
      output = task.report ? task.report(r) : 'ok';
    } else {
      const r = await conn.exec(task.sql);
      output = (r && r.changes) ? `${r.changes} changes` : 'done';
    }
    return { ok: true, output, elapsed: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, output: e.message, elapsed: Math.round(performance.now() - t0) };
  }
}

class ServerConnection {
  constructor(meta) { this.meta = meta; this.readonly = !!meta.readonly; }
  get id() { return this.meta.id; }
  get kind() { return 'server'; }
  async tables() { return (await Api.proxy('tables', { db: this.id })).tables; }
  async schema(table) { return Api.proxy('schema', { db: this.id, table }); }
  async browse(table, o = {}) { return Api.proxy('browse', { db: this.id, table, ...o }); }
  async query(sql, o = {}) { return Api.proxy('query', { db: this.id, sql, ...o }); }
  async exec(sql, params) { return Api.proxy('exec', { db: this.id, sql, params: params || null }); }
  async transaction(sql, opts = {}) { return Api.proxy('exec', { db: this.id, sql, tx: true, fkoff: !!opts.fkOff }); }
  async backup() { download((this.meta.label || this.id) + '.sqlite', await Api.backupBlob(this.id)); }
  async optimize() { return (await Api.proxy('optimize', { db: this.id })).report; }
  async size() { const i = await this.dbInfo().catch(() => null); return i ? i.size : null; }
  async dbInfo() { return (await Api.proxy('info', { db: this.id })).info; }
  async runTask(task) { return runTaskOn(this, task); }
}

class LocalConnection {
  constructor(meta, db, handle) {
    this.meta = meta; this.db = db; this.handle = handle || null;
    this.readonly = false; this.dirty = false;
  }
  get id() { return this.meta.id; }
  get kind() { return 'local'; }

  async tables() {
    const res = this.db.exec("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY type,name");
    return rowsToObjects(res).map(r => ({
      name: r.name,
      type: /^CREATE VIRTUAL TABLE/i.test(r.sql || '') ? 'virtual' : r.type,
      internal: r.name.startsWith('sqlite_'),
    }));
  }

  colNames(table) {
    return rowsToObjects(this.db.exec(`PRAGMA table_info(${qid(table)})`)).map(c => c.name);
  }

  async schema(table) {
    const columns = rowsToObjects(this.db.exec(`PRAGMA table_xinfo(${qid(table)})`))
      .filter(c => Number(c.hidden) !== 1)
      .map(c => ({
        name: c.name, type: c.type, notnull: c.notnull, default: c.dflt_value, pk: c.pk,
        generated: Number(c.hidden) === 2 ? 'virtual' : (Number(c.hidden) === 3 ? 'stored' : null),
      }));
    const foreign_keys = rowsToObjects(this.db.exec(`PRAGMA foreign_key_list(${qid(table)})`));
    const indexes = rowsToObjects(this.db.exec(`PRAGMA index_list(${qid(table)})`)).map(ix => ({
      name: ix.name, unique: ix.unique, origin: ix.origin,
      columns: rowsToObjects(this.db.exec(`PRAGMA index_info(${qid(ix.name)})`)).map(c => c.name),
    }));
    const sqlRes = this.db.exec('SELECT sql FROM sqlite_master WHERE name=?', [table]);
    let strict = false, without_rowid = false;
    try { const tl = rowsToObjects(this.db.exec(`PRAGMA table_list(${qid(table)})`))[0]; if (tl) { strict = !!tl.strict; without_rowid = !!tl.wr; } } catch (_) {}
    return { columns, foreign_keys, indexes, sql: sqlRes.length ? sqlRes[0].values[0][0] : '', strict, without_rowid };
  }

  async browse(table, o = {}) {
    const limit = Math.max(1, o.limit || 50), offset = Math.max(0, o.offset || 0);
    const names = this.colNames(table);
    let order = '';
    if (o.order && names.includes(o.order)) order = ` ORDER BY ${qid(o.order)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`;
    const total = this.db.exec(`SELECT COUNT(*) FROM ${qid(table)}`)[0].values[0][0];
    const res = this.db.exec(`SELECT * FROM ${qid(table)}${order} LIMIT ${limit} OFFSET ${offset}`);
    return { columns: names, rows: res.length ? res[0].values : [], total, offset, limit };
  }

  async query(sql, o = {}) {
    const limit = Math.max(1, o.limit || 200);
    const t0 = performance.now();
    const res = this.db.exec(sql, o.params || undefined);
    const elapsed = Math.round(performance.now() - t0);
    if (res.length) {
      const last = res[res.length - 1];
      const truncated = last.values.length > limit;
      return { columns: last.columns, rows: last.values.slice(0, limit), truncated, limit, elapsed };
    }
    await this.persist();
    return { changes: this.db.getRowsModified(), elapsed };
  }

  async exec(sql, params) {
    const t0 = performance.now();
    if (params) this.db.run(sql, params); else this.db.exec(sql);
    await this.persist();
    return { changes: this.db.getRowsModified(), last_insert_id: this.db.exec('SELECT last_insert_rowid()')[0].values[0][0], elapsed: Math.round(performance.now() - t0) };
  }

  async transaction(sql, opts = {}) {
    const t0 = performance.now();
    if (opts.fkOff) try { this.db.exec('PRAGMA foreign_keys=OFF'); this.db.exec('PRAGMA legacy_alter_table=ON'); } catch (_) {}
    const restore = () => { if (opts.fkOff) try { this.db.exec('PRAGMA legacy_alter_table=OFF'); this.db.exec('PRAGMA foreign_keys=ON'); } catch (_) {} };
    this.db.exec('BEGIN');
    try { this.db.exec(sql); this.db.exec('COMMIT'); }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} restore(); throw e; }
    restore();
    await this.persist();
    return { changes: this.db.getRowsModified(), elapsed: Math.round(performance.now() - t0) };
  }

  export() { return this.db.export(); }

  async persist() {
    if (this.handle) {
      const w = await this.handle.createWritable();
      await w.write(this.export()); await w.close();
      this.dirty = false;
    } else {
      this.dirty = true;
    }
  }

  async save() {
    if (this.handle) return this.persist();
    download((this.meta.label || 'database') + '.sqlite', this.export());
    this.dirty = false;
  }

  async backup() { download((this.meta.label || 'database') + '.sqlite', this.export()); }
  async size() { return this.export().length; }

  async runTask(task) { return runTaskOn(this, task); }

  async dbInfo() {
    const val = q => { const r = this.db.exec(q); return r.length ? r[0].values[0][0] : null; };
    const compile = () => { const r = this.db.exec('PRAGMA compile_options'); return r.length ? r[0].values.map(v => v[0]) : []; };
    return {
      journal_mode: 'memory',
      page_size: val('PRAGMA page_size'),
      page_count: val('PRAGMA page_count'),
      freelist_count: val('PRAGMA freelist_count'),
      auto_vacuum: val('PRAGMA auto_vacuum'),
      sqlite_version: val('SELECT sqlite_version()'),
      size: this.export().length,
      extensions: [],
      compile_options: compile(),
    };
  }

  async optimize() {
    const before = this.export().length;
    const val = q => { const r = this.db.exec(q); return r.length ? r[0].values[0][0] : null; };
    this.db.exec('PRAGMA optimize');
    this.db.run('ANALYZE');
    this.db.run('VACUUM');
    const report = {
      journal_mode: 'memory (in-browser)',
      integrity: val('PRAGMA integrity_check'),
      page_size: val('PRAGMA page_size'),
      page_count: val('PRAGMA page_count'),
      freelist_count: val('PRAGMA freelist_count'),
      size_before: before,
      size_after: this.export().length,
      steps: ['PRAGMA optimize', 'ANALYZE', 'VACUUM'],
    };
    await this.persist();
    return report;
  }
}

export async function openServer(meta) { return new ServerConnection(meta); }

export async function openLocal(meta, bytes, handle) {
  const SQL = await getSql();
  const db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  return new LocalConnection(meta, db, handle);
}

const IDB = 'liteadmin', STORE = 'handles';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function saveHandle(id, handle) {
  try { const db = await idb(); db.transaction(STORE, 'readwrite').objectStore(STORE).put(handle, id); } catch (_) {}
}
export async function loadHandle(id) {
  try {
    const db = await idb();
    return await new Promise(res => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null);
    });
  } catch (_) { return null; }
}
