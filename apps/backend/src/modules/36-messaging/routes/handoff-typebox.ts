import {
  HANDOFF_ACTIONS,
  HANDOFF_CLOSE_REASONS,
  HANDOFF_ITEM_KINDS,
  HANDOFF_ITEM_STATES,
  HANDOFF_STATES,
} from "@chartwarden/types";
// apps/backend/src/modules/36-messaging/routes/handoff-typebox.ts - WP 3.5 clinical-handoff schemas (request + OpenAPI response).
// Ids are canonical uuids. Counts and the policy minutes are transport-checked loosely here on purpose: the service owns the
// typed 422 codes (HANDOFF_ITEMS_REQUIRED, HANDOFF_TOO_MANY_ITEMS, HANDOFF_POLICY_INVALID) so the client sees a stable code.
import { type TSchema, Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Hard transport bound only (the service enforces 250 items / 50 patients with its own typed codes). */
const OFFER_TRANSPORT_MAX_ITEMS = 1000;
const PREFILL_MAX_PATIENTS = 50;
const ACCEPT_MAX_ITEMS = 250;

export const HandoffParamsSchema = Type.Object({ handoffId: Uuid });

export const ListHandoffsQuerySchema = Type.Object({
  scope: Type.Optional(literals(["incoming", "outgoing"] as const)),
  state: Type.Optional(literals(["active", "closed", "all"] as const)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const PrefillBodySchema = Type.Object(
  { patient_ids: Type.Array(Uuid, { minItems: 1, maxItems: PREFILL_MAX_PATIENTS }) },
  { additionalProperties: false },
);

export const OfferHandoffBodySchema = Type.Object(
  {
    to_user_id: Uuid,
    items: Type.Array(
      Type.Object(
        { kind: literals(HANDOFF_ITEM_KINDS), ref_id: Uuid, patient_id: Uuid },
        { additionalProperties: false },
      ),
      { maxItems: OFFER_TRANSPORT_MAX_ITEMS },
    ),
  },
  { additionalProperties: false },
);

export const AcceptHandoffBodySchema = Type.Object(
  { item_ids: Type.Array(Uuid, { minItems: 1, maxItems: ACCEPT_MAX_ITEMS }) },
  { additionalProperties: false },
);

export const DeclineHandoffBodySchema = Type.Object(
  { item_ids: Type.Optional(Type.Array(Uuid, { minItems: 1, maxItems: ACCEPT_MAX_ITEMS })) },
  { additionalProperties: false },
);

export const PutHandoffPolicyBodySchema = Type.Object(
  { expiry_minutes: Type.Number() },
  { additionalProperties: false },
);

const ItemSummarySchema = Type.Object({
  state: literals(["ok", "gone", "unavailable", "restricted"] as const),
  status: Type.Optional(Type.String()),
  occurred_at: Type.Optional(Type.String()),
  still_open: Type.Optional(Type.Boolean()),
});

export const HandoffItemSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  patient_id: nullable(Type.String({ format: "uuid" })),
  patient_display_name: nullable(Type.String()),
  mrn_suffix: nullable(Type.String()),
  kind: literals(HANDOFF_ITEM_KINDS),
  ref_id: nullable(Type.String({ format: "uuid" })),
  state: literals(HANDOFF_ITEM_STATES),
  accountable_user_id: Type.String({ format: "uuid" }),
  accountable_display_name: nullable(Type.String()),
  resolved_at: nullable(Type.String({ format: "date-time" })),
  summary: ItemSummarySchema,
});

const ItemCountsSchema = Type.Object({
  pending: Type.Integer(),
  accepted: Type.Integer(),
  declined: Type.Integer(),
  expired: Type.Integer(),
  cancelled: Type.Integer(),
});

export const HandoffSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  from_user_id: Type.String({ format: "uuid" }),
  from_display_name: nullable(Type.String()),
  to_user_id: Type.String({ format: "uuid" }),
  to_display_name: nullable(Type.String()),
  state: literals(HANDOFF_STATES),
  offered_at: Type.String({ format: "date-time" }),
  expires_at: Type.String({ format: "date-time" }),
  accepted_at: nullable(Type.String({ format: "date-time" })),
  closed_at: nullable(Type.String({ format: "date-time" })),
  closed_reason: nullable(literals(HANDOFF_CLOSE_REASONS)),
  needs_attention: Type.Boolean(),
  patient_count: Type.Integer(),
  item_counts: ItemCountsSchema,
  allowed_actions: Type.Array(literals(HANDOFF_ACTIONS)),
  items: Type.Optional(Type.Array(HandoffItemSchema)),
});

export const HandoffResponseSchema = Type.Object({ handoff: HandoffSchema });
export const OfferHandoffResponseSchema = Type.Object({
  handoff: HandoffSchema,
  created: Type.Boolean(),
});
/** `enabled:false` (tenant flag off) lets the web hide the UI without a 404 storm. */
export const HandoffListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  handoffs: Type.Array(HandoffSchema),
});

export const CaseloadResponseSchema = Type.Object({
  patients: Type.Array(
    Type.Object({
      patient_id: Type.String({ format: "uuid" }),
      display_name: Type.String(),
      mrn_suffix: nullable(Type.String()),
    }),
  ),
});

export const PrefillResponseSchema = Type.Object({
  patients: Type.Array(
    Type.Object({
      patient_id: Type.String({ format: "uuid" }),
      items: Type.Array(
        Type.Object({
          kind: literals(HANDOFF_ITEM_KINDS),
          ref_id: Type.String({ format: "uuid" }),
          status: Type.Optional(Type.String()),
          occurred_at: Type.Optional(Type.String()),
        }),
      ),
      unavailable_sources: Type.Array(literals(HANDOFF_ITEM_KINDS)),
    }),
  ),
});

export const HandoffPolicyViewSchema = Type.Object({
  expiry_minutes: Type.Integer(),
  platform_max_minutes: Type.Integer(),
  customised: Type.Boolean(),
});
