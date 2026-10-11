<?php

/**
 * Service published as "apikeys" — other plugins fetch it via
 * $host->getService('apikeys') and call validate()/keyFromRequest().
 */
class ApiKeysService {
    private $pdo;
    function __construct($pdo) { $this->pdo = $pdo; }

    static function hashKey($key) { return hash('sha256', (string)$key); }

    /** Returns the key row (id,label,scope) when valid for $scope, else null. */
    function validate($key, $scope = 'read') {
        $key = (string)$key;
        if ($key === '') return null;
        $st = $this->pdo->prepare('SELECT id, label, scope FROM api_keys WHERE key_hash = ?');
        $st->execute([self::hashKey($key)]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) return null;
        if ($scope === 'write' && $row['scope'] !== 'write') return null;
        $this->pdo->prepare('UPDATE api_keys SET last_used = ? WHERE id = ?')->execute([time(), $row['id']]);
        return $row;
    }

    /** Extracts the presented key from X-Api-Key or "Authorization: Bearer". */
    function keyFromRequest() {
        $k = $_SERVER['HTTP_X_API_KEY'] ?? '';
        if ($k === '' && !empty($_SERVER['HTTP_AUTHORIZATION']) && preg_match('/Bearer\s+(\S+)/i', $_SERVER['HTTP_AUTHORIZATION'], $m)) $k = $m[1];
        return trim($k);
    }
}

class ApiKeysPlugin {
    private $pdo;

    private function db($host) {
        if ($this->pdo) return $this->pdo;
        $this->pdo = new PDO('sqlite:' . $host->dataDir() . '/apikeys.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT \'read\', created INTEGER, last_used INTEGER)');
        return $this->pdo;
    }

    function register($host) {
        $pdo = $this->db($host);
        $service = new ApiKeysService($pdo);

        // Available to other plugins.
        $host->service('apikeys', $service);
        $host->guard('apikey', function ($in, $opts) use ($service) {
            $scope = ($opts['scope'] ?? 'read') === 'write' ? 'write' : 'read';
            return $service->validate($service->keyFromRequest(), $scope) !== null;
        });

        // Admin management (LiteAdmin session required).
        $host->route('list', function () use ($pdo) {
            return ['keys' => $pdo->query('SELECT id, label, scope, created, last_used FROM api_keys ORDER BY created DESC')->fetchAll(PDO::FETCH_ASSOC)];
        }, ['auth' => 'session']);

        $host->route('create', function ($in) use ($pdo) {
            $label = trim((string)($in['label'] ?? ''));
            if ($label === '') App::fail('Label required', 400);
            $scope = ($in['scope'] ?? 'read') === 'write' ? 'write' : 'read';
            $key = 'lak_' . bin2hex(random_bytes(24));
            $pdo->prepare('INSERT INTO api_keys (label, key_hash, scope, created) VALUES (?,?,?,?)')
                ->execute([$label, ApiKeysService::hashKey($key), $scope, time()]);
            return ['id' => (int)$pdo->lastInsertId(), 'label' => $label, 'scope' => $scope, 'key' => $key];
        }, ['auth' => 'session', 'audit' => true]);

        $host->route('revoke', function ($in) use ($pdo) {
            $pdo->prepare('DELETE FROM api_keys WHERE id = ?')->execute([(int)($in['id'] ?? 0)]);
            return ['ok' => true];
        }, ['auth' => 'session', 'audit' => true]);

        // Demo endpoint authenticated by the apikey guard — the pattern other plugins reuse.
        $host->route('whoami', function () use ($service) {
            $row = $service->validate($service->keyFromRequest(), 'read');
            return ['label' => $row['label'] ?? null, 'scope' => $row['scope'] ?? null];
        }, ['auth' => ['guard' => 'apikey', 'scope' => 'read']]);
    }
}
