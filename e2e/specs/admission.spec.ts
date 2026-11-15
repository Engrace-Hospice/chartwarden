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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN_ACCOUNT, PLATFORM_OPS_ACCOUNT, PRESCRIBER_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs, signOut } from "../fixtures/helpers";

const RESPONSIVE_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 1000 },
] as const;

let cachedAdminCookies: Parameters<ReturnType<Page["context"]>["addCookies"]>[0] | null = null;

async function signInAsAdmin(page: Page): Promise<void> {
  if (cachedAdminCookies) {
    await page.context().addCookies(cachedAdminCookies);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /Ada Administrator.*account menu/ }),
    ).toBeVisible();
    return;
  }
  await signInAs(page, ADMIN_ACCOUNT());
  cachedAdminCookies = await page.context().cookies();
}

/**
 * Drive one `EntityLookupField`: focus it, type, and pick the first real option. Selecting from the
 * listbox — rather than typing an id — is the point: it exercises the lookup's own API call and the
 * id it hands back, which is what a user actually does.
 */
async function pickFromLookup(page: Page, label: string, query: string): Promise<string> {
  const field = page.getByRole("combobox", { name: new RegExp(label) });
  await field.click();
  await field.fill(query);
  const option = page.getByRole("listbox").getByRole("option").first();
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
async function completeIntakeContext(page: Page, patientQuery = "Whitfield"): Promise<void> {
  await pickFromLookup(page, "Patient", patientQuery);
  // By option value (the UB-04 code), not label: the labels are "<code> — <text>" and would break on relabel.
  await page.getByRole("combobox", { name: /Type of admission/ }).selectOption("3"); // Elective
  await page.getByRole("combobox", { name: /Point of origin/ }).selectOption("1"); // Non-health care facility
  // The selected patient's benefit-period plan loads asynchronously and gates Continue.
  await expect(page.getByRole("spinbutton", { name: "Benefit period number" })).toHaveValue("1");
}

/**
 * Create this test's own obviously synthetic candidate through the real authenticated M5 route.
 * The canonical seed already gives Whitfield an active admission, so reusing that fixture can never
 * prove the successful direct-intake path. A fresh patient has no open episode by construction; the
 * wizard still has to discover and select it through its normal lookup.
 */
async function createAdmissionCandidate(page: Page): Promise<string> {
  const lastName = `Testpatient${Date.now()}`;
  const status = await page.evaluate(async (syntheticLastName) => {
    const cookies = new Map(
      document.cookie.split("; ").map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    const csrf = cookies.get("__Host-chartwarden_csrf") ?? cookies.get("chartwarden_csrf") ?? "";
    const response = await fetch("/api/v1/patients", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": decodeURIComponent(csrf),
      },
      body: JSON.stringify({
        firstName: "Prfive",
        lastName: syntheticLastName,
        dob: "1955-05-05",
        administrativeSex: "unknown",
      }),
    });
    return response.status;
  }, lastName);
  expect(status, "the synthetic admission candidate should be created through M5").toBe(201);
  return lastName;
}

async function createDirectAdmission(page: Page, physicianQuery = "Harris"): Promise<string> {
  const patientQuery = await createAdmissionCandidate(page);
  await page.goto("/admissions/new");
  await completeIntakeContext(page, patientQuery);
  await page.getByRole("button", { name: "Continue" }).click();
  await pickFromLookup(page, "Hospice medical director", physicianQuery);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create admission" }).click();
  await page.waitForURL(
    (url) => /\/admissions\/[^/]+$/.test(url.pathname) && url.pathname !== "/admissions/new",
    { timeout: 15_000 },
  );
  await expect(page.getByRole("heading", { name: "Admission Intake" })).toBeVisible();
  return new URL(page.url()).pathname;
}

async function captureResponsiveEvidence(page: Page, checkpoint: string): Promise<void> {
  const evidenceDir = process.env.ADMISSION_EVIDENCE_DIR;
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

  for (const viewport of RESPONSIVE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("heading", { name: /Admission (?:Intake|activated)/i }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${checkpoint} should not introduce document-level horizontal overflow at ${viewport.width}px`,
    ).toBe(true);
    await expectNoAxeViolations(page);
    if (evidenceDir) {
      await page.screenshot({
        path: join(
          evidenceDir,
          `${checkpoint}-${viewport.name}-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
  }
}

test.describe("Admission", () => {
  test("main path: direct-intake wizard creates an admission for a synthetic patient", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page);
    const patientQuery = await createAdmissionCandidate(page);
    await page.goto("/admissions/new");
    await expect(page.getByRole("heading", { name: "New admission" })).toBeVisible();

    // Step 1 — Intake context. "Continue" without a patient shows the error and stays on the step.
    const advance = page.getByRole("button", { name: "Continue" });
    await continueBlockedWith(page, "Select a patient before continuing.");
    await completeIntakeContext(page, patientQuery);
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
        (/\/admissions\/[^/]+$/.test(window.location.pathname) &&
          window.location.pathname !== "/admissions/new") ||
        document.querySelector('[role="alert"]') !== null,
      { timeout: 15_000 },
    );
    const pathname = new URL(page.url()).pathname;
    const created = /\/admissions\/[^/]+$/.test(pathname) && pathname !== "/admissions/new";
    if (!created) await expect(page.getByRole("alert").first()).toBeVisible();
    expect(created, "the wizard should have created the admission and navigated to it").toBe(true);

    // PR5/G4 — the pending admission lands in the grouped, server-derived readiness cockpit.
    await expect(page.getByRole("heading", { name: "Admission Intake" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Required before activation" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "After admission and follow-up" }),
    ).toBeVisible();
    await expect(page.getByText("Intake coordinator").first()).toBeVisible();
    await expectNoAxeViolations(page);

    // A server blocker opens its existing corrective ceremony; it is not a decorative action.
    await page.getByRole("button", { name: "Complete Notice of Rights" }).first().click();
    await expect(page.getByRole("heading", { name: "Complete Notice of Rights" })).toBeVisible();
  });

  test("multi-role journey: organization administrator prepares, physician signs, and administrator activates", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    await signInAs(page, PLATFORM_OPS_ACCOUNT());
    const admissionPath = await createDirectAdmission(page);

    await expect(page.getByRole("heading", { name: "Admission Intake" })).toBeVisible();
    await captureResponsiveEvidence(page, "pending-readiness");

    await page.getByRole("button", { name: "Complete admission details" }).first().click();
    await page.getByLabel("Admission/SOC date").fill("2026-11-14");
    const provider = page.getByRole("combobox", { name: /Hospice provider/ });
    if ((await provider.inputValue()).trim() === "") {
      await pickFromLookup(page, "Hospice provider", "Engrace");
    }
    const physician = page.getByRole("combobox", { name: /Hospice Physician/ });
    if ((await physician.inputValue()).trim() === "") {
      await pickFromLookup(page, "Hospice Physician", "Harris");
    }
    await page.getByLabel("Street address").fill("101 Synthetic Care Lane");
    await page.getByLabel("City").fill("Asheville");
    await page.getByLabel("State (2 letters)").fill("NC");
    await page.getByLabel("ZIP code").fill("28801");
    await page.getByRole("button", { name: "Save residence address" }).click();
    await expect(page.getByText("Patient residence", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save admission details" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: "Complete Notice of Rights" }).first().click();
    await page.getByRole("button", { name: /Record in ChartWarden/ }).click();
    await page.getByLabel("Acknowledged by (name)").fill("Prfive Testpatient");
    await page.getByRole("button", { name: "Record acknowledgment" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: "Complete Election Statement" }).first().click();
    await page.getByRole("button", { name: /Create in ChartWarden/ }).click();
    await page.getByLabel("Effective date").fill("2026-11-14");
    await page.getByLabel("Primary diagnosis ICD-10").fill("C34.90");
    await page.getByLabel("Primary diagnosis ICD-10").press("Enter");
    await pickFromLookup(page, "Elected hospice provider", "Engrace");
    await page.getByLabel(/acknowledged hospice election/i).check();
    await page.getByLabel(/Also record the signer.s signature now/i).check();
    await page.getByLabel("Signer name").fill("Prfive Testpatient");
    await page.getByLabel(/I attest the Election Statement/i).check();
    await page.getByRole("button", { name: "Create and sign" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // The activation-period CTI draft already exists. Wait for the readiness refresh after the
    // compound Election create/sign call before handing the CTI to the physician; the old Election
    // action can remain visible for one render while the server truth reloads.
    await expect(page.getByRole("button", { name: "Complete CTI signature" }).first()).toBeVisible({
      timeout: 15_000,
    });
    const patientPath = await page.locator('a[href^="/patients/"]').first().getAttribute("href");
    expect(patientPath, "the admission should link to its patient chart").toMatch(/^\/patients\//);
    if (!patientPath) throw new Error("Admission patient link was missing its href.");

    await signOut(page);
    await signInAs(page, PRESCRIBER_ACCOUNT());
    await page.goto(`${patientPath}/election-certification`);
    await expect(page.getByRole("heading", { name: "Election & Certification" })).toBeVisible();
    await page.getByRole("button", { name: "Sign CTI" }).click();
    const narrativeDialog = page.getByRole("dialog", {
      name: "Add the certification narrative",
    });
    await expect(narrativeDialog).toBeVisible();
    await narrativeDialog
      .getByLabel("Physician narrative")
      .fill(
        "The patient has advanced terminal lung disease with progressive functional decline, worsening dyspnea, reduced oral intake, increasing dependence for activities of daily living, and a clinical course consistent with a prognosis of six months or less if the illness runs its normal course. The hospice interdisciplinary team will focus on comfort, symptom relief, and support for the patient and family.",
      );
    await narrativeDialog.getByRole("button", { name: "Sign CTI" }).click();
    await expect(narrativeDialog).toBeHidden();

    await signOut(page);
    await signInAs(page, PLATFORM_OPS_ACCOUNT());
    await page.goto(admissionPath);
    const activate = page.getByRole("button", { name: "Activate Admission" });
    await expect(activate).toBeEnabled();
    await activate.click();
    const location = page.getByRole("combobox", { name: /Service location/ });
    if (await location.isVisible().catch(() => false)) {
      await location.click();
      await page.getByRole("option").first().click();
    }
    await page.getByLabel("I attest the admission is ready for activation.").check();
    await page.getByRole("button", { name: "Activate", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Admission activated" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open patient chart" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review care team" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open HOPE" })).toBeVisible();
    await captureResponsiveEvidence(page, "active-continuation");
    expect(serverErrors, "the journey should receive no server-error responses").toEqual([]);
    expect(consoleErrors, "the journey should emit no browser console errors").toEqual([]);
    expect(pageErrors, "the journey should emit no uncaught page errors").toEqual([]);
  });

  test("the wizard gates each step on its own required field", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page);
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
    await signInAsAdmin(page);
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
    await signInAsAdmin(page);
    await page.goto("/admissions/new");
    await expect(page.getByRole("heading", { name: "New admission" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
