# ChartWarden — Module 41: Billing — Commercial — Specification

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) win on as-built behaviour. Built so far: the payer and plan model (migration 1260, issue #721). Billing-domain facts were reviewed against primary sources on 2026-10-24 (ADR-0100 "Billing facts review"); items that depend on a payer's contract are **confirm-with-payer-contract** configuration, not assumptions in code.

**Version:** 0.1
**Status:** Draft (proposal); ADR-0100 Accepted
**Owner:** Fabrice V. Adjam (ChartWarden)
**Dependencies (manifest):** M1 Foundation, M23 Billing — Medicare (shared 837I builder and `ClearinghouseTransport` in `x12-837-client`), M40 MDM (payer master)
**Decision record:** [ADR-0100](../adr/ADR-0100-commercial-billing-module-41.md); transport contract [ADR-0053](../adr/ADR-0053-clearinghouse-transport-port.md)
**Sibling specs read into context:** M23 v0.2 (D15), M24 v0.2.1 (structure), M25 v0.2 (D9), M40 v0.4

## Changelog
- **0.2 (2026-10-24)** — ADR-0100 ratified; UNVERIFIED claim-shape and COB statements corrected (Medicare Advantage hospice is billed to the MAC, not M41). Payer and plan model built: `commercial_payer_plan`, plus two tables added to the owned set, `commercial_payer_route` (clearinghouse payer id) and `commercial_contract_rate` (rate terms; no longer deferred).
- **0.1 (2026-10-23)** — First draft. Skeleton and decision record only; no tables, routes or events exist.

---

## 1. Purpose & Scope

M41 bills **commercial** payers for hospice care: assemble an institutional claim (837I), validate it against payer rules and
authorization, submit it through the platform clearinghouse, track acknowledgments, and hand claim ownership to M25 so the
835 can be matched and posted.

**In scope.** Commercial payer plans and routing, per-payer enrollment, pre-authorization, eligibility (270/271), claim
assembly and validation with audited overrides, submission, acknowledgments (999 and 277CA, both stages), claim status,
coordination-of-benefits data, and a claim-ownership seam for M25.

**Out of scope.** Medicare FFS (M23; its `NON_MEDICARE_PRIMARY_PAYER` guard stays), Medicaid (M24), direct-to-payer channels (ADR-0100 D4), patient statements and collections.

**Not a promise of coverage.** M41 can submit only for payers the active clearinghouse routes and for provider entities
that are enrolled with that payer. Everything else refuses to send (§4.3).

## 2. Domain Model

### 2.1 Claim lifecycle
`draft → ready → submitted → ack_pending → accepted | rejected → adjudicated → paid | denied`, plus `void` and `replaced`.
"submitted", "accepted" (payer stage), "adjudicated" and "paid" are distinct states (ADR-0100 D9). Clearinghouse-stage
acceptance stamps `clearinghouse_accepted_at` and never advances the claim to accepted (ADR-0053 D2).

### 2.2 Entities
| Entity | Purpose |
|---|---|
| `commercial_payer_plan` | Per-tenant plan for an active commercial M40 payer: claim filing indicator, authorization requirement, effective dating (no overlap per payer and plan name). No PHI. Built |
| `commercial_payer_route` | The payer id a clearinghouse routes a plan on, effective dated, one in effect per plan and clearinghouse. Built |
| `commercial_contract_rate` | Contract rate per level of care: revenue code, basis (per diem, per hour, percent of charges), amount, effective dated. Built |
| `commercial_payer_enrollment` | Per provider entity, per payer, per clearinghouse: `not_enrolled`, `pending`, `enrolled`, `suspended`, with dates and evidence reference |
| `commercial_authorization` | Pre-authorization: number, patient, payer, approved level of care and dates, units, status |
| `commercial_eligibility_check` | A 270/271 exchange: request id, outcome, as-of date, no member id in logs |
| `commercial_claim` | Header: patient, payer plan, billing period, type of bill, COB context, totals, state |
| `commercial_claim_line` | Revenue code, HCPCS, service date, units, charge; PE-scoped |
| `commercial_claim_state_history` | Immutable transition log |
| `commercial_submission` | One logical submission: idempotency key, control number, clearinghouse attempt reference |
| `commercial_acknowledgment` | 999 and 277CA events with stage (`clearinghouse` or `payer`), codes only |
| `commercial_validation_run`, `_result`, `_override` | Rule results with id, severity, policy version, evidence; audited overrides |

All PHI tables carry `organization_id`, `provider_entity_id` and nullable `location_id`; RLS is a single policy on
`app.org_id` (ADR-0010); provider-entity narrowing is ABAC. Children inherit scope from the PE-scoped claim root. Exact
columns are fixed when each migration is written.

### 2.3 Claim shape
837I (005010X223A2), type of bill 081x (082x if hospital-based), default revenue codes 0651/0652/0655/0656. Whether a payer also wants HCPCS site-of-service lines, hourly continuous care, 0657, or other edits is **confirm-with-payer-contract** and is stored in the plan and rate rows; Medicare rules are not assumed. Medicare Advantage enrollees are not billed here: hospice for them goes to the MAC through M23 (ADR-0100 D7). Filing indicators are limited to the commercial set in `@chartwarden/types` (`COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES`).

## 3. Cross-module contracts

| Direction | Contract |
|---|---|
| M41 reads M23 claim facts | Existing M23 claim-assembly seams (coverage, election, diagnoses, visits, charges). No M23 schema import |
| M41 reads payers | M40 payer repository |
| M41 calls the clearinghouse | `ClearinghouseTransport` from `@chartwarden/x12-837-client` via the platform binding |
| M25 reads M41 claims | New `CommercialClaimReader` seam in `@chartwarden/types`, registered at boot and checked by `validateSeams()`. No M25 to M41 `dependsOn` edge |
| M41 emits events | `m41.<resource>.<verb>` names in the event catalog (for example `m41.claim.submitted`, `m41.claim.rejected`); added with the first emit site and the real catalog-validating publisher in tests |

## 4. API Routes & Seams (proposed)

### 4.1 Routes (all mutating routes require `Idempotency-Key`, reject AI actors, and audit)
- `GET/POST /billing/commercial/payer-plans`, `PATCH …/:id`
- `GET/POST /billing/commercial/enrollments`, `PATCH …/:id`
- `GET/POST /billing/commercial/authorizations`
- `POST /billing/commercial/eligibility/check`
- `GET/POST /billing/commercial/claims`, `GET …/:id`, `POST …/:id/validate`, `POST …/:id/submit`, `POST …/:id/void`
- `POST …/claims/:id/validation-results/:resultId/override` (permission, step-up, reason ≥ policy length)
- `GET …/claims/:id/timeline`

### 4.2 Validation
Separate syntax, payer policy, authorization, eligibility and coverage rules. A hard block cannot be overridden without a
policy change; a warning override needs permission, step-up and a reason. Rules are effective-dated.

### 4.3 Send gate (fail closed)
`submit` refuses, creates no queue job, and returns a stable code when: the transport is unbound (`CH_NOT_WIRED`); the
payer plan has no route for the active clearinghouse; the provider entity is not `enrolled` for that payer; authorization is
required and missing or expired; validation has an unresolved block. The message tells the user what to do next.

### 4.4 Workers
Submit and retry, acknowledgment pull, claim-status poll, enrollment-expiry watch. Per-job `withOrgContext`; org-explicit
seam functions in workers (workers are not requests). Durable idempotency comes from the existing clearinghouse attempt
store; an ambiguous send is UNKNOWN and reconciled before any resend.

## 5. UI Surfaces (proposed)
Payer plans and enrollment status (supported-payers view), authorization list, commercial claim work queue (payer-kind
filter, validation panel, send gate reasons), claim detail (payer, plan, authorization, COB, timeline). Uses the shared kit
and the flat rail/drawer pattern; screens are added to the UI corpus so `docs:ui` and `ui:parity` stay green.

## 6. Permissions
`commercial_billing.read`, `.write`, `.submit`, `.override_validation`, `.manage_enrollment`. `submit` and enrollment
changes require step-up. Auditor and AI actors are read-denied by default.

## 7. Acceptance scenarios
| # | Scenario | Expected |
|---|---|---|
| S15 | Valid commercial hospice claim | Correct 837I, payer-stage accepted, 835 matched by M25 and posted once |
| S16 | Commercial primary, Medicare or Medicaid secondary | COB data present; no Medicare claim emitted as primary |
| S17 | Authorization missing or expired | Hard stop with an actionable message; nothing enqueued |
| S18 | Payer not routed or provider entity not enrolled | Refuses to send with a stable code; no queue job |
| S19 | Commercial 835 for another tenant or payer | Quarantined; nothing posts |

## 8. Security & Privacy
Member ids and payloads never appear in logs, events or alert text (codes and ids only). Cross-tenant isolation is proven
live as the real NOBYPASSRLS `chartwarden_app` role. Credentials are platform-held by the clearinghouse binding; M41 stores
none. Eraser registered with M4. Rate limiting and idempotency on every mutating route.

## 9. Testing
Test-first. Unit tests for validation rules and the send gate; live suites (private `pgvector/pgvector:pg18`, own database
per suite, `-c max_locks_per_transaction=1024`) for RLS, idempotency, enrollment gate, acknowledgment staging, and the S15-S19
scenarios; the real catalog-validating outbox publisher, not `NOOP_OUTBOX`; every live suite gets a `package.json` script and
a `ci.yml` job row. Conformance for the transport is owned by ADR-0053.

## 10. Implementation tasks (in order)
1. Skeleton: ADR-0100, this spec, manifest `.ts` and `.cjs`, `bun run scaffold`, index updates. **Done by this change.**
2. Migrations and Drizzle schema for the owned tables, code-side enum mirrors, RLS and audit triggers. **Plan, route and rate tables done (#721, migration 1260, live suite `test:m41:payer-plan:live`).**
3. Payer plan, enrollment and authorization routes with live RLS suite.
4. Claim assembly from M23 seams and validation rules (S17).
5. Submission and acknowledgment workers through the transport (S15, S18); requires the Medicare submission-path decision.
6. Eligibility.
7. `CommercialClaimReader` seam and the M25 payer-keyed candidate provider (S15, S19).
8. UI and browser tests.
9. Regenerate `status:matrix` and `ui:parity`; run `build`, `typecheck`, `arch:fitness`, tests and `check:boot:platform`.

## 11. Resolved decisions
See ADR-0100 D1-D10.

## 12. Open questions
Mirrors ADR-0100: which payers the chosen clearinghouse routes for hospice 837I (data in `commercial_payer_route`) and whether the screens extend the M23 work queue.

## 13. Proposed manifest entry
`id: 41`, `name: "Billing — Commercial"`, `dependsOn: [1, 23, 40]`, `codePaths` the two app directories, and the 14 owned
tables in §2.2 (the three validation tables are listed individually). Applied to `architecture/module-manifest.ts` and the
`.cjs` mirror with this change.
