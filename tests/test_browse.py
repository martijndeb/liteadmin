"""Open the bundled sample database and browse a table."""
from playwright.sync_api import expect


def _open_sample(page):
    page.goto("/")
    expect(page.get_by_text("Server databases")).to_be_visible()
    page.get_by_role("button", name="Open").first.click()
    expect(page.get_by_role("tab", name="Browse")).to_be_visible()


def test_table_list_and_grid(authed_page):
    _open_sample(authed_page)

    # The sample database ships with these two tables.
    rail = authed_page.locator(".table-list")
    expect(rail.get_by_text("posts", exact=True)).to_be_visible()
    expect(rail.get_by_text("users", exact=True)).to_be_visible()

    # The browse tab shows a populated data grid for the first table.
    grid = authed_page.locator("table.datagrid")
    expect(grid).to_be_visible()
    assert grid.locator("tbody tr").count() > 0


def test_switching_tables(authed_page):
    _open_sample(authed_page)
    authed_page.locator(".table-list").get_by_text("users", exact=True).click()
    grid = authed_page.locator("table.datagrid")
    expect(grid).to_be_visible()
    expect(grid.locator("thead")).to_contain_text("id")
