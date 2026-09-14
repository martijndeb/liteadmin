<?php

/**
 * Service published as "restapi". Holds the exposure configuration (which
 * databases/tables are served), schema introspection, the CRUD primitives the
 * front controller (api.php) calls, and the OpenAPI generator.
 *
 * Exposure is stored in a SQLite database in the plugin data dir (restapi.sqlite,
 * mirroring liteadmin-apikeys): one row per exposed database/table pair. A table
 * is served only while its row is present, so a fresh install serves nothing.
 */
class RestApiService {
    private $pdo;

    function __construct(PDO $pdo) { $this->pdo = $pdo; }

    /* ---- identifier helpers -------------------------------------------- */

    /** Quote an SQLite identifier. Callers must validate against the schema first. */
    static function qid($name) { return '"' . str_replace('"', '""', (string)$name) . '"'; }

    /** URL slug for a database key ("managed:foo.sqlite" -> "foo.sqlite"). */
    static function slug($key) { return strncmp((string)$key, 'managed:', 8) === 0 ? substr($key, 8) : (string)$key; }

    /** Map of slug => internal database key for every configured/managed db. */
    static function slugMap() {
        $map = [];
        foreach (App::databases() as $key => $_) $map[self::slug($key)] = $key;
        return $map;
    }

    static function keyForSlug($slug) {
        $map = self::slugMap();
        return $map[(string)$slug] ?? null;
    }

    /* ---- schema introspection ------------------------------------------ */

    /** Names of the real (non-internal) tables in an open database. */
    static function tables(PDO $pdo) {
        $st = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        return $st->fetchAll(PDO::FETCH_COLUMN) ?: [];
    }

    /** table_info rows. $table must already be a known table name. */
    static function columns(PDO $pdo, $table) {
        return $pdo->query('PRAGMA table_info(' . self::qid($table) . ')')->fetchAll(PDO::FETCH_ASSOC);
    }

    /** ['names' => [...], 'pk' => [...], 'cols' => [table_info rows]] */
    static function schema(PDO $pdo, $table) {
        $names = []; $pk = []; $cols = self::columns($pdo, $table);
        foreach ($cols as $c) {
            $names[] = $c['name'];
            if ((int)$c['pk'] > 0) $pk[] = $c['name'];
        }
        return ['names' => $names, 'pk' => $pk, 'cols' => $cols];
    }

    /** Single-column primary key when there is exactly one, else the implicit rowid. */
    static function idColumn(PDO $pdo, $table) {
        $pk = self::schema($pdo, $table)['pk'];
        return count($pk) === 1 ? $pk[0] : 'rowid';
    }

    /** Quote the id column, leaving the special rowid unquoted so SQLite treats it as such. */
    private static function idExpr($idc) { return $idc === 'rowid' ? 'rowid' : self::qid($idc); }

    /** Normalise a JSON value for binding into SQLite. */
    private static function bind($v) {
        if (is_bool($v)) return $v ? 1 : 0;
        if (is_array($v)) return json_encode($v, JSON_UNESCAPED_SLASHES);
        return $v;
    }

    /* ---- exposure configuration (SQLite-backed) ------------------------ */

    /** Persist the selection: replace all rows with the given db key => [tables] map. */
    function saveExposure(array $databases) {
        $this->pdo->beginTransaction();
        try {
            $this->pdo->exec('DELETE FROM exposure');
            $st = $this->pdo->prepare('INSERT OR IGNORE INTO exposure (db_key, table_name) VALUES (?, ?)');
            foreach ($databases as $key => $tables) {
                if (!is_array($tables)) continue;
                foreach (array_unique(array_map('strval', $tables)) as $t) $st->execute([(string)$key, $t]);
            }
            $this->pdo->commit();
            return true;
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            return false;
        }
    }

    /** Names of the tables selected for a db key; empty when none are served. */
    private function exposedTables($dbKey) {
        $st = $this->pdo->prepare('SELECT table_name FROM exposure WHERE db_key = ?');
        $st->execute([$dbKey]);
        return $st->fetchAll(PDO::FETCH_COLUMN) ?: [];
    }

    function isExposed($dbKey, $table) {
        return in_array($table, $this->exposedTables($dbKey), true);
    }

    /* ---- admin panel data ---------------------------------------------- */

    /** Every database with its tables and their current exposure state. */
    function panel() {
        $out = [];
        foreach (App::databases() as $key => $db) {
            $sel = $this->exposedTables($key);
            $tables = [];
            if ($db['exists']) {
                try {
                    [$pdo] = App::pdo($key);
                    foreach (self::tables($pdo) as $t) {
                        $tables[] = ['name' => $t, 'exposed' => in_array($t, $sel, true)];
                    }
                } catch (Throwable $e) { /* unreadable db -> no tables */ }
            }
            $out[] = [
                'key' => $key,
                'slug' => self::slug($key),
                'label' => $db['label'],
                'readonly' => $db['readonly'],
                'exists' => $db['exists'],
                'tables' => $tables,
            ];
        }
        return ['databases' => $out];
    }

    /* ---- CRUD primitives (called by api.php) --------------------------- */

    function listRows(PDO $pdo, $table, array $query) {
        $names = self::schema($pdo, $table)['names'];
        $where = []; $args = [];
        foreach ($query as $k => $v) {
            if ($k === 'limit' || $k === 'offset') continue;
            if (in_array($k, $names, true)) { $where[] = self::qid($k) . ' = ?'; $args[] = self::bind($v); }
        }
        $max = (int)(App::config()['app']['max_rows'] ?? 1000);
        $limit = isset($query['limit']) ? max(1, min((int)$query['limit'], $max)) : min(100, $max);
        $offset = isset($query['offset']) ? max(0, (int)$query['offset']) : 0;
        $sql = 'SELECT * FROM ' . self::qid($table);
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' LIMIT ' . $limit . ' OFFSET ' . $offset;
        $st = $pdo->prepare($sql);
        $st->execute($args);
        $data = $st->fetchAll(PDO::FETCH_ASSOC);
        return ['data' => $data, 'limit' => $limit, 'offset' => $offset, 'count' => count($data)];
    }

    function getRow(PDO $pdo, $table, $id) {
        $idc = self::idColumn($pdo, $table);
        $sel = $idc === 'rowid' ? 'rowid, *' : '*';
        $st = $pdo->prepare('SELECT ' . $sel . ' FROM ' . self::qid($table) . ' WHERE ' . self::idExpr($idc) . ' = ? LIMIT 1');
        $st->execute([$id]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    function createRow(PDO $pdo, $table, array $body) {
        $names = self::schema($pdo, $table)['names'];
        $cols = []; $ph = []; $args = [];
        foreach ($body as $k => $v) {
            if (in_array($k, $names, true)) { $cols[] = self::qid($k); $ph[] = '?'; $args[] = self::bind($v); }
        }
        if (!$cols) throw new RuntimeException('No recognised columns in request body');
        $pdo->prepare('INSERT INTO ' . self::qid($table) . ' (' . implode(',', $cols) . ') VALUES (' . implode(',', $ph) . ')')->execute($args);
        $rowid = $pdo->lastInsertId();
        $st = $pdo->prepare('SELECT rowid, * FROM ' . self::qid($table) . ' WHERE rowid = ? LIMIT 1');
        $st->execute([$rowid]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        return $row === false ? ['inserted' => true] : $row;
    }

    /** Update the provided columns of an existing row; null when it does not exist. */
    function updateRow(PDO $pdo, $table, $id, array $body) {
        $names = self::schema($pdo, $table)['names'];
        $set = []; $args = [];
        foreach ($body as $k => $v) {
            if (in_array($k, $names, true)) { $set[] = self::qid($k) . ' = ?'; $args[] = self::bind($v); }
        }
        if (!$set) throw new RuntimeException('No recognised columns in request body');
        if ($this->getRow($pdo, $table, $id) === null) return null;
        $idc = self::idColumn($pdo, $table);
        $args[] = $id;
        $pdo->prepare('UPDATE ' . self::qid($table) . ' SET ' . implode(', ', $set) . ' WHERE ' . self::idExpr($idc) . ' = ?')->execute($args);
        return $this->getRow($pdo, $table, $id);
    }

    function deleteRow(PDO $pdo, $table, $id) {
        $idc = self::idColumn($pdo, $table);
        $st = $pdo->prepare('DELETE FROM ' . self::qid($table) . ' WHERE ' . self::idExpr($idc) . ' = ?');
        $st->execute([$id]);
        return $st->rowCount();
    }

    /* ---- OpenAPI generation -------------------------------------------- */

    private static function jsonType($sqliteType) {
        $t = strtoupper((string)$sqliteType);
        if (strpos($t, 'INT') !== false) return ['type' => 'integer'];
        if (strpos($t, 'CHAR') !== false || strpos($t, 'CLOB') !== false || strpos($t, 'TEXT') !== false) return ['type' => 'string'];
        if (strpos($t, 'BLOB') !== false || $t === '') return ['type' => 'string'];
        if (strpos($t, 'REAL') !== false || strpos($t, 'FLOA') !== false || strpos($t, 'DOUB') !== false || strpos($t, 'NUM') !== false || strpos($t, 'DEC') !== false) return ['type' => 'number'];
        return ['type' => 'string'];
    }

    private function tableSchema(PDO $pdo, $table) {
        $props = [];
        foreach (self::columns($pdo, $table) as $c) $props[$c['name']] = self::jsonType($c['type']);
        return ['type' => 'object', 'properties' => $props];
    }

    /** A component-schema key limited to the OpenAPI-allowed character set. */
    private static function safeName($s) {
        $s = preg_replace('/[^A-Za-z0-9._-]/', '_', (string)$s);
        return $s === '' ? '_' : $s;
    }

    /**
     * Build the path items for one database's exposed tables and register their
     * schemas. $pathPrefix ('' or '/<slug>') prefixes the URL; $schemaPrefix
     * ('' or '<slug>.') namespaces schema keys so combined docs don't collide.
     */
    private function buildTablePaths(PDO $pdo, $dbKey, $pathPrefix, $schemaPrefix, array &$schemas, $readonly) {
        $paths = [];
        foreach (self::tables($pdo) as $t) {
            if (!$this->isExposed($dbKey, $t)) continue;
            $name = self::safeName($schemaPrefix . $t);
            $base = $name; $i = 2;
            while (isset($schemas[$name])) { $name = $base . '_' . $i++; }
            $schemas[$name] = $this->tableSchema($pdo, $t);
            $ref = '#/components/schemas/' . $name;
            $tag = [ltrim($pathPrefix . '/' . $t, '/')];
            $body = ['required' => true, 'content' => ['application/json' => ['schema' => ['$ref' => $ref]]]];
            $okItem = ['description' => 'The item', 'content' => ['application/json' => ['schema' => ['$ref' => $ref]]]];
            $idParam = ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string'], 'description' => 'Primary key (or rowid) of the row'];

            $collection = [
                'get' => [
                    'tags' => $tag, 'summary' => 'List rows of ' . $t,
                    'parameters' => [
                        ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer']],
                        ['name' => 'offset', 'in' => 'query', 'schema' => ['type' => 'integer']],
                    ],
                    'responses' => ['200' => ['description' => 'A page of rows']],
                ],
            ];
            $item = [
                'get' => ['tags' => $tag, 'summary' => 'Fetch one row of ' . $t, 'parameters' => [$idParam], 'responses' => ['200' => $okItem, '404' => ['description' => 'Not found']]],
            ];
            if (!$readonly) {
                $collection['post'] = ['tags' => $tag, 'summary' => 'Create a row in ' . $t, 'requestBody' => $body, 'responses' => ['201' => $okItem]];
                $item['put'] = ['tags' => $tag, 'summary' => 'Update a row of ' . $t, 'parameters' => [$idParam], 'requestBody' => $body, 'responses' => ['200' => $okItem, '404' => ['description' => 'Not found']]];
                $item['patch'] = ['tags' => $tag, 'summary' => 'Partially update a row of ' . $t, 'parameters' => [$idParam], 'requestBody' => $body, 'responses' => ['200' => $okItem, '404' => ['description' => 'Not found']]];
                $item['delete'] = ['tags' => $tag, 'summary' => 'Delete a row of ' . $t, 'parameters' => [$idParam], 'responses' => ['200' => ['description' => 'Deleted'], '404' => ['description' => 'Not found']]];
            }
            $paths[$pathPrefix . '/' . $t] = $collection;
            $paths[$pathPrefix . '/' . $t . '/{id}'] = $item;
        }
        return $paths;
    }

    private function openapiDoc($title, $description, $serverUrl, array $paths, array $schemas) {
        return [
            'openapi' => '3.0.3',
            'info' => ['title' => $title, 'version' => '1.0.0', 'description' => $description],
            'servers' => [['url' => $serverUrl]],
            'security' => [['ApiKey' => []]],
            'components' => [
                'securitySchemes' => ['ApiKey' => ['type' => 'apiKey', 'in' => 'header', 'name' => 'X-Api-Key']],
                'schemas' => $schemas,
            ],
            'paths' => $paths,
        ];
    }

    private static function scopeNote() {
        return ' Reads (GET) accept any valid API key; writes (POST/PUT/PATCH/DELETE) require a key issued with the read+write scope.';
    }

    /** OpenAPI 3.0 document describing the exposed tables of one database. */
    function openapi($dbKey) {
        $slug = self::slug($dbKey);
        [$pdo, $dbInfo] = App::pdo($dbKey);
        $schemas = [];
        $paths = $this->buildTablePaths($pdo, $dbKey, '', '', $schemas, !empty($dbInfo['readonly']));
        return $this->openapiDoc('LiteAdmin REST API — ' . $slug, 'CRUD access to the exposed tables of the "' . $slug . '" database.' . self::scopeNote(), '/api/' . $slug, $paths, $schemas);
    }

    /** Combined OpenAPI 3.0 document spanning every exposed database. */
    function openapiAll() {
        $paths = []; $schemas = [];
        foreach (App::databases() as $key => $db) {
            if (!$db['exists']) continue;
            // Skip managed files whose name App::resolve() would reject (it calls
            // App::fail(), which exits and would abort the whole combined document).
            if (strncmp($key, 'managed:', 8) === 0 && !preg_match('/^[A-Za-z0-9_-]+$/', substr($key, 8))) continue;
            try { [$pdo, $dbInfo] = App::pdo($key); } catch (Throwable $e) { continue; }
            $slug = self::slug($key);
            foreach ($this->buildTablePaths($pdo, $key, '/' . $slug, $slug . '.', $schemas, !empty($dbInfo['readonly'])) as $k => $v) {
                $paths[$k] = $v;
            }
        }
        return $this->openapiDoc('LiteAdmin REST API — all databases', 'Combined CRUD access to every exposed table across all databases, keyed by /<database>/<table>.' . self::scopeNote(), '/api', $paths, $schemas);
    }
}

class RestApiPlugin {
    private $pdo;

    private function db($host) {
        if ($this->pdo) return $this->pdo;
        $this->pdo = new PDO('sqlite:' . $host->dataDir() . '/restapi.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS exposure (db_key TEXT NOT NULL, table_name TEXT NOT NULL, PRIMARY KEY (db_key, table_name))');
        return $this->pdo;
    }

    function register($host) {
        $svc = new RestApiService($this->db($host));
        $host->service('restapi', $svc);

        // Admin panel: read the current selection (LiteAdmin session required).
        $host->route('panel', function () use ($svc) {
            return $svc->panel();
        }, ['auth' => 'session']);

        // Admin panel: persist which databases/tables are served.
        $host->route('save', function ($in) use ($svc) {
            $dbs = $in['databases'] ?? null;
            if (!is_array($dbs)) App::fail('Invalid selection', 400);
            if (!$svc->saveExposure($dbs)) App::fail('Could not save selection (is data_dir writable?)', 500);
            return ['ok' => true];
        }, ['auth' => 'session']);
    }
}
