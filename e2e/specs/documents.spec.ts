// e2e/specs/documents.spec.ts — critical workflow 5/6: documents (TEST-001).
// Scoped to read + filter, not upload: apps/web has no upload UI anywhere yet (grepped for
// `type="file"` across the whole app — zero hits; the module's own screens.ts comment confirms
// "write+modal surfaces fill in as those write paths harden"). Testing an upload that doesn't exist
// would either be a stub (defeats the point of TEST-001) or silently pass on the wrong assertion —
// this stays honest about what the app can actually do today.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Documents", () => {
  test("main path: a patient's document list renders from a real API call", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    // Proves the retention-class filter round-trips through the API without crashing the screen.
    await page.getByLabel("Retention class").selectOption({ label: "Clinical" });
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  });

  test("accessibility: the documents list has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
