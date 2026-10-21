// apps/backend/src/modules/36-messaging/routes/break-glass-typebox.ts - WP 5.8 (ADR-0087, PROPOSED) schemas for the break-glass routes. Wire keys
// are camelCase (the contract in packages/types/src/messaging-break-glass.ts). Responses carry ids, closed codes, instants and counts, plus the two
// reviewer-only free-text fields (justification, note) on the REVIEW routes only; Fastify strips anything not listed. No message body ever.
import {
  BREAK_GLASS_JUSTIFICATION_MAX,
  BREAK_GLASS_JUSTIFICATION_MIN,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_MIN_MINUTES,
  BREAK_GLASS_NOTE_MAX,
  BREAK_GLASS_READ_KINDS,
  BREAK_GLASS_REASON_CODES,
  BREAK_GLASS_REVIEW_OUTCOMES,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableUuid = Type.Union([Uuid, Type.Null()]);
const ReasonCode = Type.Union(BREAK_GLASS_REASON_CODES.map((c) => Type.Literal(c)));
const Outcome = Type.Union(BREAK_GLASS_REVIEW_OUTCOMES.map((o) => Type.Literal(o)));

export const BreakGlassIdParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false });

export const CreateBreakGlassBodySchema = Type.Object(
  {
    channelId: Uuid,
    reasonCode: ReasonCode,
    // Trimmed length is enforced again by the service and the table CHECK; the schema bounds the raw input.
    justification: Type.String({
      minLength: BREAK_GLASS_JUSTIFICATION_MIN,
      maxLength: BREAK_GLASS_JUSTIFICATION_MAX + 200,
    }),
    durationMinutes: Type.Optional(
      Type.Integer({ minimum: BREAK_GLASS_MIN_MINUTES, maximum: BREAK_GLASS_MAX_MINUTES }),
    ),
  },
  { additionalProperties: false },
);

export const ListReviewsQuerySchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([Type.Literal("pending"), Type.Literal("reviewed"), Type.Literal("all")]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const CompleteReviewBodySchema = Type.Object(
  {
    outcome: Outcome,
    note: Type.Optional(Type.String({ maxLength: BREAK_GLASS_NOTE_MAX + 200 })),
  },
  { additionalProperties: false },
);

export const GrantResponseSchema = Type.Object({
  id: Uuid,
  channelId: Uuid,
  channelKind: Type.String(),
  reasonCode: ReasonCode,
  grantedAt: Type.String(),
  expiresAt: Type.String(),
  revokedAt: NullableString,
  status: Type.Union([Type.Literal("active"), Type.Literal("expired"), Type.Literal("revoked")]),
});

export const GrantListResponseSchema = Type.Object({ grants: Type.Array(GrantResponseSchema) });

const ReviewShape = {
  reviewId: Uuid,
  grantId: Uuid,
  granteeUserId: Uuid,
  granteeName: NullableString,
  channelId: Uuid,
  channelKind: Type.String(),
  channelTitle: NullableString,
  patientId: NullableUuid,
  reasonCode: ReasonCode,
  justification: Type.String(),
  grantedAt: Type.String(),
  endedAt: Type.String(),
  stillActive: Type.Boolean(),
  readCount: Type.Integer({ minimum: 0 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("reviewed")]),
  outcome: Type.Union([Outcome, Type.Null()]),
  reviewedAt: NullableString,
  reviewerUserId: NullableUuid,
  note: NullableString,
  dueAt: Type.String(),
  overdue: Type.Boolean(),
} as const;

export const ReviewResponseSchema = Type.Object(ReviewShape);
export const ReviewListResponseSchema = Type.Object({ reviews: Type.Array(ReviewResponseSchema) });

export const ReviewDetailResponseSchema = Type.Object({
  ...ReviewShape,
  reads: Type.Array(
    Type.Object({
      readKind: Type.Union(BREAK_GLASS_READ_KINDS.map((k) => Type.Literal(k))),
      resourceId: NullableUuid,
      itemCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      readAt: Type.String(),
    }),
  ),
});
