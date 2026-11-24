# M24-1075-L7 — Medicaid ERA Operator Workflow Qualification

Date: 2026-11-24  
Branch: `audit/m24-1075-oregon-eocco-readiness-r2`  
Starting HEAD: `8f447f3cdae4c9355992a110b5d73419708096ec`  
PR: [#1115](https://github.com/Engrace-Hospice/chartwarden/pull/1115), Draft

## Implemented workflow

The M25 screen registry and Billing → Revenue Cycle navigation now include a cursor-paginated
`Medicaid ERA reviews` worklist at `/remittance/medicaid-era-reviews` and a deep-linked investigation
workspace at `/remittance/medicaid-era-reviews/:id`. The existing Claim.MD ERA screen remains the
source-artifact entry point and now has a permission-gated `Evaluate for Medicaid` action for the
selected staged artifact. The operator never enters an artifact identifier or uploads an ERA here.

The worklist shows workflow status separately from assessment outcome, evaluator trust, source
environment, matching and duplicate status. It uses only the API's `limit`/`cursor` contract, makes no
total-count or complete-search claim, and provides an empty state that links back to the Claim.MD
source screen. Its small in-memory cache contains only the current scoped list projection and is
discarded when organization, user, provider scope or permissions change.

The detail workspace presents assessment reasons, claim observations, source/evidence limitations,
controlled investigation reasons, allowed nonposting dispositions, and the assessment/investigation
timeline. A runtime allowlist parser rejects malformed or unsupported summaries. It requires complete
claim/submission identity before creating a claim link, keeps absent amounts unavailable, and does
not repeat the transaction-level payment total under every claim. Displayed amounts remain reported
835 observations; no ledger balance, allowed amount, allocation, or posted total is inferred. Legacy
assessment identity and summary remain redacted. Source environment is explicitly described as
provenance, not payer enrollment or production authorization.

## API and authorization

The existing list, detail, history, evaluation, notes, and disposition contracts are reused. One
server-owned operation was added: `POST /api/v1/remittance/medicaid-era-reviews/:id/reassess`. It
accepts an authorized review ID and idempotency key, resolves the staged reference only from an
evaluator-attested scoped review row, and then reuses the existing evaluator service. The artifact
reference is not returned to the client. Legacy, incomplete, or unavailable source identity returns
a typed hold. OpenAPI and the generated client include the operation.

| Operation | Required permission |
|---|---|
| List | `remittance.read` |
| Detail | `remittance.read` and `remittance.financial_review` |
| History | `remittance.read` |
| Evaluate a selected staged artifact | `remittance.match_review` |
| Reassess | `remittance.match_review` |
| Record a reason or disposition | `remittance.financial_review` |

Mutations use the shared `useAttemptKey` idempotency keeper; reason and disposition writes send the
server's current `expectedVersion`. A stale response reloads authoritative state without optimistic
financial or trust-state changes. Completing review is explicitly labeled `Reviewed — not posted`
and confirmed with nonposting wording.

## Accessibility and visual inspection

The page reuses ChartWarden `PageHeader`, `WorkQueueLayout`, `StatusPill`, shared Billing navigation,
and design tokens. Responsive styling keeps the review hierarchy and actions visible. Desktop and
375px narrow layouts were visually inspected. Sections use semantic headings and description lists; controls have labels, buttons
have text names, status is not color-only, focus remains visible, and reduced-motion styling is
included.

A source-mounted Playwright pass used synthetic API responses and no production or live backend.
Screenshots were captured locally at `/tmp/m24-l7-worklist.png`,
`/tmp/m24-l7-detail.png`, and `/tmp/m24-l7-detail-mobile.png` (not committed). axe reported zero
violations on the worklist, desktop detail, and 375px mobile detail. The first keyboard Tab landed on
the labeled Refresh button; no browser runtime errors occurred. This is a visual/UI check, not a
live API or database integration test.

## Verification

The final targeted results are recorded below; no database schema or migration changed, so L7 did
not rerun PostgreSQL/RLS suites.

- `bunx vitest run apps/web/src/modules/25-remittance/medicaid-era-reviews.dom.test.tsx apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx apps/web/src/shell/billing-tabs.dom.test.tsx apps/backend/src/modules/25-remittance/routes/__tests__/medicaid-era-review.routes.test.ts` — **4 files, 93 tests passed, 0 failed, 0 skipped**.
- `bunx tsc -b packages/ui apps/web --pretty false` — targeted UI project-reference typecheck passed.
- Changed-file `bunx biome check ...` and `git diff --check` — passed.
- `bun run openapi:check` and `bun run client:check` — generated API/client contracts current.
- `bun run docs:ui` and `bun run arch:module-docs` — passed.
- `bun run arch:compliance` — passed. CW-AC-01 already contains migration 1548 and the L6D live-suite file evidence; no control claim was changed for this UI lot.
- `bun run harness:phi-scan <changed paths>` — passed for 19 files.
- Local Gitleaks executable was unavailable.

No L7 live PostgreSQL suite was run because the only backend addition is a route over the existing
service and persistence: no schema, database authorization, or writer boundary changed. The focused
route test verifies permission denial and server-resolved reassessment behavior with a stub service;
it does not claim a new real-database integration result. The L6D API-to-evaluator and PostgreSQL
qualification remains the prior, separately documented evidence.

## Limits and remaining work

F09 remains open. L7 adds an operator UI and safe investigation actions, but there is still no
authenticated production Medicaid 835 delivery path, verified EOCCO enrollment, real qualified M24
submission provenance, payer-certified route, supported Stedi JSON-to-observation mapper, or
authorized financial posting/claim-state workflow. The list contract currently has no filters or
total count. Provider and payer display names are unavailable in the current API projection and are
not fabricated. No customer or vendor activation is implied.

Full monorepo tests/typecheck/lint, full `arch:fitness`, full dependency-cruiser, all PostgreSQL live
suites, immutable release-image qualification, production Compose qualification, and exhaustive
historical PR review are deferred to `M24-1075-L7-V`. This report does not assert merge or production
readiness.

## Safety

No vendor or payer request, live ERA retrieval, payment posting, financial ledger mutation, financial
claim-state transition, financial outbox event, production migration, deployment, or merge occurred.
No synthetic record was promoted to production evidence; Medicaid electronic submission remains
disabled.
