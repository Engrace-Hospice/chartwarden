// e2e/specs/hope.spec.ts — critical workflow: record a HOPE timepoint and sign it (F-031, #91).
//
// #91's fifth acceptance criterion asks for at least one E2E spec per module driving the primary
// authored-then-signed path. This is M10's — the module the issue ranks behind eMAR and orders because
// HOPE is CMS-reportable: what this screen records is what the agency submits to iQIES and what HQRP
// scores it on.
//
// IT FOUND THREE DEFECTS, WHICH IS THE ARGUMENT FOR WRITING IT (F-074).
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
// THIS SPEC BRINGS ITS OWN SUBJECT: it records the draft it then signs, rather than consuming a seeded
// queue row the way the orders and eMAR specs do.
//
// IT MOVED PATIENTS, AND WHY IT HAD TO IS A FOURTH DEFECT (F-085). It used to record an UNSCHEDULED
// HUV1 on Whitfield, and its header explained that choice: "`hope_timepoint_schedule` is EMPTY on a
// seeded stack because schedules are written by the M6 outbox consumer rather than by any seed". True,
// and the cause was one layer further out — the outbox RELAY only runs when `DATABASE_PLATFORM_URL` is
// configured, and no local stack and no CI job had ever set it, so the consumer that writes the
// schedules had never run ANYWHERE. F-082 gave the e2e job the platform credential (M8's finalize needs
// it to resolve the tenant DEK); the schedules now exist, and this spec immediately went red with
// `409 M10_TIMEPOINT_NOT_OPEN` — HUV1 opens on day 6 of the benefit period. The old path had been
// passing because the schedule was absent.
//
// Recording against an OPEN window meant recording the ADMISSION timepoint, which meant a patient who
// does not already have one — and that could not be done at all. The timeline's "Record timepoint"
// control renders only when `admissionId` resolves, and `admissionId` came off `items[0]`: the newest
// EXISTING timepoint. A patient with none got no control, and the header named the intended exit —
// "the schedule worklist … is the entry point for the first capture" — which is `/hope`, an org-wide
// read that M10's own `hope.scope` predicate admits only for `medical_director` /`compliance_officer` /
// `survey_coordinator`, with no patient filter in the UI. So the CMS admission timepoint, due within 5
// days of election for every newly admitted patient, was recordable from nowhere by an RN. Same missing
// fact as F-065 (M12) and F-083 (M8): the patient's `admissionId`.
//
// Samuel Okonkwo rather than Eleanor Whitfield, then: his admission is ACTIVE (the capture route refuses
// a closed one, `409 M10_ADMISSION_NOT_ACTIVE`), his admission window is open, and he has NO HOPE
// timepoint — which is exactly the state that could not be authored.
//
// The D4 symptom-follow-up assertion is folded into the main path rather than standing as its own test,
// because a separate test would have to assume either an execution ORDER or a fixed row count — and the
// seed already leaves one open SFV, so "there is a row" passes without this spec doing anything. It is
// asserted on THIS assessment's own row (`j2051TriggerFired`) rather than against the org-wide SFV
// worklist, which paginates: a "one more than before" count over a paginated list stops growing once a
// database has accumulated a page of obligations, and the assertion becomes untestable without failing.
//
// Signs in as the RN, not the admin: `hope.authorDisciplineAllowed` resolves the caller's disciplines
// from their M3 role grants, and `admin@` holds every permission key and no clinical role — it passes
// RBAC and is refused by ABAC. The same split emar.spec.ts signs in around. Rita holds `rn` and
// `rn_case_manager`; only the first normalizes into the CMS author vocabulary, so "Recording as" resolves
// to exactly one option and preselects it.
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

/**
 * An admitted patient with an OPEN admission window and no HOPE timepoint yet — the state the CMS
 * admission assessment exists for, and the one F-085 made authorable. Deliberately NOT Whitfield: the
 * seed already records and signs her admission timepoint, so her window is `completed` and the only
 * thing left to record on her is a HUV1 whose window has not opened.
 */
const PATIENT_LAST_NAME = "Okonkwo";

test.describe("HOPE", () => {
  test("main path: an RN records a HOPE timepoint and signs it", async ({ page }) => {
    // This journey completes the whole CMS instrument through the UI (dozens of answers, each waited on
    // until the server has re-read it) plus the SFV. ~9 s locally, but past the suite's 30 s default on a
    // shared CI runner (it timed out mid-Section I) — a longer budget for this test only.
    test.setTimeout(180_000);
    await signInAs(page, RN_ACCOUNT());

    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/hope`);
    await expect(page.getByRole("heading", { name: "HOPE Timeline" })).toBeVisible();

    // THE REGRESSION GUARD for F-085. The control is offered on a patient with NO timepoints — the
    // admission id now resolves from the patient's own admission rather than from a timepoint that does
    // not exist. Before the fix this button is simply absent and the spec cannot start.
    //
    // Selected by the `button` role, not `row`: each `<tr>` carries `role="button"` so the whole row is
    // keyboard-actionable, and an explicit role REPLACES the implicit one — `getByRole("row")` matches
    // only the header. Same trap F-023 documents in `e2e/fixtures/patients.ts`, from the other side.
    const rows = page.getByRole("table").getByRole("button");
    const before = await rows.count();

    await page.getByRole("button", { name: "Record timepoint" }).click();
    const dialog = page.getByRole("dialog", { name: "Record HOPE timepoint" });
    await expect(dialog).toBeVisible();

    // The ADMISSION timepoint, because it is the one whose window is open. `assertCaptureAllowed`
    // classifies the target date against the STORED window, so which RFA this is is not a preference —
    // it is the only one the server will accept today.
    await dialog.getByLabel("Reason for assessment").selectOption("01_admission");
    await expect(dialog.getByRole("heading", { name: "Record Admission" })).toBeVisible();

    // THE REGRESSION GUARD for defect 1. The value is the CMS discipline code the route accepts, not the
    // M3 role key the select used to carry. Rita holds two nursing roles and only `rn` normalizes into
    // the author vocabulary, so there is one option and it is preselected rather than left on a
    // "Select a discipline…" placeholder.
    await expect(dialog.getByLabel("Recording as")).toHaveValue("RN");

    // The dialog's own Section J capture. Note (#235): the CMS workspace does not read these legacy
    // dialog fields — its J2051 answers start empty (the timeline's J2051 column reads "None") — so the
    // D4 trigger is armed below, in the workspace's J2051A item, where the server evaluates it.
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
    // against the same database finds the FIRST run's timepoint sitting there signed, and matching on
    // the RFA alone would open that one and then fail on a Sign button a signed assessment does not
    // offer.
    const draftRow = rows.filter({ hasText: "Admission" }).filter({ hasText: "Draft" }).first();
    await expect(draftRow).toBeVisible();
    await draftRow.click();
    await page.waitForURL(/\/hope\/assessments\/[^/]+$/);
    // Since the #235 redesign the assessment detail is the CMS item WORKSPACE: a section navigator
    // (A · F · I · J · M · N · Review) over the imported HOPE specification, answers auto-saving item
    // by item.
    await expect(page.getByRole("heading", { level: 1, name: "Admission Workspace" })).toBeVisible({
      timeout: 15_000,
    });

    // An incomplete assessment cannot be signed, and the Review step says so rather than offering the
    // signature. The redesign made this a hard gate: signing is enabled only when the SERVER's readiness
    // review reports no blockers (it used to be possible to sign over "N errors block iQIES
    // submission"). What matters here is that the review RAN and found the record incomplete, which is
    // what makes "Ready to complete" below mean checked-and-clean rather than never-checked.
    await openSection(page, "Review");
    await expect(page.getByRole("heading", { name: "Before signature" })).toBeVisible();
    await expect(workspace(page).getByRole("button", { name: "Sign & complete" })).toBeDisabled();

    // Complete the CMS instrument the way a nurse does: section by section, through the workspace's own
    // controls, each answer saved by the server before the next.
    await completeAdmissionSections(page);

    // D4 — a moderate symptom impact (J2051A) arms the 2-day Symptom Follow-Up Visit. Since ea6979a9 the
    // SERVER opens that obligation when the J2051 answers are saved rather than at signature, and
    // readiness then holds the signature until the SFV is recorded — so the SFV is asserted, and
    // completed, here, before the sign ceremony instead of after it.
    const sfvCard = workspace(page).getByRole("heading", { name: "Symptom Follow-Up Visit" });
    await expect(sfvCard).toBeVisible();
    await expect(
      workspace(page).getByText("A moderate or severe symptom impact requires a follow-up visit."),
    ).toBeVisible();
    await workspace(page).getByRole("button", { name: "Complete SFV" }).click();
    const sfv = page.getByRole("dialog", { name: "Complete SFV" });
    await expect(sfv).toBeVisible();
    await expect(sfv.getByLabel("Author discipline")).toHaveValue("RN");
    const reassessment = sfv.getByRole("combobox", { name: /J2053[A-H]/ });
    await expect(reassessment).toHaveCount(8);
    for (let i = 0; i < 8; i += 1) {
      // Pain eased to mild at the follow-up; nothing else present.
      await reassessment.nth(i).selectOption({ label: i === 0 ? "Mild" : "None" });
    }
    await sfv.getByRole("button", { name: "Complete SFV" }).click();
    await expect(sfv).toBeHidden({ timeout: 15_000 });

    // Now the review is clean, and only now is the signature offered.
    await openSection(page, "Review");
    await expect(page.getByRole("heading", { name: "Ready to complete" })).toBeVisible({
      timeout: 15_000,
    });
    await workspace(page).getByRole("button", { name: "Sign & complete" }).first().click();
    const signDialog = page.getByRole("dialog", { name: "Complete Admission" });
    await expect(signDialog).toBeVisible();
    await signDialog.getByRole("button", { name: "Sign & complete" }).click();
    await expect(signDialog).toBeHidden({ timeout: 15_000 });

    // The round trip: the server re-read the row and it is signed — the workspace re-renders as the
    // completed, read-only record. Asserting the record's own state rather than the POST's status code
    // is what makes this a statement about the record instead of about the call.
    await expect(page.getByRole("heading", { level: 1, name: "Completed Admission" })).toBeVisible({
      timeout: 15_000,
    });
    // …and the header now offers the correction path, which is only ever shown on a signed assessment —
    // so its presence is a second, independent read of the same transition.
    // (Offered twice on the completed record — in the header and in the review panel.)
    await expect(page.getByRole("button", { name: "Create correction" }).first()).toBeVisible();

    // D4, from the record's side: `j2051TriggerFired` is set on the signed row, which the timeline shows
    // as the "SFV" chip. Asserted on THIS assessment's own timeline row rather than by counting the
    // org-wide SFV worklist: that worklist paginates, so once a database has accumulated a page of
    // obligations a "one more than before" count stops growing and the assertion silently becomes
    // untestable.
    await page.goto(`/patients/${patientId}/hope`);
    await expect(page.getByRole("heading", { name: "HOPE Timeline" })).toBeVisible();
    const signedAdmission = rows
      .filter({ hasText: "Admission" })
      .filter({ hasText: "Signed" })
      .first();
    await expect(signedAdmission).toContainText("SFV", { timeout: 15_000 });
  });

  test("the HOPE timeline is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/hope`);
    await expect(page.getByRole("heading", { name: "HOPE Timeline" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

// ── The HOPE workspace, driven through its own controls ───────────────────────────────────────────────

/** The workspace's main column (the section form), as opposed to the chart rail beside it. */
function workspace(page: Page): Locator {
  return page.locator(".wx-hope-main");
}

async function openSection(page: Page, code: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Admission sections" })
    .getByRole("button", { name: new RegExp(`^${code}\\b`) })
    .click();
  const heading = code === "Review" ? /^Review & Sign$/ : new RegExp(`^${code}\\. `);
  await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
}

/**
 * Performs one answer and waits for it to be SAVED: every answer is its own versioned PATCH, after which
 * the workspace re-reads the item state and the readiness review, and only then re-renders the control.
 * Acting on the next control before that lands races the re-render (a checkbox clicked back off before
 * its "on" had rendered stays on).
 */
async function saving(page: Page, act: () => Promise<void>): Promise<void> {
  const reread = (path: string) =>
    page.waitForResponse(
      (r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(path),
      { timeout: 20_000 },
    );
  const done = Promise.all([reread("/workspace"), reread("/review")]);
  await act();
  await done;
}

async function answerRadio(page: Page, question: string, choice: string): Promise<void> {
  const option = workspace(page)
    .getByRole("group", { name: question, exact: true })
    .getByRole("radio", { name: choice, exact: true });
  if (await option.isChecked()) return;
  await saving(page, () => option.click());
  await expect(option).toBeChecked();
}

async function answerSelect(select: Locator, page: Page): Promise<void> {
  if ((await select.inputValue()) !== "") return;
  const values = await select
    .locator("option")
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""),
    );
  await saving(page, async () => {
    await select.selectOption(values[0] as string);
  });
}

async function answerText(page: Page, label: string, value: string): Promise<void> {
  const box = workspace(page).getByRole("textbox", { name: label });
  if ((await box.inputValue()) !== "") return;
  await box.fill(value);
  await saving(page, () => box.blur());
}

/**
 * Answers every item the CMS admission record requires, choosing the simplest clinically coherent path
 * (the "No" branches, which close their follow-on items) — except J2050/J2051, where a moderate pain
 * impact is recorded on purpose so the D4 Symptom Follow-Up Visit is armed.
 */
async function completeAdmissionSections(page: Page): Promise<void> {
  const main = workspace(page);

  // A — Administrative. Identity, payer and admission items arrive pre-filled from the chart; the rest
  // is the nurse's. "Select all that apply" groups: CMS scores every box, so each one left unticked must
  // be answered "not checked" too — in the workspace that is ticking it and clearing it again.
  await openSection(page, "A");
  await answerText(page, "Social Security Number", "123456789");
  await answerText(page, "Patient Medicaid number", "N");
  for (const legend of [/^Ethnicity/, /^Race/, /^Payer information/]) {
    const boxes = main.getByRole("group", { name: legend }).getByRole("checkbox");
    const count = await boxes.count();
    for (let i = 0; i < count; i += 1) {
      const box = boxes.nth(i);
      if (await box.isChecked()) continue;
      await saving(page, () => box.click());
      await expect(box).toBeChecked();
      await saving(page, () => box.click());
      await expect(box).not.toBeChecked();
    }
  }
  for (const label of [
    "Preferred language",
    "Does the patient need or want an interpreter",
    "Admitted from",
    "Living Arrangements",
    "Availability of Assistance",
    "Sex",
  ]) {
    await answerSelect(main.getByRole("combobox", { name: label, exact: true }), page);
  }

  // F — Preferences & goals.
  await openSection(page, "F");
  for (const question of [
    "Was ptnt/rsp prty asked about CPR",
    "Was ptnt/rsp prty asked treatments oth than CPR",
    "Was ptnt/rsp prty asked hospitalization",
    "Was ptnt/crgvr asked sprtual/exstntial cncrns",
  ]) {
    await answerRadio(page, question, "No");
  }

  // I — Diagnoses: the principal diagnosis category and each comorbidity flag.
  await openSection(page, "I");
  const diagnoses = main.getByRole("combobox");
  const diagnosisCount = await diagnoses.count();
  expect(diagnosisCount).toBeGreaterThan(0);
  for (let i = 0; i < diagnosisCount; i += 1) await answerSelect(diagnoses.nth(i), page);
  // The comorbidity flags (I0100 … I8005) render as a Yes/No pair ("<condition>: select Yes or No", two
  // checkboxes) rather than a dropdown, and unticking one saves nothing — so each is answered by ticking
  // "No". Left unanswered they are 15 "active and applicable but unanswered" blockers and the review never
  // reaches "Ready to complete".
  const flags = main.getByRole("group", { name: /: select Yes or No$/ });
  const flagCount = await flags.count();
  expect(flagCount).toBeGreaterThan(0);
  for (let i = 0; i < flagCount; i += 1) {
    const no = flags.nth(i).getByRole("checkbox", { name: "No", exact: true });
    if (await no.isChecked()) continue;
    await saving(page, () => no.click());
    await expect(no).toBeChecked();
  }

  // M — Skin, N — Medications.
  await openSection(page, "M");
  await answerRadio(page, "Patient has one or more skin conditions", "No");
  await openSection(page, "N");
  await answerRadio(page, "Was scheduled opioid initiated or continued", "No");
  await answerRadio(page, "Was PRN opioid initiated or continued", "No");

  // J — Health conditions, last, so the section stays open for the SFV it arms.
  await openSection(page, "J");
  for (const question of [
    "Death is Imminent",
    "Was patient screened for pain",
    "Is pain an active problem for the patient?",
    "Neuropathic Pain",
    "Was patient screened for shortness of breath",
  ]) {
    await answerRadio(page, question, "No");
  }
  await answerRadio(page, "Was symptom impact screening completed", "Yes");
  await answerText(
    page,
    "J2050B Date of symptom impact screening",
    new Date().toLocaleDateString("en-CA"),
  );
  await answerRadio(page, "Symptom Impact - Pain", "Moderate");
  for (const symptom of [
    "Shortness of breath",
    "Anxiety",
    "Nausea",
    "Vomiting",
    "Diarrhea",
    "Constipation",
    "Agitation",
  ]) {
    await answerRadio(
      page,
      `Symptom Impact - ${symptom}`,
      "Not applicable (the patient is not experiencing the symptom)",
    );
  }
}
