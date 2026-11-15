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
import type { Locator, Page } from "@playwright/test";
import { ADMIN_ACCOUNT, RN_ACCOUNT } from "../fixtures/credentials";
import {
  enrolPasskey,
  expectNoAxeViolations,
  signInAs,
  signOut,
  stepUpWithPasskey,
} from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

/** The flagship seeded patient — active RHC, so she has an admission to open an encounter against. */
const PATIENT_LAST_NAME = "Whitfield";
const EVV_ATTESTATION =
  "The assigned mobile device did not produce an EVV bracket, so this visit is being attested manually.";

async function pickLookupOption(
  scope: Locator,
  label: string,
  query: string,
  option: RegExp,
): Promise<void> {
  const box = scope.getByRole("combobox", { name: label, exact: true });
  await box.fill(query);
  const hit = scope
    .getByRole("listbox", { name: label, exact: true })
    .getByRole("option", { name: option })
    .first();
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await hit.click();
}

function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function openVisitWindow(
  page: Page,
  serviceDate: string,
  assignedMembershipId: string,
): Promise<{ start: string; end: string }> {
  return page.evaluate(
    async ({ day, membershipId }) => {
      const from = new Date(`${day}T00:00`);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      const response = await fetch(
        `/api/v1/visits?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error(`visit availability read failed: ${response.status}`);
      const body = await response.json();
      const visits = (Array.isArray(body) ? body : (body.items ?? [])) as Array<{
        assignedMembershipId: string;
        scheduledStartedAt: string;
        scheduledEndedAt: string;
      }>;
      for (let hour = 7; hour <= 20; hour += 1) {
        const hh = String(hour).padStart(2, "0");
        const start = new Date(`${day}T${hh}:00`);
        const end = new Date(start.getTime() + 45 * 60_000);
        const overlaps = visits.some(
          (visit) =>
            visit.assignedMembershipId === membershipId &&
            Date.parse(visit.scheduledStartedAt) < end.getTime() &&
            Date.parse(visit.scheduledEndedAt) > start.getTime(),
        );
        if (!overlaps)
          return {
            start: `${day}T${hh}:00`,
            end: `${day}T${hh}:45`,
          };
      }
      throw new Error("no open RN visit window was available for the synthetic test day");
    },
    { day: serviceDate, membershipId: assignedMembershipId },
  );
}

const visitShortId = (visitId: string): string =>
  visitId.length > 18 ? `${visitId.slice(0, 8)}...${visitId.slice(-6)}` : visitId;

test.describe("Encounters", () => {
  test("main path: an RN opens a visit note, composes it, finalizes and signs it", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // ── 1. An administrator schedules the RN's visit; M17 publishes it and M8 owns draft seeding. ──
    await signInAs(page, ADMIN_ACCOUNT());
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const serviceDate = localDay(tomorrow);
    await page.goto(`/scheduling/day?date=${serviceDate}`);
    await expect(page.getByRole("heading", { name: "Day View" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "New Visit" }).click();
    const visitDialog = page.getByRole("dialog", { name: "New Visit" });
    await pickLookupOption(
      visitDialog,
      "Patient",
      PATIENT_LAST_NAME,
      new RegExp(PATIENT_LAST_NAME, "i"),
    );
    const admission = visitDialog.getByRole("combobox", { name: "Active admission" });
    await admission.click();
    await visitDialog
      .getByRole("listbox", { name: "Active admission" })
      .getByRole("option")
      .first()
      .click();
    await visitDialog.getByLabel("Visit purpose").selectOption("routine_visit");
    await visitDialog.getByLabel("Visit setting").selectOption("telephonic");
    const clinician = visitDialog.getByRole("combobox", { name: /Assigned clinician/ });
    await clinician.selectOption({ label: "Rita Alvarez, RN · RN" });
    const assignedMembershipId = await clinician.inputValue();
    const visitWindow = await openVisitWindow(page, serviceDate, assignedMembershipId);
    await visitDialog.getByLabel("Scheduled start").fill(visitWindow.start);
    await visitDialog.getByLabel("Scheduled end").fill(visitWindow.end);
    await visitDialog.getByRole("button", { name: "Create Visit" }).click();
    await page.waitForURL(/\/scheduling\/visits\/[^/]+$/, { timeout: 15_000 });
    const visitId = /\/scheduling\/visits\/([^/?#]+)$/.exec(page.url())?.[1] as string;
    expect(visitId).toBeTruthy();
    const visit = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/visits/${id}`, { credentials: "include" });
      if (!response.ok) throw new Error(`visit read failed: ${response.status}`);
      return response.json() as Promise<{ patientId: string }>;
    }, visitId);
    const patientId = visit.patientId;

    // The assigned RN advances the visit with the existing fresh-auth self-attestation flow.
    await signOut(page);
    await signInAs(page, RN_ACCOUNT());
    await enrolPasskey(page);
    await stepUpWithPasskey(page, "/me/visits");
    await expect(page.getByRole("heading", { name: "My Visits" })).toBeVisible();
    const shortVisitId = visitShortId(visitId);
    await page.getByRole("button", { name: `Start visit ${shortVisitId}` }).click();
    const startDialog = page.getByRole("dialog", { name: "Start visit" });
    await startDialog.getByLabel("Reason there is no EVV bracket (required)").fill(EVV_ATTESTATION);
    await startDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(startDialog).toBeHidden({ timeout: 15_000 });
    await page.getByRole("button", { name: `Check in visit ${shortVisitId}` }).click();
    const arriveDialog = page.getByRole("dialog", { name: "Check in to visit" });
    await arriveDialog
      .getByLabel("Reason there is no EVV bracket (required)")
      .fill(EVV_ATTESTATION);
    await arriveDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(arriveDialog).toBeHidden({ timeout: 15_000 });

    // Wait for the asynchronous M17-published → M8-draft consumer, then enter through My Visits.
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ expectedPatientId, expectedVisitId }) => {
              const response = await fetch(
                `/api/v1/encounters?patientId=${encodeURIComponent(expectedPatientId)}`,
                { credentials: "include" },
              );
              if (!response.ok) return false;
              const body = await response.json();
              const rows = Array.isArray(body) ? body : (body.encounters ?? []);
              return rows.some((row: { visitId?: string }) => row.visitId === expectedVisitId);
            },
            { expectedPatientId: patientId, expectedVisitId: visitId },
          ),
        { timeout: 60_000, message: "M8 did not seed the encounter for the published visit" },
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "My Visits" })).toBeVisible();
    await page.getByRole("button", { name: `Open encounter for visit ${shortVisitId}` }).click();
    await page.waitForURL(/\/encounters\/[^/]+$/, { timeout: 15_000 });
    const encounterId = /\/encounters\/([^/]+)$/.exec(page.url())?.[1] as string;
    expect(encounterId).toBeTruthy();
    await page.getByRole("button", { name: "Compose note" }).click();
    await page.waitForURL(new RegExp(`/encounters/${encounterId}/compose$`), { timeout: 15_000 });

    // ── 2. Compose it ──────────────────────────────────────────────────────────────────────────────
    await expect(page.getByRole("heading", { name: "Compose visit note" })).toBeVisible({
      timeout: 15_000,
    });

    // Every REQUIRED section, because the §2.6 Layer-3 gate refuses a note that says nothing and that
    // refusal is the server's — the composer captions required sections "Required" and never
    // pre-empts it. The tabs are the section nav; a section is satisfied by an entry OR by prose, and
    // free text deliberately exercises the tenant-DEK sealing path that protects authored narrative.
    const sections = page.getByRole("complementary", { name: "Visit note sections" });
    const requiredLabels = await sections
      .getByRole("button", { name: /: Required$/ })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
    expect(requiredLabels.length).toBeGreaterThan(0);
    for (const label of requiredLabels) {
      // Keep the explicit server-template heading: the state suffix changes to "Documented" while
      // another section is edited, and decorative step numbers never enter this accessible name.
      await sections.getByRole("button", { name: label, exact: true }).click();
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
    await page.getByRole("button", { name: "Finalize note", exact: true }).click();
    await expect(page.getByText("Note finalized", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // ── 4. Sign with the same server-verified fresh step-up used for visit arrival. ────────────────
    await page.goto(`/patients/${patientId}/encounters/${encounterId}`);
    const signButton = page.getByRole("button", { name: "Sign encounter", exact: true });
    await expect(signButton).toBeVisible({ timeout: 15_000 });
    await signButton.click();
    const signDialog = page.getByRole("dialog", { name: "Sign encounter" });
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

    // M8's signed event is the only authority that completes M17. The visit and chart must lead back
    // to this exact immutable encounter rather than parallel client-owned status.
    await page.goto(`/scheduling/visits/${visitId}`);
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Signed", exact: true }).click();
    await page.waitForURL(`/patients/${patientId}/encounters/${encounterId}`);
  });

  test("the patient encounters list is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, PATIENT_LAST_NAME);
    await page.goto(`/patients/${patientId}/encounters`);
    await expect(page.getByRole("heading", { name: "Encounters / Visits" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
