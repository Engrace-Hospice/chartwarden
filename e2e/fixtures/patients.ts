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
  // F-023 (#56) — select the row through the roles the census actually exposes. This used to look
  // for a `<button>` inside the `<table>`, which was true when the spec was written and stopped
  // being true when the census moved to the shared `DataTable`
  // (packages/ui/src/web/components/data-table.tsx). That component renders a real `<tbody>` of
  // `<tr>`/`<td>` — so `row`/`cell`/`columnheader` all resolve now, and there is no button in the
  // table at all. The stale selector timed out and took seven E2E tests across three specs with it.
  //
  // `.nth(1)` skips the header row, which `getByRole("row")` also matches. Waiting on the row COUNT
  // rather than the first row's visibility additionally distinguishes "the census is still loading"
  // from "the census returned nothing" — the second is a real failure worth seeing as one.
  const rows = page.getByRole("table").getByRole("row");
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(1);
  const firstRow = rows.nth(1);
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await page.getByRole("button", { name: "Open chart" }).click();
  await page.waitForURL(/\/patients\/[^/]+$/);
  const match = page.url().match(/\/patients\/([^/?#]+)/);
  if (!match?.[1]) throw new Error(`e2e fixtures: could not parse patient id from ${page.url()}`);
  return match[1];
}
