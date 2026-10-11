<?php

/**
 * Front controller for the REST API.
 *
 * Reached as /api/<database>/<table>[/<id>] and /api/<database>/openapi.json.
 * In production a server rewrite forwards /api/* here preserving the sub-path
 * (see the README). Under the PHP built-in server it also works directly as
 * /plugins/liteadmin-restapi/api.php/<database>/<table> via PATH_INFO.
 *
 * The sub-path is resolved, in order, from: the _path query set by the rewrite,
 * PATH_INFO, or the /api/ segment of REQUEST_URI.
 */

// Locate the LiteAdmin core (src/) by walking up until lib.php is found, so the
// controller works regardless of where the plugin dir sits relative to src.
$core = __DIR__;
for ($i = 0; $i < 6 && !is_file($core . '/lib.php'); $i++) $core = dirname($core);
if (!is_file($core . '/lib.php')) { http_response_code(500); echo '{"error":"LiteAdmin core not found"}'; exit; }

require $core . '/lib.php';
require_once $core . '/plugins.php';

function rest_json($code, $data) {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}
function rest_error($code, $msg) { rest_json($code, ['error' => $msg]); }
function rest_body() {
    $raw = file_get_contents('php://input');
    $d = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($d)) rest_error(400, 'Request body must be a JSON object');
    return $d;
}

App::boot();
Plugins::boot();

/** @var RestApiService|null $svc */
$svc = Plugins::service('restapi');
$keys = Plugins::service('apikeys');
if (!$svc || !$keys) rest_error(404, 'REST API is not enabled');

// Resolve the sub-path after /api.
$path = (string)($_GET['_path'] ?? '');
if ($path === '') {
    $pi = (string)($_SERVER['PATH_INFO'] ?? '');
    if ($pi !== '') {
        $path = ltrim($pi, '/');
    } else {
        $uri = (string)parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        $pos = strpos($uri, '/api/');
        if ($pos !== false) $path = ltrim(substr($uri, $pos + 5), '/');
    }
}
$segs = $path === '' ? [] : array_values(array_filter(explode('/', $path), fn($s) => $s !== ''));
if (!$segs) rest_error(404, 'No database specified');

// Resolve the presented key once. 'read' validation accepts any valid key and
// returns its row (including scope); null means no/invalid key. OpenAPI docs are
// discovery metadata, readable with any valid key or by an authenticated admin
// (so the panel links work in-browser); serve() emits one and exits.
$keyRow = $keys->validate($keys->keyFromRequest(), 'read');
$serveOpenapi = function ($doc) use ($keyRow) {
    if (!$keyRow && !App::authed()) { header('WWW-Authenticate: Bearer'); rest_error(401, 'Missing or invalid API key'); }
    header('Content-Type: application/json');
    echo json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
};

// Combined OpenAPI across every exposed database: /api/openapi.json
if (count($segs) === 1 && $segs[0] === 'openapi.json') {
    try { $doc = $svc->openapiAll(); }
    catch (Throwable $e) { error_log('liteadmin-restapi: ' . $e->getMessage()); rest_error(500, 'Could not build OpenAPI document'); }
    $serveOpenapi($doc);
}

$dbKey = RestApiService::keyForSlug($segs[0]);
if ($dbKey === null) rest_error(404, 'Unknown database');

// Per-database OpenAPI document: /api/<database>/openapi.json
if (($segs[1] ?? '') === 'openapi.json' && count($segs) === 2) {
    try { $doc = $svc->openapi($dbKey); }
    catch (Throwable $e) { error_log('liteadmin-restapi: ' . $e->getMessage()); rest_error(500, 'Could not build OpenAPI document'); }
    $serveOpenapi($doc);
}

// Data endpoints require a valid key. Read verbs accept any key; write verbs
// (POST/PUT/PATCH/DELETE) require a key issued with the read+write scope.
if (!$keyRow) { header('WWW-Authenticate: Bearer'); rest_error(401, 'Missing or invalid API key'); }

$table = $segs[1] ?? '';
if ($table === '') rest_error(404, 'No table specified');
if (!$svc->isExposed($dbKey, $table)) rest_error(404, 'Table is not exposed');

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$write = in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);
if ($write && ($keyRow['scope'] ?? '') !== 'write') rest_error(403, 'This API key lacks the read+write scope');
// Audit-log event for a write; completed and sent once the outcome is known.
$audit = $write ? ['source' => 'rest', 'actor' => 'apikey:' . ($keyRow['label'] ?? '?'), 'action' => $method, 'db' => $dbKey, 'target' => $table, 'id' => $segs[2] ?? null] : null;

try {
    [$pdo, $dbInfo] = App::pdo($dbKey, false, $write);
    if ($write && !empty($dbInfo['readonly'])) rest_error(405, 'Database is read-only');
    if (!in_array($table, RestApiService::tables($pdo), true)) rest_error(404, 'Unknown table');

    $id = $segs[2] ?? null;
    if (isset($segs[3])) rest_error(404, 'Not found');

    switch ($method) {
        case 'GET':
            if ($id === null) rest_json(200, $svc->listRows($pdo, $table, $_GET));
            $row = $svc->getRow($pdo, $table, $id);
            $row === null ? rest_error(404, 'Not found') : rest_json(200, $row);
            break;

        case 'POST':
            if ($id !== null) rest_error(405, 'POST is only allowed on a collection');
            $body = rest_body();
            $row = $svc->createRow($pdo, $table, $body);
            App::audit(['id' => $pdo->lastInsertId()] + $audit + ['detail' => $body, 'changes' => 1]);
            rest_json(201, $row);
            break;

        case 'PUT':
        case 'PATCH':
            if ($id === null) rest_error(405, $method . ' requires an item id');
            $body = rest_body();
            $row = $svc->updateRow($pdo, $table, $id, $body);
            if ($row !== null) App::audit($audit + ['detail' => $body, 'changes' => 1]);
            $row === null ? rest_error(404, 'Not found') : rest_json(200, $row);
            break;

        case 'DELETE':
            if ($id === null) rest_error(405, 'DELETE requires an item id');
            $n = $svc->deleteRow($pdo, $table, $id);
            if ($n) App::audit($audit + ['changes' => $n]);
            $n ? rest_json(200, ['deleted' => $n]) : rest_error(404, 'Not found');
            break;

        default:
            header('Allow: GET, POST, PUT, PATCH, DELETE');
            rest_error(405, 'Method not allowed');
    }
} catch (Throwable $e) {
    if ($audit) App::audit($audit + ['ok' => false, 'error' => $e->getMessage()]);
    // Our own validation errors (RuntimeException) carry safe, deliberate messages.
    // Driver errors (PDOException extends RuntimeException) can expose internals, as
    // can anything else: log the detail, answer with a category message.
    if ($e instanceof RuntimeException && !$e instanceof PDOException) rest_error(400, $e->getMessage());
    error_log('liteadmin-restapi: ' . $e->getMessage());
    rest_error(400, $e instanceof PDOException
        ? 'The database rejected the request (check required fields and value types)'
        : 'Request could not be processed');
}
