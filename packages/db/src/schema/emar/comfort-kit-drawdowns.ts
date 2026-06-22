// @wardenx/db — `comfort_kit_drawdown` (M13 §3.3 / §2.7 D5). Per-medication line of a comfort_kit_deployment:
// expected vs remaining quantity, the replenishment threshold (drives the m13.comfort_kit.* replenishment event
// consumed by M21), and the lot/expiration. Org-scoped (no patient row — the parent deployment carries it);
// standard app.org_id RLS. Non-partitioned. `comfort_kit_deployment_id` is M13-owned but kept loose (no SQL FK);
// `medication_order_id` is an M12 logical FK (resolved through seam). RLS + grants + the M4 write-audit trigger
// (notes denylisted, §3.6) land in the RLS migration.
import { sql } from "drizzle-orm";
import { date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const comfortKitDrawdowns = pgTable(
  "comfort_kit_drawdown",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    comfortKitDeploymentId: uuid("comfort_kit_deployment_id").notNull(), // M13 (loose; no FK)
    medicationOrderId: uuid("medication_order_id").notNull(), // M12 (resolved through seam; no FK)

    expectedQuantity: numeric("expected_quantity", { precision: 12, scale: 4 }).notNull(),
    expectedUnit: text("expected_unit").notNull(),
    remainingQuantity: numeric("remaining_quantity", { precision: 12, scale: 4 }).notNull(),
    finalRemainingQuantityAtReturn: numeric("final_remaining_quantity_at_return", {
      precision: 12,
      scale: 4,
    }),
    replenishmentThreshold: numeric("replenishment_threshold", { precision: 12, scale: 4 }).notNull(),

    lotNumber: text("lot_number"),
    expirationDate: date("expiration_date"),

    notes: text("notes"), // DENYLISTED

    lastReplenishmentEmittedAt: timestamp("last_replenishment_emitted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDeployment: index("kit_drawdown_deployment_idx").on(t.comfortKitDeploymentId),
    byOrder: index("kit_drawdown_order_idx").on(t.organizationId, t.medicationOrderId),
    belowThreshold: index("kit_drawdown_below_threshold_idx")
      .on(t.organizationId)
      .where(sql`remaining_quantity <= replenishment_threshold`),
    uniqueByDeploymentOrder: uniqueIndex("kit_drawdown_deployment_order_uk").on(
      t.comfortKitDeploymentId,
      t.medicationOrderId,
    ),
  }),
);

export type ComfortKitDrawdown = typeof comfortKitDrawdowns.$inferSelect;
export type NewComfortKitDrawdown = typeof comfortKitDrawdowns.$inferInsert;
