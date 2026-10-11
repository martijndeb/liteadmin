"""The REST API plugin's exposure rules.

Runs against its own docroot and PHP server (the shared one from conftest has no
plugins enabled), and drives the HTTP API directly with urllib -- no browser is
needed to exercise the key/exposure matrix.
"""
import json
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

import pytest

from conftest import ROOT, SRC

PORT = 8078
BASE = f"http://127.0.0.1:{PORT}"
PASSWORD = "liteadmin-test-pw"
PLUGINS = ["liteadmin-apikeys", "liteadmin-restapi"]


@pytest.fixture(scope="module")
def api():
    """A running server with both plugins enabled, and a signed-in client."""
    tmp = ROOT / "tests" / ".tmp" / "restapi"
    if tmp.exists():
        shutil.rmtree(tmp)
    shutil.copytree(SRC, tmp)
    for name in ("config.json", "databases"):
        if not (tmp / name).exists():
            src = ROOT / "src" / name
            (shutil.copytree if src.is_dir() else shutil.copy2)(src, tmp / name)
    # A packaged docroot ships no plugins/ directory; take it from the source tree.
    if not (tmp / "plugins").exists():
        shutil.copytree(ROOT / "src" / "plugins", tmp / "plugins")

    cfg_path = tmp / "config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["auth"]["password_hash"] = ""
    cfg["plugins"] = PLUGINS
    # urllib honours the Secure cookie flag, so the session cookie would never be
    # sent back over this plain-HTTP server without it (see the README).
    cfg["insecure_http"] = True
    cfg_path.write_text(json.dumps(cfg, indent=4) + "\n")

    proc = subprocess.Popen(
        ["php", "-S", f"127.0.0.1:{PORT}", "-t", str(tmp)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_until_up()
        client = Client()
        client.setup(PASSWORD)
        client.docroot = tmp
        yield client
    finally:
        proc.terminate()
        proc.wait()


def _wait_until_up(timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(BASE, timeout=1)
            return
        except urllib.error.HTTPError:
            return
        except (urllib.error.URLError, socket.error):
            time.sleep(0.1)
    raise RuntimeError(f"php server did not come up at {BASE}")


class Client:
    """Session-authenticated LiteAdmin client plus raw /api requests."""

    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )
        self.csrf = ""
        self.docroot = None

    def exposure_row_count(self):
        """Rows in the plugin's exposure table; None while it has no database yet."""
        db = self.docroot / "data" / "liteadmin-restapi" / "restapi.sqlite"
        if not db.exists():
            return None
        con = sqlite3.connect(db)
        try:
            return con.execute("SELECT COUNT(*) FROM exposure").fetchone()[0]
        finally:
            con.close()

    def _post(self, path, body, headers=None):
        req = urllib.request.Request(
            f"{BASE}/{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        with self.opener.open(req) as r:
            return json.loads(r.read())

    def setup(self, password):
        d = self._post("index.php?action=setup", {"action": "setup", "password": password})
        self.csrf = d["csrf"]

    def plugin(self, name, action, **params):
        return self._post(
            "plugin.php",
            {"plugin": name, "action": action, **params},
            {"X-CSRF-Token": self.csrf},
        )

    def create_key(self, scope="write"):
        return self.plugin("liteadmin-apikeys", "create", label="test", scope=scope)["key"]

    def expose(self, databases):
        self.plugin("liteadmin-restapi", "save", databases=databases)

    def api_get(self, sub_path, key=None):
        """GET /api/<sub_path>. Returns (status, decoded body).

        The plugin's own front controller is addressed with its documented
        `_path` parameter, so the test does not depend on a server rewrite.
        Without a key the header is omitted rather than sent empty.
        """
        req = urllib.request.Request(
            f"{BASE}/plugins/liteadmin-restapi/api.php?_path={sub_path}",
            headers={"X-Api-Key": key} if key else {},
        )
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


def test_fresh_install_exposes_nothing(api):
    """A plugin that has never been configured must serve no table at all.

    This is the security default: enabling the plugin does not publish the
    admin's data, only the panel selection does.
    """
    # The module shares one server, so assert the precondition rather than rely
    # on this test running before any other has saved a selection.
    assert api.exposure_row_count() in (None, 0), "exposure was configured already"
    key = api.create_key()
    status, body = api.api_get("sample/users", key)
    assert status == 404, body
    assert body["error"] == "Table is not exposed"


def test_selected_table_is_served_and_others_are_not(api):
    key = api.create_key()
    api.expose({"sample": ["users"]})

    status, body = api.api_get("sample/users", key)
    assert status == 200, body
    assert isinstance(body["data"], list)

    status, body = api.api_get("sample/posts", key)
    assert status == 404, body


def test_deselecting_everything_takes_it_off_the_api(api):
    """Deselect all + Save must revoke, not fall back to serving everything."""
    key = api.create_key()
    api.expose({"sample": ["users"]})
    assert api.api_get("sample/users", key)[0] == 200

    api.expose({})
    status, body = api.api_get("sample/users", key)
    assert status == 404, body


def test_requests_without_a_key_are_rejected(api):
    api.expose({"sample": ["users"]})
    status, body = api.api_get("sample/users")
    assert status == 401, body


def test_read_key_cannot_write(api):
    read_key = api.create_key(scope="read")
    api.expose({"sample": ["users"]})
    req = urllib.request.Request(
        f"{BASE}/plugins/liteadmin-restapi/api.php?_path=sample/users",
        data=json.dumps({"name": "nope"}).encode(),
        headers={"X-Api-Key": read_key, "Content-Type": "application/json"},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(req)
    assert excinfo.value.code == 403
