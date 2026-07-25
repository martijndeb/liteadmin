# LiteAdmin

A hostable SQLite browser and editor like phpMyAdmin, but for SQLite. Standalone,
no build step, no toolchain. Just serve the `src/` folder with PHP.

Built with the assistance of AI, and a lot of love for SQLite ❤️.

## Features

**Connect & browse**
- Login-protected, session + CSRF secured communication
- Server databases via `proxy.php` (PDO/SQLite), local databases via in-browser sql.js (WASM)
- Recent databases list (server **and** local), re-openable via the File System Access API
- **JSON-aware** cells (click to pretty-view) and a validating JSON editor for JSON columns

**Schema & structure**
- Create databases; create **tables, views and virtual tables** with builders
- Editable structure: rename table, add/rename/drop column, add/drop index
- Per-table metrics (rows, columns, indexes, foreign keys) and per-table `ANALYZE`/`REINDEX`
- **Column/table profiler** (distinct, nulls, min/max/avg per column)
- **Compare** two tables, or two server databases, and generate **migration SQL**
- Export the **schema** (DDL) or generate an **OpenAPI/Swagger** spec for the tables

**SQL & performance**
- Monaco SQL editor with autocomplete; run / run-as-script (wrappable in a transaction)
- **Query analyzer**: EXPLAIN QUERY PLAN tree, full-bytecode EXPLAIN, performance hints
  with **"Fix this for me"** actions, single/covering **index suggestions** (one-click apply),
  auto-analyze on run, and a query **benchmark**

**Maintenance & operations**
- **Maintenance** dialog (integrity check, FK check, optimize, analyze, reindex,
  vacuum, WAL checkpoint) with a run log, plus quick one-click maintenance buttons
- **WAL / auto-vacuum** toggles that reflect the live database state
- Shows the **journal mode** (WAL badge) and **loaded SQLite extensions** on open
- All multi-statement operations run inside a **transaction** (atomic, rollback on error)

**Interface**
- Material Design via BeerCSS; auto/light/dark theme; **user-pickable accent colour**;
  subtle theme-aware gradients; responsive; keyboard accessible; Atkinson Hyperlegible font
- Multilingual UI — **English, Dutch, German, Frisian, Swedish** — with browser
  auto-detection and a language picker in Preferences

## Requirements

- PHP 8.0+ with `pdo_sqlite` and `session` extensions (PHP 8.4+ to load SQLite extensions)
- Any web server that can serve PHP (Apache, nginx + php-fpm, or `php -S` for testing)

## Install

1. Serve the `src/` directory as the document root.
2. Open the site. On first run **no password is set**, so LiteAdmin asks you to choose one
   (this requires `config.json` to be writable). The username is `admin` by default.
3. Change the password later via **Preferences → Change password**.

For a quick local try-out:

```
cd src
php -S 127.0.0.1:8000
```

> The built-in PHP server is for development only; it ignores `.htaccess` and will
> expose `config.json`. Use a real web server in production.
>
> Session cookies are marked `Secure` by default, so over plain HTTP (e.g. this local
> server) add `"insecure_http": true` to `config.json` or the browser won't keep you
> logged in.

## Install from the apt repository (Debian/Ubuntu)

A signed apt repository is published at <https://martijndeb.github.io/liteadmin>.

```bash
# 1. Trust the repository signing key
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://martijndeb.github.io/liteadmin/pubkey.gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/liteadmin.gpg

# 2. Add the repository (suite "stable", component "main")
echo "deb [signed-by=/etc/apt/keyrings/liteadmin.gpg] https://martijndeb.github.io/liteadmin stable main" \
  | sudo tee /etc/apt/sources.list.d/liteadmin.list

# 3. Install
sudo apt update
sudo apt install liteadmin
```

The package installs the app to `/usr/share/liteadmin`, keeps its configuration at
`/etc/liteadmin/config.json` and its databases under `/var/lib/liteadmin/databases` (both
symlinked into the app directory). It depends on `php-fpm` and `php-sqlite3` and recommends
`nginx` — point your web server at `/usr/share/liteadmin`, then open the site and set a
password on first run.

### Automatic updates (unattended-upgrades)

The repository's `Release` file advertises the following fields, which you use to whitelist it:

| Field            | Value       |
| ---------------- | ----------- |
| Origin           | `liteadmin` |
| Label            | `liteadmin` |
| Suite / Codename | `stable`    |
| Component        | `main`      |

To let [`unattended-upgrades`](https://wiki.debian.org/UnattendedUpgrades) keep LiteAdmin up to
date, allow that origin. Create `/etc/apt/apt.conf.d/51liteadmin`:

```
Unattended-Upgrade::Origins-Pattern {
    "origin=liteadmin,label=liteadmin,codename=stable";
};
```

Then make sure the tooling is installed and enabled, and dry-run to confirm the match:

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
sudo unattended-upgrade --dry-run --debug 2>&1 | grep -i liteadmin
```

> The `origin`, `label` and `codename` keys map directly to the `Release` fields above; the
> shorthand `"liteadmin:stable"` (i.e. `${origin}:${suite}`) in `Unattended-Upgrade::Allowed-Origins`
> works too.

## Run with Docker

The included `Dockerfile` builds a single, self-contained image running **Caddy + php-fpm 8.4**
(with `pdo_sqlite`). No build step, no external services.

```bash
docker build -t liteadmin .
docker run -d --name liteadmin -p 8080:80 \
  -v liteadmin-data:/var/www/liteadmin/src/databases \
  liteadmin
```

Open <http://localhost:8080> and choose a password on first run (the image ships with an empty
password, so it starts on the setup screen).

- The `liteadmin-data` volume keeps your server databases across container restarts.
- To persist the configuration too, bind-mount it — it must stay writable by the container's
  `www-data` so the setup and **Change password** screens can save:
  `-v "$(pwd)/config.json:/var/www/liteadmin/src/config.json"`.
- Session cookies are `Secure` by default. When reaching the container over plain HTTP, set
  `"insecure_http": true` in `config.json`, or (recommended) run it behind a TLS-terminating
  reverse proxy.

Or with Compose:

```yaml
services:
  liteadmin:
    build: .
    ports:
      - "8080:80"
    volumes:
      - liteadmin-data:/var/www/liteadmin/src/databases
volumes:
  liteadmin-data:
```

## Configuration — `src/config.json`

```json
{
  "app":    { "name": "LiteAdmin", "lang": "en", "max_rows": 1000, "buffer_rows": 200 },
  "auth":   { "username": "admin", "password_hash": "" },
  "session":{ "timeout": 3600 },
  "create_dir": "databases",
  "databases": {
    "sample": { "label": "Sample Database", "path": "databases/sample.sqlite", "readonly": false }
  }
}
```

- `auth.password_hash` — an empty value triggers the first-run setup screen. The setup and
  the **Change password** feature write the bcrypt hash back to `config.json`, so the file
  must be **writable** by the web server for those to work (a warning is shown otherwise).
- `databases` — the allow-list of server databases. `path` is relative to `src/`.
  Set `readonly: true` to forbid writes.
- `create_dir` — folder where new server databases are created and auto-discovered
  (managed databases). Set to `null` to disable creating server databases.
- `insecure_http` — session cookies are marked `Secure` by default (correct behind a
  TLS-terminating reverse proxy, where `$_SERVER['HTTPS']` is empty). Set to `true` only for
  plain-HTTP access such as local development, otherwise the browser won't send the cookie.
- `debug` — when `true`, full error messages (which may include file paths) are returned to
  the client. Leave unset/`false` in production; paths are stripped from errors by default.
- `app.lang` — default UI language (`en`, `nl`, `de`, `fy`, `sv`). Users can override it
  with the language picker; on first visit the browser language is auto-detected.
- **SQLite extensions** (optional, server only, PHP 8.4+ with `Pdo\Sqlite`): load shared
  libraries on connect. `extensions` at the top level is loaded for **every** server database
  (defaults like `vec0`); a per-database `extensions` array adds more for just that one. Bare
  names (e.g. `vec0`) resolve under `ext_dir`; values with a slash are relative to `src/`, and
  absolute paths are used as-is. The platform suffix (`.so`/`.dylib`/`.dll`) may be omitted.
  Paths only come from this file (never the client), and the loaded/failed state is shown on the
  database's **Database** tab. Example:

```json
{
  "ext_dir": "ext",
  "extensions": ["vec0"],
  "databases": {
    "vectors": { "label": "Vectors", "path": "databases/vectors.sqlite", "extensions": ["fts5_ext"] }
  }
}
```

- Generate a new password hash:

```
php -r 'echo password_hash("your-password", PASSWORD_DEFAULT), "\n";'
```

## Plugins

LiteAdmin has a small plugin system so functionality ships — and installs — separately, including as
standalone `.deb` packages. **Plugins are fully optional and off by default.** Plugins live in
`src/plugins/<name>/`, but a plugin only becomes active when its name is listed in `config.json`:

```json
{ "plugins": ["liteadmin-apikeys"] }
```

With no `plugins` key nothing is active. The **core package excludes `src/plugins/`**, so on a
packaged install each plugin is shipped as its own `.deb`: it installs the code into
`/usr/share/liteadmin/plugins/<name>/` and its `postinst` enables it by adding the name to `plugins`
in the config (uninstalling removes it again) — a one-command, reversible add-on.

### Anatomy

```
src/plugins/<name>/
  plugin.json     manifest (name, version, server/client entry points)
  plugin.php      server side — a class with a register(PluginHost $host) method
  plugin.js       client side — export function register(api) { … }
```

**Server API** (`$host`):

- `route($action, $handler, ['auth' => …])` — expose an endpoint at `plugin.php`. `auth` is
  `'session'` (LiteAdmin admin, default), `'public'`, or `['guard' => 'apikey', 'scope' => 'write']`
  to delegate to another plugin's auth guard.
- `service($name, $obj)` / `getService($name)` — publish/consume a shared service.
- `guard($name, $handler)` — publish a reusable auth guard.
- `dataDir()` — a writable per-plugin data directory (under `data_dir`).
- `on($event, $handler)` / `emit($event, $payload)` — event hooks.

**Client API** (`api`): `addStartCard({icon,title,subtitle,onOpen})`, `addTab({id,icon,label,render(panel, ws)})`,
`call(action, params)` (posts to that plugin's endpoints), plus `el`, `clear`, `t`, `toast`, `download`.

Calls go through `src/plugin.php`, which handles discovery, the auth mode and JSON I/O.

### Example plugin: `liteadmin-apikeys`

`src/plugins/liteadmin-apikeys/` issues API keys with **read**/**write** scopes (stored hashed). It is
the foundation other plugins build on: it publishes

- the **`apikeys` service** — `validate($key, $scope)` and `keyFromRequest()`, and
- the **`apikey` guard** — so any plugin route with `['auth' => ['guard' => 'apikey', 'scope' => 'read']]`
  requires a valid key, presented as `X-Api-Key: <key>` or `Authorization: Bearer <key>`.

Once enabled, manage keys from the **Plugins** section on the start page.

### Example plugin: `liteadmin-restapi`

`src/plugins/liteadmin-restapi/` builds on the API keys plugin to expose selected databases and
tables as a **CRUD REST API**. It depends on `liteadmin-apikeys` and needs no new dependencies.

- **URL scheme:** `/api/<database>/<table>` (collection) and `/api/<database>/<table>/<id>` (item),
  using `GET`, `POST`, `PUT`, `PATCH` and `DELETE`. Collections accept `?limit=`, `?offset=` and
  simple `?column=value` filters.
- **Auth & scopes:** every request needs a valid API key (`X-Api-Key: <key>` or
  `Authorization: Bearer <key>`) from `liteadmin-apikeys`. A **read** key may `GET`; only a
  **read+write** key may `POST`/`PUT`/`PATCH`/`DELETE` (else `403`). Write verbs are also refused on
  read-only databases.
- **OpenAPI:** a per-database OpenAPI 3.0 document is generated on the fly at
  `/api/<database>/openapi.json`, linked from each database in the panel. It is readable with a valid
  key or by a logged-in admin (so the panel links open in the browser).
- **Exposure panel:** open **REST API** from the Plugins section to choose which databases and tables
  are served (with **Select all** / **Deselect all**). A database is served once at least one of its
  tables is selected. The selection is stored in a SQLite database in the plugin data dir
  (`restapi.sqlite`), the same way `liteadmin-apikeys` stores its keys. Until you save for the first
  time, **all databases and tables are exposed by default** — but the plugin still does nothing until
  it is enabled.
- **Not auto-enabled:** unlike other plugins, its `.deb` does **not** add itself to `plugins` on
  install (it serves data, so enabling is left deliberate). Enable it by adding `"liteadmin-restapi"`
  to `plugins` in the config.

The pretty `/api/...` URLs rely on a rewrite to the plugin's `api.php` front controller: the bundled
Caddy config (`docker/Caddyfile`) and `src/.htaccess` (Apache, needs `mod_rewrite`) ship it already.
Under the PHP built-in server, reach the controller directly as
`/plugins/liteadmin-restapi/api.php/<database>/<table>`.

Planned plugins that slot into the same system: a **code generator** (tables → typed
classes/definitions) and an **MCP server** — each guarding its endpoints with the `apikey` guard above.

### Configuration

- `plugins` — array of enabled plugin names. **Absent/empty means no plugins are active.**
- `plugin_dir` — runtime plugin directory (default `plugins`, relative to `src/`).
- `data_dir` — writable base for plugin data (default `data`). On a packaged install point this at a
  writable location, e.g. `"data_dir": "/var/lib/liteadmin"`.

From a source checkout the bundled plugin is already in `src/plugins/`, so enabling it is just adding
`"plugins": ["liteadmin-apikeys"]` to `config.json` (and reloading php-fpm if you run one).

### Packaging a plugin as a `.deb`

Add a `packaging/<name>/control` (see `packaging/liteadmin-apikeys/`, which also ships `postinst`/`postrm`
that toggle the plugin in the config) and build:

```bash
packaging/build-plugin.sh liteadmin-apikeys 0.3.0
```

This produces `liteadmin-apikeys_0.3.0_all.deb`, which installs the plugin into
`/usr/share/liteadmin/plugins/<name>/`, depends on the `liteadmin` package, and enables itself on
install — no core changes required.

## Translating

LiteAdmin ships with **English, Dutch, German, Frisian and Swedish** (`src/i18n/*.json`).
The UI auto-detects the browser language on first visit and can be changed any time via the
language picker in Preferences; `app.lang` in `config.json` sets the default.

To add a language: copy `src/i18n/en.json` to `src/i18n/<code>.json`, translate the values
(keep the keys), then add the code to `SUPPORTED` and a display name to `LANG_NAMES` in
`src/js/i18n.js`. All locale files share the same key set.

## Contributing

`src/config.json` is a template and its `auth.password_hash` must stay empty in the
repository — never commit a real hash. A shared git hook enforces this. Enable it once
after cloning:

```sh
git config core.hooksPath .githooks
```

The `pre-commit` hook then rejects any commit that stages a non-empty
`auth.password_hash` in `src/config.json`.

## Contact

Use the issues tab for technical issues, or reach out on Mastodon on my handle @martijn@ieji.de .

## License

Released under the [MIT License](LICENSE). Vendored libraries in `src/vendor/` keep their
own respective licenses.
