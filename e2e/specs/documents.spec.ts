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
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Documents", () => {
  test("main path: a patient's document list renders from a real API call", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await page.getByRole("button", { name: "POLST" }).click();
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  });

  test("main path: upload a patient POLST, view it, upload a new version, and see history", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    const title = `E2E POLST ${Date.now()}`;

    await page.goto(`/patients/${patientId}/documents`);
    await page.getByRole("button", { name: "Upload document" }).click();
    await page.getByLabel("Document type").selectOption({ label: "POLST" });
    await page.getByLabel("Title").fill(title);
    await page.locator('input[type="file"]').setInputFiles(pdfFile("polst.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();

    const row = page.locator("article").filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "View" }).click();
    await expect(
      page.getByRole("dialog", { name: new RegExp(`View ${escapeRegExp(title)}`) }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await row.getByRole("button", { name: "History" }).click();
    await page.getByRole("button", { name: "Upload new version" }).click();
    await page.locator('input[type="file"]').setInputFiles(pdfFile("polst-v2.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(row.getByText(/PDF .* v2/)).toBeVisible();
  });

  test("main path: upload a referral fax document and view it from referral detail", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const referralId = await openFirstReferral(page);
    const title = `E2E Referral packet ${Date.now()}`;

    await page.goto(`/referrals/${referralId}`);
    await page.getByRole("button", { name: "Upload document" }).click();
    await page.getByLabel("Document type").selectOption({ label: "Referral document" });
    await page.getByLabel("Source").selectOption({ label: "Fax" });
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Fax reference").fill("E2E-FAX");
    await page.locator('input[type="file"]').setInputFiles(pdfFile("referral-packet.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();

    const row = page.locator("article").filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(/Fax/)).toBeVisible();
    await row.getByRole("button", { name: "View" }).click();
    await expect(
      page.getByRole("dialog", { name: new RegExp(`View ${escapeRegExp(title)}`) }),
    ).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

async function openFirstReferral(page: import("@playwright/test").Page): Promise<string> {
  await page.goto("/referrals");
  const firstReferral = page.getByRole("table").getByRole("button").first();
  await expect(firstReferral).toBeVisible();
  await firstReferral.click();
  await page.waitForURL(/\/referrals\/[^/]+$/);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
