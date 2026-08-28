// e2e/specs/hope.spec.ts — critical workflow: record a HOPE timepoint and sign it (F-031, #91).
//
// #91's fifth acceptance criterion asks for at least one E2E spec per module driving the primary
// authored-then-signed path. This is M10's — the module the issue ranks behind eMAR and orders because
// HOPE is CMS-reportable: what this screen records is what the agency submits to iQIES and what HQRP
// scores it on.
//
// IT FOUND THREE DEFECTS, WHICH IS THE ARGUMENT FOR WRITING IT (F-067).
//
//   1. `authorDiscipline` is the one field in the platform whose wire vocabulary is NOT the lowercase M3
//      role key — the route schema is `Union([Literal("RN"), Literal("NP"), Literal("MD")])`. The record
//      modal offered the caller's raw role keys as the select's values and sent one through an
//      `as AuthorDiscipline` cast, so every capture the UI has ever made was refused 422
//      `authorDiscipline: Expected union value`. All five RFAs and the SFV, from every screen.
//   2. The correction modal took its attribution as a PROP that the assessment detail filled from
//      `row.authorDiscipline` — which the read projection hard-codes to `""`, because the column does not
//      exist. Its `= "RN"` default could not cover that: a default fires on `undefined`, and `""` is
//      defined. Every correction sent an empty string.
//   3. `hope.correctionAuthorAllowed` compared `hope_assessment.signed_by_membership_id` against
//      `context.userId` — two id spaces that are never equal — so the original signer was denied their
//      own correction and only a clinical lead could correct anything. GAP-026 is the same defect in M12.
//
// None of it was visible from inside the repo's own tests. `tsc` was silent because of the cast;
// `hope-writes.dom.test.tsx` asserted `sent.authorDiscipline === "rn"` against a stub that 200s any
// non-GET, so it encoded the defect as the expectation; and (3) is invisible to any suite whose fixtures
// use one id for both, which M12's `actorOf` header had already written down. A real server is the only
// thing that disagrees, which is what this spec is.
//
// THIS SPEC BRINGS ITS OWN SUBJECT. Unlike the orders and eMAR specs it does not consume a seeded queue
// row — it records the draft it then signs, so it is re-runnable against the same database. The seed
// leaves exactly one HOPE assessment (`01_admission`, already `signed`), and `hope_timepoint_schedule` is
// EMPTY on a seeded stack because schedules are written by the M6 outbox consumer rather than by any seed
// — so `/hope`, the dashboard, has no open window to record against and the patient timeline's
// unscheduled capture is the only authoring surface that works here. That is a real gap in the seed, not
// in the screen; it is left as a finding rather than papered over with a hand-inserted schedule row.
//
// The D4 symptom-follow-up assertion is folded into the main path rather than standing as its own test,
// because a separate test would have to assume either an execution ORDER or a fixed row count — and the
// seed already leaves one open SFV, so "there is a row" passes without this spec doing anything.
//
// Signs in as the RN, not the admin: `hope.authorDisciplineAllowed` resolves the caller's disciplines
// from their M3 role grants, and `admin@` holds every permission key and no clinical role — it passes
// RBAC and is refused by ABAC. The same split emar.spec.ts signs in around. Rita holds `rn` and
// `rn_case_manager`; only the first normalizes into the CMS author vocabulary, so "Recording as" resolves
// to exactly one option and preselects it.
import { expect, test } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

/** The flagship seeded patient — `db:seed:scenario-clinical` gives only her a HOPE assessment. */
const PATIENT_LAST_NAME = "Whitfield";

test.describe("HOPE", () => {
  test("main path: an RN records a HOPE timepoint and signs it", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());

    // D4 baseline, taken BEFORE the capture. The seed's own admission assessment already recorded
    // `pain = moderate` and was signed, so an open SFV exists on a seeded stack — asserting a COUNT
    // rather than "there is a row" is what makes the assertion below about this test's signature.
    // Unlike the timeline, this table's rows are real `row`s; only the action cell holds a button.
    await page.goto("/hope/sfv");
    await expect(page.getByRole("heading", { name: "Symptom Follow-Up Visits" })).toBeVisible();
    const sfvRows = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: "Symptom follow-up" });
    await expect.poll(() => sfvRows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const sfvBefore = await sfvRows.count();

    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/hope`);
    await expect(page.getByRole("heading", { name: "HOPE Timeline" })).toBeVisible();

    // The timeline is the authoring surface. "Record timepoint" renders only once the patient has at
    // least one HOPE row (the admission id is read off the newest of them), which the seed guarantees.
    //
    // Selected by the `button` role, not `row`: each `<tr>` carries `role="button"` so the whole row is
    // keyboard-actionable, and an explicit role REPLACES the implicit one — `getByRole("row")` matches
    // only the header. Same trap F-023 documents in `e2e/fixtures/patients.ts`, from the other side.
    const rows = page.getByRole("table").getByRole("button");
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const before = await rows.count();

    await page.getByRole("button", { name: "Record timepoint" }).click();
    const dialog = page.getByRole("dialog", { name: "Record HOPE timepoint" });
    await expect(dialog).toBeVisible();

    // HUV1 rather than a second Admission: it is a legitimately distinct timepoint on the same
    // admission, and selecting it also exercises the RFA control, which is disabled when a schedule
    // window pins it and free here because this capture is unscheduled.
    await dialog.getByLabel("Reason for assessment").selectOption("02_huv1");
    await expect(dialog.getByRole("heading", { name: "Record HUV1" })).toBeVisible();

    // THE REGRESSION GUARD for defect 1. The value is the CMS discipline code the route accepts, not the
    // M3 role key the select used to carry. Rita holds two nursing roles and only `rn` normalizes into
    // the author vocabulary, so there is one option and it is preselected rather than left on a
    // "Select a discipline…" placeholder.
    await expect(dialog.getByLabel("Recording as")).toHaveValue("RN");

    // Section J, so the capture carries something a CMS rule can read. `moderate` deliberately arms the
    // D4 trigger — signing must then create the 2-day SFV obligation, asserted below.
    await dialog.getByLabel("J2030 — screened for pain").check();
    await dialog.getByRole("combobox", { name: "Pain", exact: true }).selectOption("moderate");

    await dialog.getByRole("button", { name: "Record draft" }).click();

    // The dialog closes only on a committed write; a refusal keeps it open carrying the server's own
    // message verbatim. Before the fix this is exactly where the spec failed, on a 422.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(before + 1);

    // Open the draft. The row navigates to the assessment detail, where signing lives.
    //
    // Filtered on "Draft" as well as the RFA, which is what makes this spec re-runnable: a second run
    // against the same database finds the FIRST run's HUV1 sitting there signed, and matching on the RFA
    // alone would open that one and then fail on a Sign button a signed assessment does not offer.
    const draftRow = rows.filter({ hasText: "HUV1" }).filter({ hasText: "Draft" }).first();
    await expect(draftRow).toBeVisible();
    await draftRow.click();
    await page.waitForURL(/\/hope\/assessments\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "HOPE — HUV1 timepoint" })).toBeVisible();

    // An unsigned assessment cannot reach iQIES, and the footer says so rather than offering submission.
    // The count is asserted as a pattern, not a number: it is one blocking `REQUIRED_SECTION_MISSING`
    // finding per HOPE section with no item definitions in this codebase (13 of the instrument's 17 —
    // `screens.ts` states the gap), so it moves whenever a section gains items. What matters here is that
    // the validation rail RAN and produced findings, which is what makes "No findings." elsewhere mean
    // checked-and-clean rather than never-checked.
    await expect(page.getByText(/\d+ errors block iQIES submission/)).toBeVisible();

    await page.getByRole("button", { name: "Sign", exact: true }).click();
    const signDialog = page.getByRole("dialog", { name: "Sign HOPE timepoint" });
    await expect(signDialog).toBeVisible();
    await signDialog.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(signDialog).toBeHidden({ timeout: 15_000 });

    // The round trip: the server re-read the row and it is signed. Asserting the status pill rather than
    // the POST's status code is what makes this a statement about the record instead of about the call.
    await expect(page.getByText("Signed", { exact: true })).toBeVisible({ timeout: 15_000 });
    // …and the footer now offers the correction path, which is only ever shown on a signed, unsuperseded
    // assessment — so its presence is a second, independent read of the same transition.
    await expect(page.getByRole("button", { name: "Correct" })).toBeVisible();

    // D4 — the SFV obligation is created by the SERVER's J2051 evaluation at sign time, from the STORED
    // payload, and is due 2 calendar days from the VISIT date rather than from the signature. One more
    // than the baseline is the assertion; the recorded `moderate` is what earns it.
    await page.goto("/hope/sfv");
    await expect(page.getByRole("heading", { name: "Symptom Follow-Up Visits" })).toBeVisible();
    await expect.poll(() => sfvRows.count(), { timeout: 15_000 }).toBe(sfvBefore + 1);
  });

  test("the HOPE timeline is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/hope`);
    await expect(page.getByRole("heading", { name: "HOPE Timeline" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
