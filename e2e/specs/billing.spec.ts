// e2e/specs/billing.spec.ts — critical workflow 6/6: billing (TEST-001).
// Scoped to reachability + empty-state, not seeded-claim assertions: none of the repo's
// scripts/db/seed*.ts scripts insert any claim data, so a fresh `db:reset` has zero claims. The
// value here is proving the Claim Workbench survives a real (empty) API round trip under RLS — a
// broken RLS predicate or a crashing empty-state is exactly the kind of defect TEST-001 flags as
// invisible to unit tests.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

test.describe("Billing", () => {
  test("main path: the Claim Workbench renders without crashing on an empty claim set", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/billing/claims");
    await expect(page.getByRole("heading", { name: "Claim Workbench" })).toBeVisible();
    // No unhandled promise/render error surfaced as a blank page or an uncaught-exception overlay.
    await expect(page.locator("#root")).not.toBeEmpty();
  });

  test("main path: the AR dashboard renders its KPI shell", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/billing");
    await expect(page.getByRole("heading", { name: "Accounts Receivable" })).toBeVisible();
  });

  test("accessibility: the Claim Workbench has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/billing/claims");
    await expect(page.getByRole("heading", { name: "Claim Workbench" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
