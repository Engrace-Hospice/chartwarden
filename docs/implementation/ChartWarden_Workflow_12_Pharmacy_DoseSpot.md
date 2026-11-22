# ChartWarden — Workflow 12: Pharmacy / DoseSpot Integration & UX Redesign

**Destination:** `docs/implementation/12-pharmacy-dosespot-workflow-redesign.md`
**Executor:** Claude Code
**Status:** PROPOSED — mandatory audit and approval gate
**Sequence:** Workflow 11 Medication Orders → **12 Pharmacy / DoseSpot** → 13 Medication Administration (eMAR)
**Baseline:** Static source inspection of uploaded `chartwarden-main.zip` (November 2026). No runtime, live database, external vendor account, sandbox, production transmission, or test execution verified during preparation.

## 0. Executive decision

Design **one comprehensible pharmacy operations experience** around the existing M12 DoseSpot integration and M11 Orders boundaries. Preserve distinct clinical-order authorization, prescription transmission, vendor acknowledgement, pharmacy action, refill decision, patient synchronization, and medication reconciliation states. Do not rebuild M11 or conflate e-prescribing with eMAR.

**Critical baseline finding:** `apps/backend/src/modules/12-dosespot/jobs/vendor-boundary.ts` explicitly documents that the `@chartwarden/dosespot` client is an **unbound, typed, fail-closed deny-stub** and says no DoseSpot credential/base-URL resolver exists in that code snapshot. The module inventory also says `dosespot.epcs` is OFF in Phase 1 and controlled-substance signing is a deny-stub. **Do not claim live pharmacy connectivity or EPCS readiness based on the presence of queues, adapters, routes, UI, or tests.** Reverify current branch, flags, vendor contract and actual network capability in WP0.

### Desired experience

1. Clinician opens a patient medication order and sees clinical authorization status separately from prescription delivery status.
2. An authorized prescription is submitted to an idempotent, auditable transmission queue only when the server and vendor integration are actually enabled.
3. Staff can see *not sent*, *queued*, *processing*, *vendor accepted*, *vendor rejected*, *delivery uncertain*, *needs attention* or equivalent **only where authoritative backend events support them**.
4. Pharmacy-related exceptions route to the right authorized user with a clear next action; users cannot bypass clinical signature or safety checks.
5. Refills, cancellation/change requests, pharmacy responses and patient sync are visible in appropriate worklists, not hidden across unrelated screens.
6. If vendor integration is not configured, show a truthful unavailable/degraded state and a clinically safe alternative workflow defined by agency policy; never simulate a successful prescription.

## 1. Evidence-based repository anchors — revalidate before editing

These files were observed in the uploaded archive. Presence is **not proof of production operation**.

| Area | Source path | Audit focus |
|---|---|---|
| M12 inventory | `apps/backend/src/modules/12-dosespot/M12_DR_INT_INVENTORY.md` | Split DR tiers, external dependency, EPCS phase flag, recovery assumptions |
| Vendor boundary | `apps/backend/src/modules/12-dosespot/jobs/vendor-boundary.ts` | Unbound vendor client and fail-closed integration; patient-sync resolvers |
| Transmission | `apps/backend/src/modules/12-dosespot/jobs/transmit-newrx.ts` | Queue-to-vendor submission, retries, ownership, idempotency |
| Settlement | `apps/backend/src/modules/12-dosespot/jobs/transmit-settle.ts` | State settlement, acknowledgement mapping, unknown outcomes |
| Recovery | `apps/backend/src/modules/12-dosespot/jobs/transmission-sweep.ts` | Reconciliation of stalled/uncertain work |
| Vendor abstraction | `apps/backend/src/modules/12-dosespot/jobs/wiring.ts`, `jobs/worker.ts`, `jobs/queue-catalog.ts`, `jobs/queues.ts` | Real runtime binding, flags, jobs and worker deployment |
| Preflight | `apps/backend/src/modules/12-dosespot/jobs/sync-preflight.ts`, `jobs/sync-outcome.ts` | Safe sync readiness and error classifications |
| API | `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `dosespot-typebox.ts`, `routes/service.ts` | Server contracts, tenant/actor guards, operations |
| Patient sync | `apps/backend/src/modules/05-patient/seams/dosespot-sync-snapshot-for-org.ts`, `apps/backend/src/modules/12-dosespot/jobs/patient-sync-store.ts` | Demographic mapping, consent, provenance, freshness |
| Medication UI | `apps/web/src/modules/12-dosespot/patient-medications.tsx`, `medication-detail.tsx`, `medication-status.ts`, `medication-workspace.ts` | Existing status model and clinical/pharmacy separation |
| Transmission UI | `apps/web/src/modules/12-dosespot/held-transmission-modal.tsx`, `retransmit-modal.tsx` | Holds, retries, authorization, duplicate-prevention UX |
| Prescribing UI | `apps/web/src/modules/12-dosespot/prescribe-modal.tsx`, `sign-inbox.tsx` | Sign vs transmit actions, role-gated navigation |
| Refills UI | `apps/web/src/modules/12-dosespot/refill-inbox.tsx`, `refill-detail.tsx`, `refill-decision-modal.tsx` | Incoming requests, review, approval/denial, SLA |
| Reconciliation | `apps/web/src/modules/12-dosespot/medication-reconciliation.tsx` | Reported/verified medication vs pharmacy records |
| Prescriber admin | `apps/web/src/modules/12-dosespot/prescriber-roster.tsx`, `prescribing-policy.tsx` | Role/credential policy, configuration separation |
| External package | Search for `packages/*dosespot*` and `@chartwarden/dosespot` | Actual client implementation, deny-stubs, vendor schemas |
| Tests | `apps/backend/__tests__/dosespot-workflow-acceptance.test.ts`, `dosespot-routes.test.ts`, `dosespot-seams.test.ts`, `dosespot-refill-inbox-sql.test.ts` | Test realism, fake-vendor coverage, live integration gaps |
| Vendor fake | `apps/backend/__tests__/_fake-dosespot-vendor.ts` | Distinguish mock success from real provider acceptance |
| Tenant tests | `apps/backend/__tests__/m12-tenant-dosespot-routes.test.ts`, `m12-tenant-dosespot.live.test.ts` | Isolation, live DB scope and test prerequisites |
| Frontend tests | `apps/web/src/modules/12-dosespot/medication-writes.dom.test.tsx`, `medication-status.test.ts` | Status rendering and write controls |
| Adjacent M11 | `apps/web/src/modules/11-orders/held-transmissions.tsx`, `resend-transmission.tsx` | Avoid duplicate queues and state authority |
| Adjacent dispensing | `apps/backend/__tests__/m21-pharmacy-dispense.live.test.ts` | Determine what pharmacy dispense evidence actually means |

**Specific source observations:**

- The M12 DR inventory describes medication-order writes as decoupled from external DoseSpot transport and identifies distinct recovery objectives. Treat those objectives as documented design targets, not tested SLAs.
- `vendor-boundary.ts` documents the unbound DoseSpot client and the need to use M5 patient data through an exported seam rather than cross-module table reads.
- `refill-inbox.tsx` documents a 48-hour warning and 72-hour critical **UX hint**, while describing the server as the authoritative SLA owner. Confirm whether these thresholds are vendor/agency operational policies, not universal regulatory deadlines.
- M12 inventory says EPCS is OFF in Phase 1; verify current status, identity proofing, two-factor, audit and applicable controlled-substance regulations before any activation work.
- Do not infer that a `transmit-settle` worker proves a prescription reached a pharmacy; inspect event semantics and external response contracts.

## 2. WP0 — Mandatory current-state audit (NO APPLICATION CHANGES)

Create `docs/implementation/evidence/12-pharmacy-dosespot-current-state.md` with exact file/line evidence, commit SHA and commands. Include:

### 2.1 End-to-end journey and ownership

- Diagram patient → M11/M12 order → clinical review → signature → queue → vendor adapter → vendor response → pharmacy/clinician follow-up.
- Trace *all* frontend entry points, routes, redirects, action modals, status labels, queues and deep links.
- Inventory exact domain entities, source of truth, identifiers, version numbers, event/outbox names and authoritative state machines. Mark vendor, pharmacy and internal states separately.
- Map refill, cancellation/change, patient sync, pharmacy selection, benefit checks and dispense evidence, distinguishing implemented from designed/deferred.
- Document which actors can draft, sign, transmit, retry, reconcile, approve refills, alter prescriber settings and view sensitive medications.

### 2.2 External integration truth table

For every feature, record **IMPLEMENTED & LIVE-VERIFIED / IMPLEMENTED BUT UNVERIFIED / MOCK ONLY / STUB / DISABLED / NOT PRESENT**:

| Capability | Evidence to demand |
|---|---|
| DoseSpot credentials and vendor contract | Secure secret resolver, environment, account tenancy, approved use |
| Client binding | Concrete runtime client replacing deny-stub, no unsafe fallback |
| NewRx | Real request/response mapping, test prescription evidence |
| Pharmacy directory | Vendor-backed selection and location identity |
| Acknowledgements | Provider-defined meanings, correlation IDs, unknown states |
| Refills | Request intake, actor decision, response and audit |
| Cancel/change | Vendor-supported message types and outcomes, if any |
| Patient sync | Mapping, deduplication, race handling and patient-identity safeguards |
| Rx benefit | Vendor capabilities, payer-specific limitations, stale response behavior |
| EPCS | Identity proofing, access control, 2FA, DEA requirements, vendor certification |
| Webhooks/polling | Authentication, replay protection, signature validation, order correlation |
| Failover/recovery | Circuit breaker, queue retention, replay, dead-letter, reconciliation |
| Dispense confirmation | Actual source and semantics; not inferred from transmission |

**Stop gate:** If the vendor is unbound or the necessary contract/credentials are absent, do not implement a fake production adapter. Produce a vendor-integration dependency list and a UX-only scope that accurately shows disabled/degraded states. Vendor credentials and PHI must never be committed or included in AI prompts.

### 2.3 Reliability, security and compliance evidence

- Verify idempotency keys and uniqueness for every external submission, webhook and retry; inspect concurrent workers and timeout/unknown-outcome handling.
- Verify durable queue/outbox transaction boundaries; prevent lost writes and duplicate prescriptions.
- Inspect vendor webhook authentication, timestamp/replay controls, payload limits, dead-letter policy, and data minimization.
- Validate tenant and patient isolation in UI, routes, database queries, jobs, vendor account mapping and logs.
- Verify prescription contents are not leaked through logs, analytics, notifications or browser storage.
- Confirm permitted PHI flow, BAAs/subprocessor agreements, retention, audit evidence, access control and security review.
- Confirm that EPCS and state pharmacy/prescribing laws are reviewed by qualified compliance/legal staff; no UI design can substitute for authorization.
- Record what happens during DoseSpot outage, partial transmission, stale data, patient merge, admission discharge, discontinued order, revoked access and prescriber credential expiry.

### 2.4 Testing baseline

- Record `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, `NOT_RUN` accurately; no test success claims without command output.
- Run scoped typecheck, lint/Biome, module tests and architecture gates **only if environment supports them**.
- Use synthetic patient and medication data; no real PHI or production prescriptions.
- Report current UI screenshots and a proposed navigation map for desktop/tablet/mobile.

**WP0 approval package:** evidence document, current-vs-target journey, route/state matrix, capability truth table, screenshots/wireframes, risk register, exact changed-file proposal, dependency list, and PR sequence. **STOP for user approval before WP1.**

## 3. UX specification — Pharmacy Operations

### 3.1 Patient-level prescription status

Within the existing Medication Workspace, add a clearly labeled **Prescriptions & pharmacy** section (do not create a second medication list). Show:

- Medication identity, strength and directions from the authorized order.
- Clinical authorization: draft / awaiting signature / signed / discontinued (actual backend enums only).
- Transmission: not submitted / queued / processing / accepted by vendor / rejected / outcome unknown (only when backed by evidence).
- Pharmacy name and location only when verified, not free-text assumptions.
- Last authoritative update, action owner, next safe action, and source of status.
- One accessible details drawer/page showing event timeline and authorized retry/correction options.

**Critical copy rule:** “Sent to DoseSpot” ≠ “Accepted by pharmacy” ≠ “Dispensed” ≠ “Administered.” Never use “delivered” without defining the exact recipient and evidence.

### 3.2 Pharmacy Operations worklist

A unified task-focused worklist for authorized roles, using existing `@chartwarden/ui` and Lantern tokens:

1. **Needs attention** — held, rejected, unknown outcome, expired authorization, invalid pharmacy, sync errors.
2. **Awaiting action** — queued, prescriber follow-up, pending refill decisions.
3. **Completed/History** — verified terminal outcomes and audit trail.

Each row: patient identifier (minimum necessary), prescription summary, reason, responsible role, authoritative timestamp, severity, source, and a direct permitted action. Filters: patient, issue, assigned user, status, date; search must respect server authorization. Do not imply a combined queue is a new source of truth; link actions back to M11/M12 owners.

### 3.3 Transmission detail and safe resolution

Use a consistent details layout:

- **Summary:** authorized order, patient, prescriber, selected pharmacy, transmission state.
- **Timeline:** signed → queued → attempted → vendor response → reconciliation; omit unsupported steps.
- **Issue:** plain-language explanation and next steps; distinguish temporary outage, validation rejection, authentication failure, and unknown outcome.
- **Actions:** retry only with verified idempotency and server authorization; correct through amendment/new order rules; escalation to authorized prescriber or support.
- **Evidence:** correlation IDs and redacted technical metadata for staff with permission; raw vendor payloads limited to audited privileged diagnostics.

Do not automatically retry a transmission with uncertain outcome unless the vendor and backend guarantee deduplication or a reconciliation step has resolved the uncertainty.

### 3.4 Refills and pharmacy requests

Preserve `refill-inbox`, `refill-detail`, `refill-decision-modal` as the source worklist and decisions. Improve the path:

Incoming refill → verify patient/source prescription → assess current order and eligibility → authorized approve/deny → vendor response → track final result.

- Surface request age and due-date hints only when backed by server policy.
- Explain clinical implications of approval, rejection and requested modifications.
- Require explicit prescriber authorization; no automatic clinical approval.
- Handle duplicate requests, discontinued orders, expired prescriber credentials, mismatched pharmacy, late requests and failed vendor responses.
- Preserve full audit, including reason and identity of the decision-maker.

### 3.5 Patient sync and configuration

- Separate **Agency pharmacy configuration** from routine bedside tasks.
- Show actual vendor connectivity state (unconfigured, disabled, test, degraded, connected) only if verified by backend health/config endpoints; never infer health from the existence of environment variables.
- Provide authorized administrative diagnostics without exposing secrets.
- Make patient demographic sync status and mismatches actionable; do not silently overwrite verified clinical identity.
- Preserve M5 patient ownership and M12 integration ownership; all cross-module data through published seams.

### 3.6 Mobile and accessibility

- One primary action per view; avoid nested modals for clinical decisions.
- Responsive worklist with readable status, plain language, 44px-class touch targets, keyboard navigation, visible focus, WCAG AA contrast and accessible error summaries.
- Never communicate high-risk status by color alone; include text and icon.
- Offline mobile may show last-known state but **must not claim submission** until authoritative server confirmation; do not queue unsanctioned prescribing writes locally.

## 4. Engineering work packages

### WP1 — Navigation and information architecture

**Scope:** audit and consolidate patient-level pharmacy navigation, global exception queues, refill entry points and admin configuration links. Preserve route compatibility and deep links; add redirects only with regression coverage.

**Deliverables:** approved screen map, route/action ownership matrix, Lantern-compliant page shell and empty/loading/error/degraded states.

**Acceptance:** users can find prescription status, refill queue and failed transmission without knowing M11/M12 module names; no authorization regression.

### WP2 — Prescription status projection and timeline

**Scope:** implement a read-only status presentation using authoritative backend state and event history. Prefer existing API contracts; propose minimal read-only endpoints only after WP0 confirms gaps.

**Acceptance:** no invented statuses, no conflation of internal queue success with vendor acceptance; unknown outcomes remain unknown; timeline ordering deterministic and audited.

### WP3 — Transmission exception worklist

**Scope:** consolidate held/rejected/unknown outcomes into a navigable operations view; reuse existing server write operations and roles; show safe resolution paths.

**Acceptance:** retry unavailable when unsafe, missing idempotency, insufficient authorization, revoked prescriber or unresolved unknown outcome; no duplicate sends on double-click or concurrent workers.

### WP4 — Refill and pharmacy-request usability

**Scope:** improve existing refill inbox/detail/decision journey, preserve server policy and clinical review; do not expand vendor capabilities without evidence.

**Acceptance:** request can be traced from receipt to final authoritative response, with duplicate handling, errors, role gating and audit trail.

### WP5 — Vendor integration readiness (CONDITIONAL)

**Scope:** only after explicit vendor approval, secure contract/BAA, supported API documentation, integration account, secret management and sandbox access. If not available, deliver a **blocked dependency report**, not fabricated transport.

If authorized and available, implement typed vendor adapter binding, credential rotation, request/response mapping, webhook verification, retry/unknown-outcome reconciliation, structured redacted logging, tenant routing, circuit breakers and contract tests. Keep vendor integration behind existing abstractions.

**Acceptance:** synthetic sandbox proof with correlation IDs and negative tests; no production go-live until a separate deployment approval and clinical safety sign-off. **EPCS remains disabled unless a distinct, reviewed EPCS project authorizes it.**

### WP6 — Reliability, compliance, QA and rollout

**Scope:** targeted unit/contract/integration/UI tests; tenant isolation; fault injection; accessibility; observability; runbooks; flags; rollback.

**Acceptance:** all mandatory gates pass, or blockers documented; deployment is reversible without loss of queued clinical orders; no PHI in telemetry.

## 5. Mandatory test scenarios (synthetic data)

| ID | Scenario | Expected invariant |
|---|---|---|
| P12-01 | Signed order with vendor disabled | No network submission; truthful disabled state |
| P12-02 | Unsigned order attempts transmission | Denied server-side |
| P12-03 | Unauthorized user retries | Denied and audited |
| P12-04 | Two workers claim same queue item | At most one effective external send |
| P12-05 | Double-click submit | No duplicate prescription |
| P12-06 | Timeout after uncertain vendor receipt | Unknown outcome; safe reconciliation, no blind duplicate |
| P12-07 | Vendor validation rejection | Accurate rejection and actionable correction |
| P12-08 | Vendor authentication failure | Safe degradation; no secrets exposed |
| P12-09 | Vendor outage / circuit open | Clinical authoring continues; external transmission deferred |
| P12-10 | Retry after recoverable failure | Idempotent and authorized |
| P12-11 | Patient sync missing address/phone | Clear error; no fabricated demographics |
| P12-12 | Wrong-tenant patient mapping | Denied across API, queue, vendor mapping |
| P12-13 | Patient merged during pending sync | No wrong-patient transmission |
| P12-14 | Prescription discontinued before send | Prevent stale transmission |
| P12-15 | Pharmacy location changes | Reverification and safe handling |
| P12-16 | Vendor callback replay | Authenticated, deduplicated, audited |
| P12-17 | Forged webhook | Rejected before PHI mutation |
| P12-18 | Refill approved by wrong role | Denied server-side |
| P12-19 | Duplicate refill request | Single authoritative decision path |
| P12-20 | Refill on discontinued order | Blocked or reviewed per server rules |
| P12-21 | Stale prescriber credential | Cannot sign/transmit where disallowed |
| P12-22 | EPCS flag off | Controlled-substance path fails closed |
| P12-23 | Allergy record unavailable | Existing fail-closed clinical safety preserved |
| P12-24 | Part 2 access denied | No sensitive disclosure through list, search or payload |
| P12-25 | Vendor says accepted, no pharmacy dispense evidence | UI never claims dispensed |
| P12-26 | Status event arrives out of order | Correct authoritative state retained |
| P12-27 | Duplicate acknowledgement | No duplicate transition or alert |
| P12-28 | Job restarts mid-processing | Durable recovery without lost or duplicate send |
| P12-29 | Permission revoked while page open | Next write denied; stale PHI not retained |
| P12-30 | Mobile network interruption | No false success; safe refresh/recovery |
| P12-31 | Keyboard/screen-reader navigation | All status, actions and errors accessible |
| P12-32 | Cross-module M11/M12 worklists | Same task not written twice; ownership preserved |
| P12-33 | Unconfigured vendor credentials | No accidental production traffic |
| P12-34 | Audit and telemetry inspection | PHI and secrets absent from unapproved logs |
| P12-35 | Restore after failed deployment | Queue state and idempotency keys preserved |
| P12-36 | Sandbox-to-production promotion | Explicit sign-off, flags and environment isolation |

**Test evidence:** record command, environment, fixture, expected vs actual, PASS/FAIL/SKIP/BLOCKED/NOT_RUN and linked test file. Do not label a mock vendor acceptance as live pharmacy proof.

## 6. PR sequence and review gates

| PR | Contents | Gate |
|---|---|---|
| PR-0 | WP0 audit, diagrams, truth table, design proposal | **User approval required** |
| PR-1 | WP1 navigation and shared UX shell | UX/accessibility review |
| PR-2 | WP2 status timeline and read projections | Domain-state correctness review |
| PR-3 | WP3 exception worklist and safe actions | Security/reliability review |
| PR-4 | WP4 refill journey | Clinical/prescriber review |
| PR-5 | WP5 vendor adapter **only if authorized** | Vendor sandbox + security approval |
| PR-6 | WP6 regression, runbooks, flags and rollout | Final go/no-go |

Keep changes small and reviewable. Never modify live integration credentials or production flags as part of UI refactoring. Do not alter historical signed orders, audit history, or M11/M12 state machines without explicit reviewed requirements.

## 7. Regulatory and operational guardrails

- Verify applicable CMS hospice Conditions of Participation, 42 CFR Part 418, medication management obligations and state scope-of-practice rules against current authoritative sources before encoding compliance rules.
- E-prescribing and EPCS requirements differ; EPCS must remain disabled unless certified vendor capability, DEA and applicable state requirements, prescriber enrollment/identity proofing, 2FA and audited authorization are confirmed.
- Vendor availability, connectivity, SLA, supported transaction types and pharmacy network behavior must be documented from the vendor agreement and current technical materials, not inferred from code names.
- HIPAA compliance requires a full operational and contractual program; a BAA alone does not prove a safe deployment.
- Never expose vendor credentials, raw sensitive medication payloads or patient identifiers in client logs, analytics, tickets or model prompts.
- Use ChartWarden's existing Lantern tokens and `@chartwarden/ui`; do not invent a new palette or introduce purple-gradient mockup styling.
- Preserve Rust migration boundaries and upstream repository policies; verify active target repository/branch before coding.

## 8. Definition of done

- [ ] WP0 audit accepted, with exact repository evidence and vendor integration truth table.
- [ ] One coherent patient-level pharmacy status journey, without conflating clinical and vendor states.
- [ ] Clear operations worklist for refill, held, rejected and uncertain outcomes.
- [ ] No unsupported claim of pharmacy acceptance, dispense, or controlled-substance capability.
- [ ] All writes use existing authorized server actions; idempotency and audit behavior proven.
- [ ] Tenant, patient, prescriber, Part 2 and medication safety protections regression-tested.
- [ ] Accessible desktop/tablet/mobile UI using Lantern and shared UI primitives.
- [ ] Synthetic fault-injection and recovery tests completed with evidence.
- [ ] Vendor integration remains blocked if required external prerequisites are absent.
- [ ] Documentation, operations runbook, release flags and rollback tested.

## 9. Claude Code execution instruction

> You are implementing ChartWarden Workflow 12 — Pharmacy / DoseSpot. Start with **WP0 only**. Read the current repository, identify the exact branch/commit, inspect all referenced files and relevant architecture/ADR documents, trace actual runtime binding and vendor integration status, and produce `docs/implementation/evidence/12-pharmacy-dosespot-current-state.md`. Verify the unbound-client/EPCS observations rather than assuming they remain current. Provide the actual route/state/capability matrices, screenshots or wireframes, risk register, proposed PR plan and test commands/results. **Stop and request approval before changing application code.** Do not invent vendor functionality, do not send PHI or prescriptions to an unapproved service, do not bypass clinical safety, and do not claim vendor connectivity without real evidence. If the current repository differs, propose amendments to this plan before implementing WP1.

---

**Next workflow:** 13 — Medication Administration (eMAR).
