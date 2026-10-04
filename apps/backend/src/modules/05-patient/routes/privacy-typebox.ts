// apps/backend/src/modules/05-patient/routes/privacy-typebox.ts — the TypeBox contract of the Privacy
// Officer routes (M5 §4.2 / §5.1 "Privacy flags"):
//
//   GET  /api/v1/patients/:id/privacy                  the officer's view of one patient's restrictions
//   POST /api/v1/patients/:id/privacy-flags/resync     re-derive the snapshot from M39 consent state
//   GET  /api/v1/privacy/restricted-patients           the officer's work queue (patients with restrictions)
//
// Ids, statuses, dates and counts only — no document content and no detection evidence crosses here.
import { Type } from "@sinclair/typebox";

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);
const IsoDate = Type.String({ format: "date-time" });

export const PrivacyFlagOriginSchema = Type.Union([
  Type.Literal("consent"),
  Type.Literal("intake_unconfirmed"),
  Type.Literal("intake_confirmed"),
  Type.Literal("unattributed"),
]);

export const PrivacyDriftSchema = Type.Union([
  Type.Literal("snapshot_stale"),
  Type.Literal("consent_active_but_restricted"),
  Type.Literal("consent_inactive_but_unrestricted"),
  Type.Literal("intake_detection_without_flag"),
  Type.Literal("intake_confirmed_not_promoted"),
  Type.Literal("intake_flag_without_detection"),
]);

export const PatientPrivacyRestrictionSchema = Type.Object({
  flag: Type.String(),
  origin: PrivacyFlagOriginSchema,
  /** When the flag last became present (from the M4 trail), else the snapshot capture time. */
  since: Nullable(IsoDate),
  /** False when `since` is the snapshot capture time because the trail does not show the flag appearing. */
  sinceFromHistory: Type.Boolean(),
});

export const Part2ConsentStateSchema = Type.Object({
  state: Type.Union([Type.Literal("active"), Type.Literal("inactive"), Type.Literal("none")]),
  consentRecordId: Nullable(Type.String()),
  status: Nullable(Type.String()),
  effectiveAt: Nullable(IsoDate),
  expiresAt: Nullable(IsoDate),
  revokedAt: Nullable(IsoDate),
});

export const IntakeSudBatchSchema = Type.Object({
  batchId: Type.String(),
  sudStatus: Type.Union([
    Type.Literal("detected"),
    Type.Literal("confirmed"),
    Type.Literal("rejected"),
  ]),
  batchStatus: Type.String(),
  receivedAt: IsoDate,
  pageCount: Type.Union([Type.Integer(), Type.Null()]),
  resolvedAt: Nullable(IsoDate),
  /** True when this batch still holds a DocLens flag on the patient. */
  contributes: Type.Boolean(),
});

export const PrivacyHistoryEntrySchema = Type.Object({
  at: IsoDate,
  actorUserId: Nullable(Type.String()),
  action: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")]),
  flagsBefore: Type.Array(Type.String()),
  flagsAfter: Type.Array(Type.String()),
  sudOriginAfter: Nullable(Type.String()),
});

export const PatientPrivacyViewSchema = Type.Object({
  patient: Type.Object({
    id: Type.String(),
    displayName: Type.String(),
    mrn: Type.String(),
    status: Type.String(),
  }),
  snapshot: Type.Object({
    exists: Type.Boolean(),
    flags: Type.Array(Type.String()),
    capturedAt: Nullable(IsoDate),
    stale: Type.Boolean(),
    invalidatedAt: Nullable(IsoDate),
    sourceConsentVersion: Nullable(Type.String()),
  }),
  restrictions: Type.Array(PatientPrivacyRestrictionSchema),
  part2Consent: Part2ConsentStateSchema,
  intakeDetections: Type.Array(IntakeSudBatchSchema),
  history: Type.Array(PrivacyHistoryEntrySchema),
  drift: Type.Array(PrivacyDriftSchema),
});

export const PrivacyResyncResponseSchema = Type.Object({
  patientId: Type.String(),
  flagsBefore: Type.Array(Type.String()),
  flagsAfter: Type.Array(Type.String()),
  sudOriginAfter: Nullable(Type.String()),
  sourceConsentVersion: Nullable(Type.String()),
  flagsChanged: Type.Boolean(),
  /** True when `m5.patient.privacy_flag_changed` was emitted (only when the flag set changed). */
  eventEmitted: Type.Boolean(),
  capturedAt: IsoDate,
});

/** M5 §4.5 `patient.snapshot_rebuild` run summary (manual admin trigger) — counts only. */
export const PrivacySnapshotRebuildResponseSchema = Type.Object({
  organizationId: Type.String(),
  patients: Type.Integer(),
  rewritten: Type.Integer(),
  flagsChanged: Type.Integer(),
  staleCleared: Type.Integer(),
  unchanged: Type.Integer(),
  failed: Type.Integer(),
});

export const RestrictedPatientsQuerySchema = Type.Object({
  origin: Type.Optional(Type.Union([PrivacyFlagOriginSchema, Type.Literal("stale")])),
  cursor: Type.Optional(Type.String({ maxLength: 16 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const RestrictedPatientSchema = Type.Object({
  patientId: Type.String(),
  displayName: Type.String(),
  mrn: Type.String(),
  flags: Type.Array(Type.String()),
  /** The origin of the `sud` flag when present, else `unattributed`. */
  origin: PrivacyFlagOriginSchema,
  capturedAt: IsoDate,
  stale: Type.Boolean(),
});

export const RestrictedPatientsResponseSchema = Type.Object({
  items: Type.Array(RestrictedPatientSchema),
  nextCursor: Nullable(Type.String()),
  counts: Type.Object({
    total: Type.Integer(),
    consent: Type.Integer(),
    intake_unconfirmed: Type.Integer(),
    intake_confirmed: Type.Integer(),
    unattributed: Type.Integer(),
    stale: Type.Integer(),
  }),
});
