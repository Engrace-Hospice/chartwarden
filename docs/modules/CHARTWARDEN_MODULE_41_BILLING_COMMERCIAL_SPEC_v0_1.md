# ChartWarden — Module 41: Billing — Commercial — Specification

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) win on as-built behaviour. Built so far: the payer and plan model (migration 1260, issue #721) and claim assembly, validation, pre-authorization, coordination of benefits and audited overrides (migrations 1261 and 1266, issue #722). Billing-domain facts were reviewed against primary sources on 2026-10-24 (ADR-0100 "Billing facts review"); items that depend on a payer's contract are **confirm-with-payer-contract** configuration, not assumptions in code.

**Version:** 0.1
**Status:** Draft (proposal); ADR-0100 Accepted
**Owner:** Fabrice V. Adjam (ChartWarden)
**Dependencies (manifest):** M1 Foundation, M23 Billing — Medicare (shared 837I builder and `ClearinghouseTransport` in `x12-837-client`), M40 MDM (payer master)
**Decision record:** [ADR-0100](../adr/ADR-0100-commercial-billing-module-41.md); transport contract [ADR-0053](../adr/ADR-0053-clearinghouse-transport-port.md)
**Sibling specs read into context:** M23 v0.2 (D15), M24 v0.2.1 (structure), M25 v0.2 (D9), M40 v0.4

## Changelog
- **0.5 (2026-10-25)** - Submission built on the ADR-0053 D10 decision (`ClearinghouseTransport` is the only submission path for Medicare and commercial; unbound answers `CH_NOT_WIRED`, nothing is sent). Migration 1274: `commercial_submission` and the claim states `submitted`, `ack_pending`, `accepted`, `rejected`. Routes `POST .../submit`, `GET .../send-gate`, `GET .../timeline`; events `m41.claim.submit_requested`, `.submitted`, `.submit_failed`; the `m41.submission-drain` worker. Migration 1275 and the `m41.ack-pull` worker ingest the two acknowledgment stages (tables `commercial_acknowledgment`, `commercial_ack_cursor`; events `m41.claim.clearinghouse_accepted`, `.accepted`, `.rejected`). The 837I parties source is not built (section 4.3.1).
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
| `commercial_submission` | One logical send through the transport: idempotency key, control number, interchange number, clearinghouse and payer id, status (`queued`, `sent`, `failed`, `in_doubt`), attempts, receipt id. No PHI. Built (migration 1274) |
| `commercial_acknowledgment` | 999 and 277CA events with stage (`clearinghouse` or `payer`), codes only; unique on the vendor event id. Built (migration 1275) |
| `commercial_ack_quarantine` | Acknowledgment events that were not applied: event id, control number, a reason code. No body, no PHI. Built (migration 1275) |
| `commercial_ack_cursor` | The acknowledgment pull position per provider entity, vendor and usage (opaque token, compare-and-set). Built (migration 1275) |
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

Built (submission slice, ADR-0053 D10): `POST /claims/:id/submit` (`commercial_billing.submit`, claim caseload scope, **fresh step-up** as M23's filing actions, no AI actor, `Idempotency-Key`; 202 `queued`, 200 `replayed: true` for the same key, 409 `COMMERCIAL_SEND_REFUSED` or 503 when the transport is unbound, with every gate reason as a detail), `GET /claims/:id/send-gate` (every reason now, judged on current facts, read-audited) and `POST /claims/:id/submissions/:submissionId/reconcile` (the human exit from `in_doubt`, section 4.3.1) and `GET /claims/:id/timeline` (state changes, submissions and acknowledgments in order, ids/dates/codes only, bounded to 200 + 50 rows, read-audited). The request only decides and records; the drain worker (`m41.submission-drain`, every minute) sends through `ClearinghouseTransport.submitClaim`.

Proposed, with their own issues: payer-plan CRUD.

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
`ClearinghouseTransport` is the only submission path for Medicare and commercial claims (ADR-0053 D10): no direct-to-payer channel, no silent fallback. `submit` refuses, writes no submission row (so no job exists) and returns a stable code. The gate is a pure function (`services/claim-send-gate.ts`) that lists every reason in a fixed order, each with a fixed message that says what to do next:

| Order | Code | Meaning |
|---|---|---|
| 1 | `COMMERCIAL_CLAIM_NOT_READY` | the claim is not `ready` (the only reason reported then) |
| 2 | `COMMERCIAL_SUBMISSION_IN_FLIGHT` | a submission is already queued, sent or in doubt (one live submission per claim) |
| 3 | `COMMERCIAL_VALIDATION_BLOCKED` | an unresolved block on the current facts (rule keys listed) |
| 4 | `COMMERCIAL_AUTHORIZATION_NOT_SATISFIED` | `authorization_on_file` blocks (hard when required, soft for `confirm_with_payer`) |
| 5 | `COMMERCIAL_ELIGIBILITY_NOT_CURRENT` | `eligibility_freshness` blocks (plan policy, or the payer answered "not active") |
| 6 | `CH_NOT_WIRED` | the transport is unbound (503) |
| 7 | `COMMERCIAL_PAYER_NOT_ROUTED` / `COMMERCIAL_ROUTE_CHANGED` | no route in effect for the bound clearinghouse / the claim was built with another payer id |
| 8 | `COMMERCIAL_PROVIDER_NOT_ENROLLED` | no `enrolled` enrollment in effect on the last service day for this payer on this clearinghouse |

The worker judges the gate again at send time.

### 4.3.1 Submission lifecycle (as built)
`ready` stays `ready` while a submission is `queued`. The drain leases ONE due row at a time just before it sends (row-locked, `SKIP LOCKED`, a 5-minute lease), renders the 837I (the member id lives only in memory) and calls `submitClaim` under ONE transport key per claim (`m41.claim.<claimId>`) with a payload that is deterministic across the claim's whole lineage of submissions (the interchange number and stamp are copied from the first). A retry, a re-lease after a crash, or a second submission row therefore REPLAYS the original receipt instead of filing twice (verified: both the in-memory and the Stedi attempt store answer a repeated key with the original receipt and `replayed: true`, and refuse a control number reused under another key). Only the transport's receipt writes `sent`, `ready -> submitted`, the history row and `m41.claim.submitted` in one transaction (ADR-0100 D9).

**Ambiguity is never `failed`.** `transport_call_started_at` is set just before the call and cleared only on a definite answer; a lease that finds it still set knows the attempt was interrupted and sets the sticky `ambiguous` flag. A definite `CH_UNAVAILABLE` requeues with backoff (5 attempts). `in_doubt` is the end of every ambiguous path: a throwing transport, `CH_IN_DOUBT`, a fault while recording what the transport accepted (the receipt id is kept), exhausted attempts after an interrupted one, and a refusal that comes after an ambiguous attempt. An `in_doubt` submission is never resent automatically and holds the claim's single live slot. A definite refusal before anything was sent, on a submission that was never ambiguous, is `failed` with a stable code (`m41.claim.submit_failed`) and the claim stays `ready`.

**Ways out of `in_doubt`.** (1) A later acknowledgment for the control number settles it: the submission becomes `sent` (resolution `acknowledgment`), the claim moves `ready -> submitted`, and the acknowledgment applies as usual; only a clearinghouse-stage answer can do this (a payer-stage answer for a submission with no recorded receipt is quarantined as `no_receipt`). (2) `POST /claims/:id/submissions/:submissionId/reconcile` with `{outcome: "received" | "not_received"}` (`commercial_billing.submit`, fresh step-up, no AI actor, Idempotency-Key, no free text; audited by the row audit and `m41.claim.submit_reconciled`): `received` settles it as `sent` and moves the claim to `submitted`; `not_received` ends it `failed` so the claim can be submitted again (the re-send replays the earlier receipt if the file had in fact arrived). A claim with a submission in doubt cannot be voided.

A `submitted` or later claim cannot be re-validated, re-readied or voided locally. The database trigger allows only the legal moves (`draft <-> ready`, `draft` or `ready -> void`, `ready -> submitted`, `submitted -> ack_pending | accepted | rejected`, `ack_pending -> accepted | rejected`, `rejected -> void`) and refuses every other jump. `CLEARINGHOUSE_VENDOR` unset: a tick that finds a waiting submission fails and sends nothing. The `direct_mac` transport (a Medicare contractor's portal) is refused for commercial claims with `COMMERCIAL_TRANSPORT_UNSUPPORTED` (ADR-0053 D10, ADR-0100 D4). The drain and acknowledgment schedules are registered at boot, and a failure to register them FAILS boot (unlike M23's logged-and-swallowed registration), because a queue nothing drains is "bound, not computing". The 837I parties source (submitter, receiver, billing provider) has no production binding yet, so a real send ends `failed` with `COMMERCIAL_837I_INCOMPLETE`.

**Acknowledgments (migration 1275).** The `m41.ack-pull` worker (every 5 minutes, only for provider entities that have a sent claim still waiting) pulls `fetchAcknowledgments` with a persisted cursor (`commercial_ack_cursor`, compare-and-set on `version`, advanced only after the page was applied; a cursor the vendor refuses is reset and the stream re-read). Every event is validated field by field at the boundary (types, ISO date, reason codes `^[A-Za-z0-9._:-]{1,64}$`, no NUL, bounded sizes); a malformed one is stored and skipped, never thrown, so it cannot stall the stream. `AckEvent` carries no payer id and no receipt id today, so the trust binding is the provider-entity scope of the stream, the control number, the clearinghouse the submission went through (`vendor_mismatch`) and the receipt rule above. Each event is matched on the control number among that provider entity's `sent`, `in_doubt` and in-flight `queued` submissions, recorded in `commercial_acknowledgment` (stage, disposition, reason CODES, payer claim number; unique on organization, clearinghouse and vendor event id, so a replay collapses and changes nothing) and, in the same transaction, moves the claim when legal and writes the event: clearinghouse accepted `submitted -> ack_pending` (`m41.claim.clearinghouse_accepted`, also stamps `commercial_submission.clearinghouse_accepted_at`), payer accepted `-> accepted` (`m41.claim.accepted`), any rejection or a payer partial `-> rejected` (`m41.claim.rejected`). A clearinghouse acceptance never reaches `accepted`; a late 999 never regresses an accepted claim. Every event that is NOT applied is stored in `commercial_ack_quarantine` (event id, control number, a reason code: `malformed`, `unmatched` for a control number that is no commercial submission of this provider entity (the stream is shared with Medicare), `scope_mismatch`, `vendor_mismatch`, `no_receipt`; never the body) in the same transaction, before the cursor can move past it, so it is reviewable and replayable instead of lost to a log line; another tenant's events are invisible (RLS). The acknowledgment pull runs for provider entities with a sent claim waiting OR a submission in doubt, and not at all on a clearinghouse that cannot carry commercial claims. Unbound with work waiting fails the tick. Not built: claim-status inquiry for a stuck submission (`fetchClaimStatus`) and a tool that replays a stored quarantine row.

### 4.4 Workers
Submit and retry, acknowledgment pull, claim-status poll, enrollment-expiry watch. Per-job `withOrgContext`; org-explicit
seam functions in workers (workers are not requests). Durable idempotency comes from the existing clearinghouse attempt
store; an ambiguous send is UNKNOWN and reconciled before any resend.

## 5. UI Surfaces (built, #726)
Payer plans and enrollment status (supported-payers view), authorization list, commercial claim work queue (payer-kind
filter, validation panel, send gate reasons), claim detail (payer, plan, authorization, COB, timeline). Uses the shared kit
and the flat rail/drawer pattern; screens are in the UI corpus so `docs:ui` and `ui:parity` stay green. Built: the claim queue (payer-kind and state filters, drawer), claim detail with override ceremony, supported payers with enrollment ("not enrolled" is a state), and the per-patient authorizations screen (list, record, deny and void; write controls only with `commercial_billing.write`; the number is never shown). The enrollments screen is built too: the provider entity's enrollment rows (payer, clearinghouse key, status, dates, evidence reference as entered), with Add and Edit only for `commercial_billing.manage_enrollment`; both writes need a fresh step-up, and a refusal keeps the typed draft across the `/step-up` round trip (restored, never auto-submitted). Edit changes status, end date and evidence only, and there is no delete. The eligibility screen is built too (`/commercial/billing/eligibility`): per patient and provider entity, the latest check with the server's freshness verdict (shown, never recomputed in the browser), the check history, **Run eligibility check** for `commercial_billing.write` (refusals in fixed words by code, the member id never in the UI or any request) and, for `commercial_billing.manage_enrollment`, **Edit eligibility policy** (warn or block, 1 to 365 days, fresh step-up with the same draft round trip). The default provider entity is the first one the user can actually bill for (probed with the payer-plans read). The assemble screen is built too (`/commercial/billing/claims/new`, `commercial_billing.write`, linked from the claim queue): provider entity, patient, service dates, optional plan and clearinghouse key; one Idempotency-Key per attempt, kept only after a thrown fetch; refusals in fixed words by code; it opens the new claim on a 201. Not built yet: the send-gate reasons and the timeline screens (the backend is built: `GET .../send-gate` and `GET .../timeline`, section 4.1). The browser test `e2e/specs/billing-commercial.spec.ts` stubs the commercial READ routes (and, for the assemble screen, the assemble POST) with `page.route`: no seed scenario can assemble a commercial claim (it needs a commercial payer plan, route, contract rates and patient coverage, and claim assembly's admission, election and diagnosis seams are not all bound in the dev seed), so the screens' behaviour, keyboard operation and accessibility are pinned against synthetic responses while sign-in, shell, provider-entity list and routing are real. The real routes, including the paging loop with more than 100 reachable claims and the 500-row scan cap, are proven by `m41-commercial-routes.live.test.ts` against the real schema.

## 6. Permissions
`commercial_billing.read`, `.write` and `.override_validation` are built (created by migration 1265; migration 1266 also grants them to every role holding the Medicare analogue); `.submit` and `.manage_enrollment` are built (1265; migration 1274 also grants `.submit` to every role holding `billing.claim.submit`). ABAC: `commercial_billing_provider_scope`, `commercial_claim_in_billing_caseload`, `commercial_override_eligible`. `submit` and enrollment
changes require step-up. Auditor and AI actors are read-denied by default.

## 7. Acceptance scenarios
| # | Scenario | Expected | Status |
|---|---|---|---|
| S15 | Valid commercial hospice claim | Correct 837I, payer-stage accepted, 835 matched by M25 and posted once | Assembly, validation and the 837I render are live-tested (`test:m41:commercial-claim:live`); queued sending through the transport is live-tested too (`test:m41:commercial-submission:live`, in-memory transport); acknowledgment ingestion and 835 matching are the next issues |
| S16 | Commercial primary, Medicare or Medicaid secondary | COB data present; no Medicare claim emitted as primary | Live-tested, including M23 refusing the same patient with `NON_MEDICARE_PRIMARY_PAYER` |
| S17 | Authorization missing or expired | Hard stop with an actionable message; nothing enqueued | Live-tested: the claim stays a draft, `ready` answers 409, no `ready_for_submission` event, and the hard block has no override path |
| S18 | Payer not routed or provider entity not enrolled | Refuses to send with a stable code; no queue job | Live-tested (`test:m41:commercial-submission:live`): unbound, not routed and not enrolled each answer a stable code and write no submission row and no event |
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
5. Submission and acknowledgment workers through the transport (S15, S18). **Submission (migration 1274) and acknowledgment ingestion (999 and 277CA, migration 1275) done on ADR-0053 D10; live suite `test:m41:commercial-submission:live`. Remaining: the 837I parties source, in-doubt reconciliation and claim-status inquiry.**
6. Eligibility.
7. `CommercialClaimReader` seam and the M25 payer-keyed candidate provider (S15, S19).
8. UI and browser tests. **Done (#726 and the authorizations screen), except send-gate reasons and the timeline.**
9. Regenerate `status:matrix` and `ui:parity`; run `build`, `typecheck`, `arch:fitness`, tests and `check:boot:platform`.

## 11. Resolved decisions
See ADR-0100 D1-D10.

## 12. Open questions
Known limits of the claim lane as built (#722): percent-of-charges contracts cannot be priced (no standard-charge source), per-hour continuous care needs whole documented hours that no reader binds yet (`chcDocumentedHours` is null in every current seam), so both block rather than guess; the billed charge is the contract amount; the Stedi JSON route refuses a claim with another payer or without HCPCS; the subscriber-identity port is bound over M5's `PatientReader`/`PatientAddressReader` (`services/render-ports.ts`), but the 837I PARTIES port (submitter, receiver, billing provider, payer name) has no production source yet (M23's loader leaves the same port unbound), so a real send ends `failed` with `COMMERCIAL_837I_INCOMPLETE` until it is bound.

Mirrors ADR-0100: which payers the chosen clearinghouse routes for hospice 837I (data in `commercial_payer_route`) and whether the screens extend the M23 work queue.

## 13. Proposed manifest entry
`id: 41`, `name: "Billing — Commercial"`, `dependsOn: [1, 23, 40]`, `codePaths` the two app directories, and the 14 owned
tables in §2.2 (the three validation tables are listed individually). Applied to `architecture/module-manifest.ts` and the
`.cjs` mirror with this change.
