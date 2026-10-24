// apps/backend/src/modules/36-messaging/routes/death-board-typebox.ts - WP 6.9 (ADR-0098) schemas for the death board routes.
// Wire keys are snake_case (the contract in packages/types/src/messaging-death-board.ts). Ids only: no free text anywhere.
import {
  DEATH_BOARD_EVENT_TYPES,
  DEATH_BOARD_ITEM_KEYS,
  DEATH_BOARD_ITEM_STATUSES,
  DEATH_BOARD_LIST_MAX,
  DEATH_BOARD_REASON_CODES,
} from "@chartwarden/types";
import { type TSchema, Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Instant = Type.String({ format: "date-time" });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const DeathBoardParamsSchema = Type.Object({ boardId: Uuid });
export const DeathBoardItemParamsSchema = Type.Object({ itemId: Uuid });

export const ListDeathBoardsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEATH_BOARD_LIST_MAX })),
});

export const ReassignDeathBoardItemBodySchema = Type.Object(
  { to_user_id: Uuid },
  { additionalProperties: false },
);

export const DeathBoardItemSchema = Type.Object({
  id: Uuid,
  item_key: literals(DEATH_BOARD_ITEM_KEYS),
  label: Type.String(),
  status: literals(DEATH_BOARD_ITEM_STATUSES),
  owner_user_id: Uuid,
  owner_display_name: nullable(Type.String()),
  needs_owner: Type.Boolean(),
  due_at: Instant,
  overdue: Type.Boolean(),
  completed_at: nullable(Instant),
  completed_by_user_id: nullable(Uuid),
  actions: Type.Array(literals(["complete", "reassign"] as const)),
});

export const DeathBoardSchema = Type.Object({
  id: Uuid,
  patient_id: Uuid,
  patient_display_name: nullable(Type.String()),
  mrn_suffix: nullable(Type.String()),
  created_at: Instant,
  open_count: Type.Integer(),
  items: Type.Array(DeathBoardItemSchema),
});

export const DeathBoardListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  boards: Type.Array(DeathBoardSchema),
});
export const DeathBoardResponseSchema = Type.Object({ board: DeathBoardSchema });
export const DeathBoardItemResponseSchema = Type.Object({ item: DeathBoardItemSchema });

export const DeathBoardHistoryResponseSchema = Type.Object({
  events: Type.Array(
    Type.Object({
      id: Uuid,
      event_type: literals(DEATH_BOARD_EVENT_TYPES),
      actor_kind: literals(["user", "system"] as const),
      actor_user_id: nullable(Uuid),
      from_owner_user_id: nullable(Uuid),
      to_owner_user_id: nullable(Uuid),
      reason_code: nullable(literals(DEATH_BOARD_REASON_CODES)),
      created_at: Instant,
    }),
  ),
});
