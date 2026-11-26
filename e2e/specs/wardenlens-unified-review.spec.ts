import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

const BATCH = "a1000000-0000-4000-8000-000000000001";

/** The one review button on an observation row: "Review <value>, page <n>". */
const REVIEW_ROW = /^Review .+, page \d+$/;

const SYNTHETIC_PAGES = Array.from({ length: 19 }, (_, index) => index + 1);
const SYNTHETIC_DOCUMENTS = SYNTHETIC_PAGES.map((page) => ({
  pageFrom: page,
  pageTo: page,
  documentType: page % 4 === 0 ? "med_recon" : "discharge_summary",
  title: `Synthetic referral document ${page}`,
  date: `2026-11-${String(Math.min(22, page + 1)).padStart(2, "0")}`,
  duplicateOfPage: null,
  boundary: "synthetic",
  identity:
    page === 1
      ? {
          status: "possible" as const,
          disagreeing: ["lastName"],
          resolution: null as "same_patient" | "other_patient" | null,
        }
      : {
          status: "match" as const,
          disagreeing: [],
          resolution: null as "same_patient" | "other_patient" | null,
        },
}));

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
  pages: SYNTHETIC_PAGES.map((page) => ({
    page,
    width: 612,
    height: 792,
    documentType: page === 3 ? "med_recon" : "discharge_summary",
    confidence: 0.96,
    needsHumanClassification: false,
  })),
  documents: SYNTHETIC_DOCUMENTS,
  jobs: [],
  review: {
    id: "a1000000-0000-4000-8000-000000000005",
    status: "in_progress",
    reviewerMembershipId: "synthetic-membership",
    isMine: true,
  },
  candidates: syntheticObservations(),
};

function observation(
  sequence: number,
  fieldPath: string,
  value: string,
  page: number,
  riskLevel: "low" | "high",
) {
  return {
    id: `b2000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    jobId: `c3000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    documentType: page >= 3 ? "med_recon" : "discharge_summary",
    fieldPath,
    description: "Synthetic E2E observation",
    riskLevel,
    confidence: 0.93,
    value,
    page,
    bbox: [190, 170, 400, 212] as [number, number, number, number],
    vision: {
      status: (riskLevel === "high" ? "verified" : "not_required") as
        | "verified"
        | "not_required"
        | "disagreed",
      observedValue: null as string | null,
    },
    sudDetected: page === 3,
    codingFlags: [],
    writebackTarget: riskLevel === "low",
    redacted: false,
    decision: null as null | {
      id: string;
      decision: "approve" | "approve_with_edit" | "reject";
      editedValue: string | null;
      reason: string | null;
      partOfBulkApprove: boolean;
      decidedAt: string;
    },
  };
}

/**
 * The original usability failure involved 19 documents, 217 observations and 101 projected
 * requirements. This deterministic synthetic twin reproduces that scale without copying any
 * production referral data: 32 three-reason medication groups, one high-risk group, one phone
 * conflict, one ordinary undecided group, one identity safeguard and one SUD safeguard.
 */
function syntheticObservations() {
  const items: ReturnType<typeof observation>[] = [];
  let sequence = 1;
  for (let medication = 0; medication < 32; medication += 1) {
    for (let source = 0; source < 6; source += 1) {
      const page = ((medication * 6 + source) % 19) + 1;
      const item = observation(
        sequence,
        `medications[${medication}].name`,
        `Synthetic medication ${medication + 1} 5 mg PO q4h`,
        page,
        "high",
      );
      item.confidence = 0.61;
      item.vision = { status: "disagreed", observedValue: "Synthetic alternate reading" };
      items.push(item);
      sequence += 1;
    }
  }
  for (let source = 0; source < 6; source += 1) {
    items.push(
      observation(
        sequence,
        "allergies[0].substance",
        "Synthetic allergen",
        (source % 19) + 1,
        "high",
      ),
    );
    sequence += 1;
  }
  for (const value of ["(503) 555-0177", "(503) 555-0188", "(503) 555-0142"]) {
    items.push(observation(sequence, "patient.phoneMobile", value, (sequence % 19) + 1, "low"));
    sequence += 1;
  }
  for (let source = 0; source < 16; source += 1) {
    items.push(
      observation(sequence, "patient.phoneHome", "(503) 555-0100", (source % 19) + 1, "low"),
    );
    sequence += 1;
  }
  return items;
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

/**
 * The six identical sources of a medication consolidate into one row, so a per-source Review button
 * exists only once its disclosure is open. Opens the last disclosure and returns the last Review button.
 */
async function lastReviewButton(page: Page) {
  const sources = page.getByRole("button", { name: /^Sources for / }).last();
  await sources.scrollIntoViewIfNeeded();
  if ((await sources.getAttribute("aria-expanded")) !== "true") await sources.click();
  return page.getByRole("button", { name: REVIEW_ROW }).last();
}

/**
 * D-01/D-03: the SUD exception names a field candidate on its page, but it must open the Part 2
 * safeguard block (marked and focused), never that field's task. Opening a task can auto-expand its
 * category, so the category is clicked only while it is collapsed.
 */
async function openSudSafeguard(page: Page) {
  const priorities = page.getByRole("complementary", { name: "Review priorities" });
  const category = priorities.getByRole("button", { name: /Part 2 \/ SUD safeguards/ });
  await category.scrollIntoViewIfNeeded();
  if ((await category.getAttribute("aria-expanded")) !== "true") await category.click();
  await priorities.getByRole("button", { name: /Part 2 \/ SUD safeguard is unresolved/ }).click();
  const block = page.getByRole("group", { name: "Part 2 / SUD safeguard" });
  await expect(block).toHaveAttribute("aria-current", "true");
  await expect(block).toBeFocused();
  return block;
}

test("WardenLens unified review is exception-first, accessible, and responsive", async ({
  page,
}) => {
  await signInAs(page, ADMIN_ACCOUNT());
  let workspaceResponse = structuredClone(WORKSPACE);
  let released = false;
  await page.route(`**/api/v1/intake/uploads/${BATCH}/workspace`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(released ? { ...workspaceResponse, review: null } : workspaceResponse),
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
  let releaseCalled = false;
  let completeCalled = false;
  await page.route("**/api/v1/intake/reviews/*/abandon", async (route) => {
    releaseCalled = true;
    released = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/v1/intake/reviews/*/complete", async (route) => {
    completeCalled = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  for (const viewport of VIEWPORTS) {
    workspaceResponse = structuredClone(WORKSPACE);
    await page.setViewportSize(viewport);
    await page.goto(`/intake/${BATCH}/review`);
    await expect(page.getByRole("heading", { name: "Review patient information" })).toBeVisible();
    await expect(
      page.getByText("Consolidated information from 19 source documents."),
    ).toBeVisible();
    await expect(page.getByText(/101 underlying requirements/)).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Clinical review sections" }).getByRole("button"),
    ).toHaveCount(6);
    await expect(page.getByRole("complementary", { name: "Review priorities" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Review task", exact: true })).toBeVisible();
    await expect(page.getByText("Source loaded")).toBeVisible();
    const medicationSection = page.getByRole("button", { name: /Medications & allergies/ });
    await expect(medicationSection).toHaveAttribute("aria-expanded", "true");
    await medicationSection.click();
    await expect(page.getByText("Synthetic medication 1 5 mg PO q4h").first()).toBeVisible();
    await expect(page.getByText("Synthetic medication 2 5 mg PO q4h").first()).toBeVisible();
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
    await expectNoAxeViolations(page);
    await capture(page, viewport);

    if (viewport.name === "desktop") {
      expect(positions?.clinical.x).toBeLessThan(positions?.task.x ?? 0);
      expect(positions?.task.x).toBeLessThan(positions?.exceptions.x ?? 0);

      const deepDecision = await lastReviewButton(page);
      await deepDecision.scrollIntoViewIfNeeded();
      const mainScrollport = page.locator(".wx-main");
      const scrollBeforeDecision = await mainScrollport.evaluate((element) => element.scrollTop);
      await deepDecision.click();
      await expect
        .poll(async () =>
          Math.abs(
            (await mainScrollport.evaluate((element) => element.scrollTop)) - scrollBeforeDecision,
          ),
        )
        .toBeLessThanOrEqual(2);
      await expect(page.locator(".wx-unified-task-column")).toBeInViewport();

      // The block is also scrolled into the task column.
      const sudBlock = await openSudSafeguard(page);
      expect(
        await sudBlock.evaluate((block) => {
          const column = block.closest(".wx-unified-task-column")?.getBoundingClientRect();
          const top = block.getBoundingClientRect().top;
          return column ? top >= column.top - 1 && top < column.bottom : false;
        }),
        "the SUD block should sit inside the visible task column",
      ).toBe(true);
      await expectNoAxeViolations(page);

      await page.getByRole("button", { name: /Patient identity & demographics/ }).click();
      await page.getByRole("button", { name: REVIEW_ROW }).first().click();
      const confirmation = page.getByRole("checkbox", { name: /I compared this with the source/ });
      await expect(confirmation).toBeEnabled();
      await confirmation.check();
      await page.getByRole("button", { name: "Accept extracted value" }).click();
      await expect(page.getByText(/Decision saved: accepted/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Next issue/ })).toBeVisible();

      await expect(page.getByRole("button", { name: "Release review" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Complete review" })).toBeDisabled();
      await page.getByRole("button", { name: "Release review" }).click();
      await expect.poll(() => releaseCalled).toBe(true);
      await expect(page.getByRole("button", { name: "Start review" })).toBeVisible();

      workspaceResponse = structuredClone(WORKSPACE);
      released = false;
      workspaceResponse.batch.identityStatus = "match";
      workspaceResponse.sud.status = "confirmed";
      workspaceResponse.documents = workspaceResponse.documents.map((document) => ({
        ...document,
        identity: { status: "match", disagreeing: [], resolution: "same_patient" },
      }));
      workspaceResponse.candidates = workspaceResponse.candidates.map((candidate) => ({
        ...candidate,
        decision: {
          id: `decision-${candidate.id}`,
          decision: "reject",
          editedValue: null,
          reason: "Synthetic browser verification",
          partOfBulkApprove: false,
          decidedAt: "2026-11-23T12:00:00.000Z",
        },
      }));
      await page.reload();
      const complete = page.getByRole("button", { name: "Complete review" });
      await expect(complete).toBeEnabled();
      await complete.click();
      const dialog = page.getByRole("dialog", { name: "Complete review" });
      await dialog.getByRole("checkbox", { name: /I reviewed each accepted field/ }).check();
      await dialog.getByRole("button", { name: "Complete review" }).click();
      await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible();
      expect(completeCalled).toBe(true);
    } else if (viewport.name === "mobile") {
      expect(positions?.exceptions.y).toBeLessThan(positions?.task.y ?? 0);
      expect(positions?.task.y).toBeLessThan(positions?.clinical.y ?? 0);

      const taskColumn = page.locator(".wx-unified-task-column");
      // Focus lands on the opened task's heading (the column is only the fallback).
      const taskHeading = taskColumn.locator("[data-task-heading]");
      const mobileDecision = await lastReviewButton(page);
      await mobileDecision.scrollIntoViewIfNeeded();
      await mobileDecision.click();
      await expect(taskHeading).toBeFocused();
      await expect(taskColumn).toBeInViewport();

      const priorities = page.getByRole("complementary", { name: "Review priorities" });
      const conflicts = priorities.getByRole("button", {
        name: /Conflicting extracted values/,
      });
      await conflicts.scrollIntoViewIfNeeded();
      await conflicts.click();
      await priorities
        .getByRole("button", { name: /Mobile phone/ })
        .first()
        .click();
      await expect(taskHeading).toBeFocused();
      await expect(taskColumn).toBeInViewport();

      // The narrow layout reveals the Part 2 safeguard block the same way: focused, in view, accessible.
      const mobileSudBlock = await openSudSafeguard(page);
      await expect(mobileSudBlock).toBeInViewport();
      await expectNoAxeViolations(page);
    }
  }
});
