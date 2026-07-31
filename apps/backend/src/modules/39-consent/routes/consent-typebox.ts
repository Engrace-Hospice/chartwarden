// apps/backend/src/modules/39-consent/routes/consent-typebox.ts — M39-T07 TypeBox route schemas
// (M39 spec §4.2). Named `consent-typebox` (not `*schema*`) so the table-ownership import heuristic
// never mistakes a TypeBox-schema import for a Drizzle one. Validation runs through TypeBox `Value`
// so a bad request fails with M1's VALIDATION_FAILED envelope and query scalars coerce first.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CONSENT_TYPE_KEYS } from "@wardenx/consent";
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
});

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
  [
    "patient_self",
    "dpoa_healthcare_agent",
    "dpoa_financial_agent",
    "court_guardian",
    "parent_for_minor",
    "healthcare_surrogate",
    "bereaved_person_self",
  ].map((g) => Type.Literal(g)),
);

const CAPTURE_METHOD = Type.Union(
  [
    "electronic_portal_signature",
    "typed_signature_in_app",
    "uploaded_signed_pdf",
    "witnessed_verbal_documented",
    "notarized",
  ].map((m) => Type.Literal(m)),
);

const RECIPIENT_KIND = Type.Union(
  [
    "external_physician",
    "facility",
    "pharmacy",
    "irb",
    "family_member",
    "attorney",
    "employer",
    "researcher",
    "free_text",
  ].map((k) => Type.Literal(k)),
);

const DPOA_AGENT_KIND = Type.Union(
  ["primary", "alternate_1", "alternate_2"].map((k) => Type.Literal(k)),
);

const DPOA_SCOPE_KIND = Type.Union(
  ["healthcare_full", "healthcare_end_of_life_only", "financial_narrow", "financial_broad"].map(
    (k) => Type.Literal(k),
  ),
);

const DPOA_ACTIVATION = Type.Union(
  [
    "immediate",
    "upon_incapacity_attested",
    "upon_physician_determination",
    "upon_incompetence_court_order",
  ].map((k) => Type.Literal(k)),
);

const DPOA_TERM_KIND = Type.Union(
  ["indefinite", "until_date", "event_driven"].map((k) => Type.Literal(k)),
);

const REMINDER_KIND = Type.Union(
  ["90_days", "30_days", "14_days", "7_days", "1_day"].map((k) => Type.Literal(k)),
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
  tighterExpirationSeconds: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  ),
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
});

/** Route 9 — POST /consents/:consentId/supersede. */
export const SupersedeBodySchema = Type.Object({
  scopeDescriptor: Type.Unknown(),
  captureMethod: CAPTURE_METHOD,
  grantorKind: GRANTOR_KIND,
  survivesDeath: Type.Optional(Type.Boolean()),
});

/** Route 20 — POST /consents/:consentId/renew. */
export const RenewBodySchema = Type.Object({
  scopeDescriptor: Type.Unknown(),
  captureMethod: CAPTURE_METHOD,
  grantorKind: GRANTOR_KIND,
  expiresAt: Type.Optional(Type.Union([isoInstant(), Type.Null()])),
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
  grantorKind: Type.String(),
  captureMethod: Type.String(),
  scopeDescriptor: Type.Unknown(),
  status: Type.Union(
    ["draft", "active", "superseded", "revoked", "expired"].map((s) => Type.Literal(s)),
  ),
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
  recipientKind: Type.String(),
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
export const ConsentRecipientListResponseSchema = dataOf(
  Type.Array(ConsentRecipientViewSchema),
);

/** `ConsentDpoaAgentView` — a named DPOA agent (D5). */
export const ConsentDpoaAgentViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  consentRecordId: Type.String(),
  patientId: Type.String(),
  agentKind: Type.String(),
  agentName: Type.String(),
  agentRelationship: Type.String(),
  scopeKind: Type.String(),
  activationCondition: Type.String(),
  termKind: Type.String(),
  termUntil: nullableStr(),
  addedAt: Type.String(),
  addedById: Type.String(),
  removedAt: nullableStr(),
  active: Type.Boolean(),
});
export const ConsentDpoaAgentListResponseSchema = dataOf(
  Type.Array(ConsentDpoaAgentViewSchema),
);
