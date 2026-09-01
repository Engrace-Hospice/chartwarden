// e2e/specs/documents.spec.ts — critical workflow 5/6: documents (TEST-001).
// Live-stack coverage for Patient Documents + Referral Documents. Upload paths intentionally use the
// real M22 verified upload UI: initiate -> presigned PUT -> complete -> signed URL view/open.
import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
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
    await expect(page.getByRole("dialog", { name: new RegExp(`View ${escapeRegExp(title)}`) })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await row.getByRole("button", { name: "History" }).click();
    await page.getByRole("button", { name: "Upload new version" }).click();
    await page.locator('input[type="file"]').setInputFiles(pdfFile("polst-v2.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(row.getByText(/PDF .* v2/)).toBeVisible();
  });

  test("main path: upload a referral fax document and view it from referral detail", async ({ page }) => {
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
    await expect(page.getByRole("dialog", { name: new RegExp(`View ${escapeRegExp(title)}`) })).toBeVisible();
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
