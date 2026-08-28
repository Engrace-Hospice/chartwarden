// e2e/specs/scheduling.spec.ts — critical workflow: schedule a visit (F-031, #91).
//
// #91's fifth acceptance criterion asks for one E2E spec per module driving the primary write path.
// M17's `screens.ts` opens "#91 — VISITS CAN BE SCHEDULED NOW", and that is the claim under test: a
// scheduled visit is what a clinician is dispatched against, what M18 brackets with EVV, and what M8
// hangs an encounter off, so a scheduling surface that cannot create one is the top of a dead chain.
//
// IT WAS NOT TRUE ON A SEEDED STACK, and the reason had moved (F-079). `db:seed:scenario-field-ops`
// created its one visit by INSERTING THE ROW DIRECTLY, under a header that read "GENUINE GAP, confirmed
// by reading the code, not assumed: `POST /api/v1/visits` is unconditionally unreachable in production"
// because `SchedulingAbacResolver` hard-coded `credentialsActiveForPurpose`→false and three siblings.
// That was accurate when written. GAP-093 and GAP-031 later replaced all four with real reads — role
// grants, org settings, and the boot-registered `CaseloadProvider` / `CredentialReader` seams — and
// nobody returned to the workaround, so the note outlived its subject and the route stayed unexercised.
//
// One cause did remain, and it was not in the platform: `membership_credential` was EMPTY on every
// seeded stack. `clinician_credentials_active` resolves the assignee's disciplines from their role
// grants, intersects them with the visit purpose's required set, and asks M17's `CredentialReader` seam
// for an ACTIVE credential in one of them — so with no licences issued it correctly refused every
// assignee. `seed-staff-personas.ts` now issues one per licensable discipline, and the field-ops seed
// schedules through the real route, because a DB-seeded row proves nothing about whether a clinician
// could have booked it.
//
// A ROLE KEY IS NOT A LICENCE, and the seed keeps them apart: only the nine `credential_discipline`
// values get a credential. `rn_case_manager`, `hospice_physician` and `clinical_supervisor` are
// authority grants — issuing licences for them would assert credentials no board awards, and would
// quietly widen a gate whose whole job is to know the difference (a clinician can hold the `rn` ROLE
// while the nursing LICENCE has lapsed, which is exactly what this predicate exists to catch).
//
// SIGNS IN AS THE ADMINISTRATOR, and that is a FINDING rather than a preference. The assignee picker is
// filled from `GET /api/v1/orgs/:id/members`, which requires `member.manage` — a tenant-ADMINISTRATION
// permission. No clinical role holds it: the RN case manager 401/403s on that read, and so does the
// clinical supervisor. For both of them the "Assign to" select renders with only its "Select a
// clinician…" placeholder and the Schedule button stays permanently disabled, with nothing on screen
// saying why — the roster simply looks empty, which is indistinguishable from an agency with no staff.
// So in practice only an org administrator can schedule a visit, while the people who actually build a
// schedule cannot. Recorded in `screens.ts`; not fixed here, because the fix is a decision about which
// permission should back a roster read, not a bug with one obvious answer.
//
// THIS SPEC BRINGS ITS OWN SUBJECT: it schedules the visit it then finds, on TODAY's date, so it neither
// consumes the seeded visit (which is tomorrow's) nor depends on it. It is NOT re-runnable against the
// same database, and the reason is a second finding rather than a limitation of the spec: `visit` carries
// a per-clinician no-overlap EXCLUSION constraint, so booking the same clinician into the same window
// twice is a legitimate conflict — and it currently reaches the caller as **HTTP 500 "An unexpected error
// occurred"**. Postgres reports it as `23P01` on `visit_<YYYY_MM>_no_overlap`, and
// `classifyDatabaseError` (the F-022 registry built for exactly this) recognises only `23505`, so the
// mapping to a 409 never happens. A double-booking is the single most ordinary thing a scheduler does
// wrong; it should say so. Not fixed here because it needs a decision the registry does not yet make:
// the constraint lives on a PARTITIONED table, so its name carries a partition suffix, and the registry
// is exact-match by design ("a name is not a specification"). CI reseeds before the suite; locally,
// re-run `bun run db:seed:scenario-field-ops` — or expect the 500 on a second pass.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

const PATIENT_LAST_NAME = "Whitfield";

/** `YYYY-MM-DDTHH:mm`, the shape the modal's free-text Starts/Ends fields are parsed from. */
function todayAt(hhmm: string): string {
  return `${new Date().toISOString().slice(0, 10)}T${hhmm}`;
}

test.describe("Scheduling", () => {
  test("main path: a visit is scheduled from the day view and appears on that day", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/scheduling/day");
    await expect(page.getByRole("heading", { name: "Day View" })).toBeVisible({ timeout: 15_000 });

    // A day view has no patient context, so scheduling starts by finding one — and choosing them is
    // what resolves the open admission and the addresses the create needs.
    await page.getByLabel("Schedule a visit — find a patient").fill(PATIENT_LAST_NAME);
    await page.getByRole("button", { name: "Search" }).click();
    const hit = page.getByRole("button", { name: new RegExp(PATIENT_LAST_NAME, "i") }).first();
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await hit.click();

    const dialog = page.getByRole("dialog", { name: "Schedule a visit" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // Telephonic rather than a home visit: the demo patient has no recorded address, and the modal says
    // so rather than offering an address picker with nothing in it. The setting is the honest choice,
    // not a workaround — a telephonic visit is a real hospice visit setting.
    await dialog.getByLabel("Purpose").selectOption("routine_visit");
    await dialog.getByLabel("Setting").selectOption("telephonic");

    // The assignee picker offers the org's ACTIVE ROSTER, not an eligibility list — the §4.7 D8
    // pre-schedule gate is the server's, and filtering here would be a second implementation of it.
    // So the spec picks the RN and lets the server decide, which is the whole point of the gate.
    const assignee = dialog.getByLabel("Assign to");
    await expect(assignee).toBeVisible();
    const rnOption = dialog.locator("option", { hasText: /Rita/i }).first();
    await expect(rnOption).toHaveCount(1);
    await assignee.selectOption({ label: await rnOption.innerText() });

    await dialog.getByLabel("Starts").fill(todayAt("14:00"));
    await dialog.getByLabel("Ends").fill(todayAt("15:00"));

    const schedule = dialog.getByRole("button", { name: "Schedule", exact: true });
    await expect(schedule).toBeEnabled();
    await schedule.click();

    // The dialog closes only on a committed write. Before F-079 this is exactly where it failed, on a
    // 403 from `clinician_credentials_active` — the assignee held the RN role and no RN licence.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // And the round trip: the visit is on the day the scheduler was looking at. Asserting the DAY VIEW
    // rather than the POST is what makes this about the schedule a clinician will actually be dispatched
    // from — a create filed against the wrong service date would pass a status-code assertion.
    await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });
    await expect(
      page
        .getByRole("table")
        .getByText(/Routine/i)
        .first(),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  test("the day view is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/scheduling/day");
    await expect(page.getByRole("heading", { name: "Day View" })).toBeVisible({ timeout: 15_000 });
    await expectNoAxeViolations(page);
  });
});
