<?php

/**
 * Append-only audit log of every write LiteAdmin performs: SQL from the editor,
 * REST and GraphQL writes, and admin actions (API keys, API exposure, password).
 * Core reports them through App::audit() as 'write' events.
 *
 * Each entry stores the SHA-256 of the previous entry plus its own content, so
 * editing or deleting a row in the middle breaks the chain and `verify` finds it.
 */
class AuditLogPlugin {
    /** Longest SQL/detail text kept per entry; a bulk import should not bloat the log. */
    const MAX_TEXT = 65536;

    private $pdo;

    private function db($host) {
        if ($this->pdo) return $this->pdo;
        $this->pdo = new PDO('sqlite:' . $host->dataDir() . '/auditlog.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $this->pdo->exec('PRAGMA journal_mode=WAL');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS log (
            id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, ip TEXT, source TEXT, action TEXT,
            db TEXT, target TEXT, row_id TEXT, sql TEXT, detail TEXT, changes INTEGER, ok INTEGER NOT NULL,
            error TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS log_ts ON log (ts)');
        return $this->pdo;
    }

    /** Fields covered by the hash, in a fixed order. */
    private static function hashOf(array $r, $prev) {
        $fields = [];
        foreach (['ts', 'actor', 'ip', 'source', 'action', 'db', 'target', 'row_id', 'sql', 'detail', 'changes', 'ok', 'error'] as $k) {
            $fields[] = $r[$k] === null ? null : (string)$r[$k];
        }
        return hash('sha256', $prev . "\n" . json_encode($fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private static function text($v) {
        if ($v === null || $v === '' || $v === []) return null;
        $s = is_string($v) ? $v : json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        return strlen($s) > self::MAX_TEXT ? substr($s, 0, self::MAX_TEXT) . '…[truncated]' : $s;
    }

    function record(array $e) {
        $pdo = $this->pdo;
        $r = [
            'ts' => time(),
            'actor' => self::text($e['actor'] ?? null),
            'ip' => self::text($e['ip'] ?? null),
            'source' => self::text($e['source'] ?? null),
            'action' => self::text($e['action'] ?? null),
            'db' => self::text($e['db'] ?? null),
            'target' => self::text($e['target'] ?? null),
            'row_id' => self::text($e['id'] ?? null),
            'sql' => self::text($e['sql'] ?? null),
            'detail' => self::text(array_filter(['params' => $e['params'] ?? null, 'data' => $e['detail'] ?? null], fn($v) => $v !== null && $v !== [])),
            'changes' => isset($e['changes']) ? (int)$e['changes'] : null,
            'ok' => empty($e['ok']) ? 0 : 1,
            'error' => self::text($e['error'] ?? null),
        ];
        // BEGIN IMMEDIATE takes the write lock before reading the chain head, so two
        // concurrent requests cannot both link to the same previous entry.
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $prev = (string)($pdo->query('SELECT hash FROM log ORDER BY id DESC LIMIT 1')->fetchColumn() ?: '');
            $r['prev_hash'] = $prev;
            $r['hash'] = self::hashOf($r, $prev);
            $cols = array_keys($r);
            $pdo->prepare('INSERT INTO log (' . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')')
                ->execute(array_values($r));
            $pdo->exec('COMMIT');
        } catch (Throwable $ex) {
            $pdo->exec('ROLLBACK');
            throw $ex;
        }
    }

    /** Walk the chain oldest-first; report the first entry whose hash or link does not match. */
    function verify() {
        $st = $this->pdo->query('SELECT * FROM log ORDER BY id');
        $prev = null; $n = 0;
        while ($r = $st->fetch(PDO::FETCH_ASSOC)) {
            // After a prune the oldest kept entry links to a removed one; trust its stored link.
            if ($prev !== null && $r['prev_hash'] !== $prev) return ['intact' => false, 'checked' => $n, 'broken_at' => (int)$r['id'], 'reason' => 'link to previous entry does not match'];
            if (self::hashOf($r, $r['prev_hash']) !== $r['hash']) return ['intact' => false, 'checked' => $n, 'broken_at' => (int)$r['id'], 'reason' => 'entry content was changed'];
            $prev = $r['hash']; $n++;
        }
        return ['intact' => true, 'checked' => $n];
    }

    function register($host) {
        $pdo = $this->db($host);
        $host->on('write', fn($e) => $this->record((array)$e));

        $host->route('list', function ($in) use ($pdo) {
            $where = []; $args = [];
            foreach (['source', 'db'] as $k) {
                if (!empty($in[$k])) { $where[] = "$k = ?"; $args[] = (string)$in[$k]; }
            }
            if (isset($in['ok']) && $in['ok'] !== '') { $where[] = 'ok = ?'; $args[] = $in['ok'] ? 1 : 0; }
            if (!empty($in['q'])) {
                $where[] = '(' . implode(' OR ', array_map(fn($c) => "$c LIKE ?", ['sql', 'detail', 'actor', 'action', 'target', 'error'])) . ')';
                array_push($args, ...array_fill(0, 6, '%' . $in['q'] . '%'));
            }
            if (!empty($in['before'])) { $where[] = 'id < ?'; $args[] = (int)$in['before']; }
            $limit = max(1, min((int)($in['limit'] ?? 100), 1000));
            $st = $pdo->prepare('SELECT id, ts, actor, ip, source, action, db, target, row_id, sql, detail, changes, ok, error FROM log'
                . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT ' . $limit);
            $st->execute($args);
            $sources = $pdo->query('SELECT DISTINCT source FROM log WHERE source IS NOT NULL ORDER BY source')->fetchAll(PDO::FETCH_COLUMN);
            $dbs = $pdo->query('SELECT DISTINCT db FROM log WHERE db IS NOT NULL ORDER BY db')->fetchAll(PDO::FETCH_COLUMN);
            return ['entries' => $st->fetchAll(PDO::FETCH_ASSOC), 'sources' => $sources, 'dbs' => $dbs,
                'total' => (int)$pdo->query('SELECT COUNT(*) FROM log')->fetchColumn()];
        });

        $host->route('verify', fn() => $this->verify());

        // Retention. The prune itself becomes the newest entry, so it is never silent.
        $host->route('prune', function ($in) use ($pdo) {
            $days = (int)($in['days'] ?? 0);
            if ($days < 1) App::fail('Keep at least 1 day', 400);
            $st = $pdo->prepare('DELETE FROM log WHERE ts < ?');
            $st->execute([time() - $days * 86400]);
            $n = $st->rowCount();
            $this->record(['source' => 'auditlog', 'action' => 'prune', 'detail' => ['older_than_days' => $days], 'changes' => $n, 'ok' => true,
                'actor' => 'admin:' . (App::config()['auth']['username'] ?? 'admin'), 'ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
            return ['deleted' => $n];
        });
    }
}
