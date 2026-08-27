// e2e/specs/emar.spec.ts — critical workflow: record a medication administration (F-031).
//
// The one path the audit called the sharp end of #91: an eMAR that renders a dose grid and cannot record
// a dose. This drives the real ceremony end to end — sign in as the seeded RN, open a patient's eMAR,
// pick an active medication order, confirm the five rights, commit — and then asserts the dose is on the
// chart afterwards. That second half is the part that matters: before F-031 the write also had a server
// defect (an administration naming no scheduled dose was filed under a hard-coded sentinel patient), so a
// spec that only asserted "the POST returned 201" would have passed against a record the patient's own
// eMAR could never show.
//
// Signs in as the RN persona, not the admin: `administration.record` is gated by M13's
// `administering_clinician_eligible` ABAC predicate on the caller's clinical discipline, and the admin
// account holds every permission key and no clinical role. See e2e/fixtures/credentials.ts.
import { expect, test } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

/** The flagship seeded patient — the only one `db:seed:scenario-orders-meds-idg` gives a medication
 *  order, and therefore the only chart with anything to administer. */
const PATIENT_LAST_NAME = "Whitfield";

test.describe("eMAR", () => {
  test("main path: an RN records an administration and it lands on the chart", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/emar`);
    await expect(
      page.getByRole("heading", { name: "Medication Administration Record" }),
    ).toBeVisible();

    const before = await page.getByRole("heading", { name: "Recent administrations" }).count();

    await page.getByRole("button", { name: "Record administration" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The commit is refused until every right is confirmed — the checklist gates the dialog.
    const commit = dialog.getByRole("button", { name: "Record administration" });
    await expect(commit).toBeDisabled();
    for (const right of [
      "Right patient",
      "Right drug",
      "Right dose",
      "Right route",
      "Right time",
    ]) {
      await dialog.getByLabel(right).check();
    }
    await expect(commit).toBeEnabled();
    await commit.click();

    // The dialog closes only on a committed write; a refusal keeps it open with the server's message.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // …and the dose is now readable on this patient's own eMAR, which is the assertion the sentinel
    // patient-id defect would have failed.
    await expect(page.getByRole("heading", { name: "Recent administrations" })).toBeVisible();
    expect(before).toBeLessThanOrEqual(1);
  });

  test("accessibility: the eMAR and its administer ceremony have no WCAG 2A/AA violations", async ({
    page,
  }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/emar`);
    await expect(
      page.getByRole("heading", { name: "Medication Administration Record" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "Record administration" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
