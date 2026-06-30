"""The first-run setup flow is performed by the `auth_state` fixture (it can
only run once per docroot). Here we confirm it produced a working session that
boots straight to the database picker."""


def test_authenticated_session_reaches_database_picker(authed_page):
    authed_page.goto("/")
    assert authed_page.get_by_text("Server databases").is_visible()
    assert authed_page.get_by_role(
        "heading", name="Sample Database"
    ).is_visible()
