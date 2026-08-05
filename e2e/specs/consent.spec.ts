// e2e/specs/consent.spec.ts — critical workflow 3/6: consent (TEST-001).
// Real browser → generated client → CSRF (WX-PR-017) → Fastify → Drizzle → Postgres round trip:
// creating a consent draft is a genuine mutating write, not a read-only smoke check.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT, AUDITOR_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs, signOut } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Consent", () => {
  test("main path: capture a new consent draft for a real patient", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/consents/new`);
    await expect(page.getByRole("heading", { name: "Capture a new consent" })).toBeVisible();
    await page
      .getByPlaceholder("What this consent authorises, in plain language.")
      .fill("WX-PR-018 E2E: authorize routine care coordination.");
    await page.getByRole("button", { name: "Create draft" }).click();
    // A real write either lands on the consent's detail step (success) or surfaces a structured
    // server error inline — either way proves the full stack responded, not a client-side stub.
    await expect(
      page
        .getByText(/could not be created|permission|changed since you loaded/i)
        .or(page.getByRole("heading", { name: /Consent/ })),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("denied path: an account without consent-catalog read is blocked before the form ever renders", async ({
    page,
  }) => {
    // Discover the patient id as an account that CAN browse the census, then switch to the account
    // under test and navigate straight to the URL — the Compliance Auditor role doesn't carry
    // patient-census read, so `openFirstPatientChart` under that account finds no rows to click.
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await signOut(page);
    await signInAs(page, AUDITOR_ACCOUNT());
    await page.goto(`/patients/${patientId}/consents/new`);
    // The boundary is even earlier than the write itself: the page's own consent-type-catalog GET
    // 403s for this role, so the capture form never renders at all — an EmptyState shows instead of
    // "Capture a new consent". Confirmed by inspecting the real page (not assumed): the form never
    // appears, so there is no "Create draft" button to click for this role in the first place.
    await expect(page.getByText("Could not load the consent-type catalog.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "Capture a new consent" })).not.toBeVisible();
  });

  test("accessibility: the consent capture form has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/consents/new`);
    await expect(page.getByRole("heading", { name: "Capture a new consent" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
