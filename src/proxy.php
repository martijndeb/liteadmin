<?php
require __DIR__ . '/lib.php';
App::boot();
App::require_auth();

$in = App::input();
$action = $in['action'] ?? '';
$appcfg = App::config()['app'];
$maxRows = (int)($appcfg['max_rows'] ?? 1000);
$bufRows = (int)($appcfg['buffer_rows'] ?? 200);

function qid($name) {
    return '"' . str_replace('"', '""', (string)$name) . '"';
}

function columns_of($pdo, $table) {
    $st = $pdo->query('PRAGMA table_xinfo(' . qid($table) . ')');
    $cols = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $c) {
        $hidden = (int)($c['hidden'] ?? 0);
        if ($hidden === 1) continue;
        $cols[] = [
            'name' => $c['name'],
            'type' => $c['type'],
            'notnull' => (int)$c['notnull'],
            'default' => $c['dflt_value'],
            'pk' => (int)$c['pk'],
            'generated' => $hidden === 2 ? 'virtual' : ($hidden === 3 ? 'stored' : null),
        ];
    }
    return $cols;
}

try {
    switch ($action) {
        case 'databases':
            App::ok(['databases' => array_values(App::databases())]);
            break;

        case 'create_database': {
            $name = App::safe_name($in['name'] ?? '');
            $key = 'managed:' . $name;
            list($pdo, $db) = App::pdo($key, true);
            if ($db['readonly']) App::fail('Read only', 403);
            $sql = trim((string)($in['sql'] ?? ''));
            if ($sql !== '') $pdo->exec($sql);
            else $pdo->exec('CREATE TABLE IF NOT EXISTS _liteadmin (id INTEGER); DROP TABLE _liteadmin;');
            App::ok(['key' => $key, 'label' => $name]);
            break;
        }

        case 'tables': {
            list($pdo) = App::pdo($in['db'] ?? '');
            $rows = $pdo->query("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name")->fetchAll(PDO::FETCH_ASSOC);
            $tables = [];
            foreach ($rows as $r) {
                $virtual = stripos((string)$r['sql'], 'CREATE VIRTUAL TABLE') === 0;
                $internal = strncmp($r['name'], 'sqlite_', 7) === 0;
                $tables[] = [
                    'name' => $r['name'],
                    'type' => $virtual ? 'virtual' : $r['type'],
                    'internal' => $internal,
                ];
            }
            App::ok(['tables' => $tables]);
            break;
        }

        case 'schema': {
            list($pdo) = App::pdo($in['db'] ?? '');
            $table = (string)($in['table'] ?? '');
            $cols = columns_of($pdo, $table);
            $fks = $pdo->query('PRAGMA foreign_key_list(' . qid($table) . ')')->fetchAll(PDO::FETCH_ASSOC);
            $idxList = $pdo->query('PRAGMA index_list(' . qid($table) . ')')->fetchAll(PDO::FETCH_ASSOC);
            $indexes = [];
            foreach ($idxList as $idx) {
                $info = $pdo->query('PRAGMA index_info(' . qid($idx['name']) . ')')->fetchAll(PDO::FETCH_ASSOC);
                $indexes[] = [
                    'name' => $idx['name'],
                    'unique' => (int)$idx['unique'],
                    'origin' => $idx['origin'] ?? '',
                    'columns' => array_column($info, 'name'),
                ];
            }
            $sqlRow = $pdo->prepare('SELECT sql FROM sqlite_master WHERE name = ?');
            $sqlRow->execute([$table]);
            $strict = false; $withoutRowid = false;
            try {
                $tl = $pdo->query('PRAGMA table_list(' . qid($table) . ')')->fetch(PDO::FETCH_ASSOC);
                if ($tl) { $strict = !empty($tl['strict']); $withoutRowid = !empty($tl['wr']); }
            } catch (Throwable $e) {}
            App::ok([
                'columns' => $cols,
                'foreign_keys' => $fks,
                'indexes' => $indexes,
                'sql' => $sqlRow->fetchColumn(),
                'strict' => $strict,
                'without_rowid' => $withoutRowid,
            ]);
            break;
        }

        case 'browse': {
            list($pdo) = App::pdo($in['db'] ?? '');
            $table = (string)($in['table'] ?? '');
            $cols = columns_of($pdo, $table);
            $names = array_column($cols, 'name');
            $limit = min(max((int)($in['limit'] ?? $bufRows), 1), $maxRows);
            $offset = max((int)($in['offset'] ?? 0), 0);
            $order = '';
            if (!empty($in['order']) && in_array($in['order'], $names, true)) {
                $dir = (strtolower($in['dir'] ?? 'asc') === 'desc') ? 'DESC' : 'ASC';
                $order = ' ORDER BY ' . qid($in['order']) . ' ' . $dir;
            }
            $total = (int)$pdo->query('SELECT COUNT(*) FROM ' . qid($table))->fetchColumn();
            $st = $pdo->prepare('SELECT * FROM ' . qid($table) . $order . ' LIMIT ? OFFSET ?');
            $st->bindValue(1, $limit, PDO::PARAM_INT);
            $st->bindValue(2, $offset, PDO::PARAM_INT);
            $st->execute();
            App::ok([
                'columns' => $names,
                'rows' => $st->fetchAll(PDO::FETCH_NUM),
                'total' => $total,
                'offset' => $offset,
                'limit' => $limit,
            ]);
            break;
        }

        case 'query': {
            list($pdo, $db) = App::pdo($in['db'] ?? '');
            $sql = (string)($in['sql'] ?? '');
            $params = is_array($in['params'] ?? null) ? $in['params'] : [];
            $limit = min(max((int)($in['limit'] ?? $bufRows), 1), $maxRows);
            $t0 = microtime(true);
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $result = ['elapsed' => round((microtime(true) - $t0) * 1000)];
            if ($stmt->columnCount() > 0) {
                $colCount = $stmt->columnCount();
                $names = [];
                for ($i = 0; $i < $colCount; $i++) {
                    $meta = $stmt->getColumnMeta($i);
                    $names[] = $meta['name'];
                }
                $rows = [];
                $more = false;
                while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
                    if (count($rows) >= $limit) { $more = true; break; }
                    $rows[] = $row;
                }
                $result += ['columns' => $names, 'rows' => $rows, 'truncated' => $more, 'limit' => $limit];
            } else {
                $result += [
                    'changes' => $stmt->rowCount(),
                    'last_insert_id' => $pdo->lastInsertId(),
                ];
            }
            App::ok($result);
            break;
        }

        case 'exec': {
            list($pdo, $db) = App::pdo($in['db'] ?? '');
            if ($db['readonly']) App::fail('Read only', 403);
            $sql = (string)($in['sql'] ?? '');
            $params = is_array($in['params'] ?? null) ? $in['params'] : null;
            $tx = !empty($in['tx']) && $params === null;
            $fkoff = !empty($in['fkoff']) && $tx;
            $t0 = microtime(true);
            if ($params !== null) {
                $stmt = $pdo->prepare($sql);
                $stmt->execute($params);
                $changes = $stmt->rowCount();
            } elseif ($tx) {
                if ($fkoff) { $pdo->exec('PRAGMA foreign_keys=OFF'); $pdo->exec('PRAGMA legacy_alter_table=ON'); }
                $pdo->beginTransaction();
                try { $changes = $pdo->exec($sql); $pdo->commit(); }
                catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); if ($fkoff) { $pdo->exec('PRAGMA legacy_alter_table=OFF'); $pdo->exec('PRAGMA foreign_keys=ON'); } throw $e; }
                if ($fkoff) { $pdo->exec('PRAGMA legacy_alter_table=OFF'); $pdo->exec('PRAGMA foreign_keys=ON'); }
            } else {
                $changes = $pdo->exec($sql);
            }
            App::ok(['changes' => $changes, 'last_insert_id' => $pdo->lastInsertId(), 'elapsed' => round((microtime(true) - $t0) * 1000)]);
            break;
        }

        case 'info': {
            list($pdo, $db) = App::pdo($in['db'] ?? '');
            $path = $db['path'];
            clearstatcache(true, $path);
            App::ok(['info' => [
                'journal_mode' => $pdo->query('PRAGMA journal_mode')->fetchColumn(),
                'page_size' => (int)$pdo->query('PRAGMA page_size')->fetchColumn(),
                'page_count' => (int)$pdo->query('PRAGMA page_count')->fetchColumn(),
                'freelist_count' => (int)$pdo->query('PRAGMA freelist_count')->fetchColumn(),
                'auto_vacuum' => (int)$pdo->query('PRAGMA auto_vacuum')->fetchColumn(),
                'sqlite_version' => $pdo->query('SELECT sqlite_version()')->fetchColumn(),
                'size' => is_file($path) ? filesize($path) : null,
                'readonly' => (bool)$db['readonly'],
                'extensions' => $db['extensions_loaded'] ?? [],
                'compile_options' => $pdo->query('PRAGMA compile_options')->fetchAll(PDO::FETCH_COLUMN),
            ]]);
            break;
        }

        case 'optimize': {
            list($pdo, $db) = App::pdo($in['db'] ?? '');
            if ($db['readonly']) App::fail('Read only', 403);
            $path = $db['path'];
            clearstatcache(true, $path);
            $sizeBefore = is_file($path) ? filesize($path) : null;
            $steps = [];
            $journal = $pdo->query('PRAGMA journal_mode=WAL')->fetchColumn(); $steps[] = 'journal_mode=WAL';
            $pdo->exec('PRAGMA optimize'); $steps[] = 'PRAGMA optimize';
            $pdo->exec('ANALYZE'); $steps[] = 'ANALYZE';
            $pdo->exec('VACUUM'); $steps[] = 'VACUUM';
            try { $pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(); $steps[] = 'wal_checkpoint(TRUNCATE)'; } catch (Throwable $e) {}
            $integrity = $pdo->query('PRAGMA integrity_check')->fetchColumn();
            $pageSize = (int)$pdo->query('PRAGMA page_size')->fetchColumn();
            $pageCount = (int)$pdo->query('PRAGMA page_count')->fetchColumn();
            $freelist = (int)$pdo->query('PRAGMA freelist_count')->fetchColumn();
            clearstatcache(true, $path);
            App::ok(['report' => [
                'journal_mode' => $journal,
                'integrity' => $integrity,
                'page_size' => $pageSize,
                'page_count' => $pageCount,
                'freelist_count' => $freelist,
                'size_before' => $sizeBefore,
                'size_after' => is_file($path) ? filesize($path) : null,
                'steps' => $steps,
            ]]);
            break;
        }

        case 'backup': {
            $db = App::resolve($in['db'] ?? '');
            if (!is_file($db['path'])) App::fail('Not found', 404);
            $name = preg_replace('/[^A-Za-z0-9_.-]/', '_', basename($db['path']));
            if (!str_contains($name, '.')) $name .= '.sqlite';
            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="' . $name . '"');
            header('Content-Length: ' . filesize($db['path']));
            readfile($db['path']);
            exit;
        }

        default:
            App::fail('Unknown action', 404);
    }
} catch (Throwable $e) {
    App::fail($e->getMessage(), 400);
}
