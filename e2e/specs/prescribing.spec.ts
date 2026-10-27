// e2e/specs/prescribing.spec.ts — critical workflow: prescribe a medication and sign it (F-031, #91).
//
// #91's fifth acceptance criterion asks for at least one E2E spec per module driving the primary
// authored-then-signed path. This is M12's, and M12's own `screens.ts` header opens "#91 / F-065 —
// PRESCRIBING WORKS NOW", which is a claim worth executing rather than reading.
//
// IT DID NOT WORK ON A SEEDED STACK, and not because of anything in M12 (F-075).
// The prescribe modal takes drug identity from M38's `GET /terminology/rxnorm/search` and deliberately
// refuses to let a prescriber type an RxCUI or NDC — its header: "identity codes: a prescriber typing
// them is a transcription error waiting to be dispensed". But `concept_rxnorm`, `code_system_version`
// and `code_system` were EMPTY on every local and CI stack: those tables say "writes only via
// `terminology_loader`", an external per-system loader that is not in this repository, and no seed
// script wrote a row. So the search returned nothing, no concept could be selected, no NDC could be
// resolved, and the modal's submit stayed disabled — M12's flagship write was unreachable from the UI.
// `scripts/db/seed-terminology.ts` (new) seeds the hospice comfort-kit drugs the demo scenarios
// actually prescribe, including the morphine RxCUI `seed-scenario-orders-meds-idg.ts` already
// hard-codes, so a scenario order and a drug picked through the UI now resolve to the same concept.
//
// The screen was HONEST about the gap the whole time — it renders "If this deployment's terminology has
// not been loaded…" — which is exactly why it went unnoticed: the failure read as a deployment fact
// rather than as a missing seed. A spec is what tells those two apart.
//
// THIS SPEC BRINGS ITS OWN SUBJECT. It prescribes the order it then signs, so it consumes no seeded
// queue row and is re-runnable against the same database. It filters the row it opens on the status it
// expects, so a previous run's signed order cannot be mistaken for this run's draft.
//
// Signs in as the PHYSICIAN, not the RN and not the admin. M12 resolves the prescribing discipline from
// the caller's M3 role grants, so the RN who administers a dose in emar.spec.ts and the physician who
// orders it are two different logins — as they are on a ward. Dr Harris holds two of M12's four
// prescriber roles, which is why "Signing as" offers a choice instead of preselecting one.
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { PRESCRIBER_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

/** The flagship seeded patient — the one every clinical scenario is anchored to. */
const PATIENT_LAST_NAME = "Whitfield";

/**
 * The canonical MDM physician `db:seed:mdm` creates, with a fixed id. Hardcoded here for the one reason
 * the fixtures' no-hardcoded-uuid rule allows: the MDM directory is the org-LESS canonical golden
 * record (RLS `USING(true)`), so this id is neither tenant-scoped nor regenerated per reseed, and
 * `seed-scenario-orders-meds-idg.ts` hardcodes the same one.
 *
 * That it must be TYPED AT ALL is a finding, not a fixture convenience: "Ordering physician (MDM id)"
 * is a free-text control asking a prescriber for a UUID — the exact pattern this module's own header
 * rejects for RxCUI and NDC, and the one CLAUDE.md records M24's claim wizard working around by asking
 * a clerk to type it. M40 holds the directory read that would back a picker.
 */
const MDM_PHYSICIAN_ID = "11111111-0000-4000-8000-000000000001";

/** The seeded RxNorm concept's display, distinct from the scenario seed's own "Morphine sulfate oral
 *  solution" so the two orders can never be mistaken for one another on the chart. */
const DRUG_DISPLAY = "Morphine Sulfate 20 MG/ML Oral Solution";

test.describe("Prescribing", () => {
  test("main path: a physician prescribes a medication, sends it for signature, and signs it", async ({
    page,
  }) => {
    await signInAs(page, PRESCRIBER_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/medications`);
    await expect(medicationList(page)).toBeVisible();

    await page.getByRole("button", { name: "Prescribe" }).click();
    const dialog = page.getByRole("dialog", { name: "Prescribe a medication" });
    await expect(dialog).toBeVisible();

    // THE REGRESSION GUARD for the terminology gap. Searching is the only way to identify the drug, so
    // an empty result set is not a cosmetic problem — it is the whole ceremony failing to start.
    await dialog.getByLabel("Find a drug (RxNorm)").fill("morphine");
    await dialog.getByRole("button", { name: "Search" }).click();
    const hit = dialog.getByText(DRUG_DISPLAY).first();
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await hit.click();

    // Selecting the concept resolves its published NDCs — the packaged forms — so the order can name
    // one without anybody typing it. `197696` is the RxCUI the scenario seed already prescribes.
    await expect(dialog.getByText(/RxCUI 197696/)).toBeVisible();

    await dialog.getByLabel("Strength").fill("20 mg/mL");
    await dialog.getByLabel("Dose form").fill("solution");
    await dialog.getByLabel("Route").fill("oral");
    await dialog.getByLabel("Dose", { exact: true }).fill("0.5");
    await dialog.getByLabel("Ordering physician (MDM id)").fill(MDM_PHYSICIAN_ID);

    const create = dialog.getByRole("button", { name: "Create draft" });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Creating the draft opens it: the prescriber's next act is on this order, so the modal hands them
    // there rather than back to a list they would have to re-find it in.
    await page.waitForURL(/\/medication-orders\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Medication Order" })).toBeVisible();
    await expect(page.getByText(DRUG_DISPLAY).first()).toBeVisible();

    // The draft the prescribe dialog creates carries the structured sig only. Since the #235 redesign,
    // requesting signature validates the order's complete §2.1 dispensing payload (human-readable SIG,
    // dispense quantity + unit, days supply, DAW), which the draft editor — "Edit draft" on the order —
    // is where a prescriber supplies it. Without it the server answers 422 "not ready for signature".
    await page.getByRole("button", { name: "Edit draft" }).click();
    await page.waitForURL(/\/medication-orders\/[^/]+\/edit/);
    // The editor hydrates from the stored draft asynchronously; typing before that lands is
    // overwritten by the hydration, so wait for the draft to have loaded first.
    await expect(page.getByLabel("Human-readable SIG")).toBeVisible();
    await expect(page.getByText("Loading draft…")).toBeHidden({ timeout: 15_000 });
    await page
      .getByLabel("Human-readable SIG")
      .fill("Take 0.5 mL by mouth every 2 hours as needed for pain.");
    await page.getByLabel("Dispense quantity", { exact: true }).fill("30");
    await page.getByLabel("Dispense quantity unit").fill("mL");
    await page.getByLabel("Days supply").fill("7");
    // DAW is a real yes/no the order must state; ticking and clearing it records an explicit "no".
    const daw = page.getByLabel("Dispense as written (DAW)");
    await daw.check();
    await daw.uncheck();
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForURL(/\/medication-orders\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Medication Order" })).toBeVisible();

    // §2.2 — a draft is sent for signature before it can be signed. Two ceremonies, not one button,
    // because the requester and the signer are not always the same person.
    await page.getByRole("button", { name: "Send for signature" }).click();
    const sendDialog = page.getByRole("dialog", { name: "Send for signature" });
    await expect(sendDialog).toBeVisible();
    await sendDialog.getByLabel("Send to discipline").selectOption("hospice_physician");
    await sendDialog.getByRole("button", { name: "Send", exact: true }).click();
    await expect(sendDialog).toBeHidden({ timeout: 15_000 });

    await page.getByRole("button", { name: "Sign", exact: true }).click();
    const signDialog = page.getByRole("dialog", { name: "Sign medication order" });
    await expect(signDialog).toBeVisible();

    // GAP-035 — signing takes no discipline and no "ordering physician" claim from the browser: the
    // server derives both from the signer's session. The discipline is chosen once, when the order is
    // sent for signature (above). Asserting the controls are ABSENT keeps the browser from quietly
    // going back to asserting provenance it cannot vouch for.
    const signButton = signDialog.getByRole("button", { name: "Sign", exact: true });
    await expect(signButton).toBeVisible(); // the body has rendered, so the absences below mean something
    await expect(signDialog.getByLabel("Signing as")).toHaveCount(0);
    await expect(
      signDialog.getByLabel("I am the ordering physician for this medication"),
    ).toHaveCount(0);
    await signButton.click();
    await expect(signDialog).toBeHidden({ timeout: 15_000 });

    // F-058 — the signature ACTIVATES the order, because nothing is being e-prescribed
    // (`dosespot_send_state` is `not_required`), so there is no NewRx to send and no pharmacy ack to
    // wait for. `active` is the state M13's eMAR can administer against; `signed` is not.
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The round trip, and the assertion that matters clinically: the order is now on the patient's own
    // ACTIVE medication list — the default view of their chart, and the read M13 administers against.
    // A spec that stopped at the detail page's status pill would pass on an order filed against the
    // wrong patient, which is the defect class F-058 and the eMAR spec's sentinel-patient bug both are.
    await page.goto(`/patients/${patientId}/medications`);
    await expect(medicationList(page)).toBeVisible();
    // The #235 redesign's medication table keeps real `row`s (the drug name inside is the button), so
    // the row role resolves again — the `role="button"`-on-`<tr>` trap F-023 documents no longer applies.
    await expect(
      medicationList(page).getByRole("row").filter({ hasText: DRUG_DISPLAY }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("the patient medication list is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, PRESCRIBER_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/medications`);
    await expect(medicationList(page)).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

/**
 * The chart's Medications tab. The #235 redesign dropped the tab's "Medications" page heading (the
 * chart tab strip names the tab; the section is a labelled region), so the list is located by the
 * table's own accessible name — rendered only once the patient's medication read has answered.
 */
function medicationList(page: Page): Locator {
  return page
    .getByRole("region", { name: "Medications", exact: true })
    .getByRole("table", { name: "Medications for this patient" });
}
