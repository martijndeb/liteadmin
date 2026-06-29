<?php

class App {
    private static $config;

    static function config() {
        if (self::$config === null) {
            $raw = file_get_contents(__DIR__ . '/config.json');
            self::$config = json_decode($raw, true);
            if (!is_array(self::$config)) self::fail('Invalid configuration', 500);
        }
        return self::$config;
    }

    static function boot() {
        ini_set('session.cookie_httponly', '1');
        ini_set('session.cookie_samesite', 'Strict');
        ini_set('session.use_strict_mode', '1');
        if (!empty($_SERVER['HTTPS'])) ini_set('session.cookie_secure', '1');
        session_name('liteadmin');
        session_start();
        $cfg = self::config();
        $timeout = $cfg['session']['timeout'] ?? 3600;
        if (!empty($_SESSION['auth'])) {
            if (time() - ($_SESSION['seen'] ?? 0) > $timeout) {
                session_unset();
                session_destroy();
            } else {
                $_SESSION['seen'] = time();
            }
        }
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header("Referrer-Policy: same-origin");
    }

    static function input() {
        $body = file_get_contents('php://input');
        $data = $body ? json_decode($body, true) : [];
        return is_array($data) ? $data : [];
    }

    static function authed() {
        return !empty($_SESSION['auth']);
    }

    static function login($user, $pass) {
        $cfg = self::config()['auth'];
        $hash = (string)($cfg['password_hash'] ?? '');
        if ($hash === '') return false;
        $ok = hash_equals($cfg['username'], (string)$user) && password_verify((string)$pass, $hash);
        if ($ok) self::start_authed_session();
        return $ok;
    }

    static function start_authed_session() {
        session_regenerate_id(true);
        $_SESSION['auth'] = true;
        $_SESSION['seen'] = time();
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    static function config_path() {
        return __DIR__ . '/config.json';
    }

    static function config_writable() {
        return is_writable(self::config_path());
    }

    static function can_create_db() {
        $dir = self::create_dir();
        return $dir !== null && is_writable($dir);
    }

    static function needs_setup() {
        $cfg = self::config();
        return empty($cfg['auth']['password_hash']);
    }

    static function set_password($plain) {
        $cfg = self::config();
        $cfg['auth']['password_hash'] = password_hash((string)$plain, PASSWORD_DEFAULT);
        return self::write_config($cfg);
    }

    static function write_config($cfg) {
        $path = self::config_path();
        if (!is_writable($path)) return false;
        $json = json_encode($cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) return false;
        $ok = file_put_contents($path, $json . "\n") !== false;
        if ($ok) self::$config = $cfg;
        return $ok;
    }

    static function csrf() {
        return $_SESSION['csrf'] ?? '';
    }

    static function require_csrf() {
        $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!self::csrf() || !hash_equals(self::csrf(), $token)) self::fail('Invalid token', 403);
    }

    static function require_auth() {
        if (!self::authed()) self::fail('Not authenticated', 401);
        $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!self::csrf() || !hash_equals(self::csrf(), $token)) self::fail('Invalid token', 403);
    }

    static function create_dir() {
        $cfg = self::config();
        if (empty($cfg['create_dir'])) return null;
        $dir = $cfg['create_dir'];
        if ($dir[0] !== '/') $dir = __DIR__ . '/' . $dir;
        if (!is_dir($dir)) @mkdir($dir, 0770, true);
        return realpath($dir) ?: null;
    }

    static function databases() {
        $cfg = self::config();
        $out = [];
        $configured = [];
        foreach (($cfg['databases'] ?? []) as $key => $db) {
            $path = $db['path'];
            if ($path[0] !== '/') $path = __DIR__ . '/' . $path;
            $real = realpath($path);
            if ($real) $configured[$real] = true;
            $out[$key] = [
                'key' => $key,
                'label' => $db['label'] ?? $key,
                'readonly' => !empty($db['readonly']),
                'exists' => is_file($path),
                'managed' => false,
            ];
        }
        $dir = self::create_dir();
        if ($dir) {
            foreach (glob($dir . '/*') as $f) {
                if (!is_file($f)) continue;
                if (isset($configured[realpath($f)])) continue;
                $name = basename($f);
                $key = 'managed:' . $name;
                if (isset($out[$key])) continue;
                $out[$key] = [
                    'key' => $key,
                    'label' => $name,
                    'readonly' => false,
                    'exists' => true,
                    'managed' => true,
                ];
            }
        }
        return $out;
    }

    static function safe_name($name) {
        $name = (string)$name;
        if (!preg_match('/^[A-Za-z0-9_-]+$/', $name)) self::fail('Invalid name', 400);
        return $name;
    }

    static function db_extensions($db = []) {
        $cfg = self::config();
        $global = is_array($cfg['extensions'] ?? null) ? $cfg['extensions'] : [];
        $local = is_array($db['extensions'] ?? null) ? $db['extensions'] : [];
        return array_values(array_unique(array_merge($global, $local)));
    }

    static function ext_path($ext) {
        if ($ext === '' || $ext[0] === '/') return $ext;
        $cfg = self::config();
        $dir = $cfg['ext_dir'] ?? null;
        if ($dir && strpos($ext, '/') === false) {
            if ($dir[0] !== '/') $dir = __DIR__ . '/' . $dir;
            return rtrim($dir, '/') . '/' . $ext;
        }
        return __DIR__ . '/' . $ext;
    }

    static function resolve($key, $forCreate = false) {
        $cfg = self::config();
        if (isset($cfg['databases'][$key])) {
            $db = $cfg['databases'][$key];
            $path = $db['path'];
            if ($path[0] !== '/') $path = __DIR__ . '/' . $path;
            return ['path' => $path, 'readonly' => !empty($db['readonly']), 'extensions' => self::db_extensions($db)];
        }
        if (strncmp($key, 'managed:', 8) === 0) {
            $dir = self::create_dir();
            if (!$dir) self::fail('Managed databases disabled', 403);
            $name = self::safe_name(substr($key, 8));
            $path = $dir . '/' . $name;
            if (!$forCreate) {
                $real = realpath($path);
                if (!$real || strncmp($real, $dir . '/', strlen($dir) + 1) !== 0) self::fail('Not found', 404);
                $path = $real;
            }
            return ['path' => $path, 'readonly' => false, 'extensions' => self::db_extensions([])];
        }
        self::fail('Unknown database', 404);
    }

    static function pdo($key, $forCreate = false) {
        $db = self::resolve($key, $forCreate);
        if (!$forCreate && !is_file($db['path'])) self::fail('Database file missing', 404);
        $flags = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
        $exts = $db['extensions'] ?? [];
        $dsn = 'sqlite:' . $db['path'];
        $loaded = [];
        if ($exts && class_exists('Pdo\\Sqlite')) {
            $pdo = \Pdo\Sqlite::connect($dsn, null, null, $flags);
            foreach ($exts as $ext) {
                if ($ext === '') continue;
                $path = self::ext_path($ext);
                try { $pdo->loadExtension($path); $loaded[] = ['name' => basename($ext), 'loaded' => true]; }
                catch (Throwable $e) { $loaded[] = ['name' => basename($ext), 'loaded' => false, 'error' => $e->getMessage()]; }
            }
        } else {
            $pdo = new PDO($dsn, null, null, $flags);
            foreach ($exts as $ext) $loaded[] = ['name' => basename($ext), 'loaded' => false, 'error' => 'Pdo\\Sqlite unavailable'];
        }
        $pdo->exec('PRAGMA foreign_keys=ON');
        if ($db['readonly']) $pdo->exec('PRAGMA query_only=ON');
        $db['extensions_loaded'] = $loaded;
        return [$pdo, $db];
    }

    static function ok($data = []) {
        header('Content-Type: application/json');
        echo json_encode(['ok' => true] + $data);
        exit;
    }

    static function fail($msg, $code = 400) {
        http_response_code($code);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => $msg]);
        exit;
    }
}
