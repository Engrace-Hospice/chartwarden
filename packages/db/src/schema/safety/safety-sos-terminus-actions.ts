// @wardenx/db - `safety_sos_terminus_action` (M20, GAP-032). The durable intent ledger behind the SOS
// emergency-terminus effects (ops page, emergency-contact dial, PSAP resolution): an INTENT row is written
// in the watchdog's tenant tx, an executor performs the call OUTSIDE any tenant tx and settles the row.
// UNIQUE (sos_alert_id, action_kind, loop_iteration, attempt_no) is what makes the re-page loop fire once
// per period instead of once per 15-second tick. Reason codes and opaque refs only: no PHI, no contact
// number, no coordinate. Closed vocabularies are text + CHECK, mirrored in @wardenx/types.
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { safetySosAlert } from "./safety-sos-alerts";

export const safetySosTerminusAction = pgTable(
  "safety_sos_terminus_action",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    sosAlertId: uuid("sos_alert_id")
      .notNull()
      .references(() => safetySosAlert.id, { onDelete: "restrict" }),
    /** `page_ops` | `dial_contact` | `resolve_psap` (CHECK). */
    actionKind: text("action_kind").notNull(),
    loopIteration: integer("loop_iteration").notNull(),
    attemptNo: integer("attempt_no").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    /** `pending` | `attempting` | `succeeded` | `failed` | `skipped` | `superseded` (CHECK). */
    status: text("status").notNull().default("pending"),
    /** Closed reason vocabulary (CHECK; see SAFETY_TERMINUS_OUTCOME_CODES). */
    outcomeCode: text("outcome_code"),
    /** Vendor call SID or pager dedup key. Never a phone number. */
    externalRef: text("external_ref"),
    jurisdictionId: uuid("jurisdiction_id"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idemUq: unique("m20_ssta_idem_uq").on(t.organizationId, t.idempotencyKey),
    iterationUq: unique("m20_ssta_iteration_uq").on(
      t.sosAlertId,
      t.actionKind,
      t.loopIteration,
      t.attemptNo,
    ),
    dueIdx: index("ssta_due_idx")
      .on(t.organizationId, t.status, t.nextAttemptAt)
      .where(sql`status IN ('pending','attempting')`),
    alertIdx: index("ssta_alert_idx").on(t.sosAlertId, t.actionKind, t.loopIteration),
    providerEntityIdx: index("ssta_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("ssta_location_idx").on(t.locationId).where(sql`location_id IS NOT NULL`),
    iterationNonNegative: check(
      "m20_ssta_iteration",
      sql`"loop_iteration" >= 0 AND "attempt_no" >= 0 AND "attempts" >= 0`,
    ),
  }),
);

export type SafetySosTerminusActionRow = typeof safetySosTerminusAction.$inferSelect;
export type NewSafetySosTerminusActionRow = typeof safetySosTerminusAction.$inferInsert;
