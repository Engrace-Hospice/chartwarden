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
    description: "A bed was assigned; M6 confirms the LCP, M23 writes the place-of-service Q-code.",
    payloadSchema: Type.Object({ ...admissionCore, bedId: id, levelOfCarePeriodId: id }),
    declaredConsumers: ["m6", "m23"],
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
    declaredConsumers: ["m23", "m26", "m27"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.discharged",
    moduleOwner: "m37",
    description: "An admission was discharged.",
    payloadSchema: Type.Object({ ...admissionCore, reason: id }),
    declaredConsumers: ["m23", "m26", "m27", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m37.ipu_admission.death_recorded",
    moduleOwner: "m37",
    description: "A death was recorded in the IPU (opens body release; M22 magic-link).",
    payloadSchema: Type.Object({ ...admissionCore, deathEventId: id }),
    declaredConsumers: ["m22", "m30", "m16"],
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
    declaredConsumers: ["m13"],
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
    declaredConsumers: ["m23", "m26", "m27"],
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
