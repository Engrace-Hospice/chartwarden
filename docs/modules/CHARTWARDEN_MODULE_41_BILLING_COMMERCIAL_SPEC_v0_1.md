# ChartWarden — Module 41: Billing — Commercial — Specification

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) win on as-built behaviour. Built so far: the payer and plan model (migration 1260, issue #721) and claim assembly, validation, pre-authorization, coordination of benefits and audited overrides (migrations 1261 and 1266, issue #722). Billing-domain facts were reviewed against primary sources on 2026-10-24 (ADR-0100 "Billing facts review"); items that depend on a payer's contract are **confirm-with-payer-contract** configuration, not assumptions in code.

**Version:** 0.1
**Status:** Draft (proposal); ADR-0100 Accepted
**Owner:** Fabrice V. Adjam (ChartWarden)
**Dependencies (manifest):** M1 Foundation, M23 Billing — Medicare (shared 837I builder and `ClearinghouseTransport` in `x12-837-client`), M40 MDM (payer master)
**Decision record:** [ADR-0100](../adr/ADR-0100-commercial-billing-module-41.md); transport contract [ADR-0053](../adr/ADR-0053-clearinghouse-transport-port.md)
**Sibling specs read into context:** M23 v0.2 (D15), M24 v0.2.1 (structure), M25 v0.2 (D9), M40 v0.4

## Changelog
- **0.4 (2026-10-25)** - UI built (issue #726): the commercial claim work queue with a payer-kind filter, the claim detail (payer, plan, authorization, coordination of benefits, validation with audited overrides) and the supported-payers view, all under `apps/web/src/modules/41-billing-commercial` (spec `docs/design/screens/revenue/CHARTWARDEN_UI_COMMERCIAL_BILLING.md`). Two read routes added for them (`GET /claims`, `GET /payer-plans`, section 4.1) and the claim read gained `plan` and `authorizations`. Browser test: `e2e/specs/billing-commercial.spec.ts`.
- **0.3 (2026-10-24)** - Claim assembly and validation built (issue #722). Tables `commercial_authorization`, `commercial_claim`, `commercial_claim_line`, `commercial_claim_state_history`, `commercial_validation_run`, `_result` and `_override` (migration 1261; role grants in 1266); the plan gains `site_of_service_hcpcs_required`. Routes under `/api/v1/billing/commercial` (section 4.1), the three-key permission set, three ABAC predicates, three `m41.claim.*` events. The shared 837I builder gained the commercial shape (SBR09 filing indicator, group number, member id, revenue-code-only lines, loop 2320/2330 for a Medicare or Medicaid secondary). M40 payer merge or deactivation is handled by a read-time guard (section 4.2), not by rewriting plans.
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
| `commercial_payer_enrollment` | Per provider entity, per payer, per clearinghouse: `not_enrolled`, `pending`, `enrolled`, `suspended`, with dates and evidence reference. Built (#724) |
| `commercial_authorization` | Pre-authorization: number (never shown in a message or audit event), patient, plan, optional level of care, date obtained, approved period, status (`approved`, `denied`, `voided`). Built (#722); no unit count yet |
| `commercial_eligibility_check` | A 270/271 exchange: request id, outcome, as-of date, no member id stored or logged. Built (#724) |
| `commercial_claim` | Header: patient, plan, payer-route snapshot, type of bill 81x, window, COB (secondary Medicare or Medicaid), diagnosis and attending snapshot, totals, expected payment, state (`draft`, `ready`, `void`). Built (#722) |
| `commercial_claim_line` | One line per level-of-care stretch the rate in effect covers: contract revenue code, optional site-of-service HCPCS, dates, units, unit rate, charge, the rate row it was priced from. Built (#722) |
| `commercial_claim_state_history` | Immutable transition log. Built (#722) |
| `commercial_submission` | One logical submission: idempotency key, control number, clearinghouse attempt reference |
| `commercial_acknowledgment` | 999 and 277CA events with stage (`clearinghouse` or `payer`), codes only |
| `commercial_validation_run`, `_result`, `_override` | Rule results with key, severity, overridable, evidence hash, message; audited overrides bound to (claim, rule, evidence hash). Built (#722) |

All PHI tables carry `organization_id`, `provider_entity_id` and nullable `location_id`; RLS is a single policy on
`app.org_id` (ADR-0010); provider-entity narrowing is ABAC. Children inherit scope from the PE-scoped claim root. Exact
columns are fixed when each migration is written.

### 2.3 Claim shape
837I (005010X223A2), type of bill 081x (082x if hospital-based), default revenue codes 0651/0652/0655/0656. Whether a payer also wants HCPCS site-of-service lines, hourly continuous care, 0657, or other edits is **confirm-with-payer-contract** and is stored in the plan and rate rows; Medicare rules are not assumed. Medicare Advantage enrollees are not billed here: hospice for them goes to the MAC through M23 (ADR-0100 D7). Filing indicators are limited to the commercial set in `@chartwarden/types` (`COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES`).

**As built (#722).** Lines are priced from the plan's contract rate rows: per diem is days times the rate, per hour is whole documented continuous-care hours times the rate (continuous care only), percent-of-charges is NOT priced (there is no standard-charge source yet) and blocks. The billed charge equals the contract amount, and the expected payment is the sum of the priced lines. Plan, route and rate periods are each intersected with the claim window: a level-of-care stretch is split wherever the rate row in effect changes and a stretch with no rate is an unpriced line that blocks. The 837I is rendered by the shared builder (`render-837i.ts`): type of bill 81x from the cadence (first or later bill, stay ended or not), SBR09 from the plan, NM109 of 2010BB from the clearinghouse route, SV2 per line, and loop 2320/2330A/2330B when Medicare or Medicaid is secondary. The Stedi JSON route cannot carry loop 2320 or a line without a procedure code and refuses both (the raw X12 stands).

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
Built (#722), all under `/api/v1/billing/commercial`, permission `commercial_billing.read` / `.write` / `.override_validation`:
- `POST /claims/assemble` (201) - 409 `NON_COMMERCIAL_PRIMARY_PAYER` when the primary payer is not a commercial plan (the mirror of M23's `NON_MEDICARE_PRIMARY_PAYER`), 422 `COMMERCIAL_PLAN_NOT_FOUND`
- `GET /claims/:id` (read-audited), `POST /claims/:id/validate`, `POST /claims/:id/ready` (409 `COMMERCIAL_CLAIM_BLOCKED` with the blocking rules), `POST /claims/:id/void`
- `POST /claims/:id/validation-results/:resultId/override` (201; step-up, reason of at least 40 characters)
- `POST /authorizations`, `POST /authorizations/:id/status`, `GET /authorizations?providerEntityId&patientId` (read-audited)

Built (#726, read only): `GET /claims?providerEntityId&state&payerKind&patientId&limit` (the work queue: one provider entity, caseload-filtered, read-audited list; keyset paging by an opaque `cursor`, `limit` 1 to 100, answering `items`, `hasMore` and `nextCursor`. The caseload axis runs after the SQL page, so a page can be short or even empty while `nextCursor` is set: clients keep following it. A scan stops at 500 rows per request and answers a cursor to continue from) and `GET /payer-plans?providerEntityId` (plans with payer state and clearinghouse routes, no patient data). `GET /claims/:id` also returns `plan` and the `authorizations` touching the claim window (status and period, never the number).

Proposed, with their own issues: payer-plan CRUD, `POST /eligibility/check`, `POST .../submit`, `GET .../timeline`.

### 4.2 Validation
Rules are pure functions over loaded facts (`domain/rules.ts`) and run on assembly, on `validate` and on every `ready`. A result is a **hard block** (`error`, never overridable: no role can move the claim past it, only a data or policy change can) or a **soft block** (`warn`, overridable with permission, step-up and a reason). Only a failing, overridable result of the claim's latest run can be overridden; the override is bound to the exact facts (rule key plus evidence hash), so it does not carry to different facts after a re-run, and there is one per result. The override writes the override row, a prominent M4 audit event (ids, rule key and reason LENGTH only) and an `m41.claim.override_applied` event in one transaction; the reason text exists only on the override row.

| Rule | Severity | Meaning |
|---|---|---|
| `plan_in_effect` | hard | the plan period covers the whole window |
| `plan_payer_active` | hard | the plan's M40 payer is still active; a merged payer names its survivor. This is the guard for ADR-0100's "payer merge or deactivation must repoint or end plans": plans are not rewritten behind the tenant's back, assembly and every re-validation refuse a plan whose payer is gone and say what to do |
| `claim_filing_indicator_commercial` | hard | SBR09 is a commercial code |
| `payer_route_in_effect` | hard | exactly one clearinghouse route is in effect on the last service day |
| `service_days_covered` | hard | every day of the window is billed exactly once (a hole or an overlap in the level-of-care periods would under- or double-bill) |
| `contract_rate_in_effect`, `charge_priceable` | hard | every billed day has a contract rate that can be priced |
| `principal_diagnosis_present`, `attending_physician_present`, `site_of_service_hcpcs` | hard | 837I content the plan requires |
| `authorization_on_file` | hard when the plan requires authorization, soft when the requirement is `confirm_with_payer` | approved authorizations cover every billed day (and the level of care when required per level); an expired one is reported as expired |
| `authorization_lead_time` | soft | the plan's lead time (days before service) was met |
| `eligibility_freshness` | hard when the plan policy is `block` or the payer answered "not active"; otherwise a visible, non-blocking finding | the latest 270/271 check (#724) is recent enough (`evaluateEligibilityFreshness`) |
| `cob_secondary_declared` | info | Medicare or Medicaid is secondary; the claim carries the other-payer loop |

**Scope of the data (security).** A route-level ABAC predicate proves the actor may act on the provider entity NAMED in the request; every service also checks the DATA it touches (`services/scope-guard.ts`): the entity is in the actor's billing scope, the patient is in their caseload (M5 `CaseloadProvider`, skipped only for organization-wide billing roles and the system principal), and the patient's admission belongs to that entity (`admission.provider_entity_id`, added to the M6 range context). Authorization lookups, lists and the claim read filter on the entity too, and an authorization recorded under another entity never satisfies a claim. Absent scope fails closed. Concurrency: lifecycle operations lock the claim row, assembly takes a per-patient advisory lock, and the table carries an exclusion constraint (one live claim per patient per day) and a trigger that makes `void` final. Idempotency on the mutating routes is presence-only (the `Idempotency-Key` header is required); a retried validate, ready or void re-executes harmlessly, a retried override or assembly is a 409.

Pricing is frozen at assembly: a pricing block is fixed by voiding and re-assembling. Authorization, plan, payer and route facts are re-read on every run.

### 4.3 Send gate (fail closed)
`submit` refuses, creates no queue job, and returns a stable code when: the transport is unbound (`CH_NOT_WIRED`); the
payer plan has no route for the active clearinghouse; the provider entity is not `enrolled` for that payer; authorization is
required and missing or expired; validation has an unresolved block. The message tells the user what to do next.

### 4.4 Workers
Submit and retry, acknowledgment pull, claim-status poll, enrollment-expiry watch. Per-job `withOrgContext`; org-explicit
seam functions in workers (workers are not requests). Durable idempotency comes from the existing clearinghouse attempt
store; an ambiguous send is UNKNOWN and reconciled before any resend.

## 5. UI Surfaces (built, #726)
Payer plans and enrollment status (supported-payers view), authorization list, commercial claim work queue (payer-kind
filter, validation panel, send gate reasons), claim detail (payer, plan, authorization, COB, timeline). Uses the shared kit
and the flat rail/drawer pattern; screens are in the UI corpus so `docs:ui` and `ui:parity` stay green. Built: the claim queue (payer-kind and state filters, drawer), claim detail with override ceremony, supported payers with enrollment ("not enrolled" is a state), and the per-patient authorizations screen (list, record, deny and void; write controls only with `commercial_billing.write`; the number is never shown). The enrollments screen is built too: the provider entity's enrollment rows (payer, clearinghouse key, status, dates, evidence reference as entered), with Add and Edit only for `commercial_billing.manage_enrollment`; both writes need a fresh step-up, and a refusal keeps the typed draft across the `/step-up` round trip (restored, never auto-submitted). Edit changes status, end date and evidence only, and there is no delete. The eligibility screen is built too (`/commercial/billing/eligibility`): per patient and provider entity, the latest check with the server's freshness verdict (shown, never recomputed in the browser), the check history, **Run eligibility check** for `commercial_billing.write` (refusals in fixed words by code, the member id never in the UI or any request) and, for `commercial_billing.manage_enrollment`, **Edit eligibility policy** (warn or block, 1 to 365 days, fresh step-up with the same draft round trip). The default provider entity is the first one the user can actually bill for (probed with the payer-plans read). Not built, and why: send-gate reasons and the timeline (they depend on the submission slice, issue 5 of section 10, which needs the Medicare submission-path decision). The browser test `e2e/specs/billing-commercial.spec.ts` stubs the commercial READ routes with `page.route`: no seed scenario can assemble a commercial claim (it needs a commercial payer plan, route, contract rates and patient coverage, and claim assembly's admission, election and diagnosis seams are not all bound in the dev seed), so the screens' behaviour, keyboard operation and accessibility are pinned against synthetic responses while sign-in, shell, provider-entity list and routing are real. The real routes, including the paging loop with more than 100 reachable claims and the 500-row scan cap, are proven by `m41-commercial-routes.live.test.ts` against the real schema.

## 6. Permissions
`commercial_billing.read`, `.write` and `.override_validation` are built (created by migration 1265; migration 1266 also grants them to every role holding the Medicare analogue); `.submit` and `.manage_enrollment` arrive with their issues. ABAC: `commercial_billing_provider_scope`, `commercial_claim_in_billing_caseload`, `commercial_override_eligible`. `submit` and enrollment
changes require step-up. Auditor and AI actors are read-denied by default.

## 7. Acceptance scenarios
| # | Scenario | Expected | Status |
|---|---|---|---|
| S15 | Valid commercial hospice claim | Correct 837I, payer-stage accepted, 835 matched by M25 and posted once | Assembly, validation and the 837I render are live-tested (`test:m41:commercial-claim:live`); sending, acknowledgment and 835 matching are the submission and remittance issues |
| S16 | Commercial primary, Medicare or Medicaid secondary | COB data present; no Medicare claim emitted as primary | Live-tested, including M23 refusing the same patient with `NON_MEDICARE_PRIMARY_PAYER` |
| S17 | Authorization missing or expired | Hard stop with an actionable message; nothing enqueued | Live-tested: the claim stays a draft, `ready` answers 409, no `ready_for_submission` event, and the hard block has no override path |
| S18 | Payer not routed or provider entity not enrolled | Refuses to send with a stable code; no queue job | Routing is a hard rule today (`payer_route_in_effect`); enrollment arrives with the enrollment issue |
| S19 | Commercial 835 for another tenant or payer | Quarantined; nothing posts | Remittance issue |

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
2. Migrations and Drizzle schema for the owned tables, code-side enum mirrors, RLS and audit triggers. **Plan, route and rate tables done (#721, migration 1260); authorization, claim, line, history and validation tables done (#722, migration 1261). Enrollment, eligibility, submission and acknowledgment tables remain.**
3. Payer plan, enrollment and authorization routes with live RLS suite.
4. Claim assembly from M23 seams and validation rules (S17). **Done (#722, migrations 1261 and 1266, live suites `test:m41:commercial-claim:live` and `test:m41:commercial-routes:live`).**
5. Submission and acknowledgment workers through the transport (S15, S18); requires the Medicare submission-path decision.
6. Eligibility.
7. `CommercialClaimReader` seam and the M25 payer-keyed candidate provider (S15, S19).
8. UI and browser tests. **Done (#726 and the authorizations screen), except send-gate reasons and the timeline.**
9. Regenerate `status:matrix` and `ui:parity`; run `build`, `typecheck`, `arch:fitness`, tests and `check:boot:platform`.

## 11. Resolved decisions
See ADR-0100 D1-D10.

## 12. Open questions
Known limits of the claim lane as built (#722): percent-of-charges contracts cannot be priced (no standard-charge source), per-hour continuous care needs whole documented hours that no reader binds yet (`chcDocumentedHours` is null in every current seam), so both block rather than guess; the billed charge is the contract amount; the Stedi JSON route refuses a claim with another payer or without HCPCS; the production binding of the 837I parties and subscriber-identity ports (like M23's loader) arrives with the submission slice.

Mirrors ADR-0100: which payers the chosen clearinghouse routes for hospice 837I (data in `commercial_payer_route`) and whether the screens extend the M23 work queue.

## 13. Proposed manifest entry
`id: 41`, `name: "Billing — Commercial"`, `dependsOn: [1, 23, 40]`, `codePaths` the two app directories, and the 14 owned
tables in §2.2 (the three validation tables are listed individually). Applied to `architecture/module-manifest.ts` and the
`.cjs` mirror with this change.
