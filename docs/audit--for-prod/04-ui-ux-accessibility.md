# 04 — UI/UX and accessibility

The repository has a coherent token/shell/list-chrome approach and extensive registered screens,
but no completed audit-run browser session. Therefore visual consistency, focus behavior, contrast,
zoom, responsive layout, browser console/network behavior, and screenshots are **BLOCKED**, not
passed.

## Evidence-backed risks

- Medicare users can enter the entire claim request before learning that the patient is payer-
  incompatible; the existing payer endpoint makes earlier feedback feasible (`CW-QA-0007`).
- Biome reports 23 `useSemanticElements` errors and other accessibility diagnostics, but each must
  be adjudicated; the aggregate is included in `CW-QA-0003` rather than misreported as 23 confirmed
  user-facing failures.
- The axe route walker intentionally excludes dynamic routes, admin, portal, pre-auth surfaces, and
  every manual WCAG dimension. Those exclusions are documented in the test itself (`CW-QA-0008`).
- Required viewport runs (1920×1080, 1440×900, 1366×768, 1024×768, 768×1024, 390×844) were not
  performed because the isolated full stack was unavailable.

## Workflow usability

Static review found task-centered modules but broad navigation dispersion in billing: claim entry,
NOE, NOTR, DDE, eligibility, rate tables, overrides, credentials, and remittance are separate
screens. A unified patient/claim workspace should be evaluated after correctness fixes, retaining
deep links and role-scoped actions. The audit did not fabricate click counts without a runnable
browser session.

## Required completion evidence

Keyboard-only and screen-reader protocols on admission, signing/addendum, HOPE, claim assembly,
payment posting, and destructive/step-up dialogs; six viewport screenshots; focus trapping/return;
announced validation; table semantics; 200%/400% zoom; reduced motion; touch targets; and browser
console/network capture.
