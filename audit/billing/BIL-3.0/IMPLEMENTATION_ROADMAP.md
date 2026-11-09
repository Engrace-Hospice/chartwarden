# BIL-3 Roadmap

## BIL-3.0 — M25 Financial Flow Baseline & Nonposting ERA Review — current

Completed for the safe review slice: inspect legacy and Claim.MD paths; use existing ownership-verified encrypted staging; expose aggregate/list and detail reads; register tenant/provider-scoped nonposting review UI; retain identity outcomes and adjustment summaries. No new tables or migrations.

## BIL-3.1 — Durable Review History & Staging Operations

- **Objective:** Make every reviewer-visible state transition explainable and durable.
- **Reuse:** `claimmd_era_m25_stage`, central delivery receipt/history, BIL-1 recovery and existing M25 read-audit patterns.
- **Backend/API:** Design a tenant-safe history projection linked only through a verified stage; add authorized read for delivery/ownership/recovery milestones; do not expose inbox payload or central account data. Add safe retry/recovery action only if permitted by platform-ops authorization, never tenant reassignment.
- **Frontend:** Show staged/held/dedup state and available safe processing history; explicit no-match/no-post boundary.
- **Data/permissions:** Prefer existing history; additive schema only if an event needed for audit is not already durable. Tenant reads require `remittance.read`; platform recovery remains separate.
- **Tests:** Org/provider RLS with real role, history ownership, no central payload, no posting, retry idempotence.
- **Acceptance:** Reviewer can tell why an item is held and what processing occurred, without gaining any mutation privilege.
- **External blockers:** Private PostgreSQL and recovery runtime certification remain outstanding.

## BIL-3.2 — Claim/Line Matching & Exception Resolution

- **Objective:** Persist deterministic claim-level and service-line financial associations with evidence.
- **Reuse:** Existing BIL-1 submission facts, parser output, M25 manual-match authorization/step-up/idempotency patterns and current tenant stage.
- **Backend/API:** Build candidate resolution scoped by org/provider/payer and immutable submitted identity; classify verified, ambiguous, unmatched, identity mismatch, duplicate, unsupported adjustment. Manual resolve only through authorized audited command and optimistic concurrency.
- **Frontend:** Exception queue and explicit evidence/reason display; link to internally authorized claim.
- **Data:** Add only the smallest association/history schema after proving current tables cannot store the evidence safely.
- **Tests:** Reused PCN, multiple submissions/claims/lines, cross-provider/TIN collisions, duplicate sources, concurrency, RLS.
- **Acceptance:** No ambiguous or cross-tenant automatic match; every manual decision is attributable and replay-safe.
- **External blockers:** Payer-specific references and complete source lineage where unavailable.

## BIL-3.3 — Financial Review Workspace

- **Objective:** Present complete payment/adjustment and exception context before authorization.
- **Reuse:** M25 advice/line read services, CARC/RARC terminology, PR ledger readers, Claim.MD review screen.
- **Backend/API:** Add read projections for CAS/CARC/RARC and PLB, claim/provider/tenant totals, reversals and source history without performing writes.
- **Frontend:** Reviewer workbench with claim/line drilldown, provider adjustments, exception explanation and review history.
- **Tests:** Decimal/cent agreement, PLB conservation, multi-claim/set, denial, zero-pay, partial-pay, reversal, protected fields.
- **Acceptance:** Review explains the source and proposed consequences; no review action posts money.
- **External blockers:** Banking/EFT reassociation evidence and payer-specific adjustment semantics.

## BIL-3.4 — Controlled Posting & Accounting Integrity

- **Objective:** Add explicit, authorized posting only after review and matching gates pass.
- **Reuse:** Existing M25 posting domain, exact financial identity guard, transaction/outbox/idempotency architecture and M23/M26 event contracts.
- **Backend/API:** Separate review approval from posting authority; atomically persist ledger effects, balance updates, audit and outbox. Support reversal/recoupment with append-only history and non-overlapping retry semantics.
- **Frontend:** Permission-aware posting confirmation, dual-approval if required by policy, and clear in-doubt recovery.
- **Data/security:** Add constraints only where tests show existing schema cannot guarantee one effect per verified identity.
- **Tests:** Private PostgreSQL concurrent posts, crash after commit, retry, cross-source duplicate, distinct partial/secondary payments, reversal and outbox atomicity.
- **Acceptance:** One consequential effect per authorized logical posting identity; unknown identity remains held.
- **External blockers:** Formal accounting policy/approvals, EFT/bank reconciliation agreement and independent security review.

## BIL-3.5 — Integrated Validation & Development Completion

- **Objective:** Validate the complete synthetic path from capture through authorized posting.
- **Reuse:** BIL-1 worker harness, M25 posting tests and new BIL-3 test fixtures.
- **Tests:** Two-tenant PostgreSQL/RLS, independent workers/fencing, mocked vendor ingress, full multiple-ST/multiple-claim scenarios, ledger assertions and rollback/recovery.
- **Acceptance:** Exact candidate commit has cumulative evidence and activation/rollback plan. Development completion does not authorize production activation.
- **External blockers:** Approved Claim.MD test account/fixtures, payer routes and controlled activation approval.
