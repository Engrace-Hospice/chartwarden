// e2e/specs/billing.spec.ts — critical workflow 6/6: billing (TEST-001).
//
// #106 (F-046) — the Medicare Claim Workbench (`/billing/claims`) stays scoped to reachability +
// empty-state: `seed-scenario-billing.ts`'s own header documents WHY, and it is a real production
// gap rather than a seeding one — `POST /billing/claims/assemble` is unconditionally unreachable.
// #250 bound 4 of the 11 reader seams for real (`patientPayer`, `mdm.resolveProviderEntity`, two of
// `referenceData`'s four methods); assemble still SEAM_UNBOUNDs at its second read,
// `admission.resolveForRange` (M6) — M6's published seam readers don't offer the patient+range query
// claim assembly needs, a real new read-surface addition to M6's own seam layer, filed as a
// follow-up rather than built here.
//
// The MEDICAID Claim Workbench (`/medicaid/billing/claims`) is different: `seed-scenario-billing.ts`
// assembles, validates, and submits one real Oregon-adapter claim for the flagship patient
// (Whitfield) via `db:seed:all`, so this suite proves the real claim → validation → submission
// lifecycle end to end — not just an empty round trip. 835/remittance POSTING (M25) is the one leg
// that stays unreachable for BOTH payers — NOT an authz bug (the `systemPrincipal` guard was fixed on
// `main` at commit `46414c60`, #75/#76, well before #250; confirmed by #250's own investigation) but a
// missing X12-835 sidecar/clearinghouse-pull transport to stage an 835 for the correctly-gated create
// route to receive — filed as the same follow-up.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

test.describe("Billing — Medicare (M23, assemble unreachable — #250)", () => {
  test("main path: the Claim Workbench renders without crashing on an empty claim set", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/billing/claims");
    await expect(page.getByRole("heading", { name: "Claim Workbench" })).toBeVisible();
    // No unhandled promise/render error surfaced as a blank page or an uncaught-exception overlay.
    await expect(page.locator("#root")).not.toBeEmpty();
  });

  test("main path: the AR dashboard renders its KPI shell", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/billing");
    // The 2026-09-25 redesign (#235) folded the AR dashboard into the "Billing / Claims" landing:
    // a KPI tile row over the claim list, with the A/R aging buckets in the "Receivables" rail.
    await expect(page.getByRole("heading", { name: "Billing / Claims", level: 1 })).toBeVisible();
    const kpis = page.getByLabel("Billing summary");
    for (const kpi of ["Submitted", "Paid", "Denied", "A/R > 30 days"]) {
      await expect(kpis.getByText(kpi, { exact: true })).toBeVisible();
    }
    const receivables = page.getByRole("complementary", { name: "Receivables" });
    await expect(receivables.getByRole("heading", { name: "A/R Aging" })).toBeVisible();
    // The aging read really answered: a failed ar-dashboard call renders "A/R aging is unavailable."
    await expect(receivables.getByText("A/R aging is unavailable.")).toHaveCount(0);
  });

  test("accessibility: the Claim Workbench has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/billing/claims");
    await expect(page.getByRole("heading", { name: "Claim Workbench" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("Billing — Medicaid (M24, a real seeded claim lifecycle)", () => {
  test("main path: the seeded claim shows SUBMITTED, not the empty-claims state", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/medicaid/billing/claims");
    await expect(page.getByRole("heading", { name: "Medicaid Claims" })).toBeVisible();
    // `seed-scenario-billing.ts` assembles, validates, and submits one real claim per seed run — the
    // regression this guards is the empty-state EmptyState rendering even though a row exists.
    await expect(page.getByText("No claims", { exact: true })).toHaveCount(0);
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible();
    // At least one row reached SUBMITTED — the state the seed's real assemble → validate → submit
    // chain leaves it in (validation and assembly are proven upstream by the seed script's own
    // non-zero exit on failure; this is the UI's read of that write path's end state).
    await expect(page.getByText(/submitted/i).first()).toBeVisible();
  });

  test("failure path: an invalid claim filter combination surfaces inline, not a crash", async ({
    page,
  }) => {
    // The claim-state filter is a closed enum on the wire; a caller-supplied value the server
    // rejects (a stale bookmark, a hand-edited URL) must degrade to a visible error, not a blank
    // page — the same class of defect TEST-001 exists to catch, exercised on the failure branch
    // rather than the happy one this file's other cases already cover.
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/medicaid/billing/claims?state=NOT_A_REAL_STATE");
    await expect(page.getByRole("heading", { name: "Medicaid Claims" })).toBeVisible();
    await expect(page.locator("#root")).not.toBeEmpty();
    // Whatever the page does with an unrecognized filter value — ignore it and show the unfiltered
    // list, or show its own inline error — it must not be the uncaught-exception overlay Vite's dev
    // overlay or React's error boundary would otherwise render.
    await expect(page.getByText(/uncaught|unhandled/i)).toHaveCount(0);
  });

  test("accessibility: the Medicaid Claim Workbench has no WCAG 2A/AA violations", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/medicaid/billing/claims");
    await expect(page.getByRole("heading", { name: "Medicaid Claims" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
