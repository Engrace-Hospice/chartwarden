// @wardenx/db — `comfort_kit_returned_content` (M21 §3.1.10). D8: the inbound half of the DEA 21 CFR §1304
// perpetual log. One row per dispatched line, closing the accounting:
//
//     quantity_unaccounted = dispatched_quantity − quantity_returned − quantity_disposed_at_home
//
// That is THE single discrepancy formula (§3.0 resolves the drift: D8's prose adds an
// `expected_consumed_if_known` term the §3.1 trigger does not compute, and §3.1 governs). A controlled line
// whose |unaccounted| is ≥ 5% of what was dispatched raises `discrepancy_flagged`, which is what fires the
// survey-investigable `m21.controlled_substance.discrepancy_detected` event.
//
// `quantity_disposed_at_home` is the SUPPORT Act column and is NOT optional: when a family destroys the
// remaining morphine at the bedside under witness, the quantity that never came back to the hub is
// accounted for, not "missing". Dropping it (as the §3.2 draft did) turns every legal home disposal into a
// diversion alert.
//
// `quantity_unaccounted` / `discrepancy_pct` / `discrepancy_flagged` are TRIGGER-computed, not GENERATED
// columns: the formula reads `dispatched_quantity` from ANOTHER row, which a generated column cannot do.
// `m21_compute_return_discrepancy()` (migration 0106) fires BEFORE INSERT OR UPDATE OF the two input
// quantities and fails CLOSED — if the dispatched line is not visible, the write raises rather than
// silently reconciling against a NULL.
//
// AUDIT (D13): NOTHING here is denylisted, for the same reason as the dispatched half — these quantities
// ARE the record a diversion investigation reads.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + provider_entity_id + location_id, all NOT NULL,
// denormalized from the dispatch. Canonical app.org_id RLS.
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) plus BOTH intra-M21
// parents — `return_id` and `dispatched_content_id`, both unpartitioned — carry real FKs, ON DELETE
// RESTRICT. The accounting must not be deletable out from under itself.
import { sql } from "drizzle-orm";
import { boolean, check, index, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { controlledSubstanceSchedule } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { comfortKitDispatchedContent } from "./comfort-kit-dispatched-contents";
import { comfortKitReturn } from "./comfort-kit-returns";

export const comfortKitReturnedContent = pgTable(
  "comfort_kit_returned_content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => comfortKitReturn.id, { onDelete: "restrict" }),
    dispatchedContentId: uuid("dispatched_content_id")
      .notNull()
      .references(() => comfortKitDispatchedContent.id, { onDelete: "restrict" }),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    // The two counted inputs.
    quantityReturned: numeric("quantity_returned").notNull().default("0"),
    quantityDisposedAtHome: numeric("quantity_disposed_at_home").notNull().default("0"),

    // Trigger-computed outputs (see header). Defaults exist so the BEFORE trigger has a row to overwrite.
    quantityUnaccounted: numeric("quantity_unaccounted").notNull().default("0"),
    discrepancyPct: numeric("discrepancy_pct").notNull().default("0"),
    discrepancyFlagged: boolean("discrepancy_flagged").notNull().default(false),

    // Denormalized from the dispatched line: the 5% threshold only applies to controlled substances, and
    // the flag must stay computable inside a BEFORE trigger without a second lookup.
    isControlledSubstance: boolean("is_controlled_substance").notNull(),
    controlledSubstanceSchedule: controlledSubstanceSchedule("controlled_substance_schedule"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    returnIdx: index("comfort_kit_returned_content_return_idx").on(t.returnId),
    discrepancyIdx: index("comfort_kit_returned_content_discrepancy_idx")
      .on(t.organizationId)
      .where(sql`discrepancy_flagged = true`),
    // One reconciliation line per dispatched line — counting the same lot twice is the failure mode this
    // table exists to prevent.
    dispatchedContentIdx: index("comfort_kit_returned_content_dispatched_idx").on(
      t.dispatchedContentId,
    ),

    quantitiesNonNegative: check(
      "m21_ckit_ret_content_qty_non_negative",
      sql`quantity_returned >= 0 AND quantity_disposed_at_home >= 0`,
    ),
    scheduleMatchesControlled: check(
      "m21_ckit_ret_content_schedule_pair",
      sql`(is_controlled_substance = true AND controlled_substance_schedule IS NOT NULL)
          OR (is_controlled_substance = false AND controlled_substance_schedule IS NULL)`,
    ),
  }),
);

export type ComfortKitReturnedContentRow = typeof comfortKitReturnedContent.$inferSelect;
export type NewComfortKitReturnedContentRow = typeof comfortKitReturnedContent.$inferInsert;
