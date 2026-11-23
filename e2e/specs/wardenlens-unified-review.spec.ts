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
    bbox: [190, 170, 400, 212],
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

test.use({
  video: process.env.WARDENLENS_V3_EVIDENCE_DIR ? "on" : "retain-on-failure",
});

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
  let workspaceResponse = structuredClone(WORKSPACE);
  await page.route(`**/api/v1/intake/uploads/${BATCH}/workspace`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(workspaceResponse),
    });
  });
  await page.route(`**/api/v1/intake/uploads/${BATCH}/pages/*/image`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792">
        <rect width="612" height="792" fill="#fff"/><rect x="36" y="36" width="540" height="64" fill="#eef2f6"/>
        <text x="60" y="78" font-family="Arial" font-size="24" font-weight="700">SYNTHETIC DISCHARGE SUMMARY</text>
        <text x="60" y="150" font-family="Arial" font-size="18">Patient: Synthetic Review Patient</text>
        <text x="60" y="198" font-family="Arial" font-size="18">Contact phone:</text>
        <rect x="190" y="170" width="210" height="42" rx="6" fill="#fff3b0" stroke="#c79000"/>
        <text x="205" y="198" font-family="Arial" font-size="20" font-weight="700">(503) 555-0177</text>
        <line x1="60" y1="250" x2="552" y2="250" stroke="#cbd5e1"/>
        <text x="60" y="294" font-family="Arial" font-size="16">Synthetic clinical evidence for automated testing only.</text>
      </svg>`,
    });
  });
  await page.route("**/api/v1/intake/reviews/*/decisions", async (route) => {
    const body = route.request().postDataJSON() as {
      candidateId: string;
      decision: "approve" | "approve_with_edit" | "reject";
      editedValue?: string;
      reason?: string;
      sourceViewConfirmed: boolean;
    };
    const candidate = workspaceResponse.candidates.find((item) => item.id === body.candidateId);
    if (candidate) {
      candidate.decision = {
        id: `decision-${candidate.id}`,
        decision: body.decision,
        editedValue: body.editedValue ?? null,
        reason: body.reason ?? null,
        partOfBulkApprove: false,
        decidedAt: "2026-11-23T12:00:00.000Z",
      };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  for (const viewport of VIEWPORTS) {
    workspaceResponse = structuredClone(WORKSPACE);
    await page.setViewportSize(viewport);
    await page.goto(`/intake/${BATCH}/review`);
    await expect(page.getByRole("heading", { name: "Review patient information" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Clinical review sections" }).getByRole("button"),
    ).toHaveCount(6);
    await expect(page.getByRole("complementary", { name: "Review priorities" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Review task", exact: true })).toBeVisible();
    await expect(page.getByText("Source loaded")).toBeVisible();
    await page.getByRole("button", { name: /Medications & allergies/ }).click();
    await expect(page.getByText("Synthetic medication 5 mg PO q4h")).toBeVisible();
    await expect(page.getByText("Synthetic medication 10 mg PO q4h")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `unified review should not overflow horizontally at ${viewport.width}px`,
    ).toBe(true);

    const positions = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const clinical = box(".wx-unified-clinical");
      const task = box(".wx-unified-task-column");
      const exceptions = box(".wx-unified-exceptions");
      return clinical && task && exceptions
        ? {
            clinical: { x: clinical.x, y: clinical.y },
            task: { x: task.x, y: task.y },
            exceptions: { x: exceptions.x, y: exceptions.y },
          }
        : null;
    });
    expect(positions).not.toBeNull();
    if (viewport.name === "desktop") {
      expect(positions?.clinical.x).toBeLessThan(positions?.task.x ?? 0);
      expect(positions?.task.x).toBeLessThan(positions?.exceptions.x ?? 0);

      await page.getByRole("button", { name: /Patient identity & demographics/ }).click();
      await page
        .getByRole("button", { name: /Review decision/ })
        .first()
        .click();
      const confirmation = page.getByRole("checkbox", { name: /I compared this with the source/ });
      await expect(confirmation).toBeEnabled();
      await confirmation.check();
      await page.getByRole("button", { name: "Accept extracted value" }).click();
      await expect(page.getByText(/Decision saved: accepted/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Next issue/ })).toBeVisible();
    } else if (viewport.name === "mobile") {
      expect(positions?.exceptions.y).toBeLessThan(positions?.task.y ?? 0);
      expect(positions?.task.y).toBeLessThan(positions?.clinical.y ?? 0);
    }
    await expectNoAxeViolations(page);
    await capture(page, viewport);
  }
});
