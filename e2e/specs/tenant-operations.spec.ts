// e2e/specs/tenant-operations.spec.ts — critical workflow 2/6: tenant operations (TEST-001).
// Staff roster (/admin/staff — the Administration · Users view) is gated on the `member.manage` permission — Administrator has
// it, Clinician/Compliance Auditor don't. `app.tsx` maps every chromed screen to its route
// regardless of permission (nav-hiding is only a second line of defense), so a caller without the
// permission still renders the page shell but the member-list fetch 403s — this is the real,
// user-visible denied path, not a route redirect.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN_ACCOUNT, CLINICIAN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

test.describe("Tenant operations", () => {
  test("main path: an Administrator sees the real staff roster", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admin/staff");
    await expectStaffScreen(page);
    // Proves a real browser → API → DB round trip, not a stub: the seeded admin account's own row.
    const roster = page.getByRole("table", { name: "Organization users" });
    await expect(roster.getByText(ADMIN_ACCOUNT().email, { exact: true })).toBeVisible();
  });

  test("denied path: a Clinician without member.manage sees a permission alert, not the roster", async ({
    page,
  }) => {
    await signInAs(page, CLINICIAN_ACCOUNT());
    await page.goto("/admin/staff");
    await expectStaffScreen(page);
    await expect(
      page.getByText("Could not load staff. You may not have permission to manage members."),
    ).toBeVisible();
    await expect(page.getByText(ADMIN_ACCOUNT().email)).not.toBeVisible();
  });

  test("accessibility: the staff roster has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admin/staff");
    await expect(page.getByText(ADMIN_ACCOUNT().email, { exact: true })).toBeVisible();
    // The "success" tone StatusPill contrast gap flagged here during WX-PR-018 is fixed (WX-PR-022,
    // --color-success-pill-fg) — no exclusion needed anymore.
    await expectNoAxeViolations(page);
  });
});

/**
 * The staff roster since the #235 redesign: /admin/staff is the "Users" view of the Administration
 * workspace (an "Administration" page heading over a Users · Roles · Organization · … tab strip),
 * where it used to be its own "Staff Management" page. The Users tab and the roster's own controls
 * render for every caller; only the member read behind them is permission-gated.
 */
async function expectStaffScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Administration", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Users" }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search staff" })).toBeVisible();
}
