import { Buffer } from "node:buffer";
// e2e/specs/documents.spec.ts — critical workflow 5/6: documents (TEST-001).
// Live-stack coverage for Patient Documents + Referral Documents. Upload paths intentionally use the
// real M22 verified upload UI: initiate -> presigned PUT -> complete -> signed URL view/open.
//
// The tag test covers the write path #153 was about. `document_tag` had two writers and no reader,
// so a tag was invisible and undeletable on the next page load — a defect that is INVISIBLE to a
// test that never reloads. The reload in that test is the assertion, not a formality. Tags need no
// object store, so that test does not depend on a MinIO deployment the way the upload tests do.
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Documents", () => {
  test("main path: a patient's document list renders from a real API call", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    // The #235 chart redesign renders the library as a "Documents" region inside the chart tab, next
    // to a "Key Documents" rail — so the heading is pinned exact. The per-type filter moved from a
    // button strip into the labelled "Type" select.
    const library = documentsLibrary(page);
    await expect(library.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
    await library.getByRole("combobox", { name: "Type" }).selectOption({ label: "POLST" });
    await expect(library.getByRole("combobox", { name: "Type" })).toHaveValue(
      "code_status_directive",
    );
    await expect(library.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
  });

  test("main path: upload a patient POLST, view it, upload a new version, and see history", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    const title = `E2E POLST ${Date.now()}`;

    await page.goto(`/patients/${patientId}/documents`);
    const library = documentsLibrary(page);
    // The header action is always present; the empty state adds a second "Upload document" button.
    await library.getByRole("button", { name: "Upload document" }).first().click();
    const upload = page.getByRole("dialog", { name: "Upload document" });
    await upload.getByLabel("Document type").selectOption({ label: "POLST" });
    await upload.getByLabel("Title").fill(title);
    await upload.locator('input[type="file"]').setInputFiles(pdfFile("polst.pdf"));
    await upload.getByRole("button", { name: "Upload document" }).click();
    await expect(upload).toBeHidden({ timeout: 15_000 });

    // The redesigned library is a table: the title is the "view" affordance, "More actions for …"
    // opens the detail dialog that hosts the version history and "Upload new version".
    const row = library.getByRole("row").filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(/PDF • v1/)).toBeVisible();
    await row.getByRole("button", { name: title, exact: true }).click();
    const viewer = page.getByRole("dialog", { name: title });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("Preview · v1")).toBeVisible();
    await viewer.getByRole("button", { name: "Close" }).click();
    await expect(viewer).toBeHidden();

    await row.getByRole("button", { name: `More actions for ${title}` }).click();
    await page
      .getByRole("dialog", { name: title })
      .getByRole("button", { name: "Upload new version" })
      .click();
    const newVersion = page.getByRole("dialog", { name: "Upload new version" });
    await newVersion.locator('input[type="file"]').setInputFiles(pdfFile("polst-v2.pdf"));
    await newVersion.getByRole("button", { name: "Upload new version" }).click();
    await expect(newVersion).toBeHidden({ timeout: 15_000 });
    await expect(row.getByText(/PDF • v2/)).toBeVisible();

    // …and the history keeps both versions, v2 current.
    await row.getByRole("button", { name: `More actions for ${title}` }).click();
    const detail = page.getByRole("dialog", { name: title });
    await expect(detail.getByRole("heading", { name: "Version history" })).toBeVisible();
    await expect(detail.getByText("POLST · v2", { exact: true })).toBeVisible();
    // "v1" only appears as a history row once v2 is current (the "Current version" field reads v2).
    await expect(detail.getByText("v1", { exact: true })).toBeVisible();
    await expect(detail.getByText("Current", { exact: true })).toHaveCount(1);
  });

  test("main path: upload a referral fax document and view it from referral detail", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const referralId = await createReferral(page);
    const title = `E2E Referral packet ${Date.now()}`;

    await page.goto(`/referrals/${referralId}`);
    await page.getByRole("button", { name: "Upload document" }).first().click();
    const upload = page.getByRole("dialog", { name: "Upload document" });
    await upload.getByLabel("Document type").selectOption({ label: "Referral document" });
    await upload.getByLabel("Source").selectOption({ label: "Fax" });
    await upload.getByLabel("Title").fill(title);
    await upload.getByLabel("Fax reference").fill("E2E-FAX");
    await upload.locator('input[type="file"]').setInputFiles(pdfFile("referral-packet.pdf"));
    await upload.getByRole("button", { name: "Upload document" }).click();
    await expect(upload).toBeHidden({ timeout: 15_000 });

    const row = page.locator("article").filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(/Fax/)).toBeVisible();
    await row.getByRole("button", { name: "View", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: title });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("Preview · v1")).toBeVisible();
  });

  test("main path: a tag survives the reload that used to erase it (#153/#91)", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    // Discovered through the app, never a hardcoded uuid — the explorer row's "Version history" link
    // is the way in: the version chain was once registered at `/documents/:documentId/versions` and
    // linked from NOWHERE, so every control it hosts was reachable only by typing a URL.
    await page.goto("/documents");
    const rows = page.getByRole("table").getByRole("link", { name: /^Version history for / });
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await rows.first().click();
    await page.waitForURL(/\/documents\/[^/]+\/versions$/);

    const key = `e2e-phase-${Date.now()}`;
    await page.getByRole("button", { name: "Add tag" }).click();
    // `getByLabel("Key")` is a SUBSTRING match and the form has three fields whose labels contain it
    // ("Kind", "Key", and the Value field's hint "…key with no value"), so both are pinned by role
    // and exact name.
    await page.getByRole("textbox", { name: "Key", exact: true }).fill(key);
    await page.getByRole("textbox", { name: /^Value/ }).fill("IIA");
    await page.getByRole("button", { name: "Add tag" }).click();
    await expect(page.getByText(key)).toBeVisible();

    // THE assertion. Before #153 the tag was written and then invisible to every client forever;
    // a spec that only checked the optimistic render would have passed against the broken build.
    await page.reload();
    await expect(page.getByText(key)).toBeVisible();

    // And removable — by an id that only a read could supply, which is why the DELETE was
    // unreachable by construction before the reader existed.
    await page.getByRole("button", { name: `Remove tag ${key}` }).click();
    await expect(page.getByText(key)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(key)).toHaveCount(0);
  });

  test("accessibility: the documents list has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    await expect(
      documentsLibrary(page).getByRole("heading", { name: "Documents", exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

/** The chart's Documents tab library — a labelled region beside the "Key Documents" rail. */
function documentsLibrary(page: Page): Locator {
  return page.getByRole("region", { name: "Documents", exact: true });
}

/**
 * Creates a fax referral through the real "New Referral" intake form and returns its id. None of the
 * demo seeds leaves a referral behind (seed-scenario-admission-outcomes deletes its patients'
 * referrals on every re-run), so "open the first inbox row" found an empty Referral Inbox. Creating
 * one through the UI keeps the id discovered from the app, never hardcoded, and makes the spec
 * independent of what other specs or seeds left in the inbox.
 */
async function createReferral(page: Page): Promise<string> {
  await page.goto("/referrals");
  await page.getByRole("button", { name: "New Referral" }).click();
  await page.waitForURL(/\/referrals\/new/);
  await page.getByLabel("Patient full name").fill(`E2E Referral ${Date.now()}`);
  await page.getByLabel("Source channel").selectOption({ label: "Fax" });
  await page.getByRole("button", { name: "Create referral" }).click();
  await page.waitForURL(/\/referrals\/(?!new)[^/]+$/, { timeout: 15_000 });
  const match = page.url().match(/\/referrals\/([^/?#]+)/);
  if (!match?.[1]) throw new Error(`e2e fixtures: could not parse referral id from ${page.url()}`);
  return match[1];
}

function pdfFile(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"),
  };
}
