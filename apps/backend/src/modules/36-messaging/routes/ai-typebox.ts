// apps/backend/src/modules/36-messaging/routes/ai-typebox.ts - WP 6.5 (ADR-0095) schemas. Wire keys are snake_case (packages/types/src/messaging-ai.ts).
import {
  MESSAGING_AI_CONFIDENCES,
  MESSAGING_AI_DRAFT_LABEL,
  MESSAGING_AI_OUTCOMES,
  MESSAGING_AI_SUMMARY_LABEL,
} from "@chartwarden/types";
import { type TSchema, Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Instant = Type.String({ format: "date-time" });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** `thread_root_message_id`: summarise one reply thread instead of the channel's recent messages. */
export const AiRequestBodySchema = Type.Object(
  { thread_root_message_id: Type.Optional(Uuid) },
  { additionalProperties: false },
);

/** The instant is parsed by a pattern (the typebox date-time format is not registered for request parsing); the ledger update matches it exactly. */
const InstantText = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$",
  maxLength: 40,
});
export const AiOutcomeBodySchema = Type.Object(
  { invocation_id: Uuid, invoked_at: InstantText, outcome: literals(MESSAGING_AI_OUTCOMES) },
  { additionalProperties: false },
);

export const AiStatusResponseSchema = Type.Object({ enabled: Type.Boolean() });

const Source = Type.Object({ n: Type.Integer(), message_id: Uuid, sent_at: Instant });

export const AiSummaryResponseSchema = Type.Object({
  label: Type.Literal(MESSAGING_AI_SUMMARY_LABEL),
  invocation_id: nullable(Uuid),
  invoked_at: nullable(Instant),
  status: literals(["ok", "insufficient_context"] as const),
  points: Type.Array(
    Type.Object({
      text: Type.String(),
      confidence: literals(MESSAGING_AI_CONFIDENCES),
      sources: Type.Array(Source),
    }),
  ),
  open_questions: Type.Array(Type.String()),
  included_count: Type.Integer(),
  withheld_count: Type.Integer(),
  input_hash: Type.String(),
});

export const AiDraftResponseSchema = Type.Object({
  label: Type.Literal(MESSAGING_AI_DRAFT_LABEL),
  invocation_id: Uuid,
  invoked_at: Instant,
  drafts: Type.Array(Type.Object({ text: Type.String() })),
  included_count: Type.Integer(),
  withheld_count: Type.Integer(),
});
