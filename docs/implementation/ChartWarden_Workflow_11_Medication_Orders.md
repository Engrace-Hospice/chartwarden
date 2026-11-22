# ChartWarden — Workflow 11: Medication Orders Redesign

**Destination:** `docs/implementation/11-medication-orders-workflow-redesign.md`
**Executor:** Claude Code
**Status:** PROPOSED — audit and approval required before application changes
**Sequence:** Workflow 10 EVV → **11 Medication Orders** → 12 Pharmacy / DoseSpot
**Baseline:** Static inspection of the user-uploaded `chartwarden-main.zip` (November 2026). No live application, database, external DoseSpot environment, or automated tests were run during preparation.

## 0. Executive decision

Redesign medication ordering as **one patient-centered, task-oriented workflow** while preserving M11 Orders and M12 DoseSpot as separate authoritative domain modules. Users should know whether they are documenting a clinical order, preparing a prescription, requesting a prescriber signature, transmitting to a pharmacy, or reconciling medication history. These actions are not interchangeable.

**Target journey:** Open patient → review current medications, allergies, relevant clinical context and coverage → start medication order → choose order type and enter structured directions → validate and resolve safety findings → route for authorized prescriber review/signature → transmit when applicable and permitted → monitor acknowledgments, failures, and follow-up → update the patient medication view with clearly distinguished order and dispensing statuses.

**Non-negotiable:** Do not infer that a draft, signed order, transmitted prescription, pharmacy acceptance, dispense event, or administered dose are the same event. Never automatically mark a drug administered because it was ordered or transmitted. Do not allow AI-extracted medications or historical medications to become active prescriptions without explicit authorized clinical review.

## 1. Verified repository anchors (revalidate on current branch)

The following files were observed in the uploaded archive. Their existence does **not** prove complete production behavior.

| Source | Observed purpose / review target |
|---|---|
| `apps/web/src/modules/12-dosespot/patient-medications.tsx` | Patient medication workspace and status-driven navigation. |
| `apps/web/src/modules/12-dosespot/medication-workspace.ts` | Workspace status grouping, KPI definitions, and needs-attention classification. |
| `apps/web/src/modules/12-dosespot/medication-order-editor.tsx` | Medication order editing, data capture, validation and unsaved-change blocking. |
| `apps/web/src/modules/12-dosespot/medication-editor-model.ts` | Draft model hydration/serialization; audit round-trip fidelity. |
| `apps/web/src/modules/12-dosespot/medication-validation.ts` | Frontend validation findings; compare with server rules. |
| `apps/web/src/modules/12-dosespot/medication-detail.tsx`, `medication-action-modal.tsx`, `prescribe-modal.tsx` | Detail, action, and prescribing entry points; identify duplicate steps and terminology. |
| `apps/web/src/modules/12-dosespot/medication-reconciliation.tsx` | Reconciliation workflow; keep separate from new prescription authoring. |
| `apps/web/src/modules/12-dosespot/verbal-orders-queue.tsx` | Verbal order follow-up. |
| `apps/web/src/modules/12-dosespot/prescriber-roster.tsx`, `prescribing-policy.tsx` | Prescriber and policy administration; not ordinary bedside tasks. |
| `apps/web/src/modules/11-orders/patient-orders.tsx`, `order-editor.tsx`, `order-detail.tsx` | General clinical orders and their lifecycle; determine overlap with medication orders. |
| `apps/web/src/modules/11-orders/orders-sign-inbox.tsx`, `cosign-queue.tsx`, `verbal-expiring-queue.tsx` | Signature, cosign and verbal-order worklists. |
| `apps/web/src/modules/11-orders/held-transmissions.tsx`, `resend-transmission.tsx` | Transmission exceptions; do not conflate with signing. |
| `apps/backend/src/modules/12-dosespot/medication-order-safety-gates.ts` | Allergy and Part 2 access safety checks for signature requests. |
| `apps/backend/src/modules/12-dosespot/prescriber-eligibility.ts`, `prescribing-physician-check.ts` | Prescriber eligibility and identity constraints. |
| `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `dosespot-typebox.ts` | API contracts, guards, response codes and write operations. |
| `apps/backend/src/modules/12-dosespot/jobs/transmit-newrx.ts`, `transmit-settle.ts`, `transmission-sweep.ts` | Prescription transmission processing; verify real provider wiring and acknowledgments. |
| `apps/backend/src/modules/11-orders/routes/orders-routes.ts`, `orders-typebox.ts` | General order APIs and lifecycle. |
| `apps/backend/src/modules/11-orders/M11_DR_INT_INVENTORY.md` | Existing disaster recovery and integration notes; distinguish design claims from tested behavior. |
| `apps/backend/__tests__/m12-medication-order-safety-gates.test.ts`, `dosespot-prescribing-physician.test.ts` | Safety and prescriber tests. |
| `apps/web/src/modules/12-dosespot/__tests__/medication-workspace.test.ts`, `medication-order-editor.dom.test.tsx`, `medication-writes.dom.test.tsx` | UI tests to extend, not replace. |

### Observations requiring attention

1. M12's `medication-workspace.ts` explicitly groups `verbal_pending`, `nack_received`, `transmission_failed`, and `expired_unsigned` into **Needs attention**. Audit whether each actionable state is explained with the correct next step and owner.
2. The M12 editor has structured field validation and an unsaved-changes navigation blocker. Preserve these capabilities and verify draft recovery rather than introducing a second unsaved-state mechanism.
3. `medication-order-safety-gates.ts` documents **fail-closed** behavior when allergy data or required Part 2 access cannot be verified. An allergy conflict has a constrained prescriber override with fresh step-up and a documented reason; an unreadable allergy record is not overridable. Keep these exact distinctions and reverify implementation.
4. The M11 inventory describes verbal-order signature timing, asynchronous outbox integration, and degraded operation. Confirm the applicable current regulatory rule and implemented server clocks before displaying countdowns or changing deadlines.
5. M11 has separate sign, cosign, verbal-expiring, and held-transmission queues. Audit whether M12's medication-specific queues and M11's general order queues duplicate tasks or merely provide different projections of distinct records.
6. DoseSpot transmission worker files exist, but this static review does not prove live pharmacy connectivity, delivery, acknowledgment, controlled-substance authorization, or production readiness.

## 2. WP0 — Mandatory evidence-based audit (STOP GATE)

**Do not modify application code in WP0.** Create `docs/implementation/evidence/11-medication-orders-current-state.md` containing:

- Exact branch, commit SHA, working tree status, architecture/ADR references, runtime flags and relevant test scripts.
- **Screen inventory and navigation graph:** patient chart → medication list → create/edit → safety review → signature → prescribing/transmission → status/reconciliation; all alternate global queues and deep links.
- **Entity ownership map:** M11 order records, M12 medication orders/prescriptions, medication history, reconciliation, eMAR administrations, pharmacy transmissions, document outputs. Identify shared IDs and cross-module seams without assuming a single database lifecycle.
- **Route matrix:** each UI action, API path, request/response schema, role/ABAC, tenant and patient scope, idempotency, optimistic concurrency, audit event, and error handling.
- **State transition matrix:** draft, signature requested, signed, verbal, expired, held, rejected, transmission pending, sent, acknowledged, failed, discontinued, renewed and corrected—only include states actually supported; label vendor and domain states separately.
- **Clinical safety matrix:** allergies, contraindication signals if supported, drug interaction checks if supported, medication identity, RxNorm/NDC lookups, dose/route/frequency, PRN indication, max dose, renal/other context if implemented, controlled substance and EPCS checks, Part 2 restrictions, duplicate therapy, discontinued orders. Record missing checks as gaps, not completed features.
- **Prescriber verification:** who may draft, request signature, sign, transmit, cosign, override and discontinue; freshness of step-up; delegated or verbal workflows; provider licensing/DEA/EPCS and organizational policy as applicable.
- **External integration truth table:** DoseSpot sandbox vs production, credentials and BAA posture, pharmacy directory, NCPDP messages, NewRx, cancellation/change/refill support, acknowledgment mapping, idempotency and retries; mark unsupported/unknown explicitly.
- **Worklist behavior:** overdue signatures, expiring verbal orders, failed transmission, NACK, pending authorization, duplicate entries and discontinued orders; task ownership and notification routing.
- **Data integrity:** draft rehydration, concurrency, two users editing, retry after timeout, duplicate submission, partial failure, rollback and patient/admission change.
- **Clinical usability walkthroughs** using synthetic data: routine order, PRN comfort medication, controlled substance, severe allergy conflict, unavailable allergy data, Part 2 restriction, verbal order, rejected prescription, discontinuation and medication reconciliation.
- **Accessibility/mobile:** keyboard, screen reader, error summaries, touch targets, color contrast, plain-language labels, responsive layout and intermittent connectivity.
- **Test evidence:** commands and outcomes, with PASS/FAIL/SKIP/BLOCKED/NOT_RUN distinguished; no fabricated successful tests.
- **Proposed implementation map:** exact files, keep/modify/consolidate/defer decisions, annotated screenshots or wireframes, risk register and PR boundaries.

**STOP:** Present WP0 findings and proposed screens for approval. If repository contracts differ from this document, revise the plan before WP1. No production PHI in test fixtures, screenshots or AI prompts.

## 3. UX design — unified medication workspace

### 3.1 Patient medications landing page

One patient-scoped workspace with clear sections:

1. **Current medications** — active medication information with name, strength, route, schedule, PRN indication, source and last reconciliation date when available. Clearly label incomplete/unverified data.
2. **Needs attention** — actionable safety blocks, signature requests, verbal follow-ups, transmission failures and pharmacy responses, each with owner, urgency and one direct resolution action.
3. **Orders and prescriptions** — distinguish clinical order status from external prescription transmission and dispensing evidence.
4. **History and reconciliation** — previous, discontinued, historical and patient-reported medications, not silently mixed with current orders.

The header should show patient safety identifiers and admission context, permitted role actions, and a clear **New medication order** primary action. Do not place administrative prescriber-roster or policy controls in the clinician's main flow.

### 3.2 Guided medication order composer

Use one coherent composer with progressive disclosure, not unrelated forms and modals:

**Step 1 — Medication:** search/select medication; identify generic/brand, strength, formulation, and structured coding where available. Display look-alike/sound-alike or uncertain identity warnings if backed by verified data; never invent a drug match.

**Step 2 — Directions:** dose, units, route, frequency, start/end, quantity/refills when applicable, PRN indication and limits, clinical reason and pharmacy selection for prescriptions. Use explicit units; prevent unsafe free-text substitution where structured data is required.

**Step 3 — Clinical review:** show allergies, relevant safety findings, duplicates and outstanding data. Present source, severity and action required. Acknowledge conflicts only through existing authorized backend override paths; no UI-only bypass.

**Step 4 — Review and route:** concise order summary, patient and prescriber identity, what happens on submit, and role-dependent action (`Save draft`, `Request signature`, `Sign`, `Transmit` only if the server allows it). Never label a signature request as a transmitted prescription.

Support safe save-and-resume, inline errors with summary links, deterministic form serialization, keyboard navigation, and explicit unsaved changes. Preserve original order identity and version history.

### 3.3 Status presentation and error recovery

Show three independent dimensions when applicable:

| Dimension | Example labels | User question answered |
|---|---|---|
| Clinical order | Draft / Awaiting signature / Signed / Discontinued | Is the order clinically authorized? |
| Prescription delivery | Not submitted / Queued / Sent / Acknowledged / Rejected / Unknown | What happened with the external transmission? |
| Medication list | Reported / Reconciled / Active / Historical | What is known about current therapy? |

**Labels are examples, not approved domain enums.** Map only from server-returned states after WP0. Unknown must remain unknown; never infer pharmacy acceptance from transport success. Show a safe retry only if the backend supports idempotent resend and actor authorization. Every error should have a clear next action without exposing PHI in logs or notifications.

### 3.4 Prescriber and supervisor queues

Create consistent worklist layout and naming for medication signatures, verbal orders, cosigns, and transmission exceptions. Preserve M11/M12 source ownership; a combined view may link to the source action but must not duplicate writes. Show due date, patient, order summary, requested action, owner, and escalation. Apply privacy redaction to sensitive medication data and respect Part 2 access decisions.

## 4. Work packages after WP0 approval

### WP1 — Navigation, information architecture and design contracts

- Produce wireframes for patient medication workspace, order composer, prescriber inbox, verbal follow-up, safety finding, and transmission exception.
- Use existing **Lantern** design tokens, shared `@chartwarden/ui` components, typography and spacing; do not introduce purple/gradient AI-style design or arbitrary palette tokens.
- Define role-specific entry points and one primary action per stage; use plain-language copy and a consistent patient context banner.
- Inventory and preserve existing URLs/deep links; redirect only where compatibility is proven.
- Deliver accessible desktop and mobile layouts; no new backend endpoints unless a documented contract gap requires approval.

**Acceptance:** A clinician can identify the correct next action without navigating through multiple unrelated modules; every proposed UI action maps to a real authorized server operation.

### WP2 — Patient medication workspace

- Refactor `patient-medications.tsx` into maintainable views/components with explicit current, needs-attention, orders, and history sections.
- Preserve existing API adapters, pagination, search, filters, error/loading/empty states and sensitive-data rules.
- Normalize status copy in presentation only; do not mutate server enums or invent lifecycle state.
- Show missing medication details as **Unverified / Information needed**, not fabricated defaults; block unsafe actions according to actual backend rules.
- Keep reconciliation actions distinct from prescription creation and medication administration.

**Acceptance:** Staff can locate an active medication, a pending signature, a failed transmission and a historical medication without confusing their meanings.

### WP3 — Guided order authoring and safety review

- Restructure `medication-order-editor.tsx` around four guided steps using existing model and validation utilities.
- Verify draft hydration/serialization and preserve unsaved-change blocking.
- Make required field errors actionable; ensure no hidden required fields in collapsed panels.
- Surface allergy conflicts, unreadable allergy data, Part 2 access decisions and prescriber restrictions from authoritative server responses.
- Preserve fresh step-up and documented override reason where required; never implement override by client-side boolean.
- Preserve special cases for controlled substances, compounded orders and verbal orders, with additional fields only when supported.

**Acceptance:** No client-side path can request signature or transmission while server safety checks fail; invalid or partially entered medication identity cannot silently become a valid order.

### WP4 — Signatures, verbal orders and prescriber workflow

- Clarify draft, requested, signed, cosign and verbal order states; ensure deadlines are server-derived.
- Integrate role-aware entry points from patient workspace to existing M11/M12 queues.
- Present exactly who must act next and why; show blocked/expired conditions distinctly.
- Preserve order audit history, attestation and correction pathways; no destructive edits to signed orders.
- Confirm any regulatory timing with current legal/compliance sources before changing rules.

**Acceptance:** Prescribers can safely review and sign permitted orders; non-prescribers cannot sign; overdue/expired verbal orders remain visible and actionable only through approved workflows.

### WP5 — Prescription transmission and reconciliation

- Display transmission attempts, statuses and acknowledgments from existing backend sources; differentiate retryable from terminal failure.
- Reuse authorized resend/recovery APIs; do not create blind duplicate NewRx submissions.
- Show pharmacist/pharmacy follow-up clearly where required and supported.
- Keep medication reconciliation separate from ordering; identify reported, extracted, confirmed and discontinued items.
- Verify the boundary with Workflow 12 Pharmacy/DoseSpot and Workflow 13 eMAR; avoid implementing their entire scope in this PR.

**Acceptance:** A failed/unknown transmission never appears as successfully dispensed; retries preserve idempotency and auditability; reconciliation cannot silently create prescriptions.

### WP6 — Validation, accessibility, observability and rollout

- Extend DOM/component tests, route authorization tests, state-transition tests, live-DB tests where available and end-to-end journeys with synthetic patients.
- Verify tenant and patient isolation on all reads/writes and queued actions.
- Ensure screen-reader labels, keyboard focus, high contrast, 200% zoom and mobile layouts.
- Instrument PHI-safe usability telemetry: completion time, abandon/retry rate, validation blockers, queue aging and failure categories; no drug names, free text or patient identifiers in generic telemetry.
- Roll out behind an approved flag if needed; document rollback preserving order and transmission data.

**Acceptance:** Existing safety tests remain green, critical flows pass end-to-end, and rollback restores the previous UI without data migration or loss.

## 5. Minimum test matrix

| ID | Scenario | Expected outcome |
|---|---|---|
| MED-01 | Open medications from correct patient chart | Patient and tenant context preserved |
| MED-02 | Attempt cross-tenant medication access | Server denies; no data leak |
| MED-03 | Create routine draft and resume | Fields and version restored accurately |
| MED-04 | Leave with unsaved changes | Explicit warning, no silent loss |
| MED-05 | Required drug identity missing | Cannot advance as valid order |
| MED-06 | Missing dose/route/frequency | Actionable validation; no unsafe signature |
| MED-07 | PRN medication without required indication/limits | Backend-appropriate validation |
| MED-08 | Allergy conflict | Clear warning; authorized fresh-step-up override only where allowed |
| MED-09 | Allergy reader unavailable/unreadable | Signature request denied; no bypass |
| MED-10 | Part 2 access restricted | Deny or redact according to server decision |
| MED-11 | Unauthorized actor requests signature | Denied by backend |
| MED-12 | Authorized prescriber signs | Signature and audit recorded once |
| MED-13 | Prescriber eligibility stale or invalid | Denied with safe remediation |
| MED-14 | Controlled-substance order | EPCS and identity gates enforced where applicable |
| MED-15 | Compounded medication | Ingredient/strength data round-trips |
| MED-16 | Verbal order recorded | Server-derived deadline and follow-up visible |
| MED-17 | Verbal signature deadline expires | No false on-time completion |
| MED-18 | Concurrent edits | Conflict handling; no silent overwrite |
| MED-19 | Duplicate submit/retry | No duplicate order or prescription |
| MED-20 | External transmission pending | No false pharmacy acceptance |
| MED-21 | Transmission NACK/failure | Visible owner, reason and safe next action |
| MED-22 | Resend after uncertain outcome | Reconciliation/idempotency prevents duplicate send |
| MED-23 | Discontinue medication | Correct downstream state; historical audit retained |
| MED-24 | Reconcile reported medication | Does not silently prescribe/administer |
| MED-25 | Extracted medication with conflicting source | Human verification required |
| MED-26 | Signed order amendment | Correct addendum/correction, original preserved |
| MED-27 | Mobile screen and keyboard | Complete workflow with accessible controls |
| MED-28 | Screen reader, 200% zoom, high contrast | WCAG 2.2 AA-oriented checks |
| MED-29 | Failed API/save and retry | Clear status and safe recovery |
| MED-30 | PHI in logs, errors, analytics, push previews | No prohibited disclosure |
| MED-31 | Background worker outage | Clinical write path and queue visibility behave as designed |
| MED-32 | Patient discharged / admission closed | Existing discontinuation and authorization rules preserved |
| MED-33 | Order versus eMAR | No dose marked given from prescription alone |
| MED-34 | Regression: M11 and M12 worklists | No lost tasks or duplicate actions |
| MED-35 | Feature flag rollback | Prior UI works without data corruption |
| MED-36 | Live DoseSpot test environment unavailable | Test marked BLOCKED, not PASS |

## 6. Proposed pull requests and gates

| PR | Scope | Required gate |
|---|---|---|
| PR-0 | WP0 evidence, navigation/API matrices, proposed wireframes | **Human approval before application code** |
| PR-1 | WP1 navigation and shared UX contracts | Design review; no backend changes |
| PR-2 | WP2 patient medication workspace | Patient isolation, statuses and DOM tests |
| PR-3 | WP3 order composer and safety review | Allergy/Part 2/EPCS regression suite; security review |
| PR-4 | WP4 signature, verbal and prescriber worklists | Signature/role/deadline tests; clinical approval |
| PR-5 | WP5 transmission status and reconciliation | Idempotency, vendor mapping, reconciliation tests |
| PR-6 | WP6 E2E, accessibility, observability and rollout | Release approval and rollback rehearsal |

Keep PRs reviewable; avoid opportunistic changes to M11/M12 state machines, pharmacy integrations, medication database schemas or clinical policies. Any necessary backend fix must be separately justified with contract tests and a migration/rollback plan.

## 7. Mandatory safety and compliance boundaries

- HIPAA minimum necessary, access controls, immutable audit evidence and tenant-scoped access must be enforced server-side.
- Respect 42 CFR Part 2 restrictions when applicable. The M12 safety gate uses a session-derived membership actor and denies signature requests when required access cannot be established.
- Never expose restricted medication details in search suggestions, cross-patient worklists, notifications or telemetry without appropriate authorization.
- Never permit frontend overrides of allergy uncertainty, prescriber eligibility, EPCS requirements or signed-order immutability.
- Controlled-substance prescribing and electronic prescriptions require current federal/state/vendor-specific verification; UI parity is not evidence of EPCS compliance.
- Maintain separate evidence for order authorization, prescription transmission, pharmacy response, dispensing and actual medication administration.
- Keep medication history, orders, medication reconciliation and eMAR linked but semantically distinct.
- Clinical and compliance reviewers must sign off on any change to drug safety behavior, verbal-order timing or prescriber authentication.

## 8. Definition of done

1. WP0 completed with source-backed evidence and explicit approval.
2. Each task in the redesigned workflow has one obvious next action, owner and status.
3. Existing M11/M12 API contracts and server state machines are preserved unless separately approved.
4. Medication safety, access restrictions, signature and EPCS checks are not weakened.
5. No false claims of pharmacy acceptance, dispensing, or medication administration.
6. All 36 test scenarios are executed or honestly recorded as BLOCKED/NOT_RUN with rationale; release blockers resolved.
7. Relevant unit, integration, live-DB and E2E suites pass in the intended environment.
8. Accessibility and responsive layouts are verified, not only visually inspected.
9. Feature rollout and rollback procedures are documented and rehearsed.
10. Documentation and traceability updated with exact source files, routes, screenshots and test outputs.

## 9. Claude Code execution instruction

> You are implementing ChartWarden Workflow 11: Medication Orders. Read this entire plan, inspect the CURRENT branch and the M11/M12 source, relevant ADRs, schemas, security gates, design tokens, and existing tests. **Execute WP0 only. Do not change application code yet.** Produce `docs/implementation/evidence/11-medication-orders-current-state.md` with exact findings, workflow maps, contract matrix, risk register, screenshots where feasible, proposed wireframes and PR scope. Separate verified facts from assumptions and planned features. Stop and request explicit approval before WP1. After approval, implement in small PRs with evidence-based tests. Never bypass server clinical safety, prescriber identity, controlled-substance requirements, tenant isolation, or Part 2 protections. Do not claim any test or live pharmacy integration passed unless actually executed and verified.

**Next workflow:** 12 — Pharmacy / DoseSpot.
