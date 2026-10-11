<?php

/**
 * Front controller for the GraphQL API.
 *
 * Reached as /graphql/<database> (POST or GET) and /graphql/<database>/schema.graphql.
 * In production a server rewrite forwards /graphql/* here (see the README). Under the
 * PHP built-in server it also works directly as
 * /plugins/liteadmin-graphql/graphql.php/<database> via PATH_INFO.
 *
 * Auth is an API key from liteadmin-apikeys: any valid key may query, mutations need
 * a read+write key. The SDL is also readable by a logged-in admin.
 */

$core = __DIR__;
for ($i = 0; $i < 6 && !is_file($core . '/lib.php'); $i++) $core = dirname($core);
if (!is_file($core . '/lib.php')) { http_response_code(500); echo '{"errors":[{"message":"LiteAdmin core not found"}]}'; exit; }

require $core . '/lib.php';
require_once $core . '/plugins.php';

/** Request-level failures (auth, routing, malformed body) use HTTP status codes. */
function gql_fail($code, $msg) {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['errors' => [['message' => $msg]]], JSON_UNESCAPED_SLASHES);
    exit;
}

App::boot();
Plugins::boot();

/** @var GraphQLService|null $svc */
$svc = Plugins::service('graphql');
$keys = Plugins::service('apikeys');
if (!$svc || !$keys || !Plugins::service('restapi')) gql_fail(404, 'GraphQL API is not enabled');

$path = (string)($_GET['_path'] ?? '');
if ($path === '') {
    $pi = (string)($_SERVER['PATH_INFO'] ?? '');
    if ($pi !== '') {
        $path = ltrim($pi, '/');
    } else {
        $uri = (string)parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        $pos = strpos($uri, '/graphql/');
        if ($pos !== false) $path = substr($uri, $pos + 9);
    }
}
$segs = array_values(array_filter(explode('/', $path), fn($s) => $s !== ''));
if (!$segs || count($segs) > 2 || (isset($segs[1]) && $segs[1] !== 'schema.graphql')) gql_fail(404, 'Not found — use /graphql/<database>');

$dbKey = RestApiService::keyForSlug($segs[0]);
if ($dbKey === null) gql_fail(404, 'Unknown database');
if (!array_filter($svc->databases(), fn($d) => $d['key'] === $dbKey)) gql_fail(404, 'Database is not exposed');

$keyRow = $keys->validate($keys->keyFromRequest(), 'read');

if (isset($segs[1])) {
    if (!$keyRow && !App::authed()) { header('WWW-Authenticate: Bearer'); gql_fail(401, 'Missing or invalid API key'); }
    header('Content-Type: application/graphql; charset=utf-8');
    echo $svc->schema($dbKey)[0]->sdl();
    exit;
}

if (!$keyRow) { header('WWW-Authenticate: Bearer'); gql_fail(401, 'Missing or invalid API key'); }

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method === 'GET') {
    $req = ['query' => $_GET['query'] ?? '', 'operationName' => $_GET['operationName'] ?? null,
        'variables' => isset($_GET['variables']) ? json_decode((string)$_GET['variables'], true) : null];
} elseif ($method === 'POST') {
    $raw = file_get_contents('php://input', false, null, 0, 1048577);
    if (strlen($raw) > 1048576) gql_fail(413, 'Request body over 1 MB');
    $type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($type === 'application/graphql') {
        $req = ['query' => $raw, 'variables' => null, 'operationName' => null];
    } else {
        $req = json_decode($raw, true);
        if (!is_array($req)) gql_fail(400, 'Body must be JSON: {"query": ..., "variables": {...}, "operationName": ...}');
    }
} else {
    header('Allow: GET, POST');
    gql_fail(405, 'Use GET or POST');
}
if (!is_string($req['query'] ?? null) || trim($req['query']) === '') gql_fail(400, 'Missing "query"');
if (isset($req['variables']) && !is_array($req['variables'])) gql_fail(400, '"variables" must be an object');

$res = $svc->execute($dbKey, $req['query'], $req['variables'] ?? null, $req['operationName'] ?? null,
    ($keyRow['scope'] ?? '') === 'write',
    ['actor' => 'apikey:' . ($keyRow['label'] ?? '?'), 'ip' => $_SERVER['REMOTE_ADDR'] ?? ''],
    $method === 'POST');

header('Content-Type: application/json');
echo json_encode($res, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
