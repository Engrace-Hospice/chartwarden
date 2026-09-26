// e2e/specs/care-plan.spec.ts — M7 Patient Care Plan operational browser paths.
//
// These scenarios run against the real app/backend when seeded IDs are supplied. They are skipped by
// default rather than faking clinical lifecycle state in the browser.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT, RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

const patientId = process.env.E2E_CARE_PLAN_PATIENT_ID;
const idgPatientId = process.env.E2E_CARE_PLAN_IDG_PATIENT_ID;

test.describe("Care Plan workspace", () => {
  test.skip(
    !patientId,
    "set E2E_CARE_PLAN_PATIENT_ID to an active Admission patient with an auto-bootstrapped Care Plan",
  );

  test("Admission-bootstrapped plan can be authored, finalized, and signed from the browser", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/patients/${patientId}/care-plan`);

    await expect(page.getByRole("heading", { name: "Patient Care Plan" })).toBeVisible();
    await page.getByRole("button", { name: "Add problem" }).click();
    await page.getByLabel("Description").fill("Terminal decline requiring interdisciplinary care");
    await page.getByLabel("Kind").selectOption("terminal");
    await page.getByRole("button", { name: "Save problem" }).click();
    await expect(page.getByText(/Problem added|Terminal decline/)).toBeVisible();

    await page.getByRole("button", { name: "Add goal" }).first().click();
    await page.getByLabel("Goal text").fill("Comfort maintained during current benefit period");
    await page.getByLabel("Measurable outcome").fill("Patient reports acceptable comfort");
    await page.getByRole("button", { name: "Save goal" }).click();
    await expect(page.getByText(/Goal added|Comfort maintained/)).toBeVisible();

    await page.getByRole("button", { name: "Add intervention" }).first().click();
    await page
      .getByLabel("Intervention / scope")
      .fill("RN evaluates symptoms and updates comfort teaching");
    await page.getByLabel("Frequency text").fill("Twice weekly and PRN");
    await page.getByLabel("Frequency value").fill("2/wk");
    await page.getByRole("button", { name: "Save intervention" }).click();
    await expect(page.getByText(/Intervention added|RN evaluates symptoms/)).toBeVisible();

    await page.getByRole("tab", { name: "Revision / Review" }).click();
    const finalize = page.getByRole("button", { name: "Review & send for signatures" });
    await expect(finalize).toBeEnabled();
    await finalize.click();
    await expect(page.getByText(/Version sent for signatures|Required signatures/)).toBeVisible();

    await page.getByRole("button", { name: "Sign" }).click();
    await page.getByRole("button", { name: "Sign version" }).click();
    await expect(page.getByText(/Signature recorded|Required signatures/)).toBeVisible();
  });

  test("governed IDG proposal is visible before it is published", async ({ page }) => {
    test.skip(
      !idgPatientId,
      "set E2E_CARE_PLAN_IDG_PATIENT_ID to a patient with an open governed IDG proposal",
    );

    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/patients/${idgPatientId}/care-plan`);

    await expect(page.getByRole("heading", { name: "Patient Care Plan" })).toBeVisible();
    await page.getByRole("tab", { name: "Revision / Review" }).click();
    await expect(page.getByRole("heading", { name: "IDG proposed changes" })).toBeVisible();
    await expect(
      page.getByText(
        "These changes are proposed until the governed review version is signed and published.",
      ),
    ).toBeVisible();
  });
});

// #190 (F-077) — the axe scan over the Care Plan workspace. Runs against the seeded demo patient (no env
// needed), so it always executes: the signer/quorum text it guards (`successPillFg` rather than
// `t.success` for small success text on a white card) failed WCAG AA at 4.33:1 before the fix.
//
// NOT ported from the lost spec: its two-login §418.56 quorum main path (RN signs → plan stays inactive
// → physician signs → activates) drove the pre-redesign footer ceremony labels ("Start IDG review",
// "Close draft for signature", "Signing as"), none of which exist in this workspace. The quorum rule
// itself is still asserted server-side; re-drive it here against the redesigned Revision / Review tab.
test.describe("Care Plan accessibility", () => {
  test("the care plan view is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const seededPatientId = await openPatientChartByLastName(page, "Whitfield");
    await page.goto(`/patients/${seededPatientId}/care-plan`);
    await expect(page.getByRole("tablist", { name: "Care Plan workspace views" })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAxeViolations(page);
  });
});
