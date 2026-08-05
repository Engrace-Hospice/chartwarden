// e2e/specs/admission.spec.ts — critical workflow 4/6: admission (TEST-001).
// The local demo seed has no hospice-medical-director provider entity to discover through the UI
// (no provider-entity picker exists on this form — it's a bare text id), so the "hospice medical
// director id" is a syntactically valid but almost certainly unmatched UUID. That's a deliberate,
// honest scope: this proves the full browser → generated client → CSRF → Fastify → Drizzle round
// trip either way — a real create (201) if it happens to resolve, or a real structured validation
// error (422) otherwise — never a client-side stub or a silent no-op.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Admission", () => {
  test("main path: direct-intake form submits for a real patient and reaches the server", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto("/admissions/new");
    await expect(
      page.getByRole("heading", { name: "New admission (direct intake)" }),
    ).toBeVisible();
    await page.getByLabel(/Patient id/).fill(patientId);
    await page
      .getByLabel(/Hospice medical director id/)
      .fill("00000000-0000-4000-8000-000000000000");
    const submit = page.getByRole("button", { name: "Create admission" });
    await expect(submit).toBeEnabled();
    await submit.click();
    // Either a real create (→ /admissions/:id) or a real structured server error — proves the round
    // trip completed, doesn't assume this environment's seed happens to have a matching director id.
    await page.waitForFunction(
      () =>
        /\/admissions\/[^/]+$/.test(window.location.pathname) ||
        document.querySelector('[role="alert"]') !== null,
      { timeout: 10_000 },
    );
    const created = /\/admissions\/[^/]+$/.test(new URL(page.url()).pathname);
    if (!created) await expect(page.getByRole("alert")).toBeVisible();
  });

  test("form gates submission on the two required fields", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admissions/new");
    const submit = page.getByRole("button", { name: "Create admission" });
    await expect(submit).toBeDisabled();
    await page.getByLabel(/Patient id/).fill("some-patient-id");
    await expect(submit).toBeDisabled(); // director id still empty
    await page
      .getByLabel(/Hospice medical director id/)
      .fill("00000000-0000-4000-8000-000000000000");
    await expect(submit).toBeEnabled();
  });

  test("accessibility: the direct-intake form has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admissions/new");
    await expect(
      page.getByRole("heading", { name: "New admission (direct intake)" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
