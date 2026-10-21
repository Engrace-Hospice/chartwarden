// @chartwarden/db — `bereavement_cop_opt_out_credit` (M16, F-206 #248). One durable row per
// `m16.bereavement.plan_skipped_per_patient_opt_out` outbox delivery that M30's CoP 418.64(d)
// `bereavement_coverage_rate` measure should count as SATISFIED rather than silently absent — the
// user's own decision on the `scripts/outbox-deferred-consumers.ts` `no-consumer-surface` gap: a death
// where the patient's own M5 pre-death directive said "no bereavement outreach" is not a compliance
// failure to hold against the agency, it is the family's choice honored.
//
// WHY A NEW TABLE RATHER THAN READING `bereavement_plan_closure` DIRECTLY: the event this row records can
// fire from TWO shapes (its own payload type doc comment, `packages/types/src/bereavement.ts`) — (1) the
// LIVE path, M5's patient-level opt-out flag flipping while a `bereavement_plan` already exists
// (`eligible`/`initiating`), which DOES produce a `bereavement_plan_closure` row (reason
// `patient_opt_out_pre_death`) M30 could theoretically join through; and (2) the INTAKE-time skip
// `decideEligibilityIntake` already contracts for (`../16-bereavement/consumers/m6-eligibility.ts`), where
// NO plan row is EVER opened — the event's own payload comment says so verbatim ("Carries NO planId:
// nothing opened"). Coupling M30's compliance math to M16's internal closure-reason taxonomy would silently
// break the moment path (2) is ever wired live (it is currently unreachable — `m6-bereavement-eligible.ts`
// always resolves `patientOptOut: null`, a documented TOCTOU gap, not a build gap this pass touches). A
// table that records exactly what the CONSUMED EVENT said — `patientId`/`admissionId`/`deathDate`, nothing
// M16-internal — supports both shapes uniformly and is the honest "what was consumed" record the
// `document_version.source_event_id` (F-168) / `unmapped_taxonomy_occurrence` (#248 m23 group) precedent
// already establishes for this exact purpose elsewhere in the platform.
//
// IDEMPOTENCY: a UNIQUE index on (organization_id, source_event_id) — the delivered outbox event's own id,
// never a pre-read — the migration-0249/0255 precedent. A redelivery of the same event inserts nothing a
// second time and so cannot double-count toward the CoP rate.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable — the M16 nine-table
// convention (`./index.ts`'s own header). `patient_id`/`admission_id` are LOGICAL uuid (M5/M6), matching
// every other cross-module reference in this schema directory — validated at the write boundary, no FK.
import { date, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const bereavementCopOptOutCredit = pgTable(
  "bereavement_cop_opt_out_credit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5, logical
    admissionId: uuid("admission_id").notNull(), // M6, logical
    deathDate: date("death_date").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),

    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceEventUnique: uniqueIndex("berv_cop_optout_credit_source_event_uq").on(
      t.organizationId,
      t.sourceEventId,
    ),
    scopeDeathIdx: index("berv_cop_optout_credit_scope_death_idx").on(
      t.organizationId,
      t.providerEntityId,
      t.deathDate,
    ),
  }),
);

export type BereavementCopOptOutCreditRow = typeof bereavementCopOptOutCredit.$inferSelect;
export type NewBereavementCopOptOutCreditRow = typeof bereavementCopOptOutCredit.$inferInsert;
