<?php
require __DIR__ . '/lib.php';
require_once __DIR__ . '/plugins.php';
App::boot();
Plugins::boot();

$in = App::input();
$name = (string)($in['plugin'] ?? $_GET['plugin'] ?? '');
$action = (string)($in['action'] ?? $_GET['action'] ?? '');
if ($name === '' || $action === '') App::fail('Missing plugin or action', 400);

$route = Plugins::route($name, $action);
if (!$route) App::fail('Unknown plugin action', 404);

$auth = $route['opts']['auth'] ?? 'session';
if ($auth === 'session') {
    App::require_auth();
} elseif ($auth === 'public') {
    // no authentication
} elseif (is_array($auth) && !empty($auth['guard'])) {
    $guard = Plugins::guard($auth['guard']);
    if (!$guard || !$guard($in, $auth)) App::fail('Unauthorized', 401);
} else {
    App::fail('Forbidden', 403);
}

try {
    $result = ($route['handler'])($in);
    // Routes registered with 'audit' => true change state (keys, exposure, ...).
    // Log the request with secrets dropped, never the response (it may hold a new key).
    if (!empty($route['opts']['audit'])) {
        App::audit(['source' => 'plugin', 'action' => $name . ':' . $action,
            'detail' => array_diff_key($in, array_flip(['plugin', 'action', 'password', 'key', 'secret', 'token']))]);
    }
    App::ok(is_array($result) ? $result : []);
} catch (Throwable $e) {
    App::fail($e->getMessage(), 400);
}
