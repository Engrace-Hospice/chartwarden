// apps/backend/src/modules/11-orders/routes/held-transmissions-typebox.ts — the held-order worklist's TypeBox schemas
// (F-201, #248). Named `*-typebox` so the table-ownership import heuristic never mistakes it for a Drizzle import.
import { type Static, Type } from "@sinclair/typebox";
import type { HeldTransmissionPage } from "../stuck-transmission-recovery";

/** `GET /api/v1/orders/held-transmissions` — oldest first; `cursor` is the opaque `nextCursor` of the previous page. */
export const HeldTransmissionsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
});
export type HeldTransmissionsQuery = Static<typeof HeldTransmissionsQuerySchema>;

const HeldStageSchema = Type.Union([Type.Literal("none"), Type.Literal("warn"), Type.Literal("critical")]);

export const HeldTransmissionItemSchema = Type.Object({
  orderId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  /** A fixed token — `dlq_exhausted`, `application_reject` or `recovery_blocked:*`. Never free text. */
  reason: Type.String({ maxLength: 120 }),
  /** When the order was marked failed (microsecond ISO — the sort and cursor key). */
  failedAt: Type.String(),
  ageSeconds: Type.Integer({ minimum: 0 }),
  /** `none` inside the grace period, then `warn`, then `critical` (thresholds: 4 h / 24 h by default). */
  stage: HeldStageSchema,
  /** The feed the dead-ended outbound message went to; null when no outbound row is on record. */
  feedId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
});

export const HeldTransmissionsResponseSchema = Type.Object({
  items: Type.Array(HeldTransmissionItemSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

// Pinned to the service's page 1:1 — a field added, renamed or re-typed breaks `bun run build` instead of drifting
// from the published client (the `Conforms` precedent in `orders-typebox.ts`).
type Conforms<Dto extends Src, Src> = Dto;
type _HeldPage = Conforms<Static<typeof HeldTransmissionsResponseSchema>, HeldTransmissionPage>;
export type HeldTransmissionsResponse = _HeldPage;
