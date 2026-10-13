// apps/backend/src/modules/36-messaging/routes/reaction-pin-typebox.ts - WP 2.4 request/response schemas for the
// reaction and pin routes (kept out of messaging-typebox.ts, which other work packages edit in parallel).
import { type Static, Type } from "@sinclair/typebox";
import { MESSAGE_REACTION_KEYS, type MessageReactionSummary } from "@wardenx/types";
import { ResolvedMessageSchema } from "./messaging-typebox";

const Id = Type.String({ minLength: 1, maxLength: 64 });

/** The closed reaction palette as a schema; an unknown key is a 422 before it reaches the service. */
export const ReactionKeySchema = Type.Union(MESSAGE_REACTION_KEYS.map((key) => Type.Literal(key)));

export const ReactionParamsSchema = Type.Object({
  id: Id,
  messageId: Id,
  emoji: ReactionKeySchema,
});
export const PinParamsSchema = Type.Object({ id: Id, messageId: Id });

export const ReactionSummarySchema = Type.Object({
  emoji: ReactionKeySchema,
  count: Type.Integer({ minimum: 1 }),
  reactedByMe: Type.Boolean(),
});
export const SetReactionResponseSchema = Type.Object({
  reactions: Type.Array(ReactionSummarySchema),
});
export const PinResponseSchema = Type.Object({ pinnedAt: Type.String() });
export const PinListResponseSchema = Type.Object({
  pins: Type.Array(ResolvedMessageSchema),
  patientId: Type.Union([Type.String(), Type.Null()]),
});

// Compile-time pin: what the schema publishes is assignable to what the service returns.
type Conforms<T extends V, V> = T;
type _Reaction = Conforms<Static<typeof ReactionSummarySchema>, MessageReactionSummary>;
