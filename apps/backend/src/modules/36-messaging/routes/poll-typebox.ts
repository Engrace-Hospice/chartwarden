// apps/backend/src/modules/36-messaging/routes/poll-typebox.ts - WP 2.10 request/response schemas (schemas only, so the
// OpenAPI emitter does not import the auth stack). The request bounds here are loose on purpose: the service owns the
// real ones (2..10 options, 300/100 characters, plain text only, no duplicates) and answers 422 with field details.
import { type Static, Type } from "@sinclair/typebox";
import type { PollDetailView, PollView } from "@chartwarden/types";
import { PollViewSchema, UUID_PATTERN } from "./messaging-typebox";

export { PollViewSchema };

const Uuid = Type.String({ pattern: UUID_PATTERN });

export const PollChannelParamsSchema = Type.Object({ id: Uuid });
export const PollMessageParamsSchema = Type.Object({ id: Uuid, messageId: Uuid });

export const CreatePollBodySchema = Type.Object({
  question: Type.String({ maxLength: 2_000 }),
  options: Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 50 }),
  /** Stable across client retries (the message write path's DB backstop); optional. */
  clientMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const VotePollBodySchema = Type.Object({ optionId: Uuid });

export const PollVoterViewSchema = Type.Object({
  userId: Type.String(),
  displayName: Type.String(),
  votedAt: Type.String(),
});

export const PollDetailViewSchema = Type.Composite([
  PollViewSchema,
  Type.Object({ voters: Type.Record(Type.String(), Type.Array(PollVoterViewSchema)) }),
]);

export const CreatePollResponseSchema = Type.Object({
  messageId: Type.String(),
  channelId: Type.String(),
  createdAt: Type.String(),
  poll: PollViewSchema,
});

export const PollResultResponseSchema = Type.Object({ poll: PollViewSchema });

// Compile-time pin: what the schema publishes is assignable to what the service returns.
type Conforms<T extends V, V> = T;
type _Poll = Conforms<Static<typeof PollViewSchema>, PollView>;
type _Detail = Conforms<Static<typeof PollDetailViewSchema>, PollDetailView>;
