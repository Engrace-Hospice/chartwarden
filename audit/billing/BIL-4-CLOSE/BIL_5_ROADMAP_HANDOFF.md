# BIL-5 roadmap handoff

## Verified roadmap

The authoritative roadmap is [`docs/billing/BIL-0/IMPLEMENTATION_ROADMAP.md`](../../../docs/billing/BIL-0/IMPLEMENTATION_ROADMAP.md). It still names **BIL-5 — Tenant UX and Operations**. Its objective includes entity/location selection, operational rejected/denied/in-doubt/paid/partial states, ERA and unmatched worklists, A/R visibility, safe administrative portal actions, account budget/lag dashboards, and disaster-recovery/cursor-replay runbooks. Acceptance requires resolving quarantined and in-doubt items without cross-tenant raw access, plus staged rollout, reconciliation, and rollback rehearsal.

## Existing components to reuse

- The tenant/provider-scoped ERA inbox and detail page are in [`claimmd-era-review.tsx`](../../../apps/web/src/modules/25-remittance/claimmd-era-review.tsx), registered through the existing M25 screen registry.
- The API list/detail, processing history, match review, financial review, posting plan, approval, and execution routes are registered in [`claimmd-era-review.routes.ts`](../../../apps/backend/src/modules/25-remittance/routes/claimmd-era-review.routes.ts). Their TypeBox query/response contracts are in [`claimmd-era-review.schemas.ts`](../../../apps/backend/src/modules/25-remittance/routes/claimmd-era-review.schemas.ts).
- The list already accepts a provider-entity filter, status, payer, date range, cursor, and bounded limit; service scope is derived from the authenticated actor. The UI can reuse these contracts rather than create an account-wide inbox.
- M25 supplies safe review, matching and processing-history projections. Existing M23/M41 source-owner readers and links preserve claim provenance. The current financial assessment and blocker projection also exposes partial-payment, CAS, PLB and duplicate outcomes without authorizing their unsupported accounting effects.

## Permissions and action boundaries

The routes use `remittance.read` for tenant-scoped list/detail/history/matching reads, `remittance.match_review` for match decisions, and `remittance.financial_review` for nonposting financial review and plan generation. Approval and execution use distinct `remittance.posting.approve` and `remittance.posting.execute` permissions; execution also requires step-up. These permission checks are explicit in the route module. Financial review completion and plan generation do not themselves post money. Medicare posting has the server-side `MEDICARE_POSTING_NOT_CERTIFIED` blocker; controlled Claim.MD posting remains disabled by default and production startup rejects enabling it.

Safe initial worklist actions are scoped list/filter/page, open details/history, inspect matching and financial blockers, navigate to an authorized claim, and submit existing audited nonposting review decisions when permitted. Do not expose central account-wide inbox data to tenant users. Do not add replay/recovery, reassignment, posting, write-off, patient billing, reversal, refund, PLB recovery, or bank-settlement actions to the first lot. Existing platform recovery remains separately authorized and should only be surfaced after its operator controls and audit behavior are verified.

## Recommended first implementation lot

**BIL-5.1 — Tenant-Scoped ERA Operations Worklist & Entity/Location UX** should provide a single tenant-scoped operational queue with an explicit provider-entity/location context, status and exception filters, clear in-doubt/quarantine explanations, reliable pagination, and navigation into the existing M25 review surface. Include only read/review actions already authorized by the server. Do not make new accounting operations prerequisites for this worklist and do not enable live vendor traffic.

Tests should cover entity/location filtering under server-derived tenant scope, provider/tenant isolation with real application-role RLS, cursor/filter stability, status labels for held/in-doubt/duplicate items, authorized M23/M41 navigation, permission-restricted actions, loading/error/empty states, accessibility, and proof that worklist/review reads do not create financial effects. Reuse the existing private M25 PostgreSQL runner and focused frontend DOM harness; no live Claim.MD or MAC request is needed.

BIL-1–BIL-4 provide capture/staging, ownership evidence, M25 matching/review, narrow M41 financial posting, and M23 Medicare nonposting review. Remaining full BIL-5 operational UX, account-level observability, and DR/replay runbooks are not complete. External Claim.MD/MAC enrollment and route evidence remain activation dependencies, not blockers to implementing this local read-only worklist. Do not start BIL-5.1 automatically.
