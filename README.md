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

## Translating

LiteAdmin ships with **English, Dutch, German, Frisian and Swedish** (`src/i18n/*.json`).
The UI auto-detects the browser language on first visit and can be changed any time via the
language picker in Preferences; `app.lang` in `config.json` sets the default.

To add a language: copy `src/i18n/en.json` to `src/i18n/<code>.json`, translate the values
(keep the keys), then add the code to `SUPPORTED` and a display name to `LANG_NAMES` in
`src/js/i18n.js`. All locale files share the same key set.

## License

Released under the [MIT License](LICENSE). Vendored libraries in `src/vendor/` keep their
own respective licenses.
