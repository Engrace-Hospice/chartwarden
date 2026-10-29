// e2e/specs/admission.spec.ts — critical workflow 4/6: admission (TEST-001).
//
// F-023 (#56) — rewritten against the redesigned direct-intake screen. This spec was authored when
// `/admissions/new` was a single flat form of bare uuid text inputs, and its own header said "no
// provider-entity picker exists on this form — it's a bare text id", so it typed a syntactically
// valid but deliberately unmatched uuid for the medical director and accepted a 422 as proof of a
// round trip. The screen is now a three-step wizard (Intake context → Clinical responsibility →
// Review & create) whose patient and physician fields are real searchable lookups backed by the
// M5 census and the M40 directory.
//
// That makes the test STRONGER, not just different: the medical director is now chosen from the
// seeded M40 physician directory (`db:seed:mdm`), so the main path asserts a genuine 201 and a
// navigation to the created admission rather than settling for "some structured error came back".
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

/**
 * Drive one `EntityLookupField`: focus it, type, and pick the first real option. Selecting from the
 * listbox — rather than typing an id — is the point: it exercises the lookup's own API call and the
 * id it hands back, which is what a user actually does.
 */
async function pickFromLookup(page: Page, label: string, query: string): Promise<string> {
  const field = page.getByRole("combobox", { name: new RegExp(label) });
  await field.click();
  await field.fill(query);
  const option = page.getByRole("option").first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  const text = (await option.textContent()) ?? "";
  await option.click();
  return text;
}

/**
 * "Continue" is always enabled (#329): pressing it on an incomplete step shows that step's field
 * error and stays put, instead of the button being disabled up front.
 */
async function continueBlockedWith(page: Page, message: string): Promise<void> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(message)).toBeVisible();
}

/**
 * Complete step 1 ("Intake context"): the patient and the UB-04 admission type and point of origin.
 * Those three gate "Continue" (`intakeReady` in admission-create), alongside the benefit-period number,
 * which the screen prefills. The HETS confirmation is only a warning and is left alone.
 */
async function completeIntakeContext(page: Page): Promise<void> {
  await pickFromLookup(page, "Patient", "Whitfield");
  // By option value (the UB-04 code), not label: the labels are "<code> — <text>" and would break on relabel.
  await page.getByRole("combobox", { name: /Type of admission/ }).selectOption("3"); // Elective
  await page.getByRole("combobox", { name: /Point of origin/ }).selectOption("1"); // Non-health care facility
  // The selected patient's benefit-period plan loads asynchronously and gates Continue.
  await expect(page.getByRole("spinbutton", { name: "Benefit period number" })).toHaveValue("1");
}

test.describe("Admission", () => {
  test("main path: direct-intake wizard creates an admission for a real patient", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInAs(page, ADMIN_ACCOUNT());
    // Discover a real, in-scope patient through the app itself, then find them in the lookup.
    await openFirstPatientChart(page);
    await page.goto("/admissions/new");
    await expect(page.getByRole("heading", { name: "New admission" })).toBeVisible();

    // Step 1 — Intake context. "Continue" without a patient shows the error and stays on the step.
    const advance = page.getByRole("button", { name: "Continue" });
    await continueBlockedWith(page, "Select a patient before continuing.");
    await completeIntakeContext(page);
    await advance.click();

    // Step 2 — Clinical responsibility. Only the medical director is required.
    await expect(page.getByRole("heading", { name: "Clinical responsibility" })).toBeVisible();
    await continueBlockedWith(page, "Select a hospice medical director.");
    await pickFromLookup(page, "Hospice medical director", "a");
    await advance.click();

    // Step 3 — Review & create. A real browser → generated client → CSRF → Fastify → Drizzle round
    // trip; either the created admission's page or a structured server error, never a silent no-op.
    await expect(page.getByRole("heading", { name: "Review admission" })).toBeVisible();
    await page.getByRole("button", { name: "Create admission" }).click();
    await page.waitForFunction(
      () =>
        /\/admissions\/[^/]+$/.test(window.location.pathname) ||
        document.querySelector('[role="alert"]') !== null,
      { timeout: 15_000 },
    );
    const created = /\/admissions\/[^/]+$/.test(new URL(page.url()).pathname);
    if (!created) await expect(page.getByRole("alert").first()).toBeVisible();
    expect(created, "the wizard should have created the admission and navigated to it").toBe(true);
  });

  test("the wizard gates each step on its own required field", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admissions/new");

    // The later steps are not reachable by clicking the stepper either — the gate is the state, not
    // just the button. This is the assertion the old flat-form version could not make.
    await expect(page.getByRole("button", { name: /Clinical responsibility/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Review & create/ })).toBeDisabled();

    const advance = page.getByRole("button", { name: "Continue" });
    await continueBlockedWith(page, "Select a patient before continuing.");
    await expect(page.getByRole("heading", { name: "Clinical responsibility" })).toBeHidden();
    await completeIntakeContext(page);
    await advance.click();

    // Step 2 gates independently: an attending physician is optional, the director is not.
    await expect(page.getByRole("heading", { name: "Clinical responsibility" })).toBeVisible();
    await continueBlockedWith(page, "Select a hospice medical director.");
    await expect(page.getByRole("heading", { name: "Review admission" })).toBeHidden();
    await pickFromLookup(page, "Hospice medical director", "a");
    await advance.click();
    await expect(page.getByRole("heading", { name: "Review admission" })).toBeVisible();
  });

  test("step 1 also gates on the admission type and the point of origin", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admissions/new");
    const clinical = page.getByRole("heading", { name: "Clinical responsibility" });
    const advance = page.getByRole("button", { name: "Continue" });
    await pickFromLookup(page, "Patient", "Whitfield");

    // A patient alone is not enough: each remaining intake gate holds the step on its own.
    await continueBlockedWith(page, "Choose the type of admission.");
    await page.getByRole("combobox", { name: /Type of admission/ }).selectOption("3");
    await continueBlockedWith(page, "Choose the point of origin.");
    await page.getByRole("combobox", { name: /Point of origin/ }).selectOption("1");
    await advance.click();
    await expect(clinical).toBeVisible();
  });

  test("accessibility: the direct-intake wizard has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/admissions/new");
    await expect(page.getByRole("heading", { name: "New admission" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
