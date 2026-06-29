"""Run a query through the Monaco SQL editor and read the result grid."""
from playwright.sync_api import expect


def _open_sample_sql(page):
    page.goto("/")
    expect(page.get_by_text("Server databases")).to_be_visible()
    page.get_by_role("button", name="Open").first.click()
    page.get_by_role("tab", name="SQL").click()
    # Wait for Monaco to have created its model.
    page.wait_for_function(
        "window.monaco && monaco.editor.getModels().length > 0"
    )


def _set_sql(page, sql):
    # Set the editor contents directly to avoid autocomplete/keystroke flakiness.
    page.evaluate("text => monaco.editor.getModels()[0].setValue(text)", sql)


def _run(page):
    # Material-icon ligatures put "play_arrow" in the button's accessible name,
    # so match the span text instead — and exactly, to skip "Run as script".
    page.locator('button:has(span:text-is("Run"))').click()


def test_run_select(authed_page):
    _open_sample_sql(authed_page)
    _set_sql(authed_page, "SELECT 42 AS answer")
    _run(authed_page)

    grid = authed_page.locator("table.datagrid")
    expect(grid).to_be_visible()
    expect(grid.locator("thead")).to_contain_text("answer")
    expect(grid.locator("tbody")).to_contain_text("42")


def test_run_select_against_table(authed_page):
    _open_sample_sql(authed_page)
    _set_sql(authed_page, "SELECT name FROM users ORDER BY id LIMIT 1")
    _run(authed_page)

    grid = authed_page.locator("table.datagrid")
    expect(grid).to_be_visible()
    expect(grid.locator("tbody tr")).to_have_count(1)
