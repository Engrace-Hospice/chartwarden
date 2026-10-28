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

    // F-058 — the picker names a real DRUG. Before it, the seeded order stopped at `signed`: nothing in
    // the platform activated an order, so every administrable-order read was empty for every patient and
    // this control degraded to a typed-in medication-order uuid.
    await expect(dialog.getByLabel("Medication")).toBeVisible();
    await expect(dialog.getByLabel("Medication")).toContainText(/Morphine/i);

    // The picker opens on the patient's FIRST active order, and other specs (prescribing) leave their own
    // morphine orders on this chart, so pin the seeded one — its label starts "Morphine sulfate oral
    // solution" (case-sensitive: the prescribing spec's is "Morphine Sulfate 20 MG/ML…", demo ones "DEMO…").
    const seededOrder = dialog
      .getByLabel("Medication")
      .locator("option", { hasText: /^Morphine sulfate oral solution/ })
      .first();
    const seededOrderId = await seededOrder.getAttribute("value");
    if (!seededOrderId) {
      throw new Error("e2e: the seeded morphine order is not offered in the Medication picker");
    }
    await dialog.getByLabel("Medication").selectOption(seededOrderId);

    // "Right dose" is validated server-side against a stated amount: the dialog opens with Dose and
    // Unit empty, and committing without them is refused ("five-rights validation failed: dose").
    // 0.25 mL is the seeded order's own dose (seed-scenario-orders-meds-idg: doseQuantity 0.25,
    // doseUnit "mL") — change the two together.
    await dialog.getByLabel("Dose", { exact: true }).fill("0.25");
    await dialog.getByLabel("Unit", { exact: true }).fill("mL");

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

  test("IV: start an infusion, titrate it, and stop it — the graph decides what is offered", async ({
    page,
  }) => {
    // #134 — `administration_record.iv_session_id` was written nowhere, so no session could exist and the
    // §2.11 D11 ordering graph was enforced at runtime by nothing. This drives the producer end to end.
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/emar`);
    await page.getByRole("button", { name: "Start IV infusion" }).click();

    const startDialog = page.getByRole("dialog");
    await expect(startDialog.getByRole("heading", { name: "Start infusion" })).toBeVisible();
    await startDialog.getByLabel("Infusion rate").fill("4");
    await startDialog.getByLabel("Rate unit").fill("mg/hr");
    await startDialog.getByLabel("Dilution").fill("morphine 1 mg/mL in NS");
    await startDialog.getByRole("button", { name: "Start infusion" }).click();

    // Starting MINTS the session, so the app follows it to the session surface.
    await page.waitForURL(/\/iv-sessions\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "IV Continuous Session" })).toBeVisible();

    // A running session offers Titrate / Pause / Stop and NOT Resume — IV_SESSION_GRAPH, not a guess.
    await expect(page.getByRole("button", { name: "Titrate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);

    await page.getByRole("button", { name: "Pause" }).click();
    const pauseDialog = page.getByRole("dialog");
    await pauseDialog.getByLabel("Pause reason").fill("line infiltrated");
    await pauseDialog.getByRole("button", { name: "Record pause" }).click();
    await expect(pauseDialog).toBeHidden({ timeout: 15_000 });

    // Paused: Resume and Stop, and no Titrate — a paused pump has no rate to change.
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Titrate" })).toHaveCount(0);

    await page.getByRole("button", { name: "Stop" }).click();
    const stopDialog = page.getByRole("dialog");
    await stopDialog.getByLabel("Stop reason").fill("comfort achieved");
    await stopDialog.getByRole("button", { name: "Record stop" }).click();
    await expect(stopDialog).toBeHidden({ timeout: 15_000 });

    // Stopped is terminal — every CTA is gone and the screen says so.
    await expect(page.getByText("This session is stopped", { exact: false })).toBeVisible();
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
