// @wardenx/db — `comfort_kit_dispatched_content` (M21 §3.1.9). D6: one row per medication line that
// physically left the hub in a kit. THIS IS THE DEA 21 CFR §1304 PERPETUAL LOG's outbound half — lot number,
// expiration, exact quantity, the M12 prescription behind it, and the schedule. Everything the return
// reconciliation subtracts from lives here.
//
// NOT partitioned even though its parent is (§3.1.9 is explicit): the child is always read THROUGH a
// dispatch, so it inherits the parent's pruning for free, and partitioning it too would forbid the real FKs
// to `comfort_kit_template_medication` and from `comfort_kit_returned_content` that keep the accounting
// closed. It carries `dispatch_partition_dispatched_at` so a reader can address the parent's composite key
// without a scan across every partition.
//
// §3.0 / M21-F04: §3.1 is normative — lot/expiration are NOT NULL on CONTROLLED lines ONLY (not all
// medications; a saline flush has no DEA lot obligation), `is_controlled_substance` is a real boolean rather
// than the draft's jsonb, quantities are `numeric` rather than text, and `medication_order_id` / schedule /
// strength / route are restored. The draft's `dea_perpetual_log_jsonb` IS folded on (§7.2/§7.3 depend on it):
// it holds the per-transaction custody entries — witness, transaction type, scan timestamps — that are
// append-only narrative around the columns rather than a duplicate of them.
//
// DEVIATION FROM §3.1.9 (documented): the spec's `CHECK (expiration_date >= CURRENT_DATE + INTERVAL '14
// days')` CANNOT BE CREATED — `CURRENT_DATE` is STABLE (it reads the transaction clock) and PostgreSQL
// refuses non-immutable expressions in a CHECK. It is also wrong as a CHECK even if it were legal: a row
// written today would start FAILING its own constraint fifteen days later, so any unrelated UPDATE to a
// two-year-old dispatch line would be rejected. The 14-day platform floor is enforced instead by the
// BEFORE INSERT OR UPDATE OF expiration_date trigger `m21_enforce_dispatch_expiration_floor()` in migration
// 0106 — same rule, evaluated at the moment it means something. Same class of finding as M16's
// `death_anchor_at`.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + provider_entity_id + location_id, all NOT NULL,
// denormalized from the dispatch so a per-CCN controlled-substance rollup never joins back through the
// partitioned parent. Canonical app.org_id RLS.
//
// AUDIT (D13): NOTHING here is denylisted. `dispatched_quantity` / `lot_number` / `expiration_date` ARE the
// perpetual log — scrubbing them from the M4 snapshot would delete the only record of what changed in a
// controlled-substance count, which is exactly what a diversion investigation reads.
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) and the
// unpartitioned intra-M21 `comfort_kit_template_medication_id` carry real FKs. `dispatch_id` is LOGICAL
// (partitioned target); `medication_order_id` (M12) is logical uuid.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { controlledSubstanceSchedule } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { comfortKitTemplateMedication } from "./comfort-kit-template-medications";

export const comfortKitDispatchedContent = pgTable(
  "comfort_kit_dispatched_content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dispatchId: uuid("dispatch_id").notNull(), // logical FK → comfort_kit_dispatch (partitioned)
    /** The parent's partition key, carried so a reader can address the composite PK directly. */
    dispatchPartitionDispatchedAt: timestamp("dispatch_partition_dispatched_at", {
      withTimezone: true,
    }).notNull(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    comfortKitTemplateMedicationId: uuid("comfort_kit_template_medication_id")
      .notNull()
      .references(() => comfortKitTemplateMedication.id, { onDelete: "restrict" }),
    /** Logical FK → M12; NULL for an IPU stock kit, which has no per-patient prescription behind it. */
    medicationOrderId: uuid("medication_order_id"),

    rxnorm: text("rxnorm").notNull(),
    ndc: text("ndc"),
    drugName: text("drug_name").notNull(),
    strength: text("strength").notNull(),
    dosageForm: text("dosage_form").notNull(),
    routeOfAdministration: text("route_of_administration").notNull(),

    isControlledSubstance: boolean("is_controlled_substance").notNull(),
    controlledSubstanceSchedule: controlledSubstanceSchedule("controlled_substance_schedule"),

    /** `numeric` — a 0.1 mL that round-trips through a JS float is not the number the DEA log recorded. */
    dispatchedQuantity: numeric("dispatched_quantity").notNull(),
    dispatchedUnit: text("dispatched_unit").notNull(),

    lotNumber: text("lot_number"),
    expirationDate: date("expiration_date"),
    manufacturerNdc: text("manufacturer_ndc"),

    /** D6 — the append-only per-transaction custody entries (type, witness, scan times). */
    deaPerpetualLogJsonb: jsonb("dea_perpetual_log_jsonb"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dispatchIdx: index("comfort_kit_dispatched_content_dispatch_idx").on(t.dispatchId),
    medOrderIdx: index("comfort_kit_dispatched_content_med_order_idx")
      .on(t.medicationOrderId)
      .where(sql`medication_order_id IS NOT NULL`),
    lotExpiryIdx: index("comfort_kit_dispatched_content_lot_expiry_idx")
      .on(t.lotNumber, t.expirationDate)
      .where(sql`lot_number IS NOT NULL`),

    // Controlled ⇒ lot AND expiration. Not the other way round: a non-controlled line MAY carry them
    // (many do), it simply is not required to.
    controlledRequiresLot: check(
      "m21_ckit_disp_content_controlled_lot",
      sql`is_controlled_substance = false
          OR (lot_number IS NOT NULL AND expiration_date IS NOT NULL)`,
    ),
    scheduleMatchesControlled: check(
      "m21_ckit_disp_content_schedule_pair",
      sql`(is_controlled_substance = true AND controlled_substance_schedule IS NOT NULL)
          OR (is_controlled_substance = false AND controlled_substance_schedule IS NULL)`,
    ),
    quantityPositive: check(
      "m21_ckit_disp_content_qty_positive",
      sql`dispatched_quantity > 0`,
    ),
  }),
);

export type ComfortKitDispatchedContentRow = typeof comfortKitDispatchedContent.$inferSelect;
export type NewComfortKitDispatchedContentRow = typeof comfortKitDispatchedContent.$inferInsert;
