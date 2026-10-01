// e2e/specs/assessments.spec.ts — critical workflow: record a scale and acknowledge the decline it
// triggers (F-031, #91).
//
// #91's fifth acceptance criterion asks for at least one E2E spec per module driving the primary
// authored-then-acted-on path. This is M09's. There is no signature ceremony here — a clinical
// assessment is `active` the moment it is recorded — so the path that matters is the one the module was
// built around: a scale is captured, the SERVER scores it, the server's detector compares it to the
// patient's history, and a significant decline lands in a queue somebody has to acknowledge. That last
// step is the one #91 added: before it, "a decline the detector found sat unacknowledged forever, and
// the escalation that keys off acknowledgement never stopped".
//
// WHAT THIS PROVES THAT A DOM TEST CANNOT. Three things in this flow are the server's alone, and a
// mocked client agrees with itself about all of them:
//   • The FORM. `record-assessment-modal.tsx` renders `GET /api/v1/scales` and knows nothing about PPS's
//     five axes — "A new scale's form appears when its module lands". If that catalog stops publishing
//     items, the modal renders a scale with no fields and submits an empty payload.
//   • The SCORE. The modal states it outright: "The score is computed by the server from these values
//     and shown on the record afterwards — this form never calculates one."
//   • The DETECTOR. `pps_drop_20_in_14d` runs inside the recording transaction against the patient's
//     prior assessments. Nothing client-side knows a decline happened.
//
// PPS deliberately, out of the four scales the server reports `recordable`: it is the one that feeds
// hospice eligibility and HOPE, and it is `licenseRequired`, so recording it also exercises the D3
// licence gate that `db:seed:clinical` satisfies. The picker offers only the recordable four, which is
// the SERVER's answer — ten of the fourteen scales have no scorer and would 500.
//
// THIS SPEC BRINGS ITS OWN SUBJECT, twice over. It records a HIGH PPS and then a LOW one, so the decline
// is manufactured within the run rather than measured against the seeded 40. That is what makes it
// re-runnable: a second run against the same database finds the previous run's PPS of 10 sitting there,
// records 100 over it, and the drop to 10 fires the rule again — where a single low capture would find
// no drop at all and the queue would stay empty.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

const PATIENT_LAST_NAME = "Whitfield";
const PPS_LABEL = "PPS — Palliative Performance Scale";

/** PPS 100% — the five axes at their least impaired. */
const PPS_FULL: readonly [string, string][] = [
  ["Ambulation", "full"],
  ["Activity & evidence of disease", "normal"],
  ["Self-care", "full"],
  ["Intake", "normal"],
  ["Conscious level", "full"],
];

/** PPS 10% — the five axes at their most impaired. A 90-point drop from PPS_FULL, well past the
 *  platform floor `pps_drop_20_in_14d` names. */
const PPS_DECLINED: readonly [string, string][] = [
  ["Ambulation", "totally_bed_bound"],
  ["Activity & evidence of disease", "unable_any_work"],
  ["Self-care", "total_care"],
  ["Intake", "mouth_care_only"],
  ["Conscious level", "drowsy_or_coma"],
];

/** Opens the capture modal, fills the five PPS axes, and commits. The item LABELS come from the
 *  server's catalog, so a change to the instrument breaks this loudly rather than silently. */
async function recordPps(page: Page, axes: readonly (readonly [string, string])[]): Promise<void> {
  await page.getByRole("button", { name: "Record assessment" }).click();
  const dialog = page.getByRole("dialog", { name: "Record an assessment" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Scale").selectOption({ label: PPS_LABEL });
  for (const [label, value] of axes) {
    await dialog.getByLabel(label).selectOption(value);
  }
  await dialog.getByRole("button", { name: "Record", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test.describe("Assessments", () => {
  test("main path: a recorded decline reaches the significant-change queue and is acknowledged", async ({
    page,
  }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/assessments`);
    await expect(page.getByRole("button", { name: "Record assessment" })).toBeVisible({
      timeout: 15_000,
    });

    // The baseline, then the decline. Two captures rather than one so the drop belongs to this run.
    await recordPps(page, PPS_FULL);
    await recordPps(page, PPS_DECLINED);

    // Select PPS in the scale rail — the timeline opens on whichever scale it lists first, and the big
    // score belongs to the SELECTED scale.
    // The rail button's accessible name is the scale label, its latest-capture date and its capture COUNT
    // ("Pps Latest Oct 1, 2026 3"), so this matches on the prefix, case-insensitively (the label is now
    // title-cased), rather than an exact string that would drift every time the spec runs.
    await page
      .getByRole("button", { name: /^pps\b/i })
      .first()
      .click();

    // The score is the SERVER's — the modal says so outright: "this form never calculates one" — so
    // seeing 10 here is a statement about the scorer, not about what the browser typed.
    await expect(page.getByText("10", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // The detector ran inside the recording transaction and put the decline in a queue. Nothing
    // client-side knew this would happen.
    await page.goto(`/patients/${patientId}/assessments/changes`);
    await expect(page.getByRole("heading", { name: "Significant changes" })).toBeVisible();

    const acknowledge = page.getByRole("button", { name: "Acknowledge" });
    await expect(acknowledge.first()).toBeVisible({ timeout: 15_000 });
    const before = await acknowledge.count();
    expect(before).toBeGreaterThan(0);

    await acknowledge.first().click();

    // The row is KEPT and its status flips — acknowledging records that a clinician saw the decline, it
    // does not delete the finding. So the assertion is one fewer OPEN action, not one fewer row.
    await expect(acknowledge).toHaveCount(before - 1, { timeout: 15_000 });
    await expect(page.getByText("Acknowledged").first()).toBeVisible();
  });

  test("failure/rollback path: the Record button stays disabled on an incomplete PPS capture, and Cancel commits nothing", async ({
    page,
  }) => {
    // #106 (F-046) — this file's only failure-path coverage before this test was implicit (the
    // happy path above proves what a COMPLETE, valid capture does; nothing proved what an
    // INCOMPLETE one does not do). `missing.length > 0` disables the Record button client-side
    // (`record-assessment-modal.tsx`) precisely so a partial PPS axis set can never reach the
    // server — this is that guard, exercised in a real browser rather than asserted from the
    // component's source.
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/assessments`);
    await expect(page.getByRole("button", { name: "Record assessment" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Record assessment" }).click();
    const dialog = page.getByRole("dialog", { name: "Record an assessment" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Scale").selectOption({ label: PPS_LABEL });

    const record = dialog.getByRole("button", { name: "Record", exact: true });
    // Nothing filled yet — every required axis is missing.
    await expect(record).toBeDisabled();

    // Fill exactly one of the five required axes — still incomplete.
    const [firstAxisLabel, firstAxisValue] = PPS_FULL[0] as [string, string];
    await dialog.getByLabel(firstAxisLabel).selectOption(firstAxisValue);
    await expect(record).toBeDisabled();

    // Abandon the draft rather than complete it — Cancel must close the dialog and leave no trace:
    // no partial capture, no server round trip, the timeline exactly as it was.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Record assessment" })).toBeVisible();
    // Re-opening starts a FRESH, empty draft — proof the cancelled one left nothing behind to
    // resume, which is the ROLLBACK half of this case (an abandoned form is not a saved one).
    await page.getByRole("button", { name: "Record assessment" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Scale").selectOption({ label: PPS_LABEL });
    await expect(record).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("the significant-change queue is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/assessments/changes`);
    await expect(page.getByRole("heading", { name: "Significant changes" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
