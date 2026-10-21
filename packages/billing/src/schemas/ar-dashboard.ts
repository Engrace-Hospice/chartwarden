// @chartwarden/billing — AR-dashboard schema: route #37 `GET /ar-dashboard` (AR aging buckets, denial rate,
// NOE/NOTR window state) — §4.1. Aggregate-only (mirrors `ArAgingDto`); no row-level PHI.
import { type Static, Type } from "@sinclair/typebox";
import { CentsSchema, IsoDateTimeSchema, Uuid } from "./common";

export const ArDashboardQuery = Type.Object({
  /** `provider_entity_id` to scope to, or omit / "all" for the org-wide rollup. */
  providerEntityId: Type.Optional(Type.Union([Uuid, Type.Literal("all")])),
});
export type ArDashboardQuery = Static<typeof ArDashboardQuery>;

export const ArAgingBucketsView = Type.Object({
  bucket0to30Cents: CentsSchema,
  bucket31to60Cents: CentsSchema,
  bucket61to90Cents: CentsSchema,
  bucket90PlusCents: CentsSchema,
});
export type ArAgingBucketsView = Static<typeof ArAgingBucketsView>;

export const ArDashboardResponse = Type.Object({
  arAging: ArAgingBucketsView,
  /** Denial rate over the trailing window, 0..1. */
  denialRate: Type.Number({ minimum: 0, maximum: 1 }),
  /** NOE/NOTR timely-filing window-breach rate over the trailing window, 0..1. */
  noeWindowBreachRate: Type.Number({ minimum: 0, maximum: 1 }),
  notrWindowBreachRate: Type.Number({ minimum: 0, maximum: 1 }),
  /** Open NOE/NOTR counts whose window is breached or imminent. */
  noeBreachedOpen: Type.Integer({ minimum: 0 }),
  notrBreachedOpen: Type.Integer({ minimum: 0 }),
  computedAt: IsoDateTimeSchema,
});
export type ArDashboardResponse = Static<typeof ArDashboardResponse>;
