# WardenX — Business Logic, Workflows &amp; Functionality (As Built)

This document describes the business logic **actually implemented in code** across WardenX's 40
modules — state machines, validation rules, calculation logic, and cross-module workflows. It is
grounded in `apps/backend/src/modules/*` and the backing `packages/*` domain libraries, not in
`docs/modules/*` specs (which are implementation *proposals* and may describe things not yet
built — see the repo's [`CLAUDE.md`](../CLAUDE.md) authority rule).

Where a workflow, seam, or rule is explicitly **not yet wired** (a deny-stub, an unbound seam, a
fail-closed placeholder), this doc says so — that distinction is load-bearing throughout the
codebase and is preserved here rather than smoothed over.

> For build-progress metrics (route counts, test coverage, enrichment ratios) see
> `audit/implementation-status/IMPLEMENTATION_STATUS.md` and `audit/openapi-coverage/OPENAPI_COVERAGE.md` —
> this document is about *what the logic does*, not how complete the build is.

---

## Contents

1. [Platform foundation (M1–M4)](#platform-foundation-m1m4)
2. [Clinical core (M5–M14, M17, M18, M22)](#clinical-core)
3. [Field / ops tier (M15, M16, M19–M21, M37)](#field--ops-tier)
4. [Revenue cycle (M23–M27)](#revenue-cycle)
5. [Integration &amp; quality (M28–M30)](#integration--quality)
6. [Platform services &amp; portal (M31–M40)](#platform-services--portal)
7. [Cross-cutting patterns](#cross-cutting-patterns)

---

## Platform foundation (M1–M4)

### M1 — Foundation (`apps/backend/src/bootstrap`)

Not a numbered module directory — implemented as the Fastify host/bootstrap layer shared by every
module.

- **Authentication**: resolves a Better-Auth session into `request.context` (userId, orgId,
  roles, membershipId, providerEntityIds, locationIds); a constant-time-compared
  `x-internal-service-token`/`x-internal-org-id` header path authenticates system/machine
  principals (`actorKind: "system"`), mutually exclusive with interactive sessions.
- **Security baseline**: CSP/HSTS/X-Frame-Options on every response; explicit CORS allow-list;
  rate limiting tiered 30/min (unauthenticated, by IP) vs 600/min (authenticated, by org/user),
  over an injectable in-memory or Redis store. The limiter **fails open** on store outage
  (an availability control) — unlike auth/ABAC, which fail closed.
- **CSRF**: double-submit-cookie pattern for mutating methods when a session cookie is present;
  fails closed.
- **Idempotency**: `Idempotency-Key` header + org scope hashed with the request body; identical
  replay returns the cached response, a differing body is `409 IDEMPOTENCY_CONFLICT`.
- **Transactional outbox**: the pattern backing every `mN.*` cross-module event referenced
  throughout this document.

### M2/M3 — Identity &amp; Authorization (ABAC/RBAC)

- **M2 Identity**: session/membership management, tenant-org creation, step-up policy resolver,
  session-context resolver seam consumed by every module's authenticate hook.
- **M3 Authorization**:
  - Named ABAC predicates (`step_up_recent`, `inOrg`, and each module's own registered
    predicates) resolved through a central registry that **fails closed on an unknown name** —
    a typo'd predicate is a permanently-dead, 403-for-everyone endpoint with the whole build
    green.
  - **Break-glass**: a time-boxed (default 4h) emergency-access grant scoped to a single patient
    (never org-wide); whether cosign is required is decided by tenant policy, never the caller.
    An active grant satisfies ABAC denial for that (actor, patient) pair; every individual access
    under it is separately audited at `critical` severity.
  - **Anti-escalation**: role creation/update/assignment calls `assertNoEscalation` — an admin can
    never grant a permission they don't hold themselves; attempts are audited and refused.
  - **Auditor engagements**: a time-boxed, scoped external-auditor engagement mints a magic-link
    session, delivered out-of-band (never returned in the API response).
  - A `system_locked` role's deletion/update enforces a permission-floor.

### M4 — Audit

- **Audit Capture Contract**: every PHI module imports `generateAuditTrigger` (DB-trigger write
  capture on PHI tables), `auditPhiRead`/`auditListRead` (route-level read capture), and
  `declarePhiReadRoute`/`assertReadAuditDeclared` — an **undeclared PHI read route is a
  build-time failure**, not a silent gap.
- **Tamper-evidence**: `GET /api/v1/audit/integrity/report` reads live Postgres ACL grants on
  `audit_event` to verify the app role has no UPDATE/DELETE privilege (append-only enforcement).
- **Legal holds &amp; destruction certificates**: legal holds block destruction; the destruction
  workflow checks for an active hold and records a `partial_refused` status
  (`part_two_retention`) instead of executing when one exists.
- Action-catalog namespace validation ensures every module registers audit actions under its own
  `mN.` prefix.

---

## Clinical core

*(M5–M14, M17, M18, M22)*

### M5 — Patient

- Manages demographics, addresses, coverage, identifiers, deceased status, privacy flags.
- **Patient matching** (deterministic-first, probabilistic-queued): exact MBI / exact SSN+DOB /
  exact DOB+name+address rules fire first and **hard-block** (409, no new patient created).
  Otherwise a weighted probabilistic score (name Jaro-Winkler, address, DOB, phone, email — SSN
  is *never* a probabilistic feature) classifies as `hard_block` (≥0.92), `soft_review`
  (0.75–0.92, patient created + review row per candidate), or `quiet_create`. **Auto-merge never
  happens.**
- **Inbound-proposal field policy** (M29 ADT/HIE path): an inbound patch can never write
  identifiers (mrn/mbi/ssn/state_id), status, or merged_into_id — stripped and the strip list is
  audited (defense against a chatty external partner leaking SSN via PID).
- **Record death**: validates date not in the future, flips status to `deceased`, emits
  `m5.patient.deceased` in the same transaction — fanning out to M16, M23, M28, M36. Chart
  becomes read-only after death except bereavement/amendment workflows.

### M6 — Admission / Election / Certification

- **Admission state machine**: `referred → pending → notice_of_rights_acknowledged → active
  ⇄ on_hold → discharged|bereavement → closed`. Activation requires notice-of-rights
  acknowledgment + signed election statement + signed CTI + no M5 privacy-flag block + the
  initial 48h assessment not overdue (or DON override).
- **Discharge**: death → `bereavement`; else → `discharged`. `for_cause` discharges require a
  two-step cascade — filing opens the discharge `awaiting_cosign` while the admission **stays
  active**; only a medical-director cosign moves it to `discharged` (rejection returns it to
  `active`).
- **Certification/recert**: period 1 requires both hospice-MD and attending signatures (if an
  attending is on file); recert periods ≥2 require only the hospice-MD. Only a signed recert
  auto-advances the election period.
- **Face-to-face encounter**: `scheduled → completed → attested`, with a Medical-Director-only
  window-override self-loop (documented reason required). Attestation requires a minimum-length
  narrative from the actual performer.
- Integrates with M5 (privacy flags), M7 (care-plan creation on activation), M9 (48h assessment
  check), M11 (discharge cascades discontinue orders).

### M7 — Care Plan

- **Root lifecycle**: `draft → active ⇄ active → discharged`. Exactly one non-discharged plan per
  admission (partial unique index), opened automatically on M6's `admission.activated`.
  Activation requires ≥1 active terminal problem.
- **Required Signer Set / quorum**: `initial`/`interim_revision`/`discharge` versions need the
  INITIAL quorum (attending MD/NP + RN case manager); `idg_review` versions need the full IDG
  quorum (RN + MSW + chaplain + MD/DO). A greedy consume-once matcher fills slots; a role that
  fills no unmet slot is rejected as a duplicate signer.
- Consumes M14 IDG decisions to update care plans from IDG outcomes.

### M8 — Encounters

- Encounter lifecycle with addendum/late-entry support.
- **Cosignature workflow**: an LPN/CHHA primary sign opens a cosign request routed to the RN case
  manager (`routed → acknowledged → signed`), escalating at 24h and hard-capping at 48h
  (`hard_cap_reached` **locks** the encounter until a supervisor/DON releases it with a reason).
  Cosign requires a qualified RN and fresh step-up auth (CoP 418.104(c)).
- **Late-entry tiers** (computed off whole calendar days, org-local): `normal` (≤24h),
  `late_entry` (24–72h, reason ≥40 chars), `significant_late_entry` (72h–14d, reason + supervisor
  override + step-up), `administrative_override` (&gt;14d, director permission + reason ≥100 chars +
  step-up + compliance event).
- Publishes visit-linked encounters from M17's `visit.published`; feeds M18 EVV-bracket
  resolution and M20/M33 mileage/payroll readers.

### M9 — Assessments

- Records and corrects clinical assessments; corrections validate against the target row's
  active/version state.
- **Capture siting**: resolves provider-entity/location purely via M6's seam (never a direct
  schema import); falls back to an explicit "unsited" sentinel — never fabricated — if the seam
  is unavailable or mismatched, so a denormalization failure never blocks recording clinical data.
- Scale-series windows/scoring and significant-change tracking exist as separate view types;
  discipline-based recording gates are enforced defense-in-depth via ABAC.

### M10 — HOPE Engine

- **Timepoint scheduling**: CMS HOPE admission-anchored windows computed as org-local calendar
  days from SOC — Admission RFA days 1–5, HUV1 6–15, HUV2 16–30; Discharge RFA is a separate
  7-day window anchored to discharge. A configurable grace period (default 7 days) marks the
  "late" band requiring a typed reason; capture past the grace deadline needs an admin override.
- **Symptom Follow-Up Visit (SFV) engine**: a J2051-triggered SFV is due within 2 calendar days of
  the triggering assessment's signed timestamp (org-TZ). Completion is blocked past due date
  without an admin override; a watchdog decays `open → overdue → missed` (7 days past due).

### M11 — Orders

- **Order lifecycle**: `draft → pending_signature → active → completed`, with a verbal-order
  branch (`→ verbal_pending → active`) and discontinue/cascade-discontinue/expire paths. Signing
  from `pending_signature` is blocked until any required cosign is attached. Verbal orders
  require an eligible RN+ recorder and a ≥100-char attestation; unsigned verbal orders auto-expire
  past deadline.
- **Cosign rules** (three concurrent axes): LPN-drafted clinical orders require RN cosign
  (tenant-configurable kind list); NP-signed orders may require MD cosign per tenant policy; a
  level-of-care "escalation jump" (RHC→GIP skipping CHC/IRC) signed by a physician/NP requires MD
  cosign. A cosigner can never be the order's own drafter/signer.
- Discharge cascades discontinue open orders; consumes M9/M10 triggers for order-suggestion
  banners.

### M12 — DoseSpot / e-Prescribing

- Medication-order lifecycle and verbal medication order path, mirroring M11's shape.
- **EPCS/IAL2 identity proofing**: a prescriber must be `ial2_status='verified'` (per 21 CFR
  §1311.115) before opening a controlled-substance signing session; expiry alerts fire at 30 and
  7 days out.
- **Controlled-substance refill rules** (platform floor, 21 CFR 1306.22): Schedule II is
  non-refillable; Schedule III/IV/V allow up to 5 refills. Tenant policy may only tighten this,
  never loosen it.
- Discharge cascades void pending prescriptions; publishes M28 FHIR MedicationRequest and M22
  medication-order-PDF seams.

### M13 — eMAR

- **Five-rights validator** (shared pure function, frontend + backend): patient, drug (order-id
  match), dose (unit match, ≤ authorized — partial doses permitted), route (case-insensitive exact
  match — the canonical wrong-route catch), time (≤5 min future clock-skew tolerance) checked
  against the M12 order at administration time; any failure is `422 FIVE_RIGHTS_VIOLATION` naming
  every failed right.
- **Controlled-substance witness eligibility**: administering/wasting Schedule II–V requires a
  second witness who isn't the administering clinician or a caregiver, holds an eligible
  discipline, and is active on the same tenant. A break-glass-session witness is allowed but
  flagged and triggers a warn-level audit event.
- Separate handling for barcode-scan matching, IV session tracking, PRN reassessment intervals,
  late-entry tiers, comfort-kit administration, and discharge-cascade voiding of pending doses.

### M14 — IDG (Interdisciplinary Group)

- **Meeting lifecycle**: `scheduled → packets_building → packets_ready → live → adjourned`, with
  cancel/reschedule available pre-live. `ADJOURN` requires fresh step-up auth; it freezes
  packets, stamps the per-patient review floor, bursts open decisions to
  `idg.decision_recorded`, assigns action items, and finalizes signed minutes as one commit-point
  effect list.
- **Per-patient review-floor guard**: a cancel/reschedule that would push an included patient past
  their 15-day review floor with no covering meeting is refused unless the caller holds an
  override permission plus step-up — in which case the breach is audited and a compliance alert
  fires.
- **Decision recording &amp; quorum**: decisions may only be recorded while `live`, only for a
  patient actually on the meeting's caseload. Quorum is evaluated against required discipline
  slots; a non-quorate decision is still recorded but flagged. Decisions are `open` while the
  meeting runs, `emitted` at adjournment (all kinds except `team_note` publish
  `idg.decision_recorded` to M7/M11/M12/M16), and may later be `superseded` by a later meeting's
  decision — never edited in place.

### M17 — Scheduling

- **Visit lifecycle** (8 states): `proposed → published → en_route → in_visit → completed`, plus
  dismiss/cancel/reschedule/no_show. `publish` requires a pre-computed 7-predicate
  pre-schedule gate. `start`/`arrive` advance via an EVV-matched system event or a clinician
  self-attest path requiring a documented EVV-missing reason (≥40 chars) *and* fresh step-up.
  `complete` fires only from M8's `encounter.signed` consumer (system actor only). Reschedule
  spawns a new linked visit in the same transaction.
- Publishes assigned/published/started/completed/cancelled/rescheduled/no_show events consumed by
  M8, M18, M20, M31.

### M18 — EVV (Electronic Visit Verification)

- **Three-layer geofence policy**: platform floor (200m radius / 50m accuracy) → tenant default →
  per-patient-address override, each layer strictly **tighten-only** relative to its parent, with
  absolute bounds (50–1000m radius, 5–100m accuracy). The effective policy is always the narrowest
  applicable layer.
- **Missing-visit resolution** (5 terminal closes from one `open` state): `clinician_attest`
  (assigned clinician, ≤24h, reason ≥40 chars), `supervisor_override` (fresh step-up, ≤7 days,
  reason ≥60 chars), `void_for_cancelled_visit` (system-driven), `document_at_encounter`
  (system-driven off `encounter.signed`), `system_checkout_received` (late check-out pairing).
  Closed states are terminal.
- **ADR-0008 billing-gate rule**: EVV is explicitly **never** a Medicare claim gate by itself —
  only an unresolved (`open`) missing-visit row blocks downstream billing; every closed
  disposition, including "documented at encounter," is non-blocking.

### M22 — Documents

- **Document lifecycle**: `active ↔ legal_hold` (M4-driven) and `active|superseded →
  destroyed_tombstone` (M4 destruction certificate). A document under an active legal hold
  **cannot be tombstoned** — the transition graph structurally excludes it. Tombstoning
  version-deletes every object-storage version, shreds the DEK, nulls the active-version pointer,
  and appends an access-log row (never deleting prior access-log history).
- **Retention-class engine**: per-class disposition floors (`compliance`=7yr,
  `bereavement`≈13mo, `operational`=7yr, `intake_artifact`=30 days if no writeback, clinical
  classes anchored to patient lifecycle). A legal hold suspends disposition regardless of class.
  Only one upgrade is ever permitted (`clinical_record → compliance`); any downgrade, or any
  mutation of `compliance_42cfr_part2`, is refused — the Part-2 class is insert-only and can only
  change via M4's legal-hold workflow. Documents auto-tag as Part-2 at insert when sourced from a
  SUD-classified lab result or an SUD-content classifier — never after insert.
- Document requests are decided contingent on active BAA/consent state (M40/M39 gates), not
  served unconditionally.

---

## Field / ops tier

*(M15, M16, M19, M20, M21, M37)*

### M15 — Discipline Care Plans

- Manages the four discipline-specific care plans per admission — Aide POC, MSW plan, spiritual
  plan, volunteer plan — each a versioned root with a
  `draft → active ⇄ draft_revising → discharged` state machine (one row per admission+kind).
  Aide/MSW/spiritual bootstrap automatically on M6's `admission.activated`; volunteer plan is
  created lazily on first volunteer assignment. All four force-discharge on
  `admission.discharged`.
- **RN supervisory cadence** (42 CFR §418.76(h)): `next_supervisory_due_at = supervisory_at +
  cadence_days` (14-day CoP floor, tenant may only tighten). A phone-only supervisory visit
  (no linked signed encounter) doesn't advance the clock. Escalation ladder
  `on_time → due → overdue → gate_engaged`; `gate_engaged` **blocks signing a new CHHA
  encounter** unless a Clinical Supervisor documents an override.
- **Volunteer compliance gates** (42 CFR §418.78(b)/(d)): each credential (training, TB
  screening, background check, etc.) has its own validity window; status is *derived at read
  time* (`satisfied | expiring_soon | expired | not_yet_satisfied | revoked`), never trusted from
  a stored column — a missed nightly job can't silently re-qualify an expired volunteer. Overall
  compliance requires every blocking gate to clear; expiry auto-inactivates open volunteer
  assignments.

### M16 — Bereavement

- Post-death bereavement program: `bereavement_plan` per admission progresses
  `eligible → initiating → active ⇄ paused → {closed_completed | closed_declined |
  closed_early}`, with an orthogonal legal-hold state that suspends (never restarts) the program.
- Opens live only once it has ≥1 bereaved-contact roster row and an initial deterministic risk
  score, at which point it materializes a full 13-month outreach schedule + anniversary reminders.
- **Deterministic risk scoring**: weighted score → tier (low/moderate/high/complicated),
  one-directionally promoted by a positive PG-13 complicated-grief screen, optionally overridden
  by a counselor (requires ≥40-char reason). Every score is an append-only, immutable row.
- **Outreach cadence**: generated from a platform-floor table anchored to death date; tenants may
  only tighten it. Floor touchpoints are never dropped — a family's modality preference can only
  swap modality, not remove a scheduled contact. Pause cancels future outreach; resume regenerates
  forward-only (never backdates missed touchpoints).
- **Closure paths**: pre-death per-patient opt-out (`closed_completed`, no cosign); all-contacts
  opted out (`closed_declined`); early close (`closed_early`, ≥40-char narrative + supervisor
  cosign unless system-cascaded); 13-month auto-completion. Legal hold blocks early/auto close.
- Each touchpoint has its own machine (`scheduled → in_progress → completed/declined/
  no_response/missed→lateAttempt/cancelled`); in-person visits must reference a signed M8
  encounter, every other kind must not.

### M19 — On-Call Triage

- **Triage call machine** (9 states): `open → protocol_in_progress → disposition_pending →
  documented_pending_encounter → documented → closed`, plus `awaiting_callback` and
  `escalated_unresolved` as legal detours that can rejoin the main path, and `abandoned` reachable
  from any non-terminal state. `documented` is reached only when M8's linked encounter is signed
  (system event, not user action). Closing requires a 30-minute post-documentation amendment
  grace window.
- Completing the protocol requires every required question answered and no open mandatory
  escalation.
- **Disposition scope-of-practice matrix**: 8 selectable dispositions gated by actor discipline —
  RN/supervisor/medical director get all 8; LPN gets 2; MSW/chaplain get 1; external vendor
  triage operators get a PHI-minimized 5-item subset (excluding GIP admission, verbal orders,
  pronouncement). Dispositions trigger M8 encounter creation; visit dispositions also emit an M17
  dispatch request; GIP proposals emit an M37 topic + an M11 level-of-care-change order draft.
- **Escalation ladder**: `open → acknowledged → resolved`, tiered 1–5 (tier 5 = external vendor);
  a mandatory escalation can never be auto-resolved by closing the call — enforced both in code
  and by a DB CHECK.
- **On-call shift machine**: `scheduled → active → completed | cancelled` (cancellation only
  pre-activation). Activation is blocked before shift start; completion is *not* blocked before
  shift end (early close is honest and surfaces the coverage gap rather than hiding it).

### M20 — Field Safety

- **SOS panic-button machine** (13 states): a single press fires immediate fan-out;
  `raised/cancel_window_open → cancelled_in_window` (biometric-verified cancel within window) or
  `→ acknowledging` (window expires) `→ escalation_tier_1 → tier_2 → tier_3 →
  emergency_terminus` on SLA breach/delivery failure/manual escalation. `acknowledge` is legal
  from every pre-ack state. A rejected cancel (failed biometric) doesn't move the lifecycle — it's
  recorded as forensic fact and escalation continues (never surfaces as a UI error, to avoid
  tipping off a hostile actor). The terminus loops indefinitely until a human acknowledges.
- **Overdue check-in detector**: derives an escalation rung
  (`gentle_reminder → supervisor_alert → escalation → sos_equivalent`) purely from elapsed
  minutes vs. policy thresholds, reconstructed from timestamps (not a stored enum) so a rung
  fires exactly once. The top rung routes identically to a real SOS without minting an actual
  SOS-alert row (keeps SOS volume metrics honest).
- **Coverage-gap watchdog**: for every field-eligible clinician, checks whether any active
  supervisor-subscription reaches her *and* resolves to a currently-active supervisor. Three
  distinguishable gap reasons all fail toward reporting a gap.

### M21 — Supplies / DME

- **Supply request machine**: `requested → vendor_assigned → ordered → in_transit → delivered →
  received_confirmed → completed`, with a two-phase post-order cancellation
  (`cancellation_pending` until vendor confirms/refuses) and a kit-only `returned` branch.
  Completion differs by kind: one-shot supplies auto-complete on receipt; DME rentals stay open
  until M11 discontinues the order; comfort kits complete only after M13 acknowledges deployment.
  A 72-hour caregiver-confirmation grace triggers system auto-confirm.
- **Comfort-kit chain-of-custody**: `requested → assigned → retrieving → retrieved →
  reconciled`, with `overdue` (30 days) and `unreturnable` (90 days, presumed loss) escape
  states. Enforces separation of duties (reconciler ≠ dispatcher; disposal witness ≠
  retriever/reconciler); refuses over-returns rather than silently absorbing them; requires every
  dispatched line accounted for exactly once. At 90 days, any still-outstanding controlled
  substance triggers a discrepancy alert even absent an actual count.
- **Par stock**: a nightly cron is the sole emitter of below-threshold/stockout-imminent events
  (mid-day observations adjust silently, avoiding alert storms); dispatch decrements refuse
  (never clamp) rather than drive a shelf negative.

### M37 — Inpatient Unit (IPU) Management

- Manages GIP/IRC and arranged remote-facility inpatient stays: units, rooms, beds,
  staffing/RN coverage, admissions, restraints, visitors, meals, equipment, and post-mortem body
  release.
- **Admission machine**: `pending → bed_pending → bed_assigned → active →
  {transferring→transferred | discharged | deceased} → closed`. GIP/IRC admissions cannot open
  (or request a bed) unless the unit currently has active 24/7 RN coverage. Death is a
  system-only transition that opens a body-release record and *defers* the bed's dirty-cleaning
  transition until release completes.
- **IRC 5-consecutive-day cap** (CoP 418.108 respite limit): a daily watchdog moves state
  `active → approaching_cap → breached`; a breached episode blocks IRC per-diem billing. A cap
  override requires fresh step-up, a ≥100-char reason, and is capped at a 2-day extension
  (over-requests rejected, never clamped). Re-admission within a 30-day lookback continues the
  prior day count rather than resetting it, preventing cap gaming via short discharges.
- **RN coverage horizon**: the current hour is fail-closed uncovered if unresolved; coverage is
  projected forward across a configurable window; a unit can't exit `provisional` until it holds
  a full 168-hour (7-day) forward-covered window.
- **Restraint machine** (CoP 418.110, default restraint-free posture): applying a restraint
  requires step-up, a physician order, and a ≥100-char justification; reassessment interval
  floors are 15 min (behavioral) / 120 min (medical), tighten-only. Auto-closes on discharge,
  death, or transfer.
- **Body release machine**: `pending → funeral_home_identified → released → closed`; auto-opens
  on IPU death; release requires a signed body-release document and resumes the deferred
  bed-cleaning cycle.

---

## Revenue cycle

*(M23–M27)*

### M23 — Billing Medicare

- Owns the Medicare Part A hospice institutional claim lifecycle: draft assembly → validation →
  submission (X12 837I) → acknowledgment (999/277CA) → remittance posting (via M25) →
  replace/void, plus NOE (Notice of Election) and NOTR (Notice of Termination/Revocation) fast
  path filings.
- **Claim state machine**: `draft → validating → ready → submitted → ack_pending →
  ack_accepted/ack_partial/ack_rejected → paid/partial_paid/denied → replaced/voided`; submit is
  gated by zero unresolved blocking validation failures.
- **Validation framework**: a frozen platform-default rule registry — patient eligibility,
  election-period active, CTI signed per period, F2F attested for recert, NOE timeliness (warns
  day 3, blocks day 5+1), duplicate-billing check, ICD-10 sequencing, HIPPS/SIA calculation
  correctness, level-of-care coherence, EVV bracket coherence (blocks only on
  `unresolved_missing`), place-of-service consistency, modifier validity, physician credentials
  active, bereavement-discharge legitimacy, TOB/date continuity, and aggregate/IPU cap projection
  (both explicitly `skip`/`seam_not_bound` until M26's projection provider is bound). Only
  eligibility-check freshness is tenant-disableable — the rest are regulatory floor.
- **CMS payment math** (pure, penny-exact, integer cents): `calculateHipps` walks each calendar
  day against level-of-care periods, buckets RHC days 1–7 vs 8+, applies wage-index-adjusted
  per-diems. `calculateSia` computes the Service Intensity Add-on (qualifying RN/MSW visits in
  the last 7 days of life, capped 240 min/day). `applySequestrationPolicy` applies the CMS
  sequestration reduction so net+reduction always sums exactly to gross.
- **Filing guards**: idempotency-key required; optimistic-concurrency `If-Match` on
  edit/submit/replace/void; step-up re-auth (re-verified server-side) for submit/replace/void; a
  Coder role can only edit ICD codes on a draft, never economic totals; claim lists scope-narrow
  to the actor's billing scope.
- X12 837I/999/277CA generation runs through a sidecar client, fail-closed when no transport is
  wired. Of the MAC jurisdiction portals, only **NGS Jurisdiction 6** has a real (skeletal)
  implementation; the rest are deny-stubs.
- Publishes seams consumed elsewhere: `PatientDaysProvider` (→ M27 Worksheet-D census),
  `ClaimLineReader` (→ M30 HCI indicators), `ClaimSubmissionReader` (→ M25 auto-match/PR ledger).

### M24 — Billing Medicaid

- Manages state Medicaid room-and-board claims and Medicare coordination-of-benefits via a
  per-state adapter registry.
- **Claim machine**: modeled on M23's, plus a COB step (`await_medicare_primary` →
  `medicare_primary_acknowledged`) and both sync and async/poll acknowledgment paths.
- **`rb_arrangement` machine**: `DRAFT → ACTIVE → EXPIRED|TERMINATED|SUPERSEDED` (terminal states
  preserve the chain via `supersedes_arrangement_id`).
- **State adapter registry**: built at boot from the M40 state catalog; always registers Oregon
  plus WA/ID/CA/NV deny-stubs; fails closed at boot if the catalog references an active state
  with no registered adapter vendor.
- **Oregon** is the one real reference adapter (OHP via OHA DMAP + CCO routing) — implements a
  real OHP Member ID Luhn validator and a pure payload assembler; live wire I/O (270/271
  eligibility, submission, remittance) throws `ADAPTER_NOT_WIRED` unless a launch-gateway
  transport is injected (none is by default).
- **Rules**: dual-eligible Medicaid claims must reference an M23 claim that reached
  `ack_accepted`+; MCO/CCO channel must match an active trading-partner credential; Medicaid's
  EVV-bracket-coherence rule is stricter than M23's (`unresolved_missing` always blocks;
  `documented_missing` blocks unless the adapter opts in — none do, per Cures Act §12006).

### M25 — Remittance &amp; Denials

- Ingests 835 remittance advice, auto-matches lines to claims, posts payments, and manages
  denial/appeal workflows.
- **Ingestion**: `receiveAdvice` dedups on ISA/ST-derived key (caught unique-violation = already
  ingested, no error); `postAdvice` posts every line, auto-matches, routes CAS adjustments, seeds
  denial cases/PR-ledger rows, and classifies outcomes — all in one transaction (all-or-nothing;
  a failed batch is replayable).
- **Auto-match** (3-strategy precedence): payer ICN exact match (confidence 100, auto-bind);
  patient-control-number exact match (100, auto-bind); heuristic member-id+date+charge overlap
  (80, always routed to manual-match worklist, never auto-bound). Ambiguous exact-match hits are
  treated as unmatched.
- **Posting classification**: CLP02=22 → recouped; payment ≤0 → denied; payment ≥ charge−$1 →
  paid; else → partial_paid — each mapping to a distinct outbox event consumed by M23's claim
  machine.
- **Adjustment routing**: CARC category resolved via M38's taxonomy catalog; unmapped CARCs and
  denial/recoupment categories seed a denial case; group code PR posts to the PR ledger; CO/PI
  auto-post as write-offs; OA/CR flag for review.
- **Denial-case machine**: `open → in_progress/escalated → resolved → closed`, with a gated
  reopen requiring Billing-Manager+ and a reason.
- **Appeal-case machine**: `draft → submitted → under_review → decided → closed`, forward-only,
  `withdrawn` reachable from any non-terminal state, `closed` rows immutable. Implements the
  actual Medicare appeal-tier clocks — redetermination 120 days, reconsideration 180 days,
  ALJ/council/federal court 60 days each — with a hard T-0 filing block and T-30/14/7/1 alerts.
- **Denial aging**: 0-7/8-15/16-30/31-60/61-90/91+ buckets; &gt;30 days triggers an operational
  alert, &gt;90 with no appeal triggers high-severity escalation.

### M26 — Cap Management

- Tracks the Medicare hospice aggregate payment cap (§418.308) and the inpatient day cap
  (§418.302(f)) per cap year, projects exposure, reconciles against the MAC's PS&amp;R report, and
  computes year-end settlement.
- **`cap_period` lifecycle**: `open → active (on first accrual) → in_settlement → settled →
  reopened → settled`; `in_settlement→settled` and `reopened` both require step-up.
- **Two locked-per-period beneficiary-counting methodologies** (§418.309): **streamlined** (each
  beneficiary counts once, weight 1.0 — cross-hospice transfers can be double-counted by design)
  vs **proportional** (weight = this-provider election days / total-hospice election days,
  falling back to 1.0 when cross-hospice data is unavailable). Locked at first accrual.
- **Deterministic linear-extrapolation projection** (not AI/predictive):
  `projectedYearEnd = paidYtd / elapsedFraction`; accrual basis is paid amount from M25
  remittance only. Alert bands at 90/95/100% aggregate, 18/20% inpatient (tenants may tighten,
  never loosen).
- **Inpatient cap**: GIP+IRC days over total patient days must stay ≤20%; overage at settlement is
  recouped at the RHC-differential per-diem rate.
- **Settlement**: compares final paid total to the methodology-derived cap; positive signed
  overage = overpayment owed to CMS, negative = underpayment owed to provider.
- **PS&amp;R reconciliation**: parses quarterly PS&amp;R CSVs (per-MAC column dictionaries), diffs
  against the running ledger, routes variances above a threshold (default $50) to a worklist.
- Publishes seams consumed cross-module: `CapProjectionProvider`/`InpatientCapProvider` (bound
  into M23's validation once M26 is DB-bound), `CapAccrualReader` (→ M27 Worksheet cap
  aggregates), `CapSettlementProvider`, `CapMetricsProvider`.

### M27 — Cost Report

- Produces the Medicare hospice cost report (CMS-1984-14) — cost-center allocation across
  Worksheets A–H, statistical reconciliation, validation, and ECR/Print-Image filing artifacts.
- **Lifecycle**: `draft → populating → validating → ready_for_review → approved_for_submit →
  submitted → accepted|rejected`, with `reopen` re-entering from accepted/rejected. Approval into
  `approved_for_submit` requires zero unresolved blocking validation failures.
- **Worksheets implemented** (certified against Pub 15-2 Ch.43): S, S-1, S-2, A, A-1–A-4, A-6,
  A-8, A-8-1, B, B-1, C, F, F-1, F-2.
- **Allocation pipeline**: a non-reciprocal step-down propagates Worksheet A overhead/
  general-service cost onto direct centers by statistical basis (sq ft, FTEs, accumulated cost),
  closing each overhead center once in fixed order; total cost is conserved to the cent via a
  largest-remainder proportional-allocation money kernel. Further stages carry allocated cost
  through Worksheet B/C/D and program settlement.
- **Validation engine**: 28 platform-default rules across 16 categories; CFR-mandated rules
  (§413.24 adequate cost data, §418.308/§418.309 caps, PRM Ch.3/4 bad debt) are tagged
  regulatory-required and can't be tenant-disabled; cap-category rules `skip`/`seam_not_bound`
  rather than fail when the upstream M23/M26 seam isn't bound.
- **ECR/Print-Image generation**: a pure entry point turns a frozen cost-report snapshot's
  worksheet payloads into the machine-readable ECR file and human-readable Print Image text; the
  worker emits a render-requested event for M22 to render/store bytes.
- **Cross-module cap bind**: M27 resolves M26's `CapAccrualReader` seam through an opaque
  `CapContext` view (never imports M26's schema directly) — fail-closed on unbound/null, so cap
  validation rules skip rather than fabricate a figure until M26 is DB-bound.

---

## Integration &amp; quality

*(M28–M30)*

### M28 — FHIR Gateway

- Exposes a SMART-on-FHIR R4 read/inbound-staging gateway plus an admin surface for registering
  FHIR clients, running bulk exports, and reviewing inbound-staged resources.
- Static CapabilityStatement advertising 12 US-Core resource types (read + search-type). Every
  spec route resolves a bearer and checks `system/{Resource}.read|write` scope; unscoped/expired
  clients get a FHIR `OperationOutcome` 401/403.
- **Bulk export** (`$export`, `Patient/$export`, `Group/:id/$export`): real queued-job state
  machine with poll/cancel.
- **Inbound staging**: a write-scoped POST stages the payload as an `inbound_proposal` (202) for
  review rather than writing directly.
- **Admin: client registry**: dual-approval onboarding (propose → distinct-approver co-approve →
  active); revoke/suspend cascades kill live sessions and cancel in-flight exports; credential
  rotation returns the plaintext exactly once.
- **Admin: inbound review**: accept binds only through the *owning module's* native write path
  (ABAC-checked); reject requires a ≥40-char rationale, and the payload is
  destruction-scheduled at +30 days.
- **Rate-limit override is tighten-only** against the platform tier floor.
- **Phase-1 posture is explicitly read-stub**: single-resource read and type search always return
  an empty Bundle/404 — the mapper pipeline exists (Patient/Encounter/Condition/CarePlan/Goal/
  Medication) but the consumed read seams are fail-closed deny-stubs this wave, so no live
  clinical read has a data path yet. The SMART token-mint endpoint likewise fails closed
  (`invalid_client`) — no client can actually authenticate yet.

### M29 — External Interfaces

- Runs the HL7v2 inbound (ADT/ORU over MLLP) and outbound (ORM) interface engine, a deterministic
  patient-matching cascade, a lab-results clinician surface, and a nightly NPPES provider-directory
  sync.
- **Feed lifecycle**: create (pending_approval, step-up) → activate (requires a distinct
  compliance co-approver *and* the M40 BAA gate satisfied) → suspend/revoke (revoke is
  dual-approval).
- **MLLP listener**: a supervised socket listener with framing/parsing, ACK/NAK generation.
- **Deterministic patient-match cascade** (5 ordered levels — internal-MRN exact,
  external-MRN exact, SSN-last-4+DOB, exact name/DOB/sex, loose name/DOB): each level carries a
  fixed confidence weight; follows merge-redirects up to 3 hops; every outcome routes to
  propose-then-review — never mutates M5/M6 directly.
- **ADT message-type routing**: a fixed table maps A01/A04/A08/A03/A11 to owner module and
  no-match behavior — admits/updates propose a new-patient row on no-match; discharge/cancel on
  no-match are dropped-with-audit.
- **Inbound proposal review**: `pending` is the only reviewable state; accepted/rejected/expired
  are terminal (a fresh message creates a fresh proposal); an SLA sweep auto-expires stale ones.
- **Outbound ORM dispatch planning**: a pure planner turns an M11 order-request event + a
  resolved M40 BAA decision into either a dispatch (builds the ORM^O01 wire, permanent
  idempotency key) or a pre-persist `baa_refused` (no row written, high-severity alert — doesn't
  fail the underlying M11 order, since a BAA lapse is transient and the DLQ auto-requeues once
  reactivated).
- **Lab results surface**: caseload-scoped reads, an unmatched-result review queue, RN
  abnormal-flag acknowledgment (409 if the result carries no abnormal flag).
- **NPPES sync**: nightly platform-shared job — collects distinct NPIs across tenants, diffs/
  upserts the cache, checkpoints every 50 NPIs, trips a circuit breaker after 50 consecutive
  failures. A tenant-scoped trigger is explicitly refused before any store is touched (public
  data, platform-only).

### M30 — HQRP &amp; Quality (largest module, 60 routes)

The hospice quality-management system of record: computed HQRP/CMS measures (HCI, HVLDL,
HOPE-derived), CAHPS-Hospice survey vendor integration, QAPI governance, incident surveillance,
mortality review, Security Risk Assessment, infection surveillance/outbreak detection, CoP
compliance, and a risk register.

**Measures — what actually computes vs. what's blocked** (the distinction between "calculator
registered" and "input actually resolvable" is real and load-bearing):

- **Live today**: `hci_indicator_01` (M6 LOC periods), `hci_indicator_03`/`04` (M6 discharge
  timing), `hci_indicator_10` and `hvldl` (M6 death census + M8 EVV-verified signed encounters),
  `opioid_on_admission_rate` (M6 admission onset + M12 meds), the four HOPE-derived measures
  (live M10 consumer), and 11 operational measures (visit-on-time, EVV compliance, late-entry
  rate, verbal-order signature timing, care-plan 15-day adherence, missed-dose rate, PRN
  effectiveness documentation, IDG cadence adherence, bereavement coverage, supervisory-visit
  on-time, volunteer compliance gate). `hci_indicator_07` and the CoP 418.310 filing-status read
  now bind to M23/M27 (recently un-suppressed).
- **Structurally unwired** (`hci_indicator_02/05/06/08/09` and `hci_composite`, plus
  `comfort_kit_deployment_to_admin_minutes`): the input-resolver dispatcher has no branch for
  these codes and hard-throws — the non-HOPE M5–M18 read seams they need were never built.
- **Wired but blocked on an absent producer module**: `bereavement_coverage_rate` and
  `supervisory_visit_on_time`/discipline measures route through seams that, per the consumed-seam
  adapter registry, are still M1 deny-stubs — the recompute throws rather than writing a
  fabricated value.
- The `quality_measure_value` write path is fully implemented measure-agnostically: idempotent
  processing log, content-hash dedup (identical re-run is a no-op), soft-supersede of the prior
  current row, threshold-breach detection only on a transition *into* red.

**CAHPS-Hospice**:
- **Sampling**: builds the monthly sample from the prior month's decedents, applying CMS exclusion
  rules in fixed priority order (stay &lt;48h → caregiver unavailable → language unsupported →
  prior opt-out).
- **Vendor adapters**: **SHP** is the real platform default (CSV export, CMS min-cell suppression
  of 30, signed intake client — though the network transport itself is unwired, so push fails
  closed rather than hitting the network); **manual** is real and functional (renders a CSV for
  hand-off, ingests a coordinator-uploaded result CSV). **Deyta, HEALTHCAREfirst, and Press
  Ganey are explicit Phase-2 placeholders** that refuse to bind at boot.

**QAPI, SRA, incidents, mortality, infection, CoP**:
- **QAPI**: annual program adoption, indicator definitions with thresholds, PI project charters,
  PIP cycles, governance minutes. Closing a PIP is a two-person co-sign — the closer can never be
  the charterer, enforced server-side and by a DB check constraint.
- **Incidents**: `draft → submitted → triaged → under_investigation → resolved →
  closed_followup_complete` (with reopen), enforcing separation of duties throughout — resolve/
  close/reopen structurally forbid the resolver from being the same person as the assignee.
  Mandatory external-report determination is a pure rule table (abuse allegation always requires
  immediate APS/DHS reporting; four specific exposure-event subkinds each have their own
  reporting target/timeline) enforced as a submit-time gate. Abuse-allegation rows are only
  reachable via a dedicated co-sign queue gated by a distinct permission; the general incident
  list filters them out for callers who lack it, rather than 403ing the whole endpoint.
- **Mortality review**: auto-created from every death event (idempotent mapper) with a 30-day
  default completion target (tenant may tighten to as low as 1 day, never loosen). Externally
  sourced (HL7) deaths get a deferred completion clock until M6's cosign receipt re-anchors it.
- **SRA**: pure 5×5 likelihood×impact risk-matrix scoring, banded at fixed thresholds; residual
  reduction is validated so remediation can never *increase* risk.
- **Infection surveillance**: a real, deterministic outbreak detector — a sliding 14-day window
  per (provider-entity, pathogen, body-site) cluster key, firing on the third qualifying event,
  one case per cluster. Outbreak cases are never user-creatable — server-derived only.
- **CoP compliance** and **risk register** exist as dedicated route surfaces with repository/
  refresh logic.

**Seams**: consumes M5–M18, M23, M27 (all live); M15 and M16 seams are still deny-stubs — not
built yet, so the measures depending on them stay blocked. Publishes
`QualityMeasureProvider`/`IncidentRegisterProvider`/`QapiProjectProvider`/
`ComplianceStatusProvider`/`SecurityRiskAssessmentReader`, consumed by M22, M28 (FHIR
MeasureReport), M33, M34.

---

## Platform services &amp; portal

*(M31–M40)*

### M31 — Patient/Family Portal &amp; Telehealth

- Patient/caregiver self-service (lay-language chart reads, document upload, message send,
  amendment requests) and browser-based video visits, via its own SPA (`apps/portal`).
- Every PHI route runs through a "foundation gate" that calls M39's `ConsentEvaluator` per grant
  kind (patient-self, family-caregiver, DPOA, personal-representative, bereaved-family) and fails
  closed on any error, missing seam, or non-allowed result.
- **Telehealth visit lifecycle**: `room_minted → {patient_joined|clinician_joined} →
  in_progress → ended_clean|ended_aborted → reconciled`; joins are idempotent, illegal
  transitions throw.
- **Two-party recording consent**: a hard-coded 14-state platform floor (CA, CT, DE, FL, HI, IL,
  MA, MD, MI, MT, NH, NV, PA, WA) a tenant may only tighten; an unknown/empty residence state
  fails closed to two-party.
- Write surfaces: caregiver-attested medication administration, document upload (routed into M22
  intake), amendment requests (§164.526).
- Admin routes: invitations, suspend/reinstate, bereaved-family invites, halt recording mid-call,
  portal audit trail.

### M32 — AI Platform

- Governs and gates all AI/LLM usage platform-wide; every capability sits behind an `ai.full`
  feature flag that is currently **OFF**, so no model is actually dispatched — the routes govern a
  platform not yet serving inference.
- **8-state capability lifecycle FSM**: `PROPOSED → DESIGN_REVIEW → EVALUATION → PILOT →
  APPROVED → MONITORING`, plus DEPRECATED/RETIRED demotion edges.
- **Invocation pipeline** runs a strict gate order (flag → capability lookup → kill switch →
  tenant opt-in/clinician opt-out → routing → hard token cap → PHI-minimization validator →
  dispatch → single terminal ledger write) and never throws to signal refusal — every gate
  failure returns a typed `{available:false, gate, reason}`.
- Ledger rows are append-only (a DB trigger freezes token counts/ciphertext/model pin/ZDR flag
  after write).
- **Kill switch**: org- or platform-scoped; SEV-1 activations auto-demote the capability via a
  queued worker (never inline). Hallucination reports flow filing → triage → an async worker that
  can auto-kill and demote the capability platform-wide (never tenant-scoped, since a fabrication
  is a model property).
- Four ports are deliberately unbound/refusing by default in Phase 1: kill switch, chart-context
  PHI validator (defaults deny-all), token budget resolver (defaults unconfigured/refuse), model
  backend registry (empty).

### M33 — Reporting &amp; Dashboards

- Ad-hoc report definitions, saved views, dashboards/tiles, scheduled report runs, drilldown/
  export (CSV/PDF/XLSX) over materialized "report bases" and metrics.
- Definitions are drafted, versioned, published; views can be scheduled (pause/resume/cancel/
  delete-all-runs) with a worker running nightly refreshes and materialized-view
  `REFRESH ... CONCURRENTLY` (primary pool only, never the replica).
- Drilldown exports write an envelope-encrypted audit row of the filter context before serving;
  fails closed if no encryption port is bound (refuses rather than writing plaintext).
- Admin ops routes let platform ops refresh/suspend materialized views and monitor replication lag.

### M34 — SaaS Tenant Platform (Admin Console backend)

- Provisions/administers tenant organizations: signup intents, tenant creation, onboarding tasks,
  BAAs, feature flags, key-ring/DEK rotation, support sessions, tenant offboarding/destruction.
  Backs the `apps/admin` SPA.
- Tenant provisioning is event-driven: an outbox event is consumed and enqueued onto a job queue;
  actual work (DEK mint/wrap, storage prefix creation, admin invitation email) runs through an
  injected provisioning gateway.
- **Tenant offboarding/"shred"** (cryptographic erasure) requires a preflight check: an *approved*
  destruction certificate using the `crypto_erasure` method, no active legal hold, and a
  co-signer distinct from the certificate approver — a strict two-person rule enforced in code
  before any destructive primitive runs.
- Support sessions can be "elevated" (step-up) and require patient/tenant consent grants
  (revocable). Cross-tenant platform reads/writes run under an explicit platform-context runner,
  not tenant RLS.
- DSAR/tenant export jobs support fulfill/extend/deny/download workflows.

### M35 — Subscription Billing

- Manages tenant subscription plans, payment methods, invoices, usage-based metering, promo
  codes, refunds, and dunning, integrated with Stripe.
- Tenant-facing: list plans, read/change/cancel/resume subscription, apply promo codes, manage
  payment methods (Stripe SetupIntent), view invoices/usage.
- Platform-ops: plan lifecycle management, meters, dunning, refunds (step-up plus a "four-eyes"
  re-check against the loaded refund row), promo codes, per-org usage/revenue views.
- Inbound Stripe webhooks authenticate purely via Stripe-Signature HMAC (no session/permission
  key), dedup on Stripe event id, reject payloads older than a replay window, never log the
  payload; fails closed (503) until a live Stripe credential is wired.

### M36 — Messaging (Secure Messaging &amp; Alerts)

- Internal secure staff messaging (channels/DMs), a cross-module alert-emission seam, and
  outbound notification delivery (SMS/email) with PHI sanitization for out-of-band channels.
- Publishes the `AlertEmitter` seam every clinical/billing module emits alerts through, and a
  `MessagingProvider` seam for cross-module channel/message CRUD.
- **`composeAndDispatch`**: loads a template, renders it from a source event payload, resolves
  recipients via a pluggable resolver registry, dispatches — M36 never imports a producer module,
  keeping the dependency direction one-way.
- Owns the platform's transactional email transport (password reset/magic-link delivery for
  auth).
- Inbound vendor webhooks (Twilio SMS/voice status, Postmark events) are the only
  unauthenticated-by-session M36 routes, protected by a two-layer defense (replay window + HMAC/
  IP-allowlist + bearer token).

### M38 — Terminology

- Serves canonical clinical code-system lookups (ICD-10, SNOMED, LOINC, RxNorm) and value-set
  expansion/membership, plus per-tenant value-set extensions.
- Value-set data loads from external terminology feeds via a scheduled loader; degradations pause
  new-version loads while cached/last-loaded data keeps serving.
- The only tenant write is an "add-only" value-set extension — canonical/platform rows are
  immutable to tenants.
- Tenant offboarding erases only the org's extensions; platform reference tables are untouched.

### M39 — Consent &amp; Authorization Management

- The platform's central disclosure/authorization gate: evaluates and records patient consent for
  every PHI-egress path (portal access, AI invocation, telehealth recording, data sharing).
- Publishes the `ConsentEvaluator` seam (`evaluate({organizationId, patientId, consentType,
  sessionContext, callerModule, callerRoute})`) other modules call opaquely through the seam
  registry — the canonical enforcement mechanism M31's foundation gate is built on.
- **Lifecycle**: draft → sign → supersede/renew (renewal-cycle tracking, expiring-consent
  lookups) → revoke; revocation and superseding both produce new version-chain entries rather
  than mutating in place.
- Right-to-erasure deletes a patient's consent subtree except rows under legal hold or a 42 CFR
  Part 2 release retained for the patient's lifetime; the evaluation-audit trail is destroyed
  only through M4's certified audit-retention path.
- Supports DPOA agent management, delegated-access resolution, post-mortem/bereavement consent
  eligibility, cascading document re-render on consent change.

### M40 — MDM (Master Data Management)

- Maintains a master directory of external entities (physicians, facilities, payers) with
  merge/dedup, provisional-record promotion, and BAA tracking; syncs physician data from NPPES.
- Publishes `MdmEntityProvider` (merge-aware master-data read seam consumed by clinical/billing/
  interop modules) and `BaaStatusProvider`.
- **Merge workflow**: merge requests require platform-ops approval/rejection before entities are
  re-pointed; provisional entities can be promoted to canonical by platform ops.
- NPPES sync currently runs as a nightly job; an event-driven sync path from M29 exists as an
  unwired forward seam.
- Tenant offboarding erases only the org's overlay/provisional/BAA rows — canonical reference
  entities are untouched.

---

## Cross-cutting patterns

These conventions recur across nearly every module and are as much "the business logic" as any
single workflow:

- **Opaque seam registry, not direct imports.** Every module registers "published seams" into a
  central M1 registry (`getSeam(...)`) rather than importing another module's schema/service
  directly. Consumers resolve dependencies at runtime; a seam that isn't bound yet resolves to an
  explicit deny-stub, never a silent null-turned-zero.
- **Fail-closed by default, fail-open only for pure availability controls.** Auth, ABAC, consent
  evaluation, CSRF, and destructive-operation preflights fail closed on any ambiguity or missing
  wiring. The rate limiter is the one deliberate exception (fails open on store outage, since
  it's an availability/DoS control, not a data-integrity one).
- **Tighten-only tenant overrides.** Wherever a tenant can override a platform-default threshold
  (EVV geofence radius, bereavement outreach cadence, mortality-review target days, cap alert
  bands, controlled-substance refill limits, restraint reassessment intervals, FHIR client rate
  limits), the override may only make the constraint stricter than the platform floor, never
  looser — enforced in code, not just by convention.
- **Step-up (fresh re-authentication) gates high-stakes actions.** Claim submit/replace/void,
  IDG adjournment, cosign on controlled encounters, break-glass access, cap-period settlement,
  IPU restraint application/cap override, FHIR cursor-key rotation, and tenant destruction all
  require a freshly-verified step-up session, re-checked server-side at the point of action.
- **Two-person / separation-of-duties control on irreversible or high-risk actions.** PIP
  closure, incident resolve/close (resolver ≠ assignee), comfort-kit reconciliation (reconciler ≠
  dispatcher), tenant cryptographic shred (co-signer ≠ approver), FHIR client onboarding
  (distinct approver), external-feed activation/revocation (distinct co-approver).
- **Append-only / immutable audit and scoring trails.** Bereavement risk scores, AI invocation
  ledger rows, audit_event rows (DB-ACL-enforced no UPDATE/DELETE), and IDG decisions
  (superseded, never edited) are all insert-only, preserving a reconstructable history rather
  than a mutable "current state" column.
- **Deterministic-first, probabilistic-fallback matching.** Both M5 (patient identity) and M29
  (HL7 patient matching) use the same shape: hard deterministic rules fire and either hard-block
  or auto-resolve; anything softer always routes to a human review queue — auto-merge never
  happens anywhere in the codebase.
- **System-only transitions for clinically authoritative facts.** A visit only reaches
  `completed` when M8's encounter is signed; an admission only reaches `documented` (M19) or
  advances via death (M5/M6/M37) through a system-emitted event — never a direct user-driven
  status write — so the clinical record of what happened can't be front-run by a status field.
