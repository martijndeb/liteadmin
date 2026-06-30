"""Shared fixtures: a throwaway docroot served by `php -S`, plus a one-time
first-run setup that the authenticated tests reuse via a saved session."""
import json
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
TMP = ROOT / "tests" / ".tmp"
DOCROOT = TMP / "www"
STATE = TMP / "state.json"

PORT = 8077
USERNAME = "admin"  # LiteAdmin's built-in default
PASSWORD = "liteadmin-test-pw"


def _prepare_docroot():
    """Copy src/ to a scratch dir and blank the password so the setup flow
    always runs. Keeps the real source pristine across test runs."""
    if TMP.exists():
        shutil.rmtree(TMP)
    shutil.copytree(SRC, DOCROOT)
    cfg_path = DOCROOT / "config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["auth"]["password_hash"] = ""
    cfg_path.write_text(json.dumps(cfg, indent=4) + "\n")


def _wait_until_up(url, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except urllib.error.HTTPError:
            return  # any HTTP response means the server is listening
        except (urllib.error.URLError, socket.error):
            time.sleep(0.1)
    raise RuntimeError(f"php server did not come up at {url}")


@pytest.fixture(scope="session")
def base_url():
    """pytest-playwright resolves relative page.goto() against this."""
    return f"http://127.0.0.1:{PORT}"


@pytest.fixture(scope="session", autouse=True)
def php_server(base_url):
    _prepare_docroot()
    proc = subprocess.Popen(
        ["php", "-S", f"127.0.0.1:{PORT}", "-t", str(DOCROOT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_until_up(base_url)
        yield base_url
    finally:
        proc.terminate()
        proc.wait()


@pytest.fixture(scope="session")
def auth_state(browser, base_url):
    """Run the first-run setup once (which also signs in) and save the
    session. This is where the setup UI itself gets exercised."""
    context = browser.new_context(base_url=base_url)
    page = context.new_page()
    page.goto("/")

    passwords = page.locator('input[type="password"]')
    passwords.nth(0).fill(PASSWORD)
    passwords.nth(1).fill(PASSWORD)
    page.locator('button[type="submit"]').click()
    page.get_by_text("Server databases").wait_for()

    STATE.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(STATE))
    context.close()
    return str(STATE)


@pytest.fixture
def authed_page(browser, base_url, auth_state):
    """A page with the saved session, so the app boots straight to the
    database picker."""
    context = browser.new_context(base_url=base_url, storage_state=auth_state)
    page = context.new_page()
    yield page
    context.close()
