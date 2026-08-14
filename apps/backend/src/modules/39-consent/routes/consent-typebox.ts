// apps/backend/src/modules/39-consent/routes/consent-typebox.ts — M39-T07 TypeBox route schemas
// (M39 spec §4.2). Named `consent-typebox` (not `*schema*`) so the table-ownership import heuristic
// never mistakes a TypeBox-schema import for a Drizzle one. Validation runs through TypeBox `Value`
// so a bad request fails with M1's VALIDATION_FAILED envelope and query scalars coerce first.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CONSENT_TYPE_KEYS } from "@wardenx/consent";
import type {
  CascadeRetryView,
  ConsentCatalogView,
  ConsentDpoaAgentView,
  ConsentRecipientView,
  ConsentRecordView,
  ConsentRenewalCycleView,
  ConsentTypeOverlayView,
  ConsentVersionChainView,
  DelegatedAccessView,
  EvalAuditRow,
  ExpiringConsentView,
  PostMortemEligibilityView,
  ReRenderReceiptView,
} from "@wardenx/consent";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

export const ConsentTypeKeySchema = Type.Union(CONSENT_TYPE_KEYS.map((k) => Type.Literal(k)));

export const PatientIdParamsSchema = Type.Object({ patientId: Type.String({ minLength: 1 }) });
export const ConsentIdParamsSchema = Type.Object({ consentId: Type.String({ minLength: 1 }) });

export const CreateDraftBodySchema = Type.Object({
  typeKey: ConsentTypeKeySchema,
  grantorKind: Type.Union(
    [
      "patient_self",
      "dpoa_healthcare_agent",
      "dpoa_financial_agent",
      "court_guardian",
      "parent_for_minor",
      "healthcare_surrogate",
      "bereaved_person_self",
    ].map((g) => Type.Literal(g)),
  ),
  captureMethod: Type.Union(
    [
      "electronic_portal_signature",
      "typed_signature_in_app",
      "uploaded_signed_pdf",
      "witnessed_verbal_documented",
      "notarized",
    ].map((m) => Type.Literal(m)),
  ),
  scopeDescriptor: Type.Unknown(),
  grantorUserId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  grantorCaregiverId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  grantorRelationshipText: Type.Optional(
    Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
  ),
  actingConsentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  effectiveAt: Type.Optional(Type.String({ minLength: 20 })),
  expiresAt: Type.Optional(Type.Union([Type.String({ minLength: 20 }), Type.Null()])),
  jurisdictionCode: Type.Optional(
    Type.Union([Type.String({ pattern: "^[A-Z]{2}$" }), Type.Null()]),
  ),
  languageCode: Type.Optional(
    Type.Union([Type.String({ pattern: "^[a-z]{2}(-[A-Z]{2})?$" }), Type.Null()]),
  ),
  survivesDeath: Type.Optional(Type.Boolean()),
  internalNotesPlaintext: Type.Optional(
    Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
  ),
});

export const CaptureEvidenceSchema = Type.Object({
  signedAtIso: Type.Optional(Type.String({ minLength: 20 })),
  typedSignatureName: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
  typedSignatureRole: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
  portalSessionId: Type.Optional(Type.String({ minLength: 1 })),
  uploadedPdfDocumentId: Type.Optional(Type.String({ format: "uuid" })),
  witnessName: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
  witnessAttestationText: Type.Optional(Type.String({ minLength: 20, maxLength: 4000 })),
  witnessSignatureEvidenceDocumentId: Type.Optional(Type.String({ format: "uuid" })),
  notaryCertificateDocumentId: Type.Optional(Type.String({ format: "uuid" })),
});

export const SignConsentBodySchema = Type.Object({ captureEvidence: CaptureEvidenceSchema });

export const RevokeBodySchema = Type.Object({
  revokedByKind: Type.Union(
    [
      "patient_self_via_portal",
      "staff",
      "dpoa_agent",
      "court_order",
      "platform_admin_break_glass",
    ].map((k) => Type.Literal(k)),
  ),
  reasonText: Type.String({ default: "" }),
  evidenceDocumentId: Type.Optional(Type.String({ format: "uuid" })),
});

// §4.12 cursor pagination — opaque cursor + bounded page size (never offset).
export const EvalAuditQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ minLength: 1 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

// ── the §4.1 surface beyond the original slice ─────────────────────────────────────────────────
//
// The vocab unions below mirror the FROZEN pgEnums in packages/db/src/enums.ts (consent_recipient_kind,
// consent_dpoa_*, consent_reminder_kind) and the @wardenx/consent type-level mirrors. An off-vocabulary
// value is refused here rather than at the INSERT — the M3/M24 boundary-validation posture.

const GRANTOR_KIND = Type.Union(
  (
    [
      "patient_self",
      "dpoa_healthcare_agent",
      "dpoa_financial_agent",
      "court_guardian",
      "parent_for_minor",
      "healthcare_surrogate",
      "bereaved_person_self",
    ] as const
  ).map((g) => Type.Literal(g)),
);

const CAPTURE_METHOD = Type.Union(
  (
    [
      "electronic_portal_signature",
      "typed_signature_in_app",
      "uploaded_signed_pdf",
      "witnessed_verbal_documented",
      "notarized",
    ] as const
  ).map((m) => Type.Literal(m)),
);

const RECIPIENT_KIND = Type.Union(
  (
    [
      "external_physician",
      "facility",
      "pharmacy",
      "irb",
      "family_member",
      "attorney",
      "employer",
      "researcher",
      // The one INTERNAL class (mig 0209): `recipientEntityId` carries an M2 MEMBERSHIP id, so a
      // §2.31 release can name the individual staff members it authorizes. Naming none keeps the
      // release program-wide; naming any restricts it to them.
      "workforce_member",
      "free_text",
    ] as const
  ).map((k) => Type.Literal(k)),
);

const DPOA_AGENT_KIND = Type.Union(
  (["primary", "alternate_1", "alternate_2"] as const).map((k) => Type.Literal(k)),
);

const DPOA_SCOPE_KIND = Type.Union(
  (
    [
      "healthcare_full",
      "healthcare_end_of_life_only",
      "financial_narrow",
      "financial_broad",
    ] as const
  ).map((k) => Type.Literal(k)),
);

const DPOA_ACTIVATION = Type.Union(
  (
    [
      "immediate",
      "upon_incapacity_attested",
      "upon_physician_determination",
      "upon_incompetence_court_order",
    ] as const
  ).map((k) => Type.Literal(k)),
);

const DPOA_TERM_KIND = Type.Union(
  (["indefinite", "until_date", "event_driven"] as const).map((k) => Type.Literal(k)),
);

const REMINDER_KIND = Type.Union(
  (["90_days", "30_days", "14_days", "7_days", "1_day"] as const).map((k) => Type.Literal(k)),
);

const CONSENT_STATUS = Type.Union(
  (["draft", "active", "superseded", "revoked", "expired"] as const).map((s) => Type.Literal(s)),
);

const RENEWAL_CYCLE_STATUS = Type.Union(
  (
    ["open", "renewed", "closed_expired", "closed_revoked", "closed_no_longer_applicable"] as const
  ).map((s) => Type.Literal(s)),
);

const CASCADE_STATUS = Type.Union(
  (["pending", "in_progress", "completed", "partial_failed"] as const).map((s) => Type.Literal(s)),
);

const isoInstant = () =>
  Type.String({ minLength: 20, description: "ISO-8601 instant (timestamptz column)" });

export const RecipientIdParamsSchema = Type.Object({
  consentId: Type.String({ minLength: 1 }),
  recipientId: Type.String({ minLength: 1 }),
});

export const DpoaAgentIdParamsSchema = Type.Object({
  consentId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
});

/** Route 2 — POST /consent-types/overlay (tighten-only; the pure validator refuses a loosen). */
export const UpsertOverlayBodySchema = Type.Object({
  typeKey: ConsentTypeKeySchema,
  tighterExpirationSeconds: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  tighterCaptureMethods: Type.Optional(Type.Array(CAPTURE_METHOD, { minItems: 1 })),
  tighterReminderCadence: Type.Optional(Type.Array(REMINDER_KIND, { minItems: 1 })),
  stateAddendumText: Type.Optional(Type.Union([Type.String({ maxLength: 8000 }), Type.Null()])),
  jurisdictionCodeRequired: Type.Optional(Type.Boolean()),
});

/** Route 7 — PATCH /consents/:consentId (only a `draft` is editable, D1). */
export const UpdateDraftBodySchema = Type.Object({
  scopeDescriptor: Type.Optional(Type.Unknown()),
  captureMethod: Type.Optional(CAPTURE_METHOD),
  grantorKind: Type.Optional(GRANTOR_KIND),
  survivesDeath: Type.Optional(Type.Boolean()),
  internalNotesPlaintext: Type.Optional(
    Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
  ),
});

/** Route 9 — POST /consents/:consentId/supersede. */
export const SupersedeBodySchema = Type.Object({
  scopeDescriptor: Type.Unknown(),
  captureMethod: CAPTURE_METHOD,
  grantorKind: GRANTOR_KIND,
  grantorUserId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  grantorCaregiverId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  grantorRelationshipText: Type.Optional(
    Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
  ),
  actingConsentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  survivesDeath: Type.Optional(Type.Boolean()),
  captureEvidence: CaptureEvidenceSchema,
});

/** Route 20 — POST /consents/:consentId/renew. */
export const RenewBodySchema = Type.Object({
  scopeDescriptor: Type.Unknown(),
  captureMethod: CAPTURE_METHOD,
  grantorKind: GRANTOR_KIND,
  grantorUserId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  grantorCaregiverId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  grantorRelationshipText: Type.Optional(
    Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
  ),
  actingConsentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  expiresAt: Type.Optional(Type.Union([isoInstant(), Type.Null()])),
  captureEvidence: CaptureEvidenceSchema,
});

/** Route 12 — POST /consents/:consentId/recipients. */
export const AddRecipientBodySchema = Type.Object({
  recipientKind: RECIPIENT_KIND,
  recipientEntityId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  recipientFreeText: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  recipientDisplayName: Type.String({ minLength: 1, maxLength: 500 }),
  purposeCode: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  expiresAt: Type.Optional(Type.Union([isoInstant(), Type.Null()])),
});

/** Route 13 — DELETE /consents/:consentId/recipients/:recipientId (flips removed_at). */
export const RemoveRecipientBodySchema = Type.Object({
  removedReasonText: Type.String({ minLength: 1, maxLength: 2000 }),
});

/** Route 15 — POST /consents/:consentId/dpoa-agents. */
export const AddDpoaAgentBodySchema = Type.Object({
  agentKind: DPOA_AGENT_KIND,
  agentName: Type.String({ minLength: 1, maxLength: 300 }),
  agentRelationship: Type.String({ minLength: 1, maxLength: 100 }),
  agentContact: Type.Object({}, { additionalProperties: true }),
  scopeKind: DPOA_SCOPE_KIND,
  activationCondition: DPOA_ACTIVATION,
  termKind: DPOA_TERM_KIND,
  termUntil: Type.Optional(Type.Union([isoInstant(), Type.Null()])),
});

/** Route 16 — PATCH /consents/:consentId/dpoa-agents/:agentId. */
export const UpdateDpoaAgentBodySchema = Type.Object({
  scopeKind: Type.Optional(DPOA_SCOPE_KIND),
  activationCondition: Type.Optional(DPOA_ACTIVATION),
  termKind: Type.Optional(DPOA_TERM_KIND),
  termUntil: Type.Optional(Type.Union([isoInstant(), Type.Null()])),
  remove: Type.Optional(Type.Boolean()),
});

/** Route 18 — GET /patients/:patientId/expiring-consents (cursor-paginated, §4.12). */
export const ExpiringConsentsQuerySchema = Type.Object({
  windowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365, default: 90 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

/** Route 22 — GET /consents/:consentId/eval-audit (cursor-paginated, §4.12). */
export const ConsentEvalAuditQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

/** Route 29 — POST /consents/bereavement-outreach (post-mortem capture, D14). */
export const BereavementOutreachBodySchema = Type.Object({
  patientId: Type.String({ minLength: 1 }),
  grantorKind: GRANTOR_KIND,
  captureMethod: CAPTURE_METHOD,
  scopeDescriptor: Type.Unknown(),
});

export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}

// ── §4.1 RESPONSE DTOs ─────────────────────────────────────────────────────────────────────────
//
// The reads the M39 web screens call. Without these the generated client types every M39 response as
// `content?: never` and a screen has to cast through a hand-maintained row shape that drifts silently —
// the exact problem the M25 screens carried until their DTOs landed. These mirror the view interfaces in
// @wardenx/consent's route service; that file is the contract, this is its wire projection.
//
// Every route wraps its payload in `{ data }` (paged reads add `nextCursor`), so the envelope is modelled
// here rather than left for each screen to guess at.

const nullableStr = () => Type.Union([Type.String(), Type.Null()]);
const dataOf = <T extends TSchema>(payload: T) => Type.Object({ data: payload });
const pagedOf = <T extends TSchema>(item: T) =>
  Type.Object({ data: Type.Array(item), nextCursor: nullableStr() });

/** `ConsentRecordView` — the record every consent surface renders. */
export const ConsentRecordViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  typeKey: ConsentTypeKeySchema,
  grantorKind: GRANTOR_KIND,
  captureMethod: CAPTURE_METHOD,
  scopeDescriptor: Type.Unknown(),
  status: CONSENT_STATUS,
  version: Type.Integer(),
  effectiveAt: nullableStr(),
  expiresAt: nullableStr(),
  signedAt: nullableStr(),
  createdById: Type.String(),
  supersedesConsentRecordId: Type.Optional(nullableStr()),
  renewedFromConsentRecordId: Type.Optional(nullableStr()),
  survivesDeath: Type.Optional(Type.Boolean()),
});
export const ConsentListResponseSchema = dataOf(Type.Array(ConsentRecordViewSchema));

/** `ExpiringConsentView` — a consent inside the renewal window, with its countdown. */
export const ExpiringConsentViewSchema = Type.Intersect([
  ConsentRecordViewSchema,
  Type.Object({ daysUntilExpiry: Type.Integer() }),
]);
export const ExpiringConsentsResponseSchema = pagedOf(ExpiringConsentViewSchema);

/** `ConsentRecipientView` — a named disclosure recipient (D6). `active` is derived server-side. */
export const ConsentRecipientViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  consentRecordId: Type.String(),
  recipientKind: RECIPIENT_KIND,
  recipientEntityId: nullableStr(),
  recipientDisplayName: Type.String(),
  purposeCode: nullableStr(),
  expiresAt: nullableStr(),
  addedAt: Type.String(),
  addedById: Type.String(),
  removedAt: nullableStr(),
  removedReasonText: nullableStr(),
  active: Type.Boolean(),
});
export const ConsentRecipientListResponseSchema = dataOf(Type.Array(ConsentRecipientViewSchema));

/** `ConsentDpoaAgentView` — a named DPOA agent (D5). */
export const ConsentDpoaAgentViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  consentRecordId: Type.String(),
  patientId: Type.String(),
  agentKind: DPOA_AGENT_KIND,
  agentName: Type.String(),
  agentRelationship: Type.String(),
  scopeKind: DPOA_SCOPE_KIND,
  activationCondition: DPOA_ACTIVATION,
  termKind: DPOA_TERM_KIND,
  termUntil: nullableStr(),
  addedAt: Type.String(),
  addedById: Type.String(),
  removedAt: nullableStr(),
  active: Type.Boolean(),
});
export const ConsentDpoaAgentListResponseSchema = dataOf(Type.Array(ConsentDpoaAgentViewSchema));

// ── §4.1 RESPONSE DTOs (F0 enrichment batch 2) ───────────────────────────────────────────────────
//
// The reads/writes the original DTO block left uncovered — the catalog, single-record reads, the two
// ancestor chains, the DPOA active-primary resolver, renewal cycles, delegated access, the post-mortem
// verdict list, the re-render receipt, and the cascade-retry verdict. Each mirrors its `service.ts` view
// interface 1:1 and is pinned to it by the compile-time `Conforms` aliases at the bottom, so a view field
// added or renamed breaks `bun run build` rather than silently drifting the generated client to `never`.

/** `ConsentCatalogView` — a row of the consent-type catalog + applicable overlay (route 1). */
export const ConsentCatalogViewSchema = Type.Object({
  typeKey: ConsentTypeKeySchema,
  displayNameEn: Type.String(),
  scopeDiscriminator: Type.String(),
  isPerRecipient: Type.Boolean(),
});
export const ConsentCatalogListResponseSchema = dataOf(Type.Array(ConsentCatalogViewSchema));

/** A single consent record (routes 4 sign/8/supersede/9/revoke/10/renew/20/create/bereavement). */
export const ConsentRecordResponseSchema = dataOf(ConsentRecordViewSchema);

/** `ConsentVersionChainView` — both ancestor chains, oldest → newest (route 5). */
export const ConsentVersionChainViewSchema = Type.Object({
  consentId: Type.String(),
  supersedes: Type.Array(ConsentRecordViewSchema),
  renewedFrom: Type.Array(ConsentRecordViewSchema),
});
export const ConsentVersionChainResponseSchema = dataOf(ConsentVersionChainViewSchema);

/** A single recipient row (routes 12 add / 13 remove). */
export const ConsentRecipientResponseSchema = dataOf(ConsentRecipientViewSchema);

/** A single DPOA agent row (routes 15 add / 16 patch). */
export const ConsentDpoaAgentResponseSchema = dataOf(ConsentDpoaAgentViewSchema);

/** The patient's ACTIVE primary DPOA agent, or null (route 17; consumed by M7/M11/M14). */
export const ActivePrimaryDpoaResponseSchema = Type.Object({
  data: Type.Union([ConsentDpoaAgentViewSchema, Type.Null()]),
});

/** `ConsentRenewalCycleView` — an open/closed renewal cycle (route 19, D8). */
export const ConsentRenewalCycleViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  sourceConsentRecordId: Type.String(),
  patientId: Type.String(),
  status: RENEWAL_CYCLE_STATUS,
  cycleStartedAt: Type.String(),
  nextActionDueAt: nullableStr(),
  closedAt: nullableStr(),
  closedReason: nullableStr(),
  resolvedConsentRecordId: nullableStr(),
  assignedToMembershipId: nullableStr(),
});
export const ConsentRenewalCycleListResponseSchema = dataOf(
  Type.Array(ConsentRenewalCycleViewSchema),
);

/** `DelegatedAccessView` — the D10 projection a portal/caregiver session resolves against (route 21). */
export const DelegatedAccessViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  consentRecordId: Type.String(),
  consentRecordRecipientId: nullableStr(),
  delegateUserId: nullableStr(),
  delegateCaregiverId: Type.String(),
  scope: Type.String(),
  effectiveFrom: Type.String(),
  effectiveUntil: nullableStr(),
  portalSessionClass: Type.String(),
  revokedAt: nullableStr(),
  active: Type.Boolean(),
});
export const DelegatedAccessListResponseSchema = dataOf(Type.Array(DelegatedAccessViewSchema));

/** `PostMortemEligibilityView` — the M16 survive-death verdict per consent (route 28, D13). */
export const PostMortemEligibilityViewSchema = Type.Object({
  consentId: Type.String(),
  typeKey: ConsentTypeKeySchema,
  status: CONSENT_STATUS,
  survivesDeath: Type.Boolean(),
  terminatesOnDeath: Type.Boolean(),
});
export const PostMortemEligibilityListResponseSchema = dataOf(
  Type.Array(PostMortemEligibilityViewSchema),
);

/** `ReRenderReceiptView` — the re-render request receipt (route 24). */
export const ReRenderReceiptViewSchema = Type.Object({
  consentRecordId: Type.String(),
  requestedAt: Type.String(),
  requestedById: Type.String(),
  eventType: Type.Literal("m39.consent.signed"),
});
export const ReRenderReceiptResponseSchema = dataOf(ReRenderReceiptViewSchema);

/** `CascadeRetryView` — the D7 cascade sweep verdict after a retry (route 30). */
export const CascadeRetryViewSchema = Type.Object({
  consentRecordId: Type.String(),
  revocationId: Type.String(),
  status: CASCADE_STATUS,
  attempts: Type.Integer(),
  pendingConsumers: Type.Array(Type.String()),
});
export const CascadeRetryResponseSchema = dataOf(CascadeRetryViewSchema);

/** `EvalAuditRow` — a consent-decision audit row (routes 22/23, cursor-paginated). */
export const EvalAuditRowSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  consentRecordId: nullableStr(),
  typeKey: ConsentTypeKeySchema,
  allowed: Type.Boolean(),
  denyReason: nullableStr(),
  callerModule: Type.String(),
  evaluatedAt: Type.String(),
});
export const EvalAuditPageResponseSchema = pagedOf(EvalAuditRowSchema);

/** `ConsentTypeOverlayView` — the published tenant overlay row (route 2, §7.6). */
export const ConsentTypeOverlayViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  typeKey: ConsentTypeKeySchema,
  tighterExpirationSeconds: Type.Union([Type.Integer(), Type.Null()]),
  tighterCaptureMethods: Type.Union([Type.Array(Type.String()), Type.Null()]),
  tighterReminderCadence: Type.Union([Type.Array(Type.String()), Type.Null()]),
  stateAddendumText: nullableStr(),
  jurisdictionCodeRequired: Type.Union([Type.Boolean(), Type.Null()]),
  publishedAt: nullableStr(),
  publishedById: nullableStr(),
});
export const ConsentTypeOverlayResponseSchema = dataOf(ConsentTypeOverlayViewSchema);

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _Rec = Conforms<Static<typeof ConsentRecordViewSchema>, ConsentRecordView>;
type _Expiring = Conforms<Static<typeof ExpiringConsentViewSchema>, ExpiringConsentView>;
type _Recipient = Conforms<Static<typeof ConsentRecipientViewSchema>, ConsentRecipientView>;
type _Dpoa = Conforms<Static<typeof ConsentDpoaAgentViewSchema>, ConsentDpoaAgentView>;
type _Catalog = Conforms<Static<typeof ConsentCatalogViewSchema>, ConsentCatalogView>;
type _Chain = Conforms<Static<typeof ConsentVersionChainViewSchema>, ConsentVersionChainView>;
type _Cycle = Conforms<Static<typeof ConsentRenewalCycleViewSchema>, ConsentRenewalCycleView>;
type _Delegated = Conforms<Static<typeof DelegatedAccessViewSchema>, DelegatedAccessView>;
type _PostMortem = Conforms<
  Static<typeof PostMortemEligibilityViewSchema>,
  PostMortemEligibilityView
>;
type _ReRender = Conforms<Static<typeof ReRenderReceiptViewSchema>, ReRenderReceiptView>;
type _Cascade = Conforms<Static<typeof CascadeRetryViewSchema>, CascadeRetryView>;
type _Eval = Conforms<Static<typeof EvalAuditRowSchema>, EvalAuditRow>;
type _Overlay = Conforms<Static<typeof ConsentTypeOverlayViewSchema>, ConsentTypeOverlayView>;
