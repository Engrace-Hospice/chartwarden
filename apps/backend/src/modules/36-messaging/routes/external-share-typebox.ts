// apps/backend/src/modules/36-messaging/routes/external-share-typebox.ts - WP 6.6 (ADR-0096, PROPOSED) schemas for the external partner share routes.
// Wire keys are camelCase (the contract in packages/types/src/messaging-external-share.ts). The partner shapes carry NO channel id, no staff
// identity beyond a display name, and no hash; Fastify strips anything not listed.
import {
  EXTERNAL_PARTNER_PAGE_MAX,
  EXTERNAL_SESSION_STAGES,
  EXTERNAL_SHARE_BAA_MAX,
  EXTERNAL_SHARE_MAX_DAYS,
  EXTERNAL_SHARE_NAME_MAX,
  EXTERNAL_SHARE_PARTNER_KINDS,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Instant = Type.String({ format: "date-time" });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const PartnerKind = Type.Union(EXTERNAL_SHARE_PARTNER_KINDS.map((k) => Type.Literal(k)));
const Stage = Type.Union(EXTERNAL_SESSION_STAGES.map((s) => Type.Literal(s)));

export const ExternalShareIdParamsSchema = Type.Object(
  { id: Uuid },
  { additionalProperties: false },
);
export const PartnerShareParamsSchema = Type.Object(
  { shareId: Uuid },
  { additionalProperties: false },
);

export const CreateExternalShareBodySchema = Type.Object(
  {
    channelId: Uuid,
    // Trimmed length is enforced again by the service and the table CHECK; the schema bounds the raw input.
    partnerName: Type.String({ minLength: 1, maxLength: EXTERNAL_SHARE_NAME_MAX + 100 }),
    partnerKind: PartnerKind,
    baaReference: Type.String({ minLength: 1, maxLength: EXTERNAL_SHARE_BAA_MAX + 100 }),
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: EXTERNAL_SHARE_MAX_DAYS })),
    // D15: REQUIRED. The creator confirms an outside party reads this and that patient names in free text are NOT filtered.
    acknowledgedMinimumNecessary: Type.Literal(true),
  },
  { additionalProperties: false },
);

const ShareShape = {
  id: Uuid,
  channelId: Uuid,
  channelTitle: NullableString,
  partnerName: Type.String(),
  partnerKind: PartnerKind,
  status: Type.Union([Type.Literal("active"), Type.Literal("expired"), Type.Literal("revoked")]),
  sharedFrom: Instant,
  expiresAt: Instant,
  createdAt: Instant,
  createdBy: Uuid,
  revokedAt: Type.Union([Instant, Type.Null()]),
  redeemed: Type.Boolean(),
  codeLocked: Type.Boolean(),
};

export const ExternalShareResponseSchema = Type.Object(ShareShape);
export const CreatedExternalShareResponseSchema = Type.Object({
  ...ShareShape,
  organizationId: Uuid,
  inviteToken: Type.String(),
  verificationCode: Type.String(),
});
export const ExternalShareListResponseSchema = Type.Object({
  shares: Type.Array(ExternalShareResponseSchema),
});

export const PartnerRedeemBodySchema = Type.Object(
  { organizationId: Uuid, token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) },
  { additionalProperties: false },
);
export const PartnerRedeemResponseSchema = Type.Object({
  sessionToken: Type.String(),
  shareId: Uuid,
  stage: Type.Literal("enrolment"),
  expiresAt: Instant,
});
export const PartnerVerifyBodySchema = Type.Object(
  { code: Type.String({ pattern: "^\\d{8}$" }) },
  { additionalProperties: false },
);
/** What verify returns: the state plus the NEW active-stage bearer (shown once; null when the session was already active). */
export const PartnerVerifiedResponseSchema = Type.Object({
  shareId: Uuid,
  stage: Stage,
  partnerName: Type.String(),
  expiresAt: Instant,
  sessionToken: NullableString,
});
export const PartnerStateResponseSchema = Type.Object({
  shareId: Uuid,
  stage: Stage,
  partnerName: Type.String(),
  expiresAt: Instant,
});
export const PartnerMessagesQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EXTERNAL_PARTNER_PAGE_MAX })),
  },
  { additionalProperties: false },
);
export const PartnerMessagesResponseSchema = Type.Object({
  messages: Type.Array(
    Type.Object({
      messageId: Uuid,
      authorName: NullableString,
      body: Type.String(),
      createdAt: Instant,
      edited: Type.Boolean(),
    }),
  ),
  nextCursor: NullableString,
});
