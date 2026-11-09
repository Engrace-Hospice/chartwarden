import { Uuid, pageLimit } from "@chartwarden/shared/route-kit";
import {
  TASK_ACTIONS,
  TASK_ACTOR_KINDS,
  TASK_CLOSE_REASONS,
  TASK_EVENT_TYPES,
  TASK_SOURCE_KINDS,
  TASK_STATUSES,
} from "@chartwarden/types";
// apps/backend/src/modules/36-messaging/routes/task-typebox.ts - WP 3.4 communication-task schemas (request + OpenAPI response).
// Ids are canonical uuids (a malformed id is a 422 and never reaches a uuid cast). The closing reason and the due instant
// are transport-checked only here; the code set and the due window are the service's (typed 422s that name the field).
import { type TSchema, Type } from "@sinclair/typebox";

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const TaskParamsSchema = Type.Object({ taskId: Uuid() });

export const ConvertTaskBodySchema = Type.Object(
  {
    assignee_user_id: Uuid(),
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
  { assignee_user_id: Uuid() },
  { additionalProperties: false },
);

export const ListTasksQuerySchema = Type.Object({
  scope: Type.Optional(literals(["assigned", "created"] as const)),
  state: Type.Optional(literals(["active", "closed", "all"] as const)),
  limit: pageLimit({ max: 100 }),
});

export const TaskSchema = Type.Object({
  id: Uuid(),
  message_id: Uuid(),
  channel_id: Uuid(),
  patient_id: nullable(Uuid()),
  created_by: Uuid(),
  assignee_id: Uuid(),
  assignee_display_name: nullable(Type.String()),
  created_by_display_name: nullable(Type.String()),
  due_at: nullable(Type.String({ format: "date-time" })),
  status: literals(TASK_STATUSES),
  clinical_concern: Type.Boolean(),
  source_kind: literals(TASK_SOURCE_KINDS),
  closed_reason: nullable(literals(TASK_CLOSE_REASONS)),
  needs_owner: Type.Boolean(),
  overdue: Type.Boolean(),
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
  allowed_actions: Type.Array(literals(TASK_ACTIONS)),
});

const TaskEventSchema = Type.Object({
  id: Uuid(),
  task_id: Uuid(),
  event_type: literals(TASK_EVENT_TYPES),
  actor_kind: literals(TASK_ACTOR_KINDS),
  actor_user_id: nullable(Uuid()),
  from_status: nullable(literals(TASK_STATUSES)),
  to_status: nullable(literals(TASK_STATUSES)),
  from_assignee_id: nullable(Uuid()),
  to_assignee_id: nullable(Uuid()),
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
