<?php
require __DIR__ . '/lib.php';
App::boot();

$action = $_GET['action'] ?? null;
$in = App::input();
if ($action === null && isset($in['action'])) $action = $in['action'];

if ($action !== null) {
    switch ($action) {
        case 'session':
            $cfg = App::config()['app'];
            App::ok([
                'authed' => App::authed(),
                'csrf' => App::authed() ? App::csrf() : '',
                'needs_setup' => App::needs_setup(),
                'config_writable' => App::config_writable(),
                'can_create_db' => App::can_create_db(),
                'app' => [
                    'name' => $cfg['name'] ?? 'LiteAdmin',
                    'lang' => $cfg['lang'] ?? 'en',
                    'max_rows' => $cfg['max_rows'] ?? 1000,
                    'buffer_rows' => $cfg['buffer_rows'] ?? 200,
                ],
            ]);
            break;

        case 'login':
            if (App::login($in['username'] ?? '', $in['password'] ?? '')) {
                App::ok(['csrf' => App::csrf()]);
            }
            App::fail('Invalid credentials', 401);
            break;

        case 'setup':
            if (!App::needs_setup()) App::fail('Already configured', 403);
            if (!App::config_writable()) App::fail('config.json is not writable', 500);
            $pw = (string)($in['password'] ?? '');
            if (strlen($pw) < 1) App::fail('Password required', 400);
            if (!App::set_password($pw)) App::fail('Could not write config.json', 500);
            App::start_authed_session();
            App::ok(['csrf' => App::csrf()]);
            break;

        case 'change_password':
            if (!App::authed()) App::fail('Not authenticated', 401);
            App::require_csrf();
            if (!App::config_writable()) App::fail('config.json is not writable', 500);
            $cur = (string)($in['current'] ?? '');
            $new = (string)($in['new'] ?? '');
            if (!password_verify($cur, App::config()['auth']['password_hash'] ?? '')) App::fail('Current password is incorrect', 403);
            if (strlen($new) < 1) App::fail('New password required', 400);
            if (!App::set_password($new)) App::fail('Could not write config.json', 500);
            App::ok();
            break;

        case 'logout':
            session_unset();
            session_destroy();
            App::ok();
            break;

        default:
            App::fail('Unknown action', 404);
    }
    exit;
}

$cfg = App::config()['app'];
$html = file_get_contents(__DIR__ . '/index.html');
$html = strtr($html, [
    '{{APP_NAME}}' => htmlspecialchars($cfg['name'] ?? 'LiteAdmin', ENT_QUOTES),
    '{{LANG}}' => htmlspecialchars($cfg['lang'] ?? 'en', ENT_QUOTES),
]);
header('Content-Type: text/html; charset=utf-8');
echo $html;
