// e2e/specs/encounters.spec.ts — critical workflow: open a visit note, compose it, finalize, sign
// (F-082/F-083/F-084, #91).
//
// #91's fifth acceptance criterion asks for one E2E spec per module driving the primary
// authored-then-signed path. This is M8's, and M8 is the module the issue is named after: a visit note
// is the highest-volume artifact in a hospice EHR, the CoP documentation that the visit happened, and
// the substantiation behind the claim. It is the last of the twelve modules to get a spec, and writing
// it found that the path did not join up in three separate places.
//
//   1. THE FIRST STEP DID NOT EXIST (F-083). `createDraft` has been exported from
//      `encounters-api.ts` since #91/F-063 built the composer, with NO CALLER anywhere in the web app,
//      and no screen offered a control that would produce one. The composer, the served template menu,
//      the selection save, the finalize and the sign ceremony are all real and all reachable only with
//      an encounter id already in hand. Every encounter in the product arrived from a seed script.
//      A clinician finishing a visit had nothing to open.
//
//   2. FINALIZE REFUSED 503 ON EVERY SEEDED DEPLOYMENT (F-082). `POST .../finalize` pins the assembled
//      narrative under the tenant DEK, which resolves through M34's key ring — and the base seed
//      creates its organization by INSERTing the row, a thing production cannot do: in production an
//      org only comes into existence through M34 provisioning, whose first step mints that key ring.
//      So "an org with no key ring" is unreachable in production and was universal in dev and CI. The
//      seed now provisions the M34 tenant spine through the same SECURITY DEFINER function the
//      production provision worker calls. It had been diagnosed as #105 (no KEK adapter) and written
//      down that way in the seed's own header; #105 was fixed months ago and the refusal survived it,
//      because the missing thing was never the KEK — it was the row the KEK wraps a key into.
//
//   3. THE SIGN REFUSAL SAID THE WRONG THING (F-084). `requireStepUp` denied with a plain
//      `ForbiddenError`, so a nurse refused for a STALE re-authentication was told "You do not have
//      permission for this action" — a statement about their ROLE, which is false, and which no amount
//      of retrying fixes. FIVE modules had already written the branch that tells the two apart and
//      shipped it dead (M6, M8, M23, M24, M39 each route a `STEP_UP_REQUIRED` code to `/step-up`), and
//      M8's own header records why it never fired. It now denies `403 STEP_UP_REQUIRED`, and the
//      redirect resolves to a ceremony that can be COMPLETED — which it could not before F-081, and
//      which is the honest reason this waited rather than being fixed at either end alone.
//
// THIS SPEC BRINGS ITS OWN SUBJECT, which is only possible because of (1): it opens the encounter it
// then composes, finalizes and signs, so it is re-runnable against the same database. That is a
// stronger statement than consuming a seeded draft would have been — the seeded drafts are created by
// an API script, and what was in doubt is whether a PERSON can.
//
// Signs in as the RN. `admin@` holds every permission key and no clinical role, so the discipline
// derivation resolves to the empty set for them and the modal correctly offers nothing — the same
// RBAC/ABAC split `hope.spec.ts` and `emar.spec.ts` sign in around.
import { expect, test } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import {
  enrolPasskey,
  expectNoAxeViolations,
  signInAs,
  stepUpWithPasskey,
} from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

/** The flagship seeded patient — active RHC, so she has an admission to open an encounter against. */
const PATIENT_LAST_NAME = "Whitfield";

test.describe("Encounters", () => {
  test("main path: an RN opens a visit note, composes it, finalizes and signs it", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInAs(page, RN_ACCOUNT());

    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/encounters`);
    await expect(page.getByRole("heading", { name: "Encounters / Visits" })).toBeVisible();

    // ── 1. Open the note (F-083) ───────────────────────────────────────────────────────────────────
    //
    // The #235 redesign replaced the old "New encounter" modal with the chart tab's "New Encounter"
    // dialog, which asks for the ACTIVE ADMISSION explicitly (a lookup over this patient's active
    // admissions) and, on a committed 201, lands on the encounter record rather than the composer —
    // the record's "Compose note" action is the way into the composer from there.
    await page.getByRole("button", { name: "New Encounter" }).click();
    const dialog = page.getByRole("dialog", { name: "New Encounter" });
    await expect(dialog).toBeVisible();

    const admission = dialog.getByRole("combobox", { name: "Active admission" });
    await admission.click();
    await dialog
      .getByRole("listbox", { name: "Active admission" })
      .getByRole("option")
      .first()
      .click();

    // THE REGRESSION GUARD for the derivation. Rita holds `rn` and `rn_case_manager`; only the first is
    // a clinical discipline, so the intersection with the §2.2 vocabulary is exactly {rn} and the field
    // preselects it rather than offering a menu whose other entries the server would refuse. Asserted
    // on the VALUE, which is the wire vocabulary, not on the rendered label.
    await expect(dialog.getByLabel("Discipline")).toHaveValue("rn");

    // A routine visit: `ENCOUNTER_DISCIPLINE_RULES` makes it rn|lpn, so it is legal for this caller and
    // the HearthNote registry has a template for the pair — which is the reason the type list is built
    // from that map rather than from the raw enum.
    await dialog.getByLabel("Encounter type").selectOption("routine_visit");
    await dialog.getByRole("button", { name: "Create Encounter" }).click();

    // The dialog closes only on a committed 201, and the app opens the new encounter's record.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.waitForURL(/\/encounters\/[^/]+$/, { timeout: 15_000 });
    const encounterId = /\/encounters\/([^/]+)$/.exec(page.url())?.[1] as string;
    expect(encounterId).toBeTruthy();
    // An empty draft is not the goal, the note is: straight on to the composer.
    await page.getByRole("button", { name: "Compose note" }).click();
    await page.waitForURL(new RegExp(`/encounters/${encounterId}/compose$`), { timeout: 15_000 });

    // ── 2. Compose it ──────────────────────────────────────────────────────────────────────────────
    await expect(page.getByRole("heading", { name: "Compose visit note" })).toBeVisible({
      timeout: 15_000,
    });

    // Every REQUIRED section, because the §2.6 Layer-3 gate refuses a note that says nothing and that
    // refusal is the server's — the composer captions required sections "Required" and never
    // pre-empts it. The tabs are the section nav; a section is satisfied by an entry OR by prose, and
    // the shipped vocabulary has no entries for several of them, so free text is what always works.
    const sections = page.getByRole("complementary", { name: "Visit note sections" });
    const requiredLabels = await sections
      .getByRole("button")
      .filter({ hasText: "Required" })
      .allTextContents();
    expect(requiredLabels.length).toBeGreaterThan(0);
    for (const label of requiredLabels) {
      // Keep the section name: a caption may change to "Documented" while another is edited.
      await sections.getByRole("button", { name: label.replace(/Required/, "").trim() }).click();
      await page
        .getByLabel("Additional notes")
        .fill("Patient resting comfortably; no new symptoms reported this visit.");
    }

    await page.getByRole("button", { name: "Save draft" }).click();
    // The server assembles the Layer-1 narrative and hands it back — the composer never assembles prose.
    // Its appearance is what proves the tree PERSISTED, which is the defect #114 fixed one layer down.
    await expect(page.getByText("Patient resting comfortably").first()).toBeVisible({
      timeout: 15_000,
    });

    // The Layer-3 gate also requires the routine-visit vitals (BP, HR, RR, T, SpO₂, pain) — they live in the
    // composer's Vitals panel, not in a note section, so prose alone no longer finalizes.
    await page.getByRole("button", { name: "Vitals", exact: true }).click();
    for (const [label, value] of [
      ["BP systolic", "118"],
      ["BP diastolic", "74"],
      ["Heart rate", "72"],
      ["Respiratory rate", "16"],
      ["Temperature", "98.4"],
      ["SpO₂", "97"],
      ["Pain score", "2"],
    ] as const) {
      await page.getByLabel(label, { exact: true }).fill(value);
    }
    await page.getByRole("button", { name: "Record vitals" }).click();
    // The panel closes itself once the server accepts the vitals.
    await expect(page.getByRole("button", { name: "Record vitals" })).toBeHidden({
      timeout: 15_000,
    });

    // ── 3. Finalize (F-082) ────────────────────────────────────────────────────────────────────────
    //
    // This is where every seeded stack used to answer 503 HEARTHNOTE_CIPHER_UNBOUND. Finalize seals the
    // assembled narrative under the tenant DEK and pins it, so what M22 prints and M28 exposes is what
    // was assembled here rather than what today's corpus would produce from the same selections.
    await page.getByRole("button", { name: "Finalize" }).click();
    await expect(page.getByText("Note finalized", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // ── 4. The sign gate refuses a session with no fresh step-up (F-084) ───────────────────────────
    //
    // Asserting the refusal is the point: CoP 418.104(c) is why the ceremony exists, and a control that
    // silently succeeded would be the defect. The session is fresh from `signInAs` and still not
    // enough — freshness here means a second factor inside the policy window, which a password never
    // establishes. What changed is what the clinician is TOLD: this used to redirect nowhere and read
    // "You do not have permission for this action".
    await page.goto(`/patients/${patientId}/encounters/${encounterId}`);
    // The record's footer action is "Sign encounter" since the redesign (it was "Sign").
    const signButton = page.getByRole("button", { name: "Sign encounter", exact: true });
    await expect(signButton).toBeVisible({ timeout: 15_000 });
    await signButton.click();
    const signDialog = page.getByRole("dialog", { name: "Sign encounter" });
    await expect(signDialog).toBeVisible();
    // The §2.7 attestation. `commitReady` is false until it is ticked, which is the ceremony's own
    // control and not something to route around: an attestation nobody affirmed is not a signature.
    await signDialog.getByRole("checkbox").check();
    await signDialog.getByRole("button", { name: "Sign & commit" }).click();
    // The refusal routes to the step-up screen rather than dead-ending in the dialog.
    await page.waitForURL(/\/step-up\?returnTo=/, { timeout: 15_000 });

    // ── 5. Enrol a factor, step up, and sign for real ──────────────────────────────────────────────
    await enrolPasskey(page);
    await stepUpWithPasskey(page, `/patients/${patientId}/encounters/${encounterId}`);

    await signButton.click();
    await expect(signDialog).toBeVisible();
    await signDialog.getByRole("checkbox").check();
    await signDialog.getByRole("button", { name: "Sign & commit" }).click();
    await expect(signDialog).toBeHidden({ timeout: 20_000 });

    // The round trip: the server re-read the row and it is signed. Asserted on the record's own status
    // and on the signature timestamp the read projects — a statement about the RECORD, not about the
    // call that produced it. The Sign button is gone because `canSign` is `status === "finalized"`.
    await expect(page.getByText("Signed", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(signButton).toBeHidden();
  });

  test("the patient encounters list is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/encounters`);
    await expect(page.getByRole("heading", { name: "Encounters / Visits" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
