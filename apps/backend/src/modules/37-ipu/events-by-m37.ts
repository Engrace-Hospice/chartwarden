// apps/backend/src/modules/37-ipu/events-by-m37.ts — Module 37's outbox-event contributions (§4.4). The
// full `m37.*` taxonomy under the `m37.` namespace; check-fitness-gaps.ts scans this file for naming
// (`m37.<resource>.<verb>`), ownership (moduleOwner='m37'), and valid declared consumers (real module ids).
// The composition root merges this into the platform event catalog at boot (the M35/M27 precedent); the
// transactional publisher Value.Checks each `m37.*` publish against its payloadSchema inside the mutation's
// tx. The event-NAME set mirrors the leaf `@wardenx/types` `M37_OUTBOX_EVENT_NAMES`.
//
// M37 payloads are PHI-lean by construction — uuids + counts + enum lifecycle codes; never a patient name,
// MRN, or free-text justification (those live only in the RLS-scoped rows, audit-denylisted).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const iso = Type.String({ minLength: 1 });
const count = Type.Integer();

/** admission aggregate — every ipu_admission.* payload carries these. */
const admissionCore = { ipuAdmissionId: id, organizationId: id };

export const M37_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── ipu_admission lifecycle (§2.2) ────────────────────────────────────────────────────────────────
  {
    eventName: "m37.ipu_admission.opened",
    moduleOwner: "m37",
    description: "An IPU admission opened (pending).",
    payloadSchema: Type.Object({ ...admissionCore, levelOfCarePeriodId: id, kind: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.bed_requested",
    moduleOwner: "m37",
    description: "A bed was requested for an admission (bed_pending).",
    payloadSchema: Type.Object({ ...admissionCore, unitId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.bed_assigned",
    moduleOwner: "m37",
    description: "A bed was assigned; M6's own confirm route verifies it via a seam read.",
    payloadSchema: Type.Object({ ...admissionCore, bedId: id, levelOfCarePeriodId: id }),
    // F-136 (#248) — m23 REMOVED: the description's "M23 writes the place-of-service Q-code" claim is
    // false — F-127 already found `placeOfService` genuinely unbound: no table anywhere records which
    // physical site (home/ALF/SNF/hospital/IPU) a patient is currently receiving care in, so
    // `place_of_service_consistency` fails honestly for every claim. M23's own spec never names M37 as
    // a consumed event either (the only M37↔M23 relationship runs the other way — M37 reads M23's
    // `ClaimReader.gipDaysForPatientInPeriod`).
    // F-143 (#248) — m6 REMOVED: the real mechanism is the OPPOSITE of a push — M6's own
    // `confirmLocBedAssignment` route (admission-route-service-db.ts) verifies the bed via a SEAM READ
    // (`ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod`), never an outbox subscription.
    // M6's own spec (line 621) names exactly one inbound external event it consumes
    // (`m29.hl7_inbound_proposal.accepted`), and this is not it.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.activated",
    moduleOwner: "m37",
    description: "An admission activated (bed occupied).",
    payloadSchema: Type.Object({ ...admissionCore, activatedAt: iso }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.transferring",
    moduleOwner: "m37",
    description: "An admission transfer was initiated.",
    payloadSchema: Type.Object({ ...admissionCore, targetKind: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.transferred",
    moduleOwner: "m37",
    description: "An admission transfer completed.",
    payloadSchema: Type.Object({ ...admissionCore, completedAt: iso }),
    // F-130 (#248) — m27 REMOVED: M27's own §1.1 relationship inventory + manifest-patch dependsOn list
    // ([1,2,3,4,6,8,12,13,22,23,26,36,38,40]) never names M37 as a consumed input at all — M27's service-
    // side census reads M6's `LevelOfCarePeriodReader` (which already covers GIP/IPU level of care
    // regardless of physical site) via seam pull, not an M37 admission-lifecycle subscription.
    // F-131 (#248) — m26 REMOVED: M26's own "Depends on" / "Consumed by" text never names M37 either —
    // its D13 inpatient-day (20% rule) source is M23 claim lines by revenue code (0655/0656), the same
    // physical-site-independent path F-130 found for M27, and its subscription-map has no M37 topic.
    // F-136 (#248) — m23 REMOVED: same reasoning — M23's own spec never names M37 as a consumed event;
    // the only M37↔M23 relationship runs the other way (M37 reads M23's `ClaimReader`).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.discharged",
    moduleOwner: "m37",
    description: "An admission was discharged.",
    payloadSchema: Type.Object({ ...admissionCore, reason: id }),
    // F-130 (#248) — m27 REMOVED: same reasoning as `m37.ipu_admission.transferred` above.
    // F-131 (#248) — m26 REMOVED: same reasoning as `m37.ipu_admission.transferred` above.
    // F-136 (#248) — m23 REMOVED: same reasoning as `m37.ipu_admission.transferred` above.
    // F-149 (#248) — m30 REMOVED: redundant sibling — M37's own outbox table conditions M30's
    // inclusion on "mortality if death is the discharge reason — but use `death_recorded` for death",
    // and the death case already has its own dedicated, correctly-declared sibling
    // (`m37.ipu_admission.death_recorded`, `declaredConsumers: ["m30","m16"]` below). `.discharged`
    // fires for every OTHER discharge reason with no independent M30 rationale once the death case is
    // carved out — the redundant-sibling shape this series has found repeatedly (F-108/F-117/F-134).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.death_recorded",
    moduleOwner: "m37",
    description: "A death was recorded in the IPU (opens body release).",
    payloadSchema: Type.Object({ ...admissionCore, deathEventId: id }),
    // F-144 (#248) — m22 REMOVED: M22's own spec never mentions a magic-link/external-collaborator
    // surface anywhere, and elsewhere explicitly disclaims a related mechanism ("M2 funeral magic-link
    // is NOT how external reviewers authenticate — external reviewer access is M31 portal + M39
    // grant").
    // F-147 (#248) — the "internally inconsistent" framing F-144 left open is resolved, not merely
    // corrected: this event's own "Consumed by"/§4.10 table row ("M22 (funeral-home magic-link session
    // creation)") is the ONE imprecise citation against 15+ other places in M37's own spec — the D12
    // rationale, the §2.11 prose, the detailed workflow walkthrough (steps 4-7), the test plan, the
    // acceptance checklist — that unanimously tie the magic-link session to the LATER
    // `m37.body_release.funeral_home_identified` transition, never to `death_recorded` itself (which
    // only opens the body-release record). This event genuinely has no magic-link consumer of its own;
    // the "M2 vs M22" question F-144 flagged is also resolved — the spec is unambiguous the consumer is
    // M22's own external-collaborator surface (architecture §7.8), never M2 directly. See
    // `m37.body_release.funeral_home_identified` below for what remains genuinely unbuilt.
    // F-172 (#248) — `m16` REMOVED, redundant sibling (the F-100/F-117/F-134 shape): M37's own spec
    // names M16 here three times ("bereavement onboarding"), but M16's real bereavement-intake
    // mechanism is keyed off the M6 admission, not off M37's IPU admission — it already fires from
    // `m6.discharge.death` (primary, `16-bereavement/outbox-consumers/m6-bereavement-eligible.ts` via
    // the co-emitted `m6.bereavement.eligible`) and `m6.admission.discharged` reason=death (secondary
    // verifier, `m6-admission-discharged-death.ts`) — the SAME `m6.discharge.death` transaction that
    // now (F-172) drives `recordDeath` itself, so a third M16 path off `death_recorded` would arrive no
    // earlier and carry no fact (patientId, admissionId) M16 doesn't already have from the M6 event.
    // Confirmed by direct read of both M16 consumer files, not assumed from the prior finding's
    // (F-134/F-147) own re-assertion.
    // F-184 (#248) — `m30` ALSO DROPPED, reversing F-149's own conclusion: F-149 never checked this
    // relationship against M30's actual trigger design, only against M37's spec citation. M30's
    // mortality-review auto-draft (`createMortalityReviewDraft`) is keyed EXCLUSIVELY to
    // `m6.discharge.death` — and `death_recorded` (`recordDeath`) fires strictly DOWNSTREAM of, and only
    // because of, that same `m6.discharge.death` event (M37's own consumer file: "recordDeath is driven
    // by the M6 death consumer"). A hypothetical M30 consumer here would fire no earlier and carry no
    // fact `m6.discharge.death` doesn't already supply — the identical redundant-sibling shape already
    // used to drop `m16` from this exact event three lines up. The real, already-tracked gap is binding
    // `m6.discharge.death` itself (F-150), not this downstream sibling.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.closed",
    moduleOwner: "m37",
    description: "An admission closed after T+7 settlement.",
    payloadSchema: Type.Object({ ...admissionCore }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── bed cleaning (§2.12) ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.bed.cleaning_started",
    moduleOwner: "m37",
    description: "A bed entered the cleaning state.",
    payloadSchema: Type.Object({ bedId: id, organizationId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.bed.ready",
    moduleOwner: "m37",
    description: "A bed returned to ready (turnover complete).",
    payloadSchema: Type.Object({ bedId: id, organizationId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.bed.cleaning_overdue",
    moduleOwner: "m37",
    description: "A bed exceeded the turnover SLA.",
    payloadSchema: Type.Object({ bedId: id, organizationId: id, unitId: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── RN coverage (§2.3) ────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.shift.coverage_gap_projected",
    moduleOwner: "m37",
    description: "A forward RN-coverage gap within the alert horizon.",
    payloadSchema: Type.Object({
      unitId: id,
      organizationId: id,
      firstGapAt: iso,
      uncoveredCount: count,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.shift.rn_uncovered",
    moduleOwner: "m37",
    description: "The current hour is RN-uncovered (block severity).",
    payloadSchema: Type.Object({ unitId: id, organizationId: id, hourAt: iso }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.rn_coverage.break_glass_invoked",
    moduleOwner: "m37",
    description: "An RN-coverage break-glass override was invoked.",
    payloadSchema: Type.Object({ unitId: id, organizationId: id, invokedAt: iso }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── GIP criteria (§2.4) ───────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.gip_criteria.reassessment_due",
    moduleOwner: "m37",
    description: "A GIP reassessment is due (stale past the window).",
    payloadSchema: Type.Object({ ...admissionCore, triggeredByEncounterId: nullableId }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.gip_criteria.reassessment_completed",
    moduleOwner: "m37",
    description: "A GIP reassessment was recorded.",
    payloadSchema: Type.Object({ ...admissionCore, criterionStillMet: Type.Boolean() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── IRC cap (§2.5) ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.irc_episode.cap_approaching",
    moduleOwner: "m37",
    description: "An IRC episode reached day 4 (approaching cap).",
    payloadSchema: Type.Object({ ...admissionCore, consecutiveDayCount: count }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.irc_episode.cap_breached",
    moduleOwner: "m37",
    description: "An IRC episode reached day 5+ (cap breached; blocks billing).",
    payloadSchema: Type.Object({ ...admissionCore, consecutiveDayCount: count }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.irc_episode.cap_override_invoked",
    moduleOwner: "m37",
    description: "An IRC cap-override break-glass was invoked.",
    payloadSchema: Type.Object({ ...admissionCore, extensionDays: count }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── IV safety overlay (§2.6) ──────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.iv_safety_overlay.required",
    moduleOwner: "m37",
    description: "An IV-continuous safety overlay was created for a signed order (M13 consumes).",
    payloadSchema: Type.Object({ ...admissionCore, orderId: id, isSedationClass: Type.Boolean() }),
    // F-140 (#248) — m13 moved to seamConsumers: both this module's own text and M13's own spec are
    // decisive this is a SEAM PULL — M37 publishes the overlay via `IpuIvSafetyOverlayProvider
    // .getOverlayForOrder(orderId)`, and M13's pre-administration gate consults it fresh; M13's own
    // live `M13_OUTBOX_SUBSCRIPTIONS` list never names this event (or any M37 event) at all. The
    // "M13 consumes" wording above describes the seam relationship, not an outbox subscription.
    declaredConsumers: [],
    seamConsumers: ["m13"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.iv_safety_overlay.bedside_check_overdue",
    moduleOwner: "m37",
    description: "An IV bedside check is overdue.",
    payloadSchema: Type.Object({ ...admissionCore, orderId: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── visitor (§2.7) ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.visitor_restriction.applied",
    moduleOwner: "m37",
    description: "A visitor restriction was applied (unit or patient scope).",
    payloadSchema: Type.Object({ organizationId: id, restrictionId: id, scope: id, kind: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── equipment (§2.9) ──────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.equipment.inspection_due",
    moduleOwner: "m37",
    description: "An equipment biomed inspection is approaching due.",
    payloadSchema: Type.Object({ equipmentId: id, organizationId: id, daysUntilDue: count }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.equipment.inspection_overdue",
    moduleOwner: "m37",
    description: "An equipment biomed inspection is overdue (blocks assignment).",
    payloadSchema: Type.Object({ equipmentId: id, organizationId: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── restraint (§2.10) ─────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.restraint.applied",
    moduleOwner: "m37",
    description: "A restraint was applied (M30 incident-report projection).",
    payloadSchema: Type.Object({ ...admissionCore, restraintEventId: id, restraintKind: id }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.restraint.reassessment_due",
    moduleOwner: "m37",
    description: "An active restraint is past its reassessment interval.",
    payloadSchema: Type.Object({ organizationId: id, restraintEventId: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.restraint.reassessment_completed",
    moduleOwner: "m37",
    description: "A restraint reassessment was recorded.",
    payloadSchema: Type.Object({ organizationId: id, restraintEventId: id, outcome: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.restraint.released",
    moduleOwner: "m37",
    description: "A restraint was released.",
    payloadSchema: Type.Object({ organizationId: id, restraintEventId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── body release (§2.11) ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.body_release.pending",
    moduleOwner: "m37",
    description: "A body-release record was auto-opened on death.",
    payloadSchema: Type.Object({ ...admissionCore, bodyReleaseId: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.body_release.funeral_home_identified",
    moduleOwner: "m37",
    description: "A funeral home was identified (M22 issues the magic-link session).",
    payloadSchema: Type.Object({
      organizationId: id,
      bodyReleaseId: id,
      patientId: id,
      funeralHomeId: id,
    }),
    // F-117 (#248) — m22 removed: `identifyFuneralHome` also emits
    // `m37.body_release.document_requested` in the SAME transition (ipu-body-release.ts), the
    // actual live-bound M22 render request that issues the magic-link session this description
    // describes.
    // F-147 (#248) — checked precisely rather than left as a loose end: the DOCUMENT RENDER and the
    // MAGIC-LINK SESSION are two distinct architecture §7.8 facts M37's own spec describes separately
    // (§2.11: "M22 issues the funeral-home magic-link session" off THIS event; "M22 renders the
    // body-release-form payload" off the sibling `document_requested`) — F-117 only established that
    // the render half is covered. The session half is genuinely unbuilt on every side: no M22 route,
    // consumer, or `external-collaborator` surface exists anywhere in `22-documents/` (the Better Auth
    // `magicLink` plugin itself lives entirely in M2's `packages/auth/src/identity/auth.ts`, whose own
    // comment already anticipates an "auditor / external-collaborator / funeral-home magic-link class"
    // but has no M22-side caller). Still record-only — there is no consumer to declare this to, only a
    // real, reportable feature gap (the M22 external-collaborator/magic-link surface, architecture
    // §7.8) one layer deeper than a catalog declaration can fix.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.body_release.document_requested",
    moduleOwner: "m37",
    description: "The body-release authorization document render was requested (M22).",
    payloadSchema: Type.Object({
      organizationId: id,
      bodyReleaseId: id,
      /** The decedent's chart — M22 files `body_release_authorization` against it (F-099). */
      patientId: id,
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.body_release.completed",
    moduleOwner: "m37",
    description: "Body release completed (bed resumes cleaning).",
    payloadSchema: Type.Object({ organizationId: id, bodyReleaseId: id, patientId: id }),
    // F-117 (#248) — m22 removed: `releaseBody`'s own guard requires the signed M22
    // `body_release_authorization` document to already exist before this transition is legal
    // (ipu-body-release.ts) — the document was rendered earlier, at `funeral_home_identified`.
    // Nothing is left for M22 to produce when release COMPLETES.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── census (§2.13) ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m37.census.snapshot_taken",
    moduleOwner: "m37",
    description:
      "A daily census snapshot was materialized (M23 per-diem, M26 cap, M27 S-3, M33 MV).",
    payloadSchema: Type.Object({
      organizationId: id,
      providerEntityId: id,
      serviceDate: iso,
      unitId: nullableId,
      remoteFacilityId: nullableId,
    }),
    // F-130 (#248) — m27 REMOVED: the description's "M27 S-3" claim has no support in M27's own spec —
    // its §1.1 dependency line documents Worksheet S-3's service-side census as an M6
    // `LevelOfCarePeriodReader` seam pull only, with no mention of M37 anywhere (M37's own
    // `CostReportProvider.getInpatientCapPositionAtFiscalDate` consumption is the OPPOSITE direction —
    // M37 reads M27's output, not the reverse).
    // F-131 (#248) — m26 REMOVED: the description's "M26 cap" claim is equally unsupported — M26's D13
    // inpatient-day source is M23 claim lines by revenue code, and M26's own text never names M37.
    // F-136 (#248) — m23 REMOVED: the description's "M23 per-diem" claim is equally unsupported — M23's
    // own spec never names M37 as a consumed event; the only M37↔M23 relationship runs the other way.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── nursing-note shift coverage (§5.14) ───────────────────────────────────────────────────────────
  {
    eventName: "m37.nursing_note.shift_overdue",
    moduleOwner: "m37",
    description: "No q-shift nursing note exists for an (admission × shift) pair.",
    payloadSchema: Type.Object({ ...admissionCore, shiftId: id }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
];
