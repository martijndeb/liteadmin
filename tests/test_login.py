"""Sign-in / sign-out. These start signed out, so they use the plain `page`
fixture but depend on `auth_state` to guarantee a password has been set."""
import pytest
from playwright.sync_api import expect

from conftest import USERNAME, PASSWORD


@pytest.fixture(autouse=True)
def _signed_out(page, auth_state):
    page.context.clear_cookies()
    page.goto("/")
    expect(page.locator('input[name="username"]')).to_be_visible()


def test_rejects_bad_credentials(page):
    page.locator('input[name="username"]').fill(USERNAME)
    page.locator('input[name="password"]').fill("wrong-password")
    page.locator('button[type="submit"]').click()

    expect(page.locator("#snackbar")).to_contain_text("Invalid credentials")
    expect(page.locator('input[name="username"]')).to_be_visible()


def test_sign_in_then_sign_out(page):
    page.locator('input[name="username"]').fill(USERNAME)
    page.locator('input[name="password"]').fill(PASSWORD)
    page.locator('button[type="submit"]').click()

    expect(page.get_by_text("Server databases")).to_be_visible()

    page.get_by_role("button", name="Sign out").click()
    expect(page.locator('input[name="username"]')).to_be_visible()
