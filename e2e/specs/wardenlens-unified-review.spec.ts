import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

const BATCH = "a1000000-0000-4000-8000-000000000001";

const WORKSPACE = {
  batch: {
    id: BATCH,
    status: "in_review",
    sourceChannel: "fax",
    uploadedAt: "2026-11-22T10:00:00.000Z",
    documentId: "a1000000-0000-4000-8000-000000000002",
    patientId: "a1000000-0000-4000-8000-000000000003",
    patientName: "Synthetic Review Patient",
    referralId: "a1000000-0000-4000-8000-000000000004",
    identityStatus: "possible",
    recordsRequestConflict: null,
  },
  sud: {
    status: "detected",
    detectorRef: "synthetic-sud-detector-v1",
    resolvedAt: null,
    resolvedByMembershipId: null,
    contentRedacted: false,
    indicators: [
      {
        page: 3,
        category: "synthetic_indicator",
        ruleId: "synthetic-rule",
        term: "synthetic safeguard term",
        bbox: [10, 10, 20, 20],
      },
    ],
  },
  pages: [1, 2, 3, 4].map((page) => ({
    page,
    width: 612,
    height: 792,
    documentType: page === 3 ? "med_recon" : "discharge_summary",
    confidence: 0.96,
    needsHumanClassification: false,
  })),
  documents: [
    {
      pageFrom: 1,
      pageTo: 2,
      documentType: "discharge_summary",
      title: "Synthetic discharge summary",
      date: "2026-11-20",
      duplicateOfPage: null,
      boundary: "synthetic",
      identity: { status: "possible", disagreeing: ["lastName"], resolution: null },
    },
    {
      pageFrom: 3,
      pageTo: 4,
      documentType: "med_recon",
      title: "Synthetic medication reconciliation",
      date: "2026-11-21",
      duplicateOfPage: null,
      boundary: "synthetic",
      identity: { status: "match", disagreeing: [], resolution: null },
    },
  ],
  jobs: [],
  review: {
    id: "a1000000-0000-4000-8000-000000000005",
    status: "in_progress",
    reviewerMembershipId: "synthetic-membership",
    isMine: true,
  },
  candidates: [
    observation("01", "patient.phoneMobile", "(503) 555-0177", 1, "low"),
    observation("02", "patient.phoneMobile", "(503) 555-0188", 2, "low"),
    observation("03", "medications[0].name", "Synthetic medication 5 mg PO q4h", 3, "high"),
    observation("04", "medications[1].name", "Synthetic medication 10 mg PO q4h", 4, "high"),
  ],
};

function observation(
  suffix: string,
  fieldPath: string,
  value: string,
  page: number,
  riskLevel: "low" | "high",
) {
  return {
    id: `b2000000-0000-4000-8000-0000000000${suffix}`,
    jobId: `c3000000-0000-4000-8000-0000000000${suffix}`,
    documentType: page >= 3 ? "med_recon" : "discharge_summary",
    fieldPath,
    description: "Synthetic E2E observation",
    riskLevel,
    confidence: 0.93,
    value,
    page,
    bbox: [10, 10, 20, 20],
    vision: { status: riskLevel === "high" ? "verified" : "not_required", observedValue: null },
    sudDetected: page === 3,
    codingFlags: [],
    writebackTarget: riskLevel === "low",
    redacted: false,
    decision: null,
  };
}

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 1000 },
] as const;

async function capture(page: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> {
  const evidenceDir = process.env.WARDENLENS_V3_EVIDENCE_DIR;
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.getByRole("heading", { name: "Review patient information" }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(
      evidenceDir,
      `unified-review-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    ),
    fullPage: true,
  });
}

test("WardenLens unified review is exception-first, accessible, and responsive", async ({
  page,
}) => {
  await signInAs(page, ADMIN_ACCOUNT());
  await page.route(`**/api/v1/intake/uploads/${BATCH}/workspace`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(WORKSPACE),
    });
  });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto(`/intake/${BATCH}/review`);
    await expect(page.getByRole("heading", { name: "Review patient information" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Clinical review sections" }).getByRole("button"),
    ).toHaveCount(6);
    await expect(page.getByText("Mobile phone has conflicting sources")).toBeVisible();
    await page.getByRole("button", { name: /Medications & allergies/ }).click();
    await expect(page.getByText("Synthetic medication 5 mg PO q4h")).toBeVisible();
    await expect(page.getByText("Synthetic medication 10 mg PO q4h")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `unified review should not overflow horizontally at ${viewport.width}px`,
    ).toBe(true);
    await expectNoAxeViolations(page);
    await capture(page, viewport);
  }
});
