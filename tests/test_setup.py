"""The first-run setup flow is performed by the `auth_state` fixture (it can
only run once per docroot). Here we confirm it produced a working session that
boots straight to the database picker."""

from playwright.sync_api import expect


def test_authenticated_session_reaches_database_picker(authed_page):
    authed_page.goto("/")
    expect(authed_page.get_by_text("Server databases")).to_be_visible()
    expect(
        authed_page.get_by_role("heading", name="Sample Database")
    ).to_be_visible()
