# ADR-0100 — Commercial hospice billing is its own module (M41), submitting only through the shared `ClearinghouseTransport`; M23 stays Medicare-FFS-only

- **Status:** **Proposed** (2026-10-23). Nothing is built beyond the empty module skeleton. The product owner chose "new module 41 — Billing — Commercial" on 2026-10-23. Every other decision below is proposed and is ratified when the first commercial claim passes the live suite. Billing-domain facts marked UNVERIFIED need a billing-expert review before they are relied on.
- **Date:** 2026-10-23
- **Phase:** post-launch billing work (commercial claim lane); follows the Medicare submission-path decision.
- **Related:** [ADR-0053](ADR-0053-clearinghouse-transport-port.md) (one `ClearinghouseTransport` port; conformance is the definition of done), [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (manifest is the source of truth; one ADR per module), [ADR-0052](ADR-0052-dde-work-queue.md) (Medicare-only DDE queue, unaffected), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (RLS keyed on `app.org_id`). Plan: `docs/audits/billing-e2e/IMPLEMENTATION_PLAN_20261023.md`, Track 6.
- **Amends:** the Module 23 spec decision D15 (Medicare FFS only; its guard is kept, and its "commercial billing out of scope" pointer now names M41) and the Module 25 spec decision D9 ("Commercial Phase 2" starts). These are module specs, so this ADR wins on conflict until they are re-locked.

## Context

Facts read from the repo on 2026-10-23:

- M23 rejects any claim whose primary payer on a service date is not Medicare FFS, with `NON_MEDICARE_PRIMARY_PAYER`, and points to Medicaid (M24) or "commercial billing (out of scope for Phase 1)" (M23 spec D15).
- Commercial exists today only as data: a payer kind in M40 (`packages/db/src/schema/mdm/payers.ts`, table `payer`), the `m25_payer_kind` enum on `remittance_advice`, and patient payer ranking in the M23 claim-assembly seam (a commercial payer at rank 1 makes Medicare not primary). There is no commercial claim, submission, acknowledgment, authorization or eligibility code.
- M25 receives commercial 835s as a discriminator value but has no commercial claim owner and no payer-keyed candidate provider, so a commercial advice yields zero automatic matches and goes to manual review (`25-remittance/ingest/service.ts`; M25 spec D9: "Commercial Phase 2").
- `ClearinghouseTransport` lives in `packages/x12-837-client`, a code path of M23. Any module that imports it or the 837I builder needs `dependsOn` to include 23 (the dependency-cruiser boundary rule enforces this).
- Module ownership is enforced by the manifest. Adding a module is a deliberate architecture change: one ADR, then the manifest (`.ts` and `.cjs` mirror), then `bun run scaffold` (ADR-0005 D5; `docs/DEVELOPMENT.md`).

## Decisions

**D1 — A new module, M41 "Billing — Commercial".** Commercial hospice billing gets its own module with its own tables, routes and UI. M23 is not extended and D15's guard stays true, so a non-Medicare-primary claim is still refused by M23 with a message that now names M41. Rejected: extending M23 (loosens a safety guard and mixes Medicare rules with payer-contract rules); deferring (commercial would stay outside the system).

**D2 — Dependencies: `[1, 23, 40]`.** M1 foundation; M23 for the shared 837I builder and `ClearinghouseTransport` in `x12-837-client`; M40 for the payer master. M41 does **not** import M23's or M40's schemas. Claim facts (coverage, election, diagnoses, visits, charges) come through M23's existing claim-assembly seams and the M40 payer repository, per the cross-module rule (seam or outbox event, never a schema import). M25 gets **no** new `dependsOn` edge: it reads commercial claims through a `CommercialClaimReader` seam in `@chartwarden/types`, mirroring M23's `ClaimSubmissionReader`.

**D3 — Code paths: the two app directories only.** `apps/backend/src/modules/41-billing-commercial` and `apps/web/src/modules/41-billing-commercial`. No package until a second consumer exists (YAGNI). There is no commercial adapter package: submission is the transport, not a per-payer adapter.

**D4 — Submission only through `ClearinghouseTransport`.** M41 calls `submitClaim`, `checkEligibility`, `fetchAcknowledgments` and `fetchClaimStatus` on the platform binding. There is no direct-to-payer channel and no per-payer HTTP client. An unbound transport answers `CH_NOT_WIRED` and nothing is sent.

**D5 — Enrollment gates every send, per payer and per provider entity.** Enrollment is per payer and per provider regardless of vendor (ADR-0053 D8). M41 records it in `commercial_payer_enrollment` and refuses to enqueue a submission for a payer the active clearinghouse does not route or for a provider entity that is not enrolled. The refusal is a stable code and a user-facing message; no queue job is created. There is no fallback to another clearinghouse.

**D6 — Hospice claim shape is payer-contract driven.** The claim is an 837I with payer-specific edit rules, a claim filing indicator and the payer id the chosen clearinghouse routes on, held in `commercial_payer_plan`. Pre-authorization is a first-class check (`commercial_authorization`). Revenue codes, level-of-care mapping and per-diem or contract rates vary by payer contract and are not assumed to match Medicare's; contract rate terms are deferred (Open question 2). UNVERIFIED: the exact commercial hospice code set and edits per payer.

**D7 — Coordination of benefits is explicit.** When Medicare or Medicaid is secondary, the commercial claim carries the COB data and M41 does not emit a Medicare claim as primary. UNVERIFIED: which patients have a commercial payer primary for hospice (for example under-65 members) and how Medicare Advantage enrollees are handled (hospice for an MA enrollee is generally paid by the Medicare contractor, not the plan). A billing expert confirms this before D7 is built.

**D8 — Remittance matching is owned by M25, fed by M41.** M41 supplies claim ownership through the `CommercialClaimReader` seam; M25 adds a payer-keyed candidate provider for `payerKind: "commercial"`. Auto-post only when the match is certain, otherwise manual review. A commercial advice for another tenant or payer quarantines and posts nothing. This starts M25 D9's "Commercial Phase 2".

**D9 — Same safety rules as M23.** Idempotency key on every mutating route; validation results with rule id, severity and evidence; hard blocks that cannot be overridden without a policy change; audited overrides with permission, reason and step-up; "submitted", "acknowledged", "adjudicated" and "paid" are distinct states; a duplicate 835 cannot double-post.

**D10 — Delivery order and gates.** (1) This ADR, the spec and the skeleton. (2) Payer and plan model, enrollment and authorization tables. (3) Assembly and validation. (4) Submission through the transport, after the Medicare submission-path decision wires the binding into workers. (5) Eligibility. (6) Remittance matching. (7) UI. Live sending stays disabled until payer enrollment, sandbox testing with synthetic data and a billing review pass.

## Consequences

- `architecture/module-manifest.ts` and `.cjs` gain module 41; `docs/modules/README.md` and `scripts/check-module-docs.ts` move from 40 to 41 modules; `bun run scaffold` creates the two empty directories.
- No tables, migrations, routes or events are added by this ADR. The 12 owned tables listed in the manifest are the proposed set from the spec; each lands with its own migration, RLS and audit trigger, checked by `arch:tenancy` and `arch:migration-numbering`.
- M23's `NON_MEDICARE_PRIMARY_PAYER` message should name M41 when M41 can accept the claim; until then it is unchanged.
- The status matrix and UI parity reports need regenerating when the skeleton lands.
- Two adapters passing the same conformance suite (Track 4 of the plan) is a precondition for relying on the transport as the only submission path; M41 inherits that.

## Open questions

1. Module spec placement of the payer plan versus an M40 extension: M40 owns the `payer` master; M41 owns per-tenant plan, enrollment and authorization. Confirm M40 needs no change.
2. Contract and rate terms (`commercial_contract_rate`): needed for expected-payment calculation, deferred until the first contracted payer is known.
3. Which commercial payers the chosen clearinghouse routes for hospice 837I (depends on the clearinghouse spike, plan Track 4).
4. Billing-expert confirmation of D6 and D7 (UNVERIFIED items above).
5. Whether the web screens extend the M23 work queue or ship as separate M41 screens (UI parity rules apply either way).
