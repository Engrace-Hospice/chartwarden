# BIL-2 Implementation Roadmap

Phases are vertical slices. Reuse existing services, schemas and UI; do not create generic duplicate billing engines. Each phase starts from `develop` after the previous phase's agreed integration. No branch is created by this audit.

## BIL-2.1 — Claim Preparation & Validation (recommended first vertical slice)

**Business objective:** let an M23 biller see, before submission, the exact current claim facts, final 837I preview, all blocking/missing fields with source ownership, and whether its payer route is configured. Preserve current validation and approval gates.

**Reuse:** M23 `buildClaimAssemblyService`, frozen rule registry, validation context/service, 837I loader/renderer, claim detail/history, BIL-1 immutable evidence and M23/M41 provider scope.

**Source areas:** `apps/backend/src/modules/23-billing-medicare/services/{claim-assembly,claim-validation-service,claim-837i-loader,claim-837i-submit}.ts`; `routes/{claims,validation}.routes.ts`; `jobs/clearinghouse-context.ts`; M23 screens `claim-assembly-wizard.tsx`, `claim-editor.tsx`, `validation-remediation.ts`, `claim-assembly-errors.ts`.

**Backend:** establish vendor/MAC payer ID resolution from an authoritative route configuration and fail closed for unknown routes; expose a read-only preview of the exact final payload identity/segments or safe field summary; return typed field→owner-source remediation; revalidate current facts before preview/send; preserve audit and claim versions. No new claim statuses.

**Frontend:** one preparation step with provider/location, service period, payer route status, validation findings grouped by correction source, final preview and explicit ready-to-submit transition. Show loading/empty/stale-validation states; keyboard-focus validation panel.

**API/DB:** prefer additive API contract. Add effective-dated payer-route configuration only if an existing owner table cannot represent MAC/vendor payer mapping; do not add a free-form payer ID field to claim requests. If schema needed, include tenant/provider/MAC/vendor/usage uniqueness, audit, RLS, backfill/rollback and BIL-1 evidence compatibility.

**Permissions/edge cases:** existing M23 assemble/read/validate/submit permissions, provider ABAC, step-up for submit/overrides; MA hospice with FFS primary, split coverage period, late NOE, provider/location identity change, stale version, ambiguous route, missing NPI/TIN, unsupported notice type.

**Focused tests:** assembly/rules/loader/transport route matrix; preview matches exact sent payload digest; invalid/unmapped payer ID blocks before attempt/network; two provider entities with different MAC routes; location/provider snapshot; stale validation and `If-Match`; MBI not logged; screen tests for error source and keyboard use.

**Acceptance:** a supported M23 claim can be assembled, understood, validated, previewed and marked ready; unresolved route/data cannot be submitted; payload preview and transmitted bytes are the same evidence identity.

**External blockers:** vendor/MAC payer identifiers and test-account route approval; none needed to implement safe fail-closed UI/backend.

## BIL-2.2 — M23 Submission, Corrections & Claim History Completion

**Business objective:** close the operational loop from ready claim to transport result, acknowledgment provenance, safe correction/replacement and user-visible next action.

**Reuse:** M23 outbox submission workers, attempt repository, Claim.MD evidence/receipt, BIL-1 response inbox/resolver/dispatcher, existing correction/void state model, timeline and history.

**Source areas:** `jobs/m23-jobs.ts`, `jobs/clearinghouse-submission.ts`, `services/claim-state-service.ts`, `services/notice-correction-service.ts`, `routes/clearinghouse-attempt.routes.ts`, M23 history/timeline screens.

**Backend:** audit status mapping by submission stage; ensure transport upload acceptance never equals payer acceptance; confirm retries/in-doubt stay attached to original attempt; expose a linked original→replacement→void history; ensure payer ID is immutable per attempt and route. Don't change notice semantics.

**Frontend:** stage-specific status timeline with retry/reconcile reason and next permitted action; correction wizard uses server-authoritative replacement constraints.

**API/DB:** add only missing correlation/history fields after confirming existing attempt and identity tables. No destructive migration, no attempt overwrite.

**Permissions/edge cases:** step-up, provider scope, duplicate submit, crash-after-send, outdated control number, late/older acknowledgment, payer rejection versus clearinghouse rejection, corrected payload and terminal original.

**Focused tests:** end-to-end fake transport through durable attempt to approved status; duplicate and in-doubt recovery; old attempt response; replacement linkage; no false acceptance; no cross-tenant response attribution.

**Acceptance:** every send and response remains attributable to original tenant/provider/claim/attempt and users can distinguish receipt, payer response and adjudication.

**External blockers:** Claim.MD/MAC transaction and payer response semantics; use synthetic/fixture tests until vendor gate approved.

## BIL-2.3 — M41 Commercial Correction & Payer-Specific Submission Slice

**Business objective:** complete one explicitly selected commercial payer route, including preparation, submission, rejection/correction/replacement and history.

**Reuse:** M41 assembly/validation/send gate/submission ledger/renderer, existing M41 Claim.MD evidence and acknowledgment adapters, payer-plan and enrollment readiness, current timeline.

**Source areas:** `apps/backend/src/modules/41-billing-commercial/services/{claim-lifecycle,submission-service,claim-send-gate,render-837i,validation-runner}.ts`; `routes/commercial-billing.routes.ts`; `jobs/submission-worker.ts`; commercial claim schema/UI.

**Backend:** choose one payer plan with documented companion requirements. Add a distinct corrected/replacement entity relationship and explicit original payer reference where required; do not locally void sent claims or overwrite attempts. Persist payer-specific replacement frequency/control identifiers. Keep per-payer send gate and external enrollment provenance.

**Frontend:** timeline action for payer-side correction only when supported; display unsupported correction route as held/manual with required evidence. Keep ordinary void for unsent/local drafts.

**API/DB:** additive replacement relation/state transition and audit; uniqueness and RLS follow existing organization/provider/location/claim scope. No change to M23/M24 tables.

**Permissions/edge cases:** latest submitted original, rejected original, accepted/adjudicated original, in-doubt original, secondary payer, corrected claim itself corrected, duplicate idempotency, stale auth/enrollment.

**Focused tests:** selected payer route contract tests, replacement link, original immutable, dual sends prevented, exact payer identifier, out-of-scope patient/provider denied, in-doubt cannot be corrected until reconciled.

**Acceptance:** one selected payer's entire supported path passes with sandbox/fixture contract; other payer routes remain gated.

**External blockers:** payer-specific 837I/edit/correction guides, enrollment and approved test environment.

## BIL-2.4 — M24 State-Specific Readiness & Submission Slice

**Business objective:** let users identify state/channel eligibility before assembly and complete an approved state-specific electronic or manual workflow.

**Reuse:** M24 route refusal, adapter registry, state channel health, per-provider trading-partner credentials, claim state machine, validation and submission timeline.

**Source areas:** `packages/medicaid-adapters/src/{registry,oregon,interface}.ts`; `apps/backend/src/modules/24-billing-medicaid/{routes, jobs}`; M24 workbench, assembly wizard and credential screen.

**Backend:** define readiness DTO derived from state, MCO, provider credential, active adapter and gateway; expose no secret. Keep unsupported state failure before claim submission outbox. For Oregon, replace modeled protocol only from confirmed OHA/CCO contract; if not available, improve blocked/manual workflow and do not transmit.

**Frontend:** state/channel availability before claim build; explain whether state, CCO, credential, gateway, catalog or required clinical data blocks; link correct setup/help.

**API/DB:** readiness endpoint may be read-only; add state-specific metadata/config only after partner contract. Preserve existing M24 schema and direct adapters.

**Permissions/edge cases:** FFS vs MCO, provider-specific credentials, state changes within coverage window, unsupported route, gateway health stale, manual portal entry, replace/void state rules.

**Focused tests:** each registered state outcome, missing/expired provider credential, route by MCO, no Claim.MD fallback, no outbox on refusal, safe status DTO, Oregon fixture gateway only.

**Acceptance:** users know if an electronic claim can be sent before assembly; only a verified state adapter can enqueue; unsupported routes remain manual and auditable.

**External blockers:** state/MCO companion guides, MMIS/CCO test account and enrollment.

## BIL-2.5 — Cross-Module Claim Work Completion & Cumulative Certification

**Business objective:** verify staff can finish the common tasks across Medicare, commercial and Medicaid without merging their payer-specific rules or status meanings.

**Reuse:** existing queues, claim details, histories, M25 remittance links, BIL-1 identity/ack foundations and all prior focused tests.

**Source areas:** billing navigation/screen registries, module-specific claim queue/detail and API client contracts, reports under `audit/billing/BIL-2.*`.

**Backend:** close only demonstrated cross-module contract gaps; prove permission/provider scopes and shared identifiers; no universal billing state engine.

**Frontend:** common task vocabulary and route blocker explanation, filters and empty/error/loading patterns; no workspace redesign or new unrelated features.

**DB/API:** only additive contract corrections found by integrated scenario; no broad shared claims table.

**Focused/cumulative tests:** synthetic two-tenant multi-provider scenarios, M23/M41 shared Claim.MD responses, M24 state isolation, M25 posted/unposted remittance references, correction history, route permissions and status provenance; run full BIL-2-relevant Billing suite once at phase end.

**Acceptance:** vertical scenarios finish with durable attempts/history, correct payer/provider/tenant, no unsupported route, no duplicate send or financial effect, and coherent UI actions.

**External blockers:** controlled test account and approvals; keep them separate from source/test readiness.
