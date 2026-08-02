// apps/backend/src/modules/31-portal/routes/portal-typebox.ts — M31-T07 (§4.2) request/response contracts.
//
// The TypeBox schemas the §4.1 route handlers `parse(...)` at the request boundary and shape their
// responses with — the `validatePortalDto` D17 leak-prevention boundary expressed as types. The file is
// named `portal-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for an ownership claim (the M19/M20 routes/*-typebox precedent). Every schema is exported so the
// OpenAPI enrichment registry (`scripts/openapi/enrichments.ts`) reuses the SAME shape the handler
// validates against — the contract cannot drift from the validator.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (v) => typeof v === "string" && EMAIL_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set("uri", (v) => typeof v === "string" && v.length > 0);
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/** Validate a request BODY at the route boundary (no coercion — a JSON body carries real types). */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}
/** Validate a request QUERY, converting the declared scalars first (`?within=7` arrives as "7"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const Iso = Type.String({ format: "date-time" });
const LayStr = Type.String();

// ── shared params ──────────────────────────────────────────────────────────────────────────────────────
export const PatientIdParams = Type.Object({ patientId: Uuid });
export const DocumentIdParams = Type.Object({ documentId: Uuid });
export const UploadIdParams = Type.Object({ uploadId: Uuid });
export const VisitIdParams = Type.Object({ visitId: Uuid });
export const AccountIdParams = Type.Object({ id: Uuid });
export const InvitationIdParams = Type.Object({ id: Uuid });
export const EngagementIdParams = Type.Object({ engagementId: Uuid });
export const PreferenceIdParams = Type.Object({ id: Uuid });

// ── §4.2 session ────────────────────────────────────────────────────────────────────────────────────────
export const SelectPatientRequest = Type.Object({ patientId: Uuid });
export const SelectPatientResponse = Type.Object({
  sessionId: Uuid,
  activePatientId: Uuid,
  activeGrantId: Uuid,
  scopeSet: Type.Array(LayStr),
  layPatientLabel: LayStr,
});
export const PortalSessionCurrentResponse = Type.Object({
  portalAccountId: Uuid,
  activePatientId: Type.Union([Uuid, Type.Null()]),
  activeGrantId: Type.Union([Uuid, Type.Null()]),
  scopeSet: Type.Array(LayStr),
  relationship: LayStr,
  status: LayStr,
});
export const StepUpRequest = Type.Object({ totpCode: Type.String({ minLength: 6, maxLength: 10 }) });
export const AckResponse = Type.Object({ ok: Type.Boolean() });

// ── §4.2 care summary + lay-language reads ─────────────────────────────────────────────────────────────
export const CareSummaryResponse = Type.Object({
  patient: Type.Object({
    layLabel: LayStr,
    pronouns: Type.Optional(LayStr),
    preferredName: Type.Optional(LayStr),
  }),
  upcomingVisitsCount: Type.Integer(),
  recentVisitsCount: Type.Integer(),
  activeMedicationsCount: Type.Integer(),
  unreadMessagesCount: Type.Integer(),
  pendingDocumentSharesCount: Type.Integer(),
});
const LayLine = Type.Object({ layLabel: LayStr });
export const CarePlanSummaryResponse = Type.Object({
  category: LayStr,
  problems: Type.Array(
    Type.Object({
      problemId: LayStr,
      label: LayStr,
      goals: Type.Array(LayStr),
      focus: Type.Array(LayStr),
    }),
  ),
  redacted: Type.Boolean(),
});
export const LayListResponse = Type.Object({
  category: LayStr,
  items: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});
export const WithinQuery = Type.Object({
  within: Type.Optional(Type.Integer({ minimum: 1, maximum: 8760 })),
});

// ── §4.2 caregiver-attested administration (write into M13) ─────────────────────────────────────────────
export const CaregiverAttestedAdministrationRequest = Type.Object({
  medicationOrderId: Uuid,
  administeredAt: Iso,
  administeredAmount: Type.Number({ minimum: 0 }),
  administeredUnit: LayStr,
  route: LayStr,
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  caregiverAttestationText: Type.String({ minLength: 5, maxLength: 500 }),
});
export const CaregiverAttestedAdministrationResponse = Type.Object({
  administrationId: Uuid,
  status: LayStr,
});

// ── §4.2 documents ──────────────────────────────────────────────────────────────────────────────────────
export const DocumentDownloadUrlResponse = Type.Object({
  url: Type.String({ format: "uri" }),
  expiresAt: Iso,
});
export const PortalDocumentUploadInitRequest = Type.Object({
  purpose: Type.Union([
    Type.Literal("insurance_card"),
    Type.Literal("prior_records"),
    Type.Literal("wound_photo"),
    Type.Literal("advance_directive_copy"),
    Type.Literal("other"),
  ]),
  purposeDetail: Type.Optional(Type.String({ maxLength: 500 })),
  mimeType: LayStr,
  expectedByteSize: Type.Integer({ minimum: 1, maximum: 52428800 }),
});
export const PortalDocumentUploadInitResponse = Type.Object({
  uploadId: Uuid,
  signedUploadUrl: Type.String({ format: "uri" }),
  signedUploadUrlExpiresAt: Iso,
});
export const UploadCompleteResponse = Type.Object({ uploadId: Uuid, status: LayStr });

// ── §4.2 amendments ─────────────────────────────────────────────────────────────────────────────────────
export const AmendmentSubmitRequest = Type.Object({
  targetKind: Type.Union([
    Type.Literal("patient_demographic"),
    Type.Literal("encounter_narrative"),
  ]),
  targetRef: Type.Optional(Uuid),
  requestedChange: Type.String({ minLength: 5, maxLength: 4000 }),
});
export const AmendmentSubmitResponse = Type.Object({
  amendmentRequestRefId: Uuid,
  status: LayStr,
});

// ── §4.2 messages ───────────────────────────────────────────────────────────────────────────────────────
export const MessagesChannelResponse = Type.Object({
  channelId: Uuid,
  lastReadPointer: Type.Union([LayStr, Type.Null()]),
});
export const MessageSendRequest = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});
export const MessageSendResponse = Type.Object({ messageId: Uuid });

// ── §4.2 notification preferences ───────────────────────────────────────────────────────────────────────
export const NotificationPreferencesResponse = Type.Object({
  channels: Type.Array(
    Type.Object({ channel: LayStr, enabled: Type.Boolean() }),
  ),
  quietHours: Type.Optional(Type.Object({ startHour: Type.Integer(), endHour: Type.Integer() })),
});
export const NotificationPreferenceUpdateRequest = Type.Object({
  enabled: Type.Boolean(),
  quietHoursStartHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
  quietHoursEndHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
});

// ── §4.2 telehealth ─────────────────────────────────────────────────────────────────────────────────────
export const TelehealthJoinResponse = Type.Object({
  vendor: Type.Union([
    Type.Literal("daily_co"),
    Type.Literal("twilio_video"),
    Type.Literal("native_webrtc"),
  ]),
  vendorJoinUrl: Type.String({ format: "uri" }),
  vendorParticipantToken: LayStr,
  tokenExpiresAt: Iso,
  audioOnlyFallbackActive: Type.Boolean(),
  recordingActive: Type.Boolean(),
});
export const StartRecordingRequest = Type.Object({
  acknowledgesStateRules: Type.Literal(true),
  acknowledgesPatientConsent: Type.Literal(true),
});
export const TelehealthVisitDetailResponse = Type.Object({
  telehealthVisitId: Uuid,
  m17VisitId: Uuid,
  patientId: Uuid,
  lifecycleState: LayStr,
  vendor: LayStr,
  audioOnlyFallbackActive: Type.Boolean(),
  visitStartedAt: Type.Union([Iso, Type.Null()]),
  visitEndedAt: Type.Union([Iso, Type.Null()]),
});
export const TelehealthVisitListResponse = Type.Object({
  items: Type.Array(TelehealthVisitDetailResponse),
});
export const WebhookAckResponse = Type.Object({ received: Type.Boolean() });

// ── §4.2 admin — invitations ────────────────────────────────────────────────────────────────────────────
export const PortalInvitationIssueRequest = Type.Object({
  patientId: Uuid,
  relationship: Type.Union([
    Type.Literal("patient_self"),
    Type.Literal("family_caregiver"),
    Type.Literal("dpoa_healthcare_agent"),
    Type.Literal("personal_representative_post_death"),
  ]),
  caregiverId: Type.Optional(Uuid),
  inviteeDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
  inviteeEmail: Type.String({ format: "email" }),
  inviteePhone: Type.Optional(LayStr),
  proposedScopeSet: Type.Array(LayStr),
});
export const PortalInvitationIssueResponse = Type.Object({
  invitationId: Uuid,
  portalAccountId: Uuid,
  status: LayStr,
  expiresAt: Iso,
});
export const InviteBereavedRequest = Type.Object({
  bereavedContactId: Uuid,
  inviteeDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
  inviteeEmail: Type.String({ format: "email" }),
});
export const PortalInvitationListResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      invitationId: Uuid,
      relationship: LayStr,
      status: LayStr,
      issuedAt: Iso,
      expiresAt: Iso,
    }),
  ),
});

// ── §4.2 admin — accounts ───────────────────────────────────────────────────────────────────────────────
export const AccountSuspendRequest = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export const PortalAccountSummary = Type.Object({
  portalAccountId: Uuid,
  relationship: LayStr,
  status: LayStr,
  invitedAt: Iso,
  activatedAt: Type.Union([Iso, Type.Null()]),
  lastActiveAt: Type.Union([Iso, Type.Null()]),
});
export const PortalAccountListResponse = Type.Object({ items: Type.Array(PortalAccountSummary) });
export const PortalAccountGrantListResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      grantId: Uuid,
      patientId: Uuid,
      grantKind: LayStr,
      grantedAt: Iso,
      revokedAt: Type.Union([Iso, Type.Null()]),
    }),
  ),
});
export const PortalAuditViewResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      patientId: Uuid,
      routePath: LayStr,
      viewedAt: Iso,
    }),
  ),
});
export const PortalEngagementResponse = Type.Object({
  hasActiveAccount: Type.Boolean(),
  daysActive: Type.Integer(),
  lastViewedAt: Type.Union([Iso, Type.Null()]),
  messagesSent: Type.Integer(),
  documentsViewed: Type.Integer(),
  amendmentsSubmitted: Type.Integer(),
  administrationsAttested: Type.Integer(),
});
