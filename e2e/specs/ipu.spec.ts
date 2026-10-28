// e2e/specs/ipu.spec.ts — critical workflow: move an inpatient admission into a bed (F-080, #91).
//
// #91's fifth acceptance criterion asks for one E2E spec per module driving the primary write path.
// M37's is the §2.2 admission lifecycle as far as a browser can drive it: `pending -> bed_pending ->
// bed_assigned`. The last step, to `active`, is M6's level-of-care-period acknowledgement (GAP-106), not
// an RN action, so the spec ends at the read-only "Awaiting M6 LCP acknowledgement" status. An IPU
// admission that cannot move is an admission that never happened — the bed is not reserved, the census
// does not count the patient, and M23 generates no per-diem line for the stay.
//
// IT COULD NOT RUN AT ALL BEFORE THE FIX, AND NOT BECAUSE OF THE SEED.
//
// `requestBed` refuses a unit whose RN coverage is inactive for the current hour (§2.3 D3,
// CoP 418.110(e)), and `openAdmission` refuses a GIP or IRC admission on the same fact. The coverage
// answer is the materialized `ipu_rn_coverage_window`, which F-071/#174 built a cron to produce after
// finding that NOTHING wrote it. That cron works. What it computes from could not exist:
//
//   §2.3 counts an hour covered only when a CONFIRMED RN assignment spans it. `ipu_staff_assignment`
//   .state defaults to `tentative`; `POST /ipu-shifts/:id/staff` never set it, no route confirmed one,
//   and `grep` found ZERO writes of `'confirmed'` anywhere in the module. So every assignment any
//   deployment could make covered nothing, the watchdog dutifully materialized 216 rows per unit all
//   reading `is_covered = false`, and every GIP and inpatient-respite admission stayed refused at open —
//   the exact outage the watchdog was built to end, one layer further in.
//
// `POST /ipu-shifts/:id/staff/confirm` is that missing producer. The seed now staffs the unit through it
// and runs the real watchdog function directly (crons are constructed only when `DATABASE_PLATFORM_URL`
// is set, which no local or e2e stack sets), which is why the unit this spec requests a bed on answers
// covered.
//
// `m37-rn-coverage.live.test.ts` was green throughout, because every one of its coverage tests inserted
// `state='confirmed'` with raw SQL — the one value the product could not produce. Its new last test
// takes the same route through the service alone. Running it also showed the suite had been RED since
// the day it was written: six units created on one facility id against a UNIQUE(org, facility) index
// that predates the file, and an expiry `UPDATE` that violates a CHECK constraint. CI has never
// executed it (`arch:live-suites` proves a suite is WIRED to a job, not that the job is green).
//
// WHAT THIS SPEC DELIBERATELY DOES NOT DRIVE: the CoP 418.108 GIP criterion attestation. It is
// step-up gated (§D14), and no browser can satisfy that today — the `/step-up` screen is built and the
// verify routes are mounted (F-029), but the factor they require can never be enrolled: the web app
// ships a passkey-enrolment screen and NO TOTP-enrolment surface, and no seeded persona has either.
// So the criterion is attested in the seed, by the physician, at admission — which is where CoP 418.108
// puts it anyway ("documented at admission with hospice MD attestation") — so the criterion already
// exists when M6's acknowledgement later activates the admission, exactly as a real one would. The
// same gate is what keeps M8 encounter signing and M14 IDG adjourn out of this suite.
//
// THIS SPEC CONSUMES ITS SEED, like `orders.spec.ts` and `evv.spec.ts`: it moves the one seeded GIP
// admission to `bed_assigned`, so a second run finds no `pending` row and fails at the first assertion
// rather than passing vacuously. CI reseeds before the suite; locally re-run `bun run db:seed:scenario-remaining`
// between runs. It is not made self-supplying because opening an IPU admission needs an M6 level-of-care
// period in `assigning`, which is a whole admission lifecycle upstream of this screen.
//
// Signs in as the RN: every route this drives is gated on a `clinical`-category key
// (`m37.bed.assign`, `m37.ipu_admission.create`), and the unit/room/bed reads the modals' pickers need
// are `clinical` too. Rita holds them; so would the admin, but the RN is who does this at 2am.
import { expect, test } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

/** The seeded unit `db:seed:scenario-remaining` creates on the `kind='ipu'` Facility. */
const UNIT_NAME = "Engrace Inpatient Unit";

test.describe("IPU", () => {
  test("main path: an RN requests a bed, assigns it, and the admission awaits M6's acknowledgement", async ({
    page,
  }) => {
    await signInAs(page, RN_ACCOUNT());
    await page.goto("/ipu/admissions");
    await expect(page.getByRole("heading", { name: "IPU admissions" })).toBeVisible({
      timeout: 15_000,
    });

    // The GIP row, at `pending`. Plain `<tr>`s here — no `role="button"` — so `getByRole("row")` is the
    // right locator (the interactive-row trap F-023 documents applies to the HOPE/EVV tables, not this
    // one). Matching on BOTH the level and the state: the arranged (CoP 418.112) admission the same seed
    // opens is also `pending`, and it has no unit, so requesting a bed for it is a different scenario.
    const gipRow = page
      .getByRole("row")
      .filter({ hasText: "GIP" })
      .filter({ hasText: "Pending" })
      .first();
    await expect(gipRow).toBeVisible({ timeout: 15_000 });

    // ── 1. Request a bed ───────────────────────────────────────────────────────────────────────────
    //
    // This is the assertion the whole fix is under. Before it, the server answered 412
    // IPU_RN_COVERAGE_UNAVAILABLE here for every unit on every deployment, and the dialog stayed open
    // carrying that message — there was no arrangement of seed data that made it pass.
    await gipRow.getByRole("button", { name: "Request bed" }).click();
    const requestDialog = page.getByRole("dialog", { name: "Request a bed" });
    await expect(requestDialog).toBeVisible();
    await requestDialog.getByLabel(/^Unit/).selectOption({ label: UNIT_NAME });
    await requestDialog.getByRole("button", { name: "Send bed request" }).click();
    await expect(requestDialog).toBeHidden({ timeout: 15_000 });

    // The state column is the round trip: the server re-read the row and it moved. Asserting the pill
    // rather than the POST's status code makes this a statement about the record, not about the call.
    const bedPendingRow = page.getByRole("row").filter({ hasText: "Bed pending" }).first();
    await expect(bedPendingRow).toBeVisible({ timeout: 15_000 });

    // ── 2. Assign a specific bed ───────────────────────────────────────────────────────────────────
    await bedPendingRow.getByRole("button", { name: "Assign bed" }).click();
    const assignDialog = page.getByRole("dialog", { name: "Assign a bed" });
    await expect(assignDialog).toBeVisible();
    // `/^Unit/`, not `"Unit"`: `FieldFrame` renders a `<label>` that WRAPS its control as well as
    // carrying `htmlFor`, so the label's text is its own caption plus every one of the select's option
    // labels — and the Bed picker's placeholder is "Choose a unit first", which a substring match on
    // "Unit" therefore also hits. Anchoring at the start of the caption is what separates the two.
    await assignDialog.getByLabel(/^Unit/).selectOption({ label: UNIT_NAME });
    // The bed picker loads rooms-then-beds off the chosen unit; the label carries the cleaning status,
    // because a bed that is not `ready` is listed and refused rather than hidden.
    const bedSelect = assignDialog.getByLabel(/^Bed/);
    await expect(bedSelect.locator("option", { hasText: "101-A" })).toBeAttached({
      timeout: 15_000,
    });
    await bedSelect.selectOption({ label: "101-A — ready" });
    await assignDialog.getByRole("button", { name: "Confirm bed assignment" }).click();
    await expect(assignDialog).toBeHidden({ timeout: 15_000 });

    const bedAssignedRow = page.getByRole("row").filter({ hasText: "Bed assigned" }).first();
    await expect(bedAssignedRow).toBeVisible({ timeout: 15_000 });

    // ── 3. Confirm is not the RN's to do ───────────────────────────────────────────────────────────
    //
    // GAP-106 (#321): `POST /ipu-admissions/:id/confirm` is system-internal (always 403 for a tenant
    // session) — M6's level-of-care-period acknowledgement activates the admission, not a browser. So a
    // bed-assigned row offers a read-only status in place of a Confirm button, and this is as far as a
    // browser can take the stay. Asserting both halves keeps a Confirm button from quietly returning as
    // a dead control that 403s.
    await expect(bedAssignedRow.getByText("Awaiting M6 LCP acknowledgement")).toBeVisible();
    await expect(bedAssignedRow.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(
      0,
    );
  });

  test("the IPU admissions worklist is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    await page.goto("/ipu/admissions");
    await expect(page.getByRole("heading", { name: "IPU admissions" })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAxeViolations(page);
  });
});
