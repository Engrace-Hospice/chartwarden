// apps/backend/src/modules/11-orders/routes/critical-lab-typebox.ts — the quarantined-critical-lab queue's TypeBox schemas
// (#1136 / CW-CS-01). Named `*-typebox` so the table-ownership import heuristic never mistakes it for a Drizzle import.
import { pageQuery } from "@chartwarden/shared/route-kit";
import { type Static, Type } from "@sinclair/typebox";
import {
  CRITICAL_LAB_REASON_MAX_LENGTH,
  CRITICAL_LAB_REASON_MIN_LENGTH,
  type CriticalLabResolutionView,
  type CriticalLabResultDetail,
  type QuarantinedCriticalPage,
} from "../critical-lab-resolution";

export const CriticalLabResultParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

/** `GET /api/v1/orders/critical-lab-results` — soonest response deadline first; `cursor` is the previous `nextCursor`. */
export const CriticalLabQueueQuerySchema = Type.Object({
  ...pageQuery({ max: 100, defaultSize: 50 }),
});

const ResolutionKind = Type.Union([
  Type.Literal("matched_to_order"),
  Type.Literal("reviewed_no_action"),
]);

/**
 * `POST /api/v1/orders/critical-lab-results/:id/resolve`. `reason` is required free text (it is stored in the append-only
 * row and scrubbed from audit; it never rides the outbox event). `matchedOrderId` is required for `matched_to_order` and
 * refused for `reviewed_no_action` (the service answers 422 either way round).
 */
export const ResolveCriticalLabRequest = Type.Object(
  {
    resolution: ResolutionKind,
    matchedOrderId: Type.Optional(Type.String({ format: "uuid" })),
    reason: Type.String({
      minLength: CRITICAL_LAB_REASON_MIN_LENGTH,
      maxLength: CRITICAL_LAB_REASON_MAX_LENGTH,
    }),
  },
  { additionalProperties: false },
);
export type ResolveCriticalLabBody = Static<typeof ResolveCriticalLabRequest>;

const Instant = Type.String({ format: "date-time" });
const NullableString = (t: ReturnType<typeof Type.String>) => Type.Union([t, Type.Null()]);

export const CriticalLabResultItemSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  observationId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  loincCode: Type.String(),
  criticalFlag: Type.Union([Type.Literal("HH"), Type.Literal("LL")]),
  disposition: Type.Union([Type.Literal("paged"), Type.Literal("quarantined_no_order")]),
  receivedAt: Instant,
  respondBy: NullableString(Instant),
  escalatedAt: NullableString(Instant),
});

export const CriticalLabQueueResponseSchema = Type.Object({
  items: Type.Array(CriticalLabResultItemSchema),
  nextCursor: NullableString(Type.String()),
});

export const CriticalLabResolutionResponseSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  criticalLabResultId: Type.String({ format: "uuid" }),
  resolution: ResolutionKind,
  matchedOrderId: NullableString(Type.String({ format: "uuid" })),
  reason: Type.String(),
  resolverMembershipId: Type.String({ format: "uuid" }),
  resolverDiscipline: Type.String(),
  resolvedAt: Instant,
});

export const CriticalLabResultDetailResponseSchema = Type.Composite([
  CriticalLabResultItemSchema,
  Type.Object({ resolution: Type.Union([CriticalLabResolutionResponseSchema, Type.Null()]) }),
]);

// Pinned to the service's views 1:1 — a field added, renamed or re-typed breaks `bun run build` instead of drifting from
// the published client (the `Conforms` precedent in `held-transmissions-typebox.ts`).
type Conforms<Dto extends Src, Src> = Dto;
type _Queue = Conforms<Static<typeof CriticalLabQueueResponseSchema>, QuarantinedCriticalPage>;
type _Resolution = Conforms<
  Static<typeof CriticalLabResolutionResponseSchema>,
  CriticalLabResolutionView
>;
type _Detail = Conforms<
  Static<typeof CriticalLabResultDetailResponseSchema>,
  CriticalLabResultDetail
>;
export type CriticalLabQueueResponse = _Queue;
export type CriticalLabResolutionResponse = _Resolution;
export type CriticalLabResultDetailResponse = _Detail;
