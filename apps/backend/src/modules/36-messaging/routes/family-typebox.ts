// apps/backend/src/modules/36-messaging/routes/family-typebox.ts - WP 6.7 (ADR-0099, PROPOSED) schemas for the family messaging routes. Wire keys are camelCase
// (the contract in packages/types/src/messaging-family.ts). The contact shapes carry NO patient, no channel id, no staff identity and no hash; Fastify strips
// anything not listed. The contact REQUEST bodies are deliberately not schema-validated by Fastify (the service checks them after the bearer resolves, so an
// unauthenticated caller never learns anything from a validation message).
import {
  FAMILY_ELIGIBILITY_REASONS,
  FAMILY_INVITE_MAX_DAYS,
  FAMILY_MODES,
  FAMILY_PAGE_MAX,
  FAMILY_SESSION_STAGES,
  FAMILY_SETTING_TEXT_MAX,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Instant = Type.String({ format: "date-time" });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableInstant = Type.Union([Instant, Type.Null()]);
const Reason = Type.Union(FAMILY_ELIGIBILITY_REASONS.map((r) => Type.Literal(r)));
const Mode = Type.Union(FAMILY_MODES.map((m) => Type.Literal(m)));
const Stage = Type.Union(FAMILY_SESSION_STAGES.map((s) => Type.Literal(s)));
const LinkState = Type.Union(
  ["none", "not_opened", "verifying", "active", "locked", "expired", "revoked"].map((s) =>
    Type.Literal(s),
  ),
);

export const FamilyContactIdParamsSchema = Type.Object(
  { contactId: Uuid },
  { additionalProperties: false },
);
export const FamilyPatientParamsSchema = Type.Object(
  { patientId: Uuid },
  { additionalProperties: false },
);

// ── staff ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SettingText = Type.Union([
  Type.String({ maxLength: FAMILY_SETTING_TEXT_MAX + 100 }),
  Type.Null(),
]);
export const FamilySettingsBodySchema = Type.Object(
  { agencyName: SettingText, agencyPhone: SettingText, bereavementPhone: SettingText },
  { additionalProperties: false },
);
export const FamilySettingsResponseSchema = Type.Object({
  agencyName: NullableString,
  agencyPhone: NullableString,
  bereavementPhone: NullableString,
});

export const FamilyCaregiversResponseSchema = Type.Object({
  caregivers: Type.Array(
    Type.Object({
      patientCaregiverId: Uuid,
      displayName: Type.String(),
      relationship: Type.String(),
      isLegalRepresentative: Type.Boolean(),
      eligible: Type.Boolean(),
      reason: Reason,
      language: NullableString,
    }),
  ),
});

export const CreateFamilyInvitationBodySchema = Type.Object(
  {
    patientId: Uuid,
    patientCaregiverId: Uuid,
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: FAMILY_INVITE_MAX_DAYS })),
    // D1: REQUIRED. The staff member confirms the code is given by voice, never in the same message as the link.
    codeByVoiceConfirmed: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const CreatedFamilyInvitationResponseSchema = Type.Object({
  contactId: Uuid,
  organizationId: Uuid,
  inviteToken: Type.String(),
  verificationCode: Type.String(),
  expiresAt: Instant,
  agencyPhone: Type.String(),
});

export const FamilyContactSummarySchema = Type.Object({
  contactId: Uuid,
  patientId: Uuid,
  patientCaregiverId: Uuid,
  patientName: Type.String(),
  displayName: Type.String(),
  relationship: Type.String(),
  consentState: Reason,
  linkState: LinkState,
  mode: Mode,
  language: NullableString,
  closed: Type.Boolean(),
  blocked: Type.Boolean(),
  channelId: Type.Union([Uuid, Type.Null()]),
  lastContactActivityAt: NullableInstant,
  unansweredSince: NullableInstant,
  highVolume: Type.Boolean(),
});
export const FamilyContactListResponseSchema = Type.Object({
  contacts: Type.Array(FamilyContactSummarySchema),
});

export const FamilyThreadResponseSchema = Type.Object({
  contact: FamilyContactSummarySchema,
  messages: Type.Array(
    Type.Object({
      messageId: Uuid,
      from: Type.Union([Type.Literal("contact"), Type.Literal("staff")]),
      authorName: NullableString,
      body: Type.String(),
      createdAt: Instant,
    }),
  ),
});

export const FamilyReplyBodySchema = Type.Object(
  // The raw bound; the real limit (2,000 characters, no control characters) is the service's.
  { body: Type.String({ minLength: 1, maxLength: 20_000 }) },
  { additionalProperties: false },
);
export const FamilyReplyResponseSchema = Type.Object({
  messageId: Uuid,
  from: Type.Literal("staff"),
  authorName: NullableString,
  body: Type.String(),
  createdAt: Instant,
});

// ── contact ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const FamilyRedeemResponseSchema = Type.Object({
  sessionToken: Type.String(),
  stage: Type.Literal("enrolment"),
  expiresAt: Instant,
});

const ContactState = {
  stage: Stage,
  mode: Mode,
  agencyName: NullableString,
  agencyPhone: NullableString,
  bereavementPhone: NullableString,
  language: NullableString,
  closed: Type.Boolean(),
  expiresAt: Instant,
};
export const FamilyContactStateResponseSchema = Type.Object(ContactState);
/** What verify returns: the state plus the NEW active-stage bearer (shown once; null when the session was already active). */
export const FamilyContactVerifiedResponseSchema = Type.Object({
  ...ContactState,
  sessionToken: NullableString,
});

export const FamilyContactMessagesQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FAMILY_PAGE_MAX })),
  },
  { additionalProperties: false },
);
export const FamilyContactMessagesResponseSchema = Type.Object({
  messages: Type.Array(
    Type.Object({
      messageId: Uuid,
      from: Type.Union([Type.Literal("you"), Type.Literal("care_team")]),
      body: Type.String(),
      createdAt: Instant,
      receivedByCareTeam: Type.Boolean(),
    }),
  ),
  nextCursor: NullableString,
});

export const FamilySendResponseSchema = Type.Object({
  messageId: Uuid,
  createdAt: Instant,
});

// Documentation only (OpenAPI): the contact REQUEST bodies. Fastify does not validate them; the service does, after the bearer resolves.
export const FamilyRedeemBodySchema = Type.Object(
  { organizationId: Uuid, token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) },
  { additionalProperties: false },
);
export const FamilyVerifyBodySchema = Type.Object(
  { code: Type.String({ pattern: "^\\d{8}$" }) },
  { additionalProperties: false },
);
export const FamilySendBodySchema = Type.Object(
  { body: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
