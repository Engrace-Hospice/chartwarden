// apps/backend/src/modules/06-admission/routes/election-addendum-typebox.ts — TypeBox schemas for the FY2027
// election statement addendum routes (42 CFR 418.24(c)/(d)). Request bodies are validated through `parse`
// (admission-typebox.ts); the response schemas are the published OpenAPI contract and are pinned to the
// service view by the `Conforms` checks at the bottom.
import { type Static, Type } from "@sinclair/typebox";
import type {
  ElectionAddendumOverview as ServiceOverview,
  ElectionAddendumView as ServiceView,
} from "../election-addendum/service";

const Version = () => Type.Integer({ minimum: 0 });
const Nullable = <T extends ReturnType<typeof Type.String>>(s: T) => Type.Union([s, Type.Null()]);

export const ElectionAddendumParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  addendumId: Type.String({ minLength: 1, maxLength: 64 }),
});

const CategorySchema = Type.Union([
  Type.Literal("condition"),
  Type.Literal("item"),
  Type.Literal("service"),
  Type.Literal("drug"),
]);
const SourceSchema = Type.Union([
  Type.Literal("problem"),
  Type.Literal("medication"),
  Type.Literal("dme"),
  Type.Literal("supply"),
  Type.Literal("service"),
]);
export const ElectionAddendumItemSchema = Type.Object({
  category: CategorySchema,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  reasonNotCovered: Type.String({ minLength: 1, maxLength: 2000 }),
  source: Type.Optional(SourceSchema),
  sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});
export const ElectionAddendumDiagnosisSchema = Type.Object({
  icd10Code: Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
  description: Type.String({ minLength: 1, maxLength: 500 }),
});

const ExemptionReasonSchema = Type.Union([
  Type.Literal("death"),
  Type.Literal("revocation"),
  Type.Literal("discharge"),
]);

/** POST /admissions/:id/election-addendum — no body fields (the server decides initial vs. update). */
export const ElectionAddendumDraftSchema = Type.Object({});

/** PATCH — edit a DRAFT version. Every field optional; `ifVersion` required. */
export const ElectionAddendumPatchSchema = Type.Object({
  ifVersion: Version(),
  items: Type.Optional(Type.Array(ElectionAddendumItemSchema, { maxItems: 100 })),
  noNonCoveredItems: Type.Optional(Type.Boolean()),
  clinicalExplanation: Type.Optional(Nullable(Type.String({ maxLength: 8000 }))),
  guidelineReferences: Type.Optional(Nullable(Type.String({ maxLength: 4000 }))),
  terminalDiagnosis: Type.Optional(Type.Array(ElectionAddendumDiagnosisSchema, { maxItems: 20 })),
  relatedDiagnoses: Type.Optional(Type.Array(ElectionAddendumDiagnosisSchema, { maxItems: 40 })),
  hospiceName: Type.Optional(Nullable(Type.String({ maxLength: 300 }))),
  patientName: Type.Optional(Nullable(Type.String({ maxLength: 300 }))),
  medicalRecordNumber: Type.Optional(Nullable(Type.String({ maxLength: 64 }))),
});

export const ElectionAddendumFurnishSchema = Type.Object({
  ifVersion: Version(),
  method: Type.Union([Type.Literal("paper"), Type.Literal("electronic_with_paper_copy")]),
  /** When it was handed over, if earlier than now (back-entry of a paper furnish). */
  furnishedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const ElectionAddendumSignatureSchema = Type.Object({
  ifVersion: Version(),
  signerKind: Type.Union([Type.Literal("beneficiary"), Type.Literal("representative")]),
  representativeName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  representativeRelationship: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
  signedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const ElectionAddendumRefusalSchema = Type.Object({
  ifVersion: Version(),
  reason: Type.String({ minLength: 5, maxLength: 2000 }),
});

/** The scanned paper copy (an M22 document version uploaded first through the verified-upload ceremony). */
const ScannedCopyFields = {
  ifVersion: Version(),
  documentId: Type.String({ format: "uuid" }),
  documentVersionId: Type.String({ format: "uuid" }),
  /** When the paper was handed over. REQUIRED when the version is still a draft (never furnished in WardenX). */
  furnishedAt: Type.Optional(Type.String({ format: "date-time" })),
};

/** POST …/signature/uploaded-evidence — a scanned SIGNED paper copy (418.24(c)(9)). */
export const ElectionAddendumUploadedSignatureSchema = Type.Object({
  ...ScannedCopyFields,
  signerKind: Type.Union([Type.Literal("beneficiary"), Type.Literal("representative")]),
  representativeName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  representativeRelationship: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
  /** The date written on the paper signature (not in the future). */
  signedAt: Type.String({ format: "date-time" }),
});

/** POST …/refusal/uploaded-evidence — a scanned paper copy on which the refusal is documented. */
export const ElectionAddendumUploadedRefusalSchema = Type.Object({
  ...ScannedCopyFields,
  reason: Type.String({ minLength: 5, maxLength: 2000 }),
  refusedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const ElectionAddendumSignatureNotRequiredSchema = Type.Object({
  ifVersion: Version(),
  reason: ExemptionReasonSchema,
  note: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
});

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const ElectionAddendumViewSchema = Type.Object({
  id: Type.String(),
  admissionId: Type.String(),
  patientId: Type.String(),
  electionStatementId: NullableString,
  versionNumber: Type.Integer(),
  trigger: Type.Union([Type.Literal("initial"), Type.Literal("poc_change")]),
  triggerCause: NullableString,
  triggeredAt: Type.String(),
  status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("furnished"),
    Type.Literal("signed"),
    Type.Literal("refused"),
    Type.Literal("signature_not_required"),
    Type.Literal("not_required"),
  ]),
  hospiceName: NullableString,
  patientName: NullableString,
  medicalRecordNumber: NullableString,
  terminalDiagnosis: Type.Array(ElectionAddendumDiagnosisSchema),
  relatedDiagnoses: Type.Array(ElectionAddendumDiagnosisSchema),
  items: Type.Array(ElectionAddendumItemSchema),
  noNonCoveredItems: Type.Boolean(),
  clinicalExplanation: NullableString,
  guidelineReferences: NullableString,
  dueAt: NullableString,
  furnishedAt: NullableString,
  furnishMethod: Type.Union([
    Type.Literal("paper"),
    Type.Literal("electronic_with_paper_copy"),
    Type.Null(),
  ]),
  signedAt: NullableString,
  signerKind: Type.Union([
    Type.Literal("beneficiary"),
    Type.Literal("representative"),
    Type.Null(),
  ]),
  representativeName: NullableString,
  representativeRelationship: NullableString,
  acknowledgementSource: Type.Union([
    Type.Literal("structured"),
    Type.Literal("uploaded"),
    Type.Null(),
  ]),
  acknowledgementDocumentId: NullableString,
  acknowledgementDocumentVersionId: NullableString,
  contentSource: Type.Union([Type.Literal("structured"), Type.Literal("scanned_paper")]),
  refusedAt: NullableString,
  refusalReason: NullableString,
  signatureNotRequiredReason: Type.Union([ExemptionReasonSchema, Type.Null()]),
  signatureNotRequiredNote: NullableString,
  signatureNotRequiredAt: NullableString,
  documentId: NullableString,
  supersededById: NullableString,
  supersededAt: NullableString,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  version: Type.Integer(),
});

export const ElectionAddendumOverviewSchema = Type.Object({
  admissionId: Type.String(),
  required: Type.Boolean(),
  electionEffectiveDate: NullableString,
  inCare: Type.Boolean(),
  current: Type.Union([ElectionAddendumViewSchema, Type.Null()]),
  history: Type.Array(ElectionAddendumViewSchema),
  openWindows: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.String(),
      status: Type.String(),
      dueAt: Type.String(),
    }),
  ),
});

// Compile-time drift guards: the published schema must accept exactly what the service returns.
type Conforms<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
export type _AddendumViewConforms = Conforms<
  DeepMutable<Static<typeof ElectionAddendumViewSchema>>,
  DeepMutable<ServiceView>
>;
export type _AddendumOverviewConforms = Conforms<
  DeepMutable<Static<typeof ElectionAddendumOverviewSchema>>,
  DeepMutable<ServiceOverview>
>;
const _viewCheck: _AddendumViewConforms = true;
const _overviewCheck: _AddendumOverviewConforms = true;
void _viewCheck;
void _overviewCheck;
