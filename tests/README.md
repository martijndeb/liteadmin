# End-to-end tests

These tests drive LiteAdmin in a real browser with
[pytest-playwright](https://playwright.dev/python/). They start a PHP server,
open the app, and check that login, browsing, and SQL all work.

## How it works

Each run copies `src/` into `tests/.tmp/www` and serves that copy with
`php -S`. The real `src/` is never changed. The copy starts with no password,
so the first-run setup flow runs and sets one. The tests then reuse that
session.

## Requirements

- PHP 8.0+ with the `pdo_sqlite` extension enabled.
- The Playwright Python package and a Chromium browser binary.

## Run

```
pytest
```

Useful options:

```
pytest --headed          # watch the browser
pytest -k browse         # run one file or test
pytest --slowmo 300      # slow each step down (ms)
```

## Files

- `conftest.py` — starts the PHP server, prepares the docroot, and provides
  the `authed_page` fixture (a page already signed in).
- `test_setup.py` — first-run setup and session.
- `test_login.py` — sign in, sign out, bad password.
- `test_browse.py` — table list and the data grid.
- `test_sql.py` — running SQL in the editor.
