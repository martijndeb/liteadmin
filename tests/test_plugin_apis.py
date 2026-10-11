"""liteadmin-graphql and liteadmin-auditlog over plain HTTP: a second php -S with
the API plugins enabled, driven like an API client would."""
import json
import shutil
import sqlite3
import subprocess
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from urllib.parse import quote

import pytest

from conftest import SRC, TMP, _wait_until_up

PORT = 8076  # 8077: conftest, 8078: test_restapi
BASE = f"http://127.0.0.1:{PORT}"
PASSWORD = "plugin-test-pw"
PLUGINS = ["liteadmin-apikeys", "liteadmin-restapi", "liteadmin-graphql", "liteadmin-auditlog"]
GQL = "/plugins/liteadmin-graphql/graphql.php/sample"

pytestmark = pytest.mark.skipif(not (SRC / "plugins" / "liteadmin-graphql").exists(),
                                reason="plugins ship separately from the core docroot")


@pytest.fixture(scope="module")
def server():
    root = TMP / "plugins-www"
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(SRC, root)
    cfg = json.loads((root / "config.json").read_text())
    cfg["auth"]["password_hash"] = subprocess.check_output(
        ["php", "-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);", PASSWORD], text=True)
    cfg["insecure_http"] = True
    cfg["plugins"] = PLUGINS
    (root / "config.json").write_text(json.dumps(cfg))
    proc = subprocess.Popen(["php", "-S", f"127.0.0.1:{PORT}", "-t", str(root)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait_until_up(BASE)
        yield root
    finally:
        proc.terminate()
        proc.wait()


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        self.csrf = ""

    def req(self, path, body=None, headers=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json", "X-CSRF-Token": self.csrf, **(headers or {})}
        r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
        try:
            with self.opener.open(r) as f:
                return f.status, f.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def plugin(self, name, action, **kw):
        return json.loads(self.req("/plugin.php", {"plugin": name, "action": action, **kw})[1])

    def gql(self, query, key, variables=None):
        status, body = self.req(GQL, {"query": query, "variables": variables}, {"X-Api-Key": key})
        return status, json.loads(body)


@pytest.fixture(scope="module")
def admin(server):
    c = Client()
    status, body = c.req("/index.php?action=login", {"action": "login", "username": "admin", "password": PASSWORD})
    assert status == 200, body
    c.csrf = json.loads(body)["csrf"]
    c.read_key = c.plugin("liteadmin-apikeys", "create", label="reader", scope="read")["key"]
    c.write_key = c.plugin("liteadmin-apikeys", "create", label="writer", scope="write")["key"]
    assert c.plugin("liteadmin-restapi", "save", databases={"sample": ["users", "posts"]})["ok"]
    return c


def test_graphql_queries_follow_foreign_keys(admin):
    status, r = admin.gql("{ users(order_by: id, limit: 1) { name posts(order_by: id) { title user { name } } } posts_count }",
                          admin.read_key)
    assert status == 200 and "errors" not in r, r
    ada = r["data"]["users"][0]
    assert ada["name"] == "Ada Lovelace"
    assert ada["posts"] and all(p["user"]["name"] == "Ada Lovelace" for p in ada["posts"])
    assert r["data"]["posts_count"] >= len(ada["posts"])


def test_graphql_variables_fragments_and_directives(admin):
    q = """query One($id: ID!, $full: Boolean = false) {
             u: users_by_pk(id: $id) { ...Names email @include(if: $full) __typename }
           }
           fragment Names on Users { name }"""
    _, r = admin.gql(q, admin.read_key, {"id": 2})
    assert r == {"data": {"u": {"name": "Alan Turing", "__typename": "Users"}}}


def test_graphql_rejects_bad_requests(admin):
    assert admin.req(GQL, {"query": "{ users { id } }"})[0] == 401
    assert "Cannot query field" in admin.gql("{ nope }", admin.read_key)[1]["errors"][0]["message"]
    assert "Syntax error" in admin.gql("{ users { id ", admin.read_key)[1]["errors"][0]["message"]
    deep = "{ users { " + "posts { user { " * 6 + "id" + " } }" * 6 + " } }"
    assert "nested too deeply" in admin.gql(deep, admin.read_key)[1]["errors"][0]["message"]
    status, body = admin.req(GQL + "?query=" + quote("mutation { delete_posts(id: 1) }"), None,
                             {"X-Api-Key": admin.write_key}, "GET")
    assert "POST" in json.loads(body)["errors"][0]["message"]


def test_graphql_mutations_need_write_scope_and_are_atomic(admin):
    m = 'mutation { insert_users(data: {name: "Reader", email: "reader@x.dev"}) { id } }'
    assert "read+write" in admin.gql(m, admin.read_key)[1]["errors"][0]["message"]

    _, r = admin.gql('mutation($n: String!) { insert_users(data: {name: $n, email: "gq@x.dev"}) { id name } }',
                     admin.write_key, {"n": "Graph Q"})
    assert r["data"]["insert_users"]["name"] == "Graph Q"

    count = lambda: admin.gql("{ users_count }", admin.read_key)[1]["data"]["users_count"]
    before = count()
    _, r = admin.gql('mutation { a: insert_users(data: {name: "A", email: "dup@x.dev"}) { id } '
                     'b: insert_users(data: {name: "B", email: "dup@x.dev"}) { id } }', admin.write_key)
    assert r["errors"] and r["data"] is None
    assert count() == before  # the first insert was rolled back with the second


def test_sdl_is_published(admin):
    status, sdl = admin.req(GQL + "/schema.graphql", None, {"X-Api-Key": admin.read_key}, "GET")
    assert status == 200
    assert "type Users {" in sdl and "posts(where: PostsInput" in sdl and "type Mutation {" in sdl


def test_audit_log_records_every_write_source(admin, server):
    admin.req("/plugins/liteadmin-restapi/api.php/sample/users", {"name": "Rest", "email": "rest@x.dev"},
              {"X-Api-Key": admin.write_key})
    admin.req("/proxy.php", {"action": "query", "db": "sample", "sql": "UPDATE users SET name = name WHERE id = 1"})
    admin.req("/proxy.php", {"action": "query", "db": "sample", "sql": "SELECT 1"})

    entries = admin.plugin("liteadmin-auditlog", "list", limit=1000)["entries"]
    seen = {(e["source"], e["action"]) for e in entries}
    assert {("plugin", "liteadmin-apikeys:create"), ("plugin", "liteadmin-restapi:save"),
            ("graphql", "insert"), ("graphql", "mutation"), ("rest", "POST"), ("sql", "query")} <= seen
    assert not any(e["sql"] == "SELECT 1" for e in entries)  # reads are not audited
    rest = next(e for e in entries if e["source"] == "rest")
    assert rest["actor"] == "apikey:writer" and rest["target"] == "users" and rest["row_id"]
    assert all("key" not in json.loads(e["detail"] or "{}").get("data", {}) for e in entries)

    assert admin.plugin("liteadmin-auditlog", "verify")["intact"] is True
    db = sqlite3.connect(server / "data" / "liteadmin-auditlog" / "auditlog.sqlite")
    db.execute("UPDATE log SET actor = 'someone-else' WHERE id = 2")
    db.commit()
    db.close()
    v = admin.plugin("liteadmin-auditlog", "verify")
    assert v["intact"] is False and v["broken_at"] == 2
