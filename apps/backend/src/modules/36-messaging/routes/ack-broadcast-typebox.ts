// apps/backend/src/modules/36-messaging/routes/ack-broadcast-typebox.ts - M36 WP 6.8 (ADR-0097) route schemas. The request side is parsed by hand
// in the handler (after the flag check), so a malformed request cannot tell a flag-off tenant from a flag-on one.
import {
  ACK_BROADCAST_FILTERS,
  ACK_BROADCAST_PAGE_DEFAULT,
  ACK_BROADCAST_PAGE_MAX,
  ACK_BROADCAST_STATES,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const literals = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));

export const AckBroadcastParamsSchema = Type.Object({
  messageId: Type.String({ pattern: UUID_PATTERN }),
});

export const AckBroadcastDetailQuerySchema = Type.Object({
  filter: Type.Optional(literals(ACK_BROADCAST_FILTERS)),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: ACK_BROADCAST_PAGE_MAX, default: ACK_BROADCAST_PAGE_DEFAULT }),
  ),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
});

const Counts = Type.Object({
  audience: Type.Integer(),
  acknowledged: Type.Integer(),
  pending: Type.Integer(),
  opened: Type.Integer(),
  notOpened: Type.Integer(),
  ineligible: Type.Integer(),
  outsideAudience: Type.Integer(),
});
const NullableString = Type.Union([Type.String(), Type.Null()]);
const SummaryProps = {
  messageId: Type.String(),
  channelId: Type.String(),
  createdAt: Type.String(),
  counts: Counts,
  deadlineAt: NullableString,
  withdrawnAt: NullableString,
  pastDeadline: Type.Boolean(),
};

/** The optional body of "require acknowledgment": a display-only deadline (ADR-0097 D13). Range-checked by the service (typed 422). */
export const AckBroadcastCreateBodySchema = Type.Object(
  { deadlineAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) },
  { additionalProperties: false },
);

export const AckBroadcastSummarySchema = Type.Object(SummaryProps);
export const AckBroadcastCreatedSchema = Type.Object({
  ...SummaryProps,
  created: Type.Boolean(),
});
export const AckBroadcastWithdrawnSchema = Type.Object({
  ...SummaryProps,
  already: Type.Boolean(),
});
export const AckBroadcastListSchema = Type.Object({ broadcasts: Type.Array(AckBroadcastSummarySchema) });
export const AckBroadcastDetailSchema = Type.Object({
  ...SummaryProps,
  filter: literals(ACK_BROADCAST_FILTERS),
  offset: Type.Integer(),
  hasMore: Type.Boolean(),
  people: Type.Array(
    Type.Object({
      userId: Type.String(),
      displayName: Type.String(),
      state: literals(ACK_BROADCAST_STATES),
      openedAt: Type.Union([Type.String(), Type.Null()]),
      acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});
export const AckBroadcastMineSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      messageId: Type.String(),
      channelId: Type.String(),
      createdAt: Type.String(),
      acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
      deadlineAt: NullableString,
    }),
  ),
});
export const AckBroadcastAcknowledgedSchema = Type.Object({
  messageId: Type.String(),
  acknowledgedAt: Type.String(),
  already: Type.Boolean(),
});
