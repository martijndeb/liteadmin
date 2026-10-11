<?php

/**
 * GraphQL over the tables the REST API plugin exposes. Dependency-free: a small
 * GraphQL parser and executor that reuses RestApiService for exposure, schema
 * introspection and the validated CRUD primitives, and the apikeys plugin for auth.
 *
 * Per database the schema has, for every exposed table <t> (type <T>):
 *   Query     <t>(where, order_by, desc, limit, offset): [T!]!   <t>_by_pk(id): T   <t>_count(where): Int!
 *   Mutation  insert_<t>(data): T   update_<t>(id, data): T   delete_<t>(id): Boolean!
 * Foreign keys between exposed tables become fields: the referenced row (posts.user)
 * and the referencing rows as a list (users.posts).
 *
 * Supported language: queries and mutations, aliases, arguments, variables with
 * defaults, named and inline fragments, @skip/@include, __typename.
 * Not supported: subscriptions and introspection (__schema/__type) — the schema is
 * published as SDL at /graphql/<database>/schema.graphql instead.
 */

class GqlError extends RuntimeException {}

/* ---- parser ------------------------------------------------------------- */

/**
 * Values in the AST: PHP scalars for literals, and tagged arrays for the rest:
 * ['var', name], ['enum', name], ['list', [...]], ['obj', [name => value]].
 */
class GqlParser {
    private $s, $n, $pos = 0, $tok;

    private function __construct($src) { $this->s = $src; $this->n = strlen($src); $this->next(); }

    static function parse($src) {
        $p = new self((string)$src);
        return $p->document();
    }

    private function fail($msg) { throw new GqlError('Syntax error: ' . $msg); }

    private function next() {
        $s = $this->s;
        while ($this->pos < $this->n) {
            $c = $s[$this->pos];
            if ($c === '#') { while ($this->pos < $this->n && $s[$this->pos] !== "\n") $this->pos++; }
            elseif ($c === ' ' || $c === "\t" || $c === "\n" || $c === "\r" || $c === ',') $this->pos++;
            elseif (substr($s, $this->pos, 3) === "\xEF\xBB\xBF") $this->pos += 3;
            else break;
        }
        if ($this->pos >= $this->n) return $this->tok = ['eof', null];
        $c = $s[$this->pos];
        if (substr($s, $this->pos, 3) === '...') { $this->pos += 3; return $this->tok = ['punct', '...']; }
        if (strpos('!$():=@[]{}|&', $c) !== false) { $this->pos++; return $this->tok = ['punct', $c]; }
        if (preg_match('/\G[_A-Za-z][_0-9A-Za-z]*/', $s, $m, 0, $this->pos)) {
            $this->pos += strlen($m[0]);
            return $this->tok = ['name', $m[0]];
        }
        if (preg_match('/\G-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/', $s, $m, 0, $this->pos)) {
            $this->pos += strlen($m[0]);
            $float = isset($m[1]) && $m[1] !== '' || isset($m[2]) && $m[2] !== '';
            return $this->tok = ['value', $float ? (float)$m[0] : (int)$m[0]];
        }
        if (substr($s, $this->pos, 3) === '"""') {
            $end = $this->pos + 3; $raw = '';
            while (true) {
                $q = strpos($s, '"""', $end);
                if ($q === false) $this->fail('unterminated block string');
                if ($s[$q - 1] === '\\') { $raw .= substr($s, $end, $q - 1 - $end) . '"""'; $end = $q + 3; continue; }
                $raw .= substr($s, $end, $q - $end);
                $this->pos = $q + 3;
                break;
            }
            return $this->tok = ['value', self::blockString($raw)];
        }
        if ($c === '"') {
            if (!preg_match('/\G"((?:[^"\\\\\n]|\\\\.)*)"/', $s, $m, 0, $this->pos)) $this->fail('unterminated string');
            $this->pos += strlen($m[0]);
            // GraphQL string escapes are JSON's (\" \\ \/ \b \f \n \r \t \uXXXX).
            $v = json_decode('"' . $m[1] . '"');
            if (!is_string($v)) $this->fail('invalid escape in string');
            return $this->tok = ['value', $v];
        }
        $this->fail("unexpected character '" . $c . "'");
    }

    /** Block string value: strip the common indentation and blank first/last lines. */
    private static function blockString($raw) {
        $lines = preg_split('/\r\n|\r|\n/', $raw);
        $indent = null;
        foreach (array_slice($lines, 1) as $l) {
            if (trim($l) === '') continue;
            $w = strlen($l) - strlen(ltrim($l, " \t"));
            $indent = $indent === null ? $w : min($indent, $w);
        }
        if ($indent) for ($i = 1; $i < count($lines); $i++) $lines[$i] = substr($lines[$i], $indent);
        while ($lines && trim($lines[0]) === '') array_shift($lines);
        while ($lines && trim(end($lines)) === '') array_pop($lines);
        return implode("\n", $lines);
    }

    private function is($type, $v = null) { return $this->tok[0] === $type && ($v === null || $this->tok[1] === $v); }

    private function expect($type, $v = null) {
        if (!$this->is($type, $v)) $this->fail('expected ' . ($v ?? $type) . ', found ' . ($this->tok[1] ?? 'end of document'));
        $t = $this->tok[1];
        $this->next();
        return $t;
    }

    private function document() {
        $ops = []; $frags = [];
        while (!$this->is('eof')) {
            if ($this->is('punct', '{')) {
                $ops[] = ['type' => 'query', 'name' => null, 'vars' => [], 'sel' => $this->selectionSet()];
            } elseif ($this->is('name', 'query') || $this->is('name', 'mutation') || $this->is('name', 'subscription')) {
                $type = $this->expect('name');
                $name = $this->is('name') ? $this->expect('name') : null;
                $vars = $this->is('punct', '(') ? $this->varDefs() : [];
                $this->directives();
                $ops[] = ['type' => $type, 'name' => $name, 'vars' => $vars, 'sel' => $this->selectionSet()];
            } elseif ($this->is('name', 'fragment')) {
                $this->next();
                $name = $this->expect('name');
                $this->expect('name', 'on');
                $on = $this->expect('name');
                $dirs = $this->directives();
                $frags[$name] = ['on' => $on, 'dirs' => $dirs, 'sel' => $this->selectionSet()];
            } else {
                $this->fail('expected an operation or fragment, found ' . ($this->tok[1] ?? 'end of document'));
            }
        }
        if (!$ops) $this->fail('document has no operation');
        return ['ops' => $ops, 'frags' => $frags];
    }

    private function varDefs() {
        $this->expect('punct', '(');
        $defs = [];
        while (!$this->is('punct', ')')) {
            $this->expect('punct', '$');
            $name = $this->expect('name');
            $this->expect('punct', ':');
            $type = $this->typeRef();
            $default = null; $hasDefault = false;
            if ($this->is('punct', '=')) { $this->next(); $default = $this->value(true); $hasDefault = true; }
            $this->directives();
            $defs[$name] = ['type' => $type, 'default' => $default, 'hasDefault' => $hasDefault];
        }
        $this->next();
        return $defs;
    }

    private function typeRef() {
        if ($this->is('punct', '[')) {
            $this->next();
            $t = '[' . $this->typeRef() . ']';
            $this->expect('punct', ']');
        } else {
            $t = $this->expect('name');
        }
        if ($this->is('punct', '!')) { $this->next(); $t .= '!'; }
        return $t;
    }

    private function directives() {
        $out = [];
        while ($this->is('punct', '@')) {
            $this->next();
            $name = $this->expect('name');
            $out[] = ['name' => $name, 'args' => $this->is('punct', '(') ? $this->args() : []];
        }
        return $out;
    }

    private function selectionSet() {
        $this->expect('punct', '{');
        $sel = [];
        while (!$this->is('punct', '}')) {
            if ($this->is('eof')) $this->fail('unterminated selection set');
            $sel[] = $this->selection();
        }
        $this->next();
        if (!$sel) $this->fail('empty selection set');
        return $sel;
    }

    private function selection() {
        if ($this->is('punct', '...')) {
            $this->next();
            if ($this->is('name') && !$this->is('name', 'on')) {
                return ['kind' => 'spread', 'name' => $this->expect('name'), 'dirs' => $this->directives()];
            }
            $on = null;
            if ($this->is('name', 'on')) { $this->next(); $on = $this->expect('name'); }
            return ['kind' => 'inline', 'on' => $on, 'dirs' => $this->directives(), 'sel' => $this->selectionSet()];
        }
        $name = $this->expect('name');
        $alias = null;
        if ($this->is('punct', ':')) { $this->next(); $alias = $name; $name = $this->expect('name'); }
        return [
            'kind' => 'field', 'alias' => $alias ?? $name, 'name' => $name,
            'args' => $this->is('punct', '(') ? $this->args() : [],
            'dirs' => $this->directives(),
            'sel' => $this->is('punct', '{') ? $this->selectionSet() : null,
        ];
    }

    private function args() {
        $this->expect('punct', '(');
        $args = [];
        while (!$this->is('punct', ')')) {
            $name = $this->expect('name');
            $this->expect('punct', ':');
            $args[$name] = $this->value(false);
        }
        $this->next();
        return $args;
    }

    private function value($const) {
        $t = $this->tok;
        if ($t[0] === 'punct' && $t[1] === '$') {
            if ($const) $this->fail('variables are not allowed in default values');
            $this->next();
            return ['var', $this->expect('name')];
        }
        if ($t[0] === 'value') { $this->next(); return $t[1]; }
        if ($t[0] === 'name') {
            $this->next();
            if ($t[1] === 'true') return true;
            if ($t[1] === 'false') return false;
            if ($t[1] === 'null') return null;
            return ['enum', $t[1]];
        }
        if ($t[0] === 'punct' && $t[1] === '[') {
            $this->next();
            $items = [];
            while (!$this->is('punct', ']')) {
                if ($this->is('eof')) $this->fail('unterminated list');
                $items[] = $this->value($const);
            }
            $this->next();
            return ['list', $items];
        }
        if ($t[0] === 'punct' && $t[1] === '{') {
            $this->next();
            $fields = [];
            while (!$this->is('punct', '}')) {
                $name = $this->expect('name');
                $this->expect('punct', ':');
                $fields[$name] = $this->value($const);
            }
            $this->next();
            return ['obj', $fields];
        }
        $this->fail('expected a value, found ' . ($t[1] ?? 'end of document'));
    }
}

/* ---- schema model ------------------------------------------------------- */

/**
 * The GraphQL schema of one database, derived from its exposed tables.
 * types:  TypeName => ['table' => t, 'id' => idColumn, 'fields' => [name => def]]
 *         def: ['kind' => 'col', 'col' => c, 'type' => Int|Float|String]
 *            | ['kind' => 'parent', 'type' => T, 'from' => col, 'to' => col]
 *            | ['kind' => 'children', 'type' => T, 'from' => col, 'to' => col]
 * query / mutation: fieldName => ['kind' => list|one|count|insert|update|delete, 'type' => T]
 */
class GqlSchema {
    public $types = [], $query = [], $mutation = [], $readonly;

    static function name($s) {
        $s = preg_replace('/[^_0-9A-Za-z]/', '_', (string)$s);
        if ($s === '' || ctype_digit($s[0])) $s = '_' . $s;
        if (strncmp($s, '__', 2) === 0) $s = 'x' . $s;
        return $s;
    }

    private static function scalar($declared) {
        $t = strtoupper((string)$declared);
        if (strpos($t, 'INT') !== false) return 'Int';
        if (preg_match('/REAL|FLOA|DOUB|NUM|DEC/', $t)) return 'Float';
        return 'String';
    }

    private static function unique($name, array $taken) {
        $base = $name; $i = 2;
        while (isset($taken[$name])) $name = $base . '_' . $i++;
        return $name;
    }

    function __construct(PDO $pdo, RestApiService $svc, $dbKey, $readonly) {
        $this->readonly = $readonly;
        $tables = array_values(array_filter(RestApiService::tables($pdo), fn($t) => $svc->isExposed($dbKey, $t)));
        $typeOf = [];
        $reserved = ['Query' => 1, 'Mutation' => 1, 'Int' => 1, 'Float' => 1, 'String' => 1, 'Boolean' => 1, 'ID' => 1];
        foreach ($tables as $t) {
            $tn = self::unique(str_replace(' ', '', ucwords(str_replace('_', ' ', self::name($t)))), $this->types + $reserved);
            $fields = [];
            foreach (RestApiService::columns($pdo, $t) as $c) {
                $fields[self::unique(self::name($c['name']), $fields)] = ['kind' => 'col', 'col' => $c['name'], 'type' => self::scalar($c['type'])];
            }
            $id = RestApiService::idColumn($pdo, $t);
            if ($id === 'rowid' && !isset($fields['rowid'])) $fields['rowid'] = ['kind' => 'col', 'col' => 'rowid', 'type' => 'Int'];
            $this->types[$tn] = ['table' => $t, 'id' => $id, 'fields' => $fields];
            $typeOf[$t] = $tn;
        }
        // Foreign keys between exposed tables, both directions.
        foreach ($typeOf as $t => $tn) {
            $fks = $pdo->query('PRAGMA foreign_key_list(' . RestApiService::qid($t) . ')')->fetchAll(PDO::FETCH_ASSOC);
            $perParent = array_count_values(array_column($fks, 'table'));
            foreach ($fks as $fk) {
                if ((int)$fk['seq'] !== 0 || !isset($typeOf[$fk['table']])) continue; // single-column keys only
                $pn = $typeOf[$fk['table']];
                $to = $fk['to'] ?? null;
                if ($to === null || $to === '') $to = RestApiService::idColumn($pdo, $fk['table']);
                $fname = preg_match('/^(.+?)(?:_id|Id)$/', $fk['from'], $m) ? $m[1] : $fk['from'] . '_ref';
                $fname = self::unique(self::name($fname), $this->types[$tn]['fields']);
                $this->types[$tn]['fields'][$fname] = ['kind' => 'parent', 'type' => $pn, 'from' => $fk['from'], 'to' => $to];
                $cname = $perParent[$fk['table']] > 1 ? self::name($t) . '_by_' . self::name($fk['from']) : self::name($t);
                $cname = self::unique($cname, $this->types[$pn]['fields']);
                $this->types[$pn]['fields'][$cname] = ['kind' => 'children', 'type' => $tn, 'from' => $fk['from'], 'to' => $to];
            }
        }
        foreach ($this->types as $tn => $def) {
            $f = self::name($def['table']);
            $this->query[self::unique($f, $this->query)] = ['kind' => 'list', 'type' => $tn];
            $this->query[self::unique($f . '_by_pk', $this->query)] = ['kind' => 'one', 'type' => $tn];
            $this->query[self::unique($f . '_count', $this->query)] = ['kind' => 'count', 'type' => $tn];
            if ($readonly) continue;
            foreach (['insert', 'update', 'delete'] as $k) $this->mutation[self::unique($k . '_' . $f, $this->mutation)] = ['kind' => $k, 'type' => $tn];
        }
    }

    /** A starter query for the console: first table, a few columns, one relation. */
    function example() {
        foreach ($this->query as $f => $d) {
            if ($d['kind'] !== 'list') continue;
            $fields = $this->types[$d['type']]['fields'];
            $sel = array_slice(array_keys(array_filter($fields, fn($fd) => $fd['kind'] === 'col')), 0, 4);
            foreach ($fields as $rf => $fd) {
                if ($fd['kind'] === 'col') continue;
                $sub = array_slice(array_keys(array_filter($this->types[$fd['type']]['fields'], fn($x) => $x['kind'] === 'col')), 0, 2);
                $sel[] = $rf . ($fd['kind'] === 'children' ? '(limit: 3)' : '') . ' { ' . implode(' ', $sub) . ' }';
                break;
            }
            return "query {\n  $f(limit: 10) {\n    " . implode("\n    ", $sel) . "\n  }\n}\n";
        }
        return "{ __typename }\n";
    }

    /** Schema Definition Language for clients and code generators. */
    function sdl() {
        $out = [];
        $listArgs = fn($tn) => "(where: {$tn}Input, order_by: {$tn}Column, desc: Boolean, limit: Int, offset: Int)";
        foreach ($this->types as $tn => $def) {
            $lines = [];
            foreach ($def['fields'] as $f => $fd) {
                if ($fd['kind'] === 'col') $lines[] = "  $f: " . $fd['type'];
                elseif ($fd['kind'] === 'parent') $lines[] = "  $f: " . $fd['type'];
                else $lines[] = "  $f" . $listArgs($fd['type']) . ': [' . $fd['type'] . '!]!';
            }
            $out[] = "\"\"\"Rows of table {$def['table']}\"\"\"\ntype $tn {\n" . implode("\n", $lines) . "\n}";
            $cols = array_keys(array_filter($def['fields'], fn($fd) => $fd['kind'] === 'col'));
            $out[] = "input {$tn}Input {\n" . implode("\n", array_map(fn($c) => "  $c: " . $def['fields'][$c]['type'], $cols)) . "\n}";
            $out[] = "enum {$tn}Column {\n" . implode("\n", array_map(fn($c) => "  $c", $cols)) . "\n}";
        }
        $q = [];
        foreach ($this->query as $f => $d) {
            $tn = $d['type'];
            if ($d['kind'] === 'list') $q[] = "  $f" . $listArgs($tn) . ": [$tn!]!";
            elseif ($d['kind'] === 'one') $q[] = "  $f(id: ID!): $tn";
            else $q[] = "  $f(where: {$tn}Input): Int!";
        }
        $out[] = "type Query {\n" . ($q ? implode("\n", $q) : '  _empty: Boolean') . "\n}";
        if ($this->mutation) {
            $m = [];
            foreach ($this->mutation as $f => $d) {
                $tn = $d['type'];
                if ($d['kind'] === 'insert') $m[] = "  $f(data: {$tn}Input!): $tn";
                elseif ($d['kind'] === 'update') $m[] = "  $f(id: ID!, data: {$tn}Input!): $tn";
                else $m[] = "  $f(id: ID!): Boolean!";
            }
            $out[] = "type Mutation {\n" . implode("\n", $m) . "\n}";
        }
        return implode("\n\n", $out) . "\n";
    }
}

/* ---- executor ----------------------------------------------------------- */

class GqlExecutor {
    const MAX_DEPTH = 10;
    /** Rows one request may return across all lists — nested lists multiply quickly. */
    const MAX_ROWS = 10000;

    private $schema, $pdo, $svc, $canWrite, $audit, $doc, $vars = [], $rows = 0, $maxList, $events = [];

    function __construct(GqlSchema $schema, PDO $pdo, RestApiService $svc, $canWrite, array $audit) {
        $this->schema = $schema; $this->pdo = $pdo; $this->svc = $svc;
        $this->canWrite = $canWrite; $this->audit = $audit;
        $this->maxList = (int)(App::config()['app']['max_rows'] ?? 1000);
    }

    /** Run a request; returns a GraphQL response array ({data} or {errors[, data]}). */
    function run($query, $variables, $operationName, $allowMutation = true) {
        try {
            $this->doc = GqlParser::parse($query);
            $ops = $this->doc['ops'];
            if ($operationName !== null && $operationName !== '') {
                $ops = array_values(array_filter($ops, fn($o) => $o['name'] === $operationName));
                if (!$ops) throw new GqlError('Unknown operation "' . $operationName . '"');
            } elseif (count($ops) > 1) {
                throw new GqlError('The document has several operations; set operationName');
            }
            $op = $ops[0];
            if ($op['type'] === 'subscription') throw new GqlError('Subscriptions are not supported');
            $this->vars = $this->coerceVars($op['vars'], is_array($variables) ? $variables : []);
        } catch (GqlError $e) {
            return ['errors' => [['message' => $e->getMessage()]]];
        }

        if ($op['type'] === 'query') {
            try { return ['data' => $this->select('Query', $op['sel'], null, 0)]; }
            catch (GqlError $e) { return ['errors' => [['message' => $e->getMessage()]], 'data' => null]; }
        }

        if (!$allowMutation) return ['errors' => [['message' => 'Mutations must be sent with POST']]];
        if ($this->schema->readonly) return ['errors' => [['message' => 'Database is read-only']]];
        if (!$this->canWrite) return ['errors' => [['message' => 'This API key lacks the read+write scope']]];
        // A mutation operation is all-or-nothing: its fields run in order inside one transaction.
        $this->pdo->beginTransaction();
        try {
            $data = $this->select('Mutation', $op['sel'], null, 0);
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            App::audit($this->audit + ['action' => 'mutation', 'sql' => $query, 'ok' => false, 'error' => $e->getMessage()]);
            return ['errors' => [['message' => self::message($e)]], 'data' => null];
        }
        foreach ($this->events as $ev) App::audit($this->audit + $ev);
        return ['data' => $data];
    }

    /** Validation errors are ours and safe to show; driver errors can expose internals. */
    private static function message(Throwable $e) {
        if ($e instanceof GqlError || ($e instanceof RuntimeException && !$e instanceof PDOException)) return $e->getMessage();
        error_log('liteadmin-graphql: ' . $e->getMessage());
        return 'The database rejected the request (check required fields and value types)';
    }

    private function coerceVars(array $defs, array $given) {
        $out = [];
        foreach ($defs as $name => $d) {
            if (array_key_exists($name, $given)) $out[$name] = $given[$name];
            elseif ($d['hasDefault']) $out[$name] = $this->resolve($d['default']);
            else $out[$name] = null;
            if ($out[$name] === null && substr($d['type'], -1) === '!') {
                throw new GqlError('Variable "$' . $name . '" of required type ' . $d['type'] . ' was not provided');
            }
        }
        return $out;
    }

    private function resolve($v) {
        if (!is_array($v)) return $v;
        switch ($v[0]) {
            case 'var':
                if (!array_key_exists($v[1], $this->vars)) throw new GqlError('Variable "$' . $v[1] . '" is not defined');
                return $this->vars[$v[1]];
            case 'enum': return $v[1];
            case 'list': return array_map(fn($x) => $this->resolve($x), $v[1]);
            default: return array_map(fn($x) => $this->resolve($x), $v[1]);
        }
    }

    private function included(array $dirs) {
        foreach ($dirs as $d) {
            $if = $this->resolve($d['args']['if'] ?? null);
            if ($d['name'] === 'skip' && $if === true) return false;
            if ($d['name'] === 'include' && $if !== true) return false;
        }
        return true;
    }

    /** Flatten fragments and directives into responseKey => [field nodes]. */
    private function collect($typeName, array $sel, array &$out, array $seen = []) {
        foreach ($sel as $s) {
            if (!$this->included($s['dirs'])) continue;
            if ($s['kind'] === 'field') { $out[$s['alias']][] = $s; continue; }
            if ($s['kind'] === 'spread') {
                $f = $this->doc['frags'][$s['name']] ?? null;
                if (!$f) throw new GqlError('Unknown fragment "' . $s['name'] . '"');
                if (isset($seen[$s['name']])) throw new GqlError('Fragment "' . $s['name'] . '" spreads itself');
                if ($f['on'] === $typeName && $this->included($f['dirs'])) $this->collect($typeName, $f['sel'], $out, $seen + [$s['name'] => 1]);
                continue;
            }
            if ($s['on'] === null || $s['on'] === $typeName) $this->collect($typeName, $s['sel'], $out, $seen);
        }
    }

    private function select($typeName, array $sel, $row, $depth) {
        if ($depth > self::MAX_DEPTH) throw new GqlError('Query is nested too deeply (max ' . self::MAX_DEPTH . ' levels)');
        $fields = [];
        $this->collect($typeName, $sel, $fields);
        $out = [];
        foreach ($fields as $key => $nodes) {
            $node = $nodes[0];
            // Same key selected twice: merge the sub-selections.
            $sub = $node['sel'] === null ? null : array_merge(...array_map(fn($n) => $n['sel'] ?? [], $nodes));
            $out[$key] = $this->field($typeName, $node, $sub, $row, $depth);
        }
        return $out;
    }

    private function field($typeName, array $node, $sub, $row, $depth) {
        $name = $node['name'];
        if ($name === '__typename') return $typeName;
        if ($name === '__schema' || $name === '__type') throw new GqlError('Introspection is not supported; fetch the schema from /graphql/<database>/schema.graphql');
        $root = $typeName === 'Query' ? $this->schema->query : ($typeName === 'Mutation' ? $this->schema->mutation : null);
        $def = $root !== null ? ($root[$name] ?? null) : ($this->schema->types[$typeName]['fields'][$name] ?? null);
        if (!$def) throw new GqlError('Cannot query field "' . $name . '" on type "' . $typeName . '"');
        $args = array_map(fn($v) => $this->resolve($v), $node['args']);

        if ($def['kind'] === 'col') {
            if ($sub !== null) throw new GqlError('Field "' . $name . '" is a ' . $def['type'] . ' and cannot have a selection');
            if ($args) throw new GqlError('Field "' . $name . '" takes no arguments');
            return self::scalarOut($row[$def['col']] ?? null, $def['type']);
        }
        $t = $def['type'];
        $objectResult = !in_array($def['kind'], ['count', 'delete'], true);
        if ($objectResult && $sub === null) throw new GqlError('Field "' . $name . '" of type ' . $t . ' must have a selection of subfields');
        if (!$objectResult && $sub !== null) throw new GqlError('Field "' . $name . '" returns a scalar and cannot have a selection');

        $table = $this->schema->types[$t]['table'];
        switch ($def['kind']) {
            case 'list':
                return $this->many($t, $this->rows($t, $args, null), $sub, $depth);
            case 'children':
                $v = $row[$def['to']] ?? null;
                return $v === null ? [] : $this->many($t, $this->rows($t, $args, [$def['from'], $v]), $sub, $depth);
            case 'count':
                self::allowed($args, ['where'], $name);
                [$w, $a] = $this->where($t, $args['where'] ?? null);
                $st = $this->pdo->prepare('SELECT COUNT(*) FROM ' . RestApiService::qid($table) . $w);
                $st->execute($a);
                return (int)$st->fetchColumn();
            case 'one':
                self::allowed($args, ['id'], $name);
                if (!isset($args['id'])) throw new GqlError('Field "' . $name . '" needs an id');
                return $this->one($t, $this->svc->getRow($this->pdo, $table, $args['id']), $sub, $depth);
            case 'parent':
                $v = $row[$def['from']] ?? null;
                if ($v === null) return null;
                $st = $this->pdo->prepare('SELECT ' . $this->cols($t) . ' FROM ' . RestApiService::qid($table) . ' WHERE ' . RestApiService::qid($def['to']) . ' = ? LIMIT 1');
                $st->execute([$v]);
                return $this->one($t, $st->fetch(PDO::FETCH_ASSOC) ?: null, $sub, $depth);
            case 'insert':
                self::allowed($args, ['data'], $name);
                $data = $this->data($t, $args['data'] ?? null, $name);
                $created = $this->svc->createRow($this->pdo, $table, $data);
                $this->events[] = ['action' => 'insert', 'target' => $table, 'id' => $this->pdo->lastInsertId(), 'detail' => $data, 'changes' => 1];
                return $this->one($t, $created, $sub, $depth);
            case 'update':
                self::allowed($args, ['id', 'data'], $name);
                if (!isset($args['id'])) throw new GqlError('Field "' . $name . '" needs an id');
                $data = $this->data($t, $args['data'] ?? null, $name);
                $updated = $this->svc->updateRow($this->pdo, $table, $args['id'], $data);
                if ($updated !== null) $this->events[] = ['action' => 'update', 'target' => $table, 'id' => $args['id'], 'detail' => $data, 'changes' => 1];
                return $this->one($t, $updated, $sub, $depth);
            case 'delete':
                self::allowed($args, ['id'], $name);
                if (!isset($args['id'])) throw new GqlError('Field "' . $name . '" needs an id');
                $n = $this->svc->deleteRow($this->pdo, $table, $args['id']);
                if ($n) $this->events[] = ['action' => 'delete', 'target' => $table, 'id' => $args['id'], 'changes' => $n];
                return $n > 0;
        }
        throw new GqlError('Unsupported field "' . $name . '"');
    }

    private static function allowed(array $args, array $names, $field) {
        foreach (array_keys($args) as $a) {
            if (!in_array($a, $names, true)) throw new GqlError('Unknown argument "' . $a . '" on field "' . $field . '"');
        }
    }

    private static function scalarOut($v, $type) {
        if ($v === null) return null;
        if ($type === 'Int' && is_numeric($v) && (float)$v == (int)$v) return (int)$v;
        if ($type === 'Float' && is_numeric($v)) return (float)$v;
        if (is_string($v) && !preg_match('//u', $v)) return base64_encode($v); // BLOB: not valid UTF-8
        return $type === 'String' ? (string)$v : $v;
    }

    /** SELECT list: rowid-keyed tables also expose their rowid. */
    private function cols($t) {
        return $this->schema->types[$t]['id'] === 'rowid' ? 'rowid, *' : '*';
    }

    private function colOf($t, $field) {
        $fd = $this->schema->types[$t]['fields'][$field] ?? null;
        if (!$fd || $fd['kind'] !== 'col') throw new GqlError('Unknown column "' . $field . '" on type "' . $t . '"');
        return $fd['col'];
    }

    /** Equality filter from a {field: value} object; null matches IS NULL. */
    private function where($t, $where, array $fixed = null) {
        $w = []; $a = [];
        if ($fixed) { $w[] = RestApiService::qid($fixed[0]) . ' = ?'; $a[] = $fixed[1]; }
        if ($where !== null) {
            if (!is_array($where) || array_is_list($where) && $where) throw new GqlError('"where" must be an object of column: value');
            foreach ($where as $f => $v) {
                $c = RestApiService::qid($this->colOf($t, $f));
                if ($v === null) { $w[] = "$c IS NULL"; continue; }
                if (is_array($v)) throw new GqlError('"where" values must be scalars');
                $w[] = "$c = ?"; $a[] = is_bool($v) ? (int)$v : $v;
            }
        }
        return [$w ? ' WHERE ' . implode(' AND ', $w) : '', $a];
    }

    private function rows($t, array $args, $fixed) {
        self::allowed($args, ['where', 'order_by', 'desc', 'limit', 'offset'], $this->schema->types[$t]['table']);
        [$w, $a] = $this->where($t, $args['where'] ?? null, $fixed);
        $sql = 'SELECT ' . $this->cols($t) . ' FROM ' . RestApiService::qid($this->schema->types[$t]['table']) . $w;
        if (isset($args['order_by'])) $sql .= ' ORDER BY ' . RestApiService::qid($this->colOf($t, (string)$args['order_by'])) . (!empty($args['desc']) ? ' DESC' : ' ASC');
        $limit = isset($args['limit']) ? max(0, min((int)$args['limit'], $this->maxList)) : min(100, $this->maxList);
        $sql .= ' LIMIT ' . $limit . ' OFFSET ' . max(0, (int)($args['offset'] ?? 0));
        $st = $this->pdo->prepare($sql);
        $st->execute($a);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        $this->rows += count($rows);
        if ($this->rows > self::MAX_ROWS) throw new GqlError('Result too large (over ' . self::MAX_ROWS . ' rows); narrow the query or lower the limits');
        return $rows;
    }

    private function many($t, array $rows, array $sub, $depth) {
        return array_map(fn($r) => $this->select($t, $sub, $r, $depth + 1), $rows);
    }

    private function one($t, $row, array $sub, $depth) {
        return $row === null ? null : $this->select($t, $sub, $row, $depth + 1);
    }

    /** Map an input object's GraphQL field names to column names. */
    private function data($t, $data, $field) {
        if (!is_array($data) || ($data && array_is_list($data))) throw new GqlError('Field "' . $field . '" needs a data object');
        $out = [];
        foreach ($data as $f => $v) {
            if (is_array($v)) throw new GqlError('Values in "data" must be scalars');
            $out[$this->colOf($t, $f)] = $v;
        }
        return $out;
    }
}

/* ---- service + plugin --------------------------------------------------- */

/** Published as "graphql"; the front controller (graphql.php) and the admin console use it. */
class GraphQLService {
    /** Looked up on use: plugins boot alphabetically, so restapi registers after us. */
    private function rest() {
        $rest = Plugins::service('restapi');
        if (!$rest) throw new RuntimeException('liteadmin-graphql needs liteadmin-restapi enabled');
        return $rest;
    }

    function schema($dbKey) {
        [$pdo, $info] = App::pdo($dbKey);
        return [new GqlSchema($pdo, $this->rest(), $dbKey, !empty($info['readonly'])), $pdo];
    }

    function execute($dbKey, $query, $variables, $operationName, $canWrite, array $audit, $allowMutation = true) {
        [$schema, $pdo] = $this->schema($dbKey);
        $exec = new GqlExecutor($schema, $pdo, $this->rest(), $canWrite, $audit + ['source' => 'graphql', 'db' => $dbKey]);
        return $exec->run($query, $variables, $operationName, $allowMutation);
    }

    /** Databases with at least one exposed table: [{key, slug, label, readonly}]. */
    function databases() {
        $out = [];
        foreach ($this->rest()->panel()['databases'] as $db) {
            if (!array_filter($db['tables'], fn($t) => !empty($t['exposed']))) continue;
            $out[] = ['key' => $db['key'], 'slug' => $db['slug'], 'label' => $db['label'], 'readonly' => $db['readonly']];
        }
        return $out;
    }
}

class GraphQLPlugin {
    function register($host) {
        $svc = new GraphQLService();
        $host->service('graphql', $svc);

        $dbKey = function ($in) {
            $key = RestApiService::keyForSlug((string)($in['db'] ?? ''));
            if ($key === null) App::fail('Unknown database', 404);
            return $key;
        };

        $host->route('databases', fn() => ['databases' => $svc->databases()]);

        $host->route('schema', function ($in) use ($svc, $dbKey) {
            $schema = $svc->schema($dbKey($in))[0];
            return ['sdl' => $schema->sdl(), 'example' => $schema->example()];
        });

        // Admin console: runs as the logged-in admin, so mutations are allowed.
        $host->route('execute', function ($in) use ($svc, $dbKey) {
            $res = $svc->execute($dbKey($in), (string)($in['query'] ?? ''), $in['variables'] ?? null, $in['operationName'] ?? null, true,
                ['actor' => 'admin:' . (App::config()['auth']['username'] ?? 'admin'), 'ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
            return ['response' => $res];
        });
    }
}
