// e2e/specs/care-plan.spec.ts — critical workflow: revise the plan of care and sign it (F-031, #91).
//
// #91's fifth acceptance criterion asks for at least one E2E spec per module driving the primary
// authored-then-signed path. This is M07's, and it is the one with the most law behind it: the plan of
// care is the legal predicate for delivering hospice care at all (42 CFR 418.56(b)), and the IDG must
// review and update it at least every 15 days (418.56(d)). Before #91 this screen's footer held three
// navigation buttons and a static quorum chip — a clinician could read the plan, see it was due, and
// have no way to move it.
//
// The path driven here is the whole §2 version lifecycle, which is a THREE-STATE machine and not a
// button: the active version is signed, so the only ceremony offered is opening a new one; that new
// version is a draft, so the only ceremony offered is closing it for signature; a closed-but-unsigned
// version is signed or reopened. Each control appears only in the state the server accepts it in, so
// the spec asserting that the NEXT control appeared is asserting the server made the transition — not
// that a button was clicked.
//
// WHAT THIS PROVES THAT A DOM TEST CANNOT. `requiredSignerSet` is populated by the SERVER at finalize,
// and both M7 screens used to type it as `string[]` when the wire has always sent `{ role, count }`.
// The checklist therefore compared an object to a role string and passed the object to a function that
// calls `s.replace`. It never threw — because the set is only populated at finalize and, before #91,
// nothing in the product could finalize. So the one code path that would have exposed the type error
// was unreachable, and a mocked test would have agreed with whichever shape the mock invented. This
// spec finalizes for real and then reads the slots the server published.
//
// AN INTERIM REVISION, NOT AN IDG REVIEW, AND THE DIFFERENCE IS THE POINT. `resolveRequiredSignerSet`
// gives `idg_review` the full IDG quorum — RN + MSW + chaplain + MD/DO, four slots — while `initial`,
// `interim_revision` and `discharge` use the §418.56(b)(1) AUTHORING PAIR: attending physician/NP plus
// the RN case manager. Only the second is drivable here, because `db:seed:staff` creates
// `primary_rn` and `attending_clinician` assignments and no others, so the seeded MSW and chaplain are
// in nobody's caseload and M7's `caseload_or_scope` denies them. Driving the pair is the more useful
// spec anyway: it is the smallest quorum that is still a QUORUM, so it proves the rule that matters —
// the plan does not activate on one signature.
//
// TWO LOGINS, deliberately. The RN signs, and the plan must still be inactive; the physician signs, and
// only then does it activate. A spec with one signer could not tell "the quorum was met" apart from
// "the quorum was never checked". Rita is anchored as primary RN on every demo patient (satisfying
// `caseload_or_scope`); Dr Harris reaches the plan through `medical_director`, one of M7's three
// org-wide scope roles, which is why no caseload row is needed for him.
//
// THIS SPEC BRINGS ITS OWN SUBJECT and returns the plan to the state it found it in. The seed leaves the
// only version SIGNED, which is exactly the state from which "open a new version" is the offered
// ceremony; completing the quorum signs the new version, so a second run finds that same state again.
// Verified by running it three times against one database.
import { expect, test } from "@playwright/test";
import { PRESCRIBER_ACCOUNT, RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs, signOut } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

const PATIENT_LAST_NAME = "Whitfield";

test.describe("Care plan", () => {
  test("main path: a revision is authored, and the plan activates only once the quorum has signed", async ({
    page,
  }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/care-plan`);

    // The seeded plan's active version is signed, so the offered ceremony is opening a new one. If this
    // control is absent the plan is in some other state and the rest of the spec would be meaningless.
    const startReview = page.getByRole("button", { name: "Start IDG review" });
    await expect(startReview).toBeVisible({ timeout: 15_000 });
    await startReview.click();

    const reviseDialog = page.getByRole("dialog", { name: "Open a new version" });
    await expect(reviseDialog).toBeVisible();
    await reviseDialog.getByLabel("Reason for the new version").selectOption("interim_revision");
    await reviseDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(reviseDialog).toBeHidden({ timeout: 15_000 });

    // The new version is a DRAFT — proven by which control the footer now offers, which is the server's
    // state and not the browser's.
    const closeForSignature = page.getByRole("button", { name: "Close draft for signature" });
    await expect(closeForSignature).toBeVisible({ timeout: 15_000 });

    // Author into the draft. A revision that changes nothing is not a review; this is the §5.2 IPOC
    // authoring surface #91 added, and it is the reason the version exists.
    await page.getByRole("button", { name: "Add problem" }).first().click();
    const problemDialog = page.getByRole("dialog", { name: "Add problem" });
    await expect(problemDialog).toBeVisible();
    const save = problemDialog.getByRole("button", { name: "Save" });
    // The problem text is required — the control is a real gate, not decoration.
    await expect(save).toBeDisabled();
    await problemDialog
      .getByLabel("Problem", { exact: true })
      .fill("Dyspnea on exertion, worsening over the past week");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(problemDialog).toBeHidden({ timeout: 15_000 });

    // Close the draft. This is the transition that populates `requiredSignerSet` server-side.
    await closeForSignature.click();
    const finalizeDialog = page.getByRole("dialog", { name: "Close draft for signature" });
    await expect(finalizeDialog).toBeVisible();
    await finalizeDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(finalizeDialog).toBeHidden({ timeout: 15_000 });

    // A closed-but-unsigned version offers exactly two ceremonies, and their appearance is the proof
    // the finalize committed.
    const sign = page.getByRole("button", { name: "Sign", exact: true });
    await expect(sign).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Return to draft" })).toBeVisible();

    await sign.click();
    const signDialog = page.getByRole("dialog", { name: "Sign care plan" });
    await expect(signDialog).toBeVisible();

    // The signature must be attributed before it can be taken — the commit is blocked until a signer
    // role is chosen, which is what makes this control a gate rather than a label.
    await signDialog.getByLabel("Signing as").selectOption("rn_case_manager");
    await signDialog.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(signDialog).toBeHidden({ timeout: 15_000 });

    // ONE SIGNATURE IS NOT A QUORUM. The version stays in review, so the footer still offers to sign
    // and to reopen — and critically it does NOT offer "Start IDG review", which is only offered when
    // no draft and no pending version exist. This is the assertion a single-signer spec cannot make.
    await expect(page.getByRole("button", { name: "Return to draft" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Start IDG review" })).toBeHidden();

    // The physician completes the §418.56(b)(1) pair.
    await signOut(page);
    await signInAs(page, PRESCRIBER_ACCOUNT());
    await page.goto(`/patients/${patientId}/care-plan`);
    const physicianSign = page.getByRole("button", { name: "Sign", exact: true });
    await expect(physicianSign).toBeVisible({ timeout: 15_000 });
    await physicianSign.click();
    const physicianDialog = page.getByRole("dialog", { name: "Sign care plan" });
    await expect(physicianDialog).toBeVisible();
    await physicianDialog.getByLabel("Signing as").selectOption("hospice_physician");
    await physicianDialog.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(physicianDialog).toBeHidden({ timeout: 15_000 });

    // The quorum is met, so the SERVER activated the version — and the footer says so by offering the
    // next ceremony instead of the signing one. That flip is the round trip: it is the server's
    // decision from the slots it published at finalize, read back through the UI rather than asserted
    // from a status code.
    await expect(page.getByRole("button", { name: "Start IDG review" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeHidden();
  });

  test("the care plan view is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/care-plan`);
    await expect(page.getByRole("button", { name: "Version history" })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAxeViolations(page);
  });
});
