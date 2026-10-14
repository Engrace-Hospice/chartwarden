// apps/backend/src/modules/36-messaging/routes/task-typebox.ts - WP 3.4 communication-task schemas (request + OpenAPI response).
// Ids are canonical uuids (a malformed id is a 422 and never reaches a uuid cast). The closing reason and the due instant
// are transport-checked only here; the code set and the due window are the service's (typed 422s that name the field).
import { type TSchema, Type } from "@sinclair/typebox";
import {
  TASK_ACTIONS,
  TASK_ACTOR_KINDS,
  TASK_CLOSE_REASONS,
  TASK_EVENT_TYPES,
  TASK_STATUSES,
} from "@wardenx/types";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const TaskParamsSchema = Type.Object({ taskId: Uuid });

export const ConvertTaskBodySchema = Type.Object(
  {
    assignee_user_id: Uuid,
    due_at: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 40 }))),
    clinical_concern: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const CloseTaskBodySchema = Type.Object(
  { reason: Type.Optional(nullable(Type.String({ maxLength: 64 }))) },
  { additionalProperties: false },
);

export const ReassignTaskBodySchema = Type.Object(
  { assignee_user_id: Uuid },
  { additionalProperties: false },
);

export const ListTasksQuerySchema = Type.Object({
  scope: Type.Optional(literals(["assigned", "created"] as const)),
  state: Type.Optional(literals(["active", "closed", "all"] as const)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const TaskSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  message_id: Type.String({ format: "uuid" }),
  channel_id: Type.String({ format: "uuid" }),
  patient_id: nullable(Type.String({ format: "uuid" })),
  created_by: Type.String({ format: "uuid" }),
  assignee_id: Type.String({ format: "uuid" }),
  assignee_display_name: nullable(Type.String()),
  created_by_display_name: nullable(Type.String()),
  due_at: nullable(Type.String({ format: "date-time" })),
  status: literals(TASK_STATUSES),
  clinical_concern: Type.Boolean(),
  closed_reason: nullable(literals(TASK_CLOSE_REASONS)),
  needs_owner: Type.Boolean(),
  overdue: Type.Boolean(),
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
  allowed_actions: Type.Array(literals(TASK_ACTIONS)),
});

export const TaskEventSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  task_id: Type.String({ format: "uuid" }),
  event_type: literals(TASK_EVENT_TYPES),
  actor_kind: literals(TASK_ACTOR_KINDS),
  actor_user_id: nullable(Type.String({ format: "uuid" })),
  from_status: nullable(literals(TASK_STATUSES)),
  to_status: nullable(literals(TASK_STATUSES)),
  from_assignee_id: nullable(Type.String({ format: "uuid" })),
  to_assignee_id: nullable(Type.String({ format: "uuid" })),
  reason_code: nullable(Type.String()),
  created_at: Type.String({ format: "date-time" }),
});

export const TaskResponseSchema = Type.Object({ task: TaskSchema });
export const ConvertTaskResponseSchema = Type.Object({ task: TaskSchema, created: Type.Boolean() });
export const TaskDetailResponseSchema = Type.Object({
  task: TaskSchema,
  events: Type.Array(TaskEventSchema),
});
/** `enabled:false` (tenant flag off) lets the web hide the UI without a 404 storm. */
export const TaskListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  tasks: Type.Array(TaskSchema),
});
