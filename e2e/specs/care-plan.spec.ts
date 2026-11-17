// e2e/specs/care-plan.spec.ts — M7 Patient Care Plan operational browser paths.
//
// These scenarios run against the real app/backend when seeded IDs are supplied. They are skipped by
// default rather than faking clinical lifecycle state in the browser.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT, RN_ACCOUNT } from "../fixtures/credentials";
import {
  enrolPasskey,
  expectNoAxeViolations,
  signInAs,
  stepUpWithPasskey,
} from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

const patientId = process.env.E2E_CARE_PLAN_PATIENT_ID;
const idgPatientId = process.env.E2E_CARE_PLAN_IDG_PATIENT_ID;

test.describe("Care Plan workspace", () => {
  test.skip(
    !patientId,
    "set E2E_CARE_PLAN_PATIENT_ID to an active Admission patient with an auto-bootstrapped Care Plan",
  );

  // Selectors follow the shipped UI (care-plan-view.tsx): the page h1 is "Plan of Care"; the tabs are
  // Goals / Interventions / Problems / Review & Sign / Revisions; the success notices are the exact
  // strings the view renders. ONE RN login authors the plan, sends the version for signatures and signs
  // ONE slot (the RN case manager), so this proves authoring + finalize + a recorded signature, not
  // quorum/activation (the quorum rule is asserted server-side). It is the RN, not the admin, because an
  // intervention is authored under a discipline and the admin account holds every permission but no
  // clinical discipline role (`discipline_scope` refuses it), and signing needs a signer role too.
  //
  // Re-runnable: the single signature leaves the version in review, where nothing can be authored, so
  // a second run returns it to draft first (which invalidates that signature) instead of assuming a
  // fresh plan.
  test("Admission-bootstrapped plan can be authored, sent for signatures, and signed once", async ({
    page,
  }) => {
    await signInAs(page, RN_ACCOUNT());
    const planPath = `/patients/${patientId}/care-plan`;
    await page.goto(planPath);

    await expect(page.getByRole("heading", { name: "Plan of Care" })).toBeVisible();
    // The next-step card only renders once the plan is loaded, so the state checks below are not
    // taken against the loading spinner.
    const guide = page.getByRole("region", { name: "Care Plan next step" });
    await expect(guide).toBeVisible();

    // Authoring needs an open draft. Open one if there is none (a fresh or an active plan); if a
    // previous run left the version in review, send it back to draft.
    const reviewTab = page.getByRole("tab", { name: /Review & Sign/ });
    const openDraft = guide.getByRole("button", {
      name: /Start initial draft|Document condition change/,
    });
    if (await openDraft.isVisible()) {
      await openDraft.click();
      // The write lands asynchronously and then moves the workspace to Review & Sign; wait for that so it
      // cannot pull the tab away from the Problems tab clicked next.
      await expect(reviewTab).toHaveAttribute("aria-selected", "true");
    } else {
      await reviewTab.click();
      const returnToDraft = page
        .getByRole("tabpanel")
        .getByRole("button", { name: "Return to draft" });
      if (await returnToDraft.isVisible()) {
        await returnToDraft.click();
        await page
          .getByRole("dialog", { name: "Return to draft" })
          .getByRole("button", { name: "Return to draft" })
          .click();
        await expect(page.getByText("Version returned to draft.")).toBeVisible();
      }
    }

    // Problems, goals and interventions are authored from the Problems tab (the Goals tab is read-only
    // until a problem exists, and carries no Add buttons of its own).
    await page.getByRole("tab", { name: "Problems" }).click();
    await page.getByRole("button", { name: "Add problem" }).first().click();
    await page
      .getByLabel("Problem description")
      .fill("Terminal decline requiring interdisciplinary care");
    await page.getByLabel("Problem type").selectOption("terminal");
    await page.getByRole("button", { name: "Save problem" }).click();
    await expect(page.getByText("Problem added.")).toBeVisible();

    await page.getByRole("button", { name: "Add goal" }).first().click();
    await page
      .getByLabel("Goal statement")
      .fill("Comfort maintained during current benefit period");
    await page.getByLabel("Measurable outcome").fill("Patient reports acceptable comfort");
    await page.getByRole("button", { name: "Save goal" }).click();
    await expect(page.getByText("Goal added.")).toBeVisible();

    await page.getByRole("button", { name: "Add intervention" }).first().click();
    await page
      .getByLabel("Intervention / scope")
      .fill("RN evaluates symptoms and updates comfort teaching");
    await page.getByLabel("Frequency", { exact: true }).fill("Twice weekly and PRN");
    await page.getByLabel("Frequency value").fill("2/wk");
    await page.getByRole("button", { name: "Save intervention" }).click();
    await expect(page.getByText("Intervention added.")).toBeVisible();

    await page.getByRole("tab", { name: "Review & sign" }).click();
    // Wording depends on the signer set: physician-only slots read "hospice physician", an IDG or
    // MSW/chaplain set reads "IDG team".
    const send = page.getByRole("button", { name: /Send to (hospice physician|IDG team)/ });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByText("Version sent for signatures.")).toBeVisible();

    // The RN case manager signs. `care_plan.sign` is guarded by requireStepUp, so do the real passkey
    // step-up before the gated write (same pattern as encounters.spec.ts / idg.spec.ts), landing back on
    // the plan.
    await enrolPasskey(page);
    await stepUpWithPasskey(page, planPath);
    await expect(page.getByRole("heading", { name: "Plan of Care" })).toBeVisible();
    await page.getByRole("tab", { name: "Review & sign" }).click();
    // The workflow guide above the tabs has a button of the same name; scope to the tab panel.
    await page.getByRole("tabpanel").getByRole("button", { name: "Review & sign" }).click();
    await expect(page.getByLabel("Version being signed")).toBeVisible();
    // The dialog preselects the physician slot; the RN signs the case-manager slot she holds.
    await page.getByLabel("Signing role").selectOption("rn_case_manager");
    await page.getByRole("button", { name: "Sign care plan" }).click();
    await expect(page.getByText("Signature recorded.")).toBeVisible();
  });

  test("governed IDG proposal is visible before it is published", async ({ page }) => {
    test.skip(
      !idgPatientId,
      "set E2E_CARE_PLAN_IDG_PATIENT_ID to a patient with an open governed IDG proposal",
    );

    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/patients/${idgPatientId}/care-plan`);

    await expect(page.getByRole("heading", { name: "Plan of Care" })).toBeVisible();
    await page.getByRole("tab", { name: "Review & sign" }).click();
    await expect(page.getByRole("heading", { name: "IDG proposed changes" })).toBeVisible();
    await expect(
      page.getByText(
        "These changes remain proposed until the governed review version is signed and published.",
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
// itself is still asserted server-side; re-drive it here against the Review & Sign tab.
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
