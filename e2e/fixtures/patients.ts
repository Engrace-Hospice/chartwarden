// e2e/fixtures/patients.ts — discovers a REAL, in-scope patient id via the app itself (Patients ·
// Census list → row → "Open chart"), rather than hardcoding a UUID. A hardcoded id is fragile
// against `db:reset` reseeding AND, as WX-PR-017's live CSRF verification found, against RLS/org
// scope — a patient id from a stale fixture or a different org 404s. Discovering the id through the
// currently signed-in session's own UI sidesteps both problems by construction.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Opens the first row in the Patients · Census list and returns its chart's patient id. */
export async function openFirstPatientChart(page: Page): Promise<string> {
  await page.goto("/patients");
  // Each census row is an accessible `<button>` directly inside the `<table>` (not a `<tr>` with an
  // ARIA row role — the header cells are plain `generic`, not `columnheader`, either), so
  // `getByRole("row")` matches nothing. Scoping to the table's own buttons selects a real row.
  const firstRow = page.getByRole("table").getByRole("button").first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await page.getByRole("button", { name: "Open chart" }).click();
  await page.waitForURL(/\/patients\/[^/]+$/);
  const match = page.url().match(/\/patients\/([^/?#]+)/);
  if (!match?.[1]) throw new Error(`e2e fixtures: could not parse patient id from ${page.url()}`);
  return match[1];
}
