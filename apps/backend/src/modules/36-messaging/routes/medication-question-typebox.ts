// apps/backend/src/modules/36-messaging/routes/medication-question-typebox.ts - WP 3.10 request + response schemas.
// The question text is a plain string (the send route's own 8000 cap); nothing else reads it. `additionalProperties:false`
// so a body can carry no order-shaped field.
import { type TSchema, Type } from "@sinclair/typebox";
import { MEDICATION_QUESTION_TEXT_MAX } from "@wardenx/types";
import { UUID_PATTERN } from "./messaging-typebox";
import { TaskSchema } from "./task-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const AskMedicationQuestionBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: MEDICATION_QUESTION_TEXT_MAX }),
    medication_id: Type.Optional(Uuid),
    assignee_user_id: Type.Optional(Uuid),
    allow_unrouted: Type.Optional(Type.Boolean()),
    client_message_id: Uuid,
  },
  { additionalProperties: false },
);

export const MedicationQuestionResponseSchema = Type.Object({
  message_id: Type.String({ format: "uuid" }),
  channel_id: Type.String({ format: "uuid" }),
  patient_id: Type.String({ format: "uuid" }),
  routed: Type.Boolean(),
  task: nullable(TaskSchema),
  created: Type.Boolean(),
});

const Person = Type.Object({
  user_id: Type.String({ format: "uuid" }),
  display_name: nullable(Type.String()),
});

export const MedicationQuestionOptionsResponseSchema = Type.Union([
  Type.Object({ enabled: Type.Literal(false) }),
  Type.Object({
    enabled: Type.Literal(true),
    patient_linked: Type.Boolean(),
    patient_id: nullable(Type.String({ format: "uuid" })),
    nurse: nullable(Person),
    colleagues: Type.Array(Person),
    links_enabled: Type.Boolean(),
  }),
]);
