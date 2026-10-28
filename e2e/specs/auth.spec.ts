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

  /**
   * NOTE FOR LOCAL ITERATION (F-081): this test spends one of `admin@`'s five failed-login attempts,
   * and `CREDENTIAL_THROTTLE_POLICY` is `perUsernameLimit: 5` over a 10-minute window. Run the whole
   * suite five times inside ten minutes and the account locks — after which every one of the 24 specs
   * that signs in as the administrator fails as a bare 30-second timeout with nothing on screen to say
   * why. That is the control working, not a defect, and CI (one run, fresh Valkey) never sees it; the
   * local fix is `redis-cli DEL ratelimit:login:user:<sha256(email)[0..32]>` or simply waiting.
   */
  test("denied path: wrong password shows an inline error, no navigation", async ({ page }) => {
    const account = ADMIN_ACCOUNT();
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Invalid username/email or password." }),
    ).toBeVisible();
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
