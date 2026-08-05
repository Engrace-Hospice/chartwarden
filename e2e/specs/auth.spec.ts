// e2e/specs/auth.spec.ts — critical workflow 1/6: Authentication (TEST-001).
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs, signOut } from "../fixtures/helpers";

test.describe("Authentication", () => {
  test("main path: sign in, select org, land on the shell", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("searchbox", { name: "Global search" })).toBeVisible();
  });

  test("denied path: wrong password shows an inline error, no navigation", async ({ page }) => {
    const account = ADMIN_ACCOUNT();
    await page.goto("/login");
    await page.getByPlaceholder("you@agency.org").fill(account.email);
    await page.getByPlaceholder("••••••••••").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign-in failed. Check your email and password.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("sign-out returns an authenticated session to /login", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await signOut(page);
    await expect(page).toHaveURL(/\/login/);
    // The session cookie is gone — reloading a chromed route bounces back to sign-in, not the shell.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("accessibility: the sign-in card has no WCAG 2A/AA violations", async ({ page }) => {
    await page.goto("/login");
    await expectNoAxeViolations(page);
  });
});
