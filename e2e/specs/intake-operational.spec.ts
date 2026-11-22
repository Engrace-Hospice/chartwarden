import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DemoAccount } from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";

const enabled = process.env.INTAKE_OPERATIONAL_ACCEPTANCE === "1";
const documentPath = process.env.INTAKE_SYNTHETIC_DOCUMENT;
const evidenceDir = process.env.INTAKE_EVIDENCE_DIR;

function requireLoopbackUrl(name: string): URL {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for isolated operational acceptance`);
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must use an http loopback origin; refusing target ${url.origin}`);
  }
  return url;
}

async function requireIsolatedAcceptanceStack(): Promise<void> {
  const webUrl = requireLoopbackUrl("E2E_BASE_URL");
  const stackId = process.env.INTAKE_ACCEPTANCE_STACK_ID;
  if (!stackId?.startsWith("cw-intake-oa-") || stackId.length < 20) {
    throw new Error("INTAKE_ACCEPTANCE_STACK_ID must be a unique cw-intake-oa-* marker");
  }
  const response = await fetch(new URL("/version", webUrl));
  if (!response.ok) throw new Error(`isolated API version probe failed with ${response.status}`);
  const version = (await response.json()) as { version?: unknown };
  if (version.version !== stackId) {
    throw new Error(
      `isolated API marker mismatch: expected ${stackId}, received ${String(version.version)}`,
    );
  }
}

function account(prefix: "ADMIN" | "REVIEWER"): DemoAccount {
  const email = process.env[`INTAKE_${prefix}_EMAIL`];
  const password = process.env[`INTAKE_${prefix}_PASSWORD`];
  if (!email || !password) throw new Error(`INTAKE_${prefix}_EMAIL/PASSWORD are required`);
  return { roleName: `Synthetic ${prefix.toLowerCase()}`, email, password };
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
}

async function clickAboveFooter(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  await button.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const geometry = await button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, height: value.height };
    };
    return {
      hittable: hit === element || (hit !== null && element.contains(hit)),
      target: { top: box.top, bottom: box.bottom, height: box.height },
      hit: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : null,
      main: rect(".wx-main"),
      workspace: rect(".wx-intake-workspace"),
      body: rect(".wx-intake-body"),
      center: rect(".wx-center-workspace"),
      footer: rect(".wx-intake-page > .wx-sticky-footer"),
    };
  });
  expect(geometry.hittable, `${name} geometry ${JSON.stringify(geometry)}`).toBe(true);
  const box = await button.boundingBox();
  if (!box) throw new Error(`${name} has no pointer box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function closeResponsiveNav(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: "Close navigation" });
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    await expect(close).toBeHidden();
  }
}

async function decideField(page: Page, index: number, total: number): Promise<void> {
  await page.locator(".wx-doclens-field").nth(index).click();
  await page.getByRole("checkbox", { name: "I compared this with the source" }).check();
  const reason = page.getByLabel("Reason for accepting despite the page reading");
  if (await reason.isVisible().catch(() => false)) {
    await reason.fill("Synthetic acceptance reviewer confirmed the source image.");
  }
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(
    page.getByText(`${index + 1} / ${total} fields decided`, { exact: true }),
  ).toBeVisible();
}

async function createReferral(page: Page): Promise<string> {
  await page.goto("/referrals/new");
  await page.getByLabel("Patient full name").fill(`Synthetic Intake OA ${Date.now()}`);
  await page.getByLabel("Source channel").selectOption({ label: "Fax" });
  await page.getByRole("button", { name: "Create referral" }).click();
  await page.waitForURL(/\/referrals\/(?!new)[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  if (!id) throw new Error("created referral id was absent from the URL");
  return id;
}

test.describe("intake operational acceptance", () => {
  test.skip(!enabled, "set INTAKE_OPERATIONAL_ACCEPTANCE=1 against an isolated full stack");

  test("synthetic referral, real WardenLens review, and exactly-once pending admission", async ({
    browser,
    page,
  }) => {
    test.setTimeout(8 * 60_000);
    page.setDefaultTimeout(20_000);
    if (!documentPath) throw new Error("INTAKE_SYNTHETIC_DOCUMENT is required");
    await requireIsolatedAcceptanceStack();

    await signInAs(page, account("ADMIN"));
    const referralId = await createReferral(page);
    await page.goto(`/referrals/${referralId}/intake`);
    await expect(page.getByRole("heading", { name: "Review the received referral" })).toBeVisible();

    const addRecords = page.getByRole("button", { name: "Add records" });
    // The intake footer is sticky. Center the section action before the pointer click so the footer
    // cannot cover the button when Playwright restores this deep-link at the bottom of the page.
    await addRecords.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await addRecords.click({ timeout: 15_000 });
    const upload = page.getByRole("dialog");
    await upload.getByLabel("Records file").setInputFiles(documentPath);
    await upload.getByLabel("Received by").selectOption({ label: "Fax" });
    const submit = upload.getByRole("button", { name: "Upload and file" });
    await submit.click();
    await expect(upload).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(/Records filed\. WardenLens is reading them/)).toBeVisible();

    // A refresh during processing must rehydrate the durable batch instead of enqueueing another one.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Review the received referral" })).toBeVisible();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/v1/intake/referral-batches?referralId=${referralId}`,
          );
          if (!response.ok()) return "request_failed";
          const body = (await response.json()) as { items?: { status?: string }[] };
          return body.items?.[0]?.status ?? "missing";
        },
        { timeout: 4 * 60_000, intervals: [5_000] },
      )
      .toBe("extraction_complete");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Review the received referral" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Review Fax received/ })).toBeVisible();
    await page.getByRole("link", { name: /Review Fax received/ }).click();
    const reviewPath = new URL(page.url()).pathname + new URL(page.url()).search;
    await screenshot(page, "01-wardenlens-ready-desktop");

    // Keep a concurrent discipline-free user signed in before the RN takes ownership. That session
    // later proves admission non-disclosure without weakening the high-risk-field discipline gate.
    const deniedContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
    const deniedPage = await deniedContext.newPage();
    deniedPage.setDefaultTimeout(20_000);
    await signInAs(deniedPage, account("REVIEWER"));
    await page.goto(reviewPath);
    const startDocumentReview = page.getByRole("button", {
      name: /^Start (?:document )?review$/,
    });
    await expect(startDocumentReview).toBeVisible();
    await startDocumentReview.click();

    const fields = page.locator(".wx-doclens-field");
    const count = await fields.count();
    expect(count).toBeGreaterThan(1);

    await page.setViewportSize({ width: 375, height: 812 });
    await closeResponsiveNav(page);
    await expect(page.getByRole("main")).toBeVisible();
    await decideField(page, 0, count);
    await screenshot(page, "02-review-mobile");
    await page.setViewportSize({ width: 768, height: 1024 });
    await closeResponsiveNav(page);
    await decideField(page, 1, count);
    await screenshot(page, "03-review-tablet");
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (let index = 2; index < count; index += 1) await decideField(page, index, count);
    await screenshot(page, "04-review-desktop");

    await page.getByRole("button", { name: "Complete review", exact: true }).click();
    const completion = page.getByRole("dialog", { name: "Complete review" });
    await completion.getByRole("checkbox").check();
    await completion.getByRole("button", { name: "Complete review", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Review complete" }).getByText("Review complete"),
    ).toBeVisible({ timeout: 30_000 });
    await screenshot(page, "05-review-complete");

    // The RN-owned review session continues into referral conversion while the clinical-only session
    // remains live, exercising concurrent authorization state without another rate-limited sign-in.
    const adminPage = page;
    await adminPage.goto(`/referrals/${referralId}/intake`);
    await adminPage.getByRole("button", { name: "Start review & continue" }).click();
    await expect(adminPage).toHaveURL(new RegExp(`/referrals/${referralId}/intake\\?step=verify$`));
    await adminPage.getByLabel("Date of birth").fill("1954-05-08");
    await adminPage.getByRole("button", { name: "Save & continue to patient matching" }).click();
    await expect(adminPage.getByRole("heading", { name: "Patient Resolution" })).toBeVisible();
    await clickAboveFooter(adminPage, "Create new patient");
    await expect(
      adminPage.getByRole("heading", { name: "Address referral blockers" }),
    ).toBeVisible();
    await adminPage
      .getByLabel("Referral reason or diagnosis")
      .fill("Synthetic terminal illness for operational acceptance");
    await adminPage
      .getByRole("textbox", { name: "Organization", exact: true })
      .fill("Synthetic Community Hospital");
    await clickAboveFooter(adminPage, "Save review information");
    await clickAboveFooter(adminPage, "Complete referral review");
    await expect(
      adminPage.getByRole("heading", { name: "Review and start the admission" }),
    ).toBeVisible();

    const code = adminPage.getByRole("combobox", { name: "Primary ICD-10" });
    await code.fill("C34.90");
    await code.press("Enter");
    const start = adminPage.getByRole("button", { name: "Start Admission", exact: true });
    await expect(start).toBeEnabled();
    // Two same-tick events exercise the client in-flight guard; the referral/census assertions below
    // independently prove that the completed conversion left exactly one admission.
    await start.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await adminPage.waitForURL(/\/admissions\/[^/]+$/);
    const admissionId = new URL(adminPage.url()).pathname.split("/").at(-1) as string;
    await expect(adminPage.getByRole("heading", { name: "Admission Intake" })).toBeVisible();
    await expect(
      adminPage.getByRole("heading", { name: "Required before activation" }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("heading", { name: "After admission and follow-up" }),
    ).toBeVisible();
    await screenshot(adminPage, "06-pending-admission-readiness");

    const referralResponse = await adminPage.request.get(`/api/v1/referrals/${referralId}`);
    expect(referralResponse.ok()).toBe(true);
    const referral = (await referralResponse.json()) as {
      status: string;
      convertedAdmissionId: string;
    };
    expect(referral).toMatchObject({ status: "converted", convertedAdmissionId: admissionId });

    const admissionResponse = await adminPage.request.get(`/api/v1/admissions/${admissionId}`);
    expect(admissionResponse.status()).toBe(200);
    const admission = (await admissionResponse.json()) as {
      id: string;
      state: string;
      version: number;
      referralId: string | null;
      activatedAt: string | null;
    };
    expect(admission).toMatchObject({
      id: admissionId,
      state: "pending",
      referralId,
      activatedAt: null,
    });

    const censusResponse = await adminPage.request.get("/api/v1/admissions?limit=100");
    expect(censusResponse.status()).toBe(200);
    const census = (await censusResponse.json()) as {
      items: { id: string; referralId?: string | null }[];
    };
    expect(census.items.filter((item) => item.referralId === referralId)).toEqual([
      expect.objectContaining({ id: admissionId }),
    ]);

    const csrfCookie = (await adminPage.context().cookies()).find((cookie) =>
      ["chartwarden_csrf", "__Host-chartwarden_csrf"].includes(cookie.name),
    );
    expect(csrfCookie, "the authenticated browser must have a CSRF cookie").toBeDefined();
    const prematureActivation = await adminPage.request.post(
      `/api/v1/admissions/${admissionId}/activate`,
      {
        data: { ifVersion: admission.version },
        headers: {
          "Idempotency-Key": `intake-oa-activation-${admissionId}`,
          "x-csrf-token": decodeURIComponent(csrfCookie?.value ?? ""),
        },
      },
    );
    expect(prematureActivation.status()).toBe(412);
    await expect(prematureActivation.json()).resolves.toMatchObject({
      error: { code: "ADMISSION_NOT_READY", details: expect.any(Array) },
    });

    const denied = await deniedPage.request.get(`/api/v1/admissions/${admissionId}`);
    expect(denied.status()).toBe(404);
    await deniedPage.goto(`/admissions/${admissionId}`);
    await expect(deniedPage.getByText("Unavailable", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(deniedPage.getByText("Admission not found or not visible to you.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(deniedPage.getByRole("heading", { name: "Admission Intake" })).toHaveCount(0);
    await deniedContext.close();
  });
});
