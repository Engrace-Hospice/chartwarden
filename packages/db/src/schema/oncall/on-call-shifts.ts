// @wardenx/db — `on_call_shift` (M19 §3.3 / §2.2.2). D2/D3/D7: one row per covered window per
// ProviderEntity per discipline. This is the single most survey-load-bearing row M19 writes — it is the
// CoP 418.100(c)(2) proof that a nurse was reachable at 2 a.m. — which is why its audit rows carry the
// `compliance` retention class even though the row itself holds no patient data.
//
// D7 — `policy_snapshot` is pinned at the `scheduled → active` transition: the tenant's
// `tenant_oncall_policy` row is copied onto the shift as JSON so a later policy edit cannot retroactively
// change what was in effect during a past night.
//
// §2.3 READ — "one active clinical_rn shift per (org, PE, window)" is NOT a uniqueness constraint and is
// deliberately NOT expressed as one here. Read in full, the rule says "AT LEAST ONE row overlapping now()"
// — a COVERAGE floor, not a de-duplication rule — and §2.4's boot-time note is explicit that a coverage gap
// must alert rather than block (M19 is DR Tier 1; refusing writes on a scheduling lapse converts an
// administrative miss into a Tier-1 outage). An EXCLUDE constraint would also make the Hybrid model
// illegal, where an internal and an external shift covering the same window is the intended shape (§2.3).
// The gap is found by the §4.8 `coverage-gap-watchdog`, which emits `m19.oncall_shift.coverage_gap`.
//
// TENANCY: organization_id + provider_entity_id NOT NULL. NO location column — a shift covers a
// ProviderEntity's whole service area, not one Location, and inventing a Location here would make the
// roster read lie about scope.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { oncallShiftDiscipline, oncallShiftStatus } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { externalTriageVendor } from "./external-triage-vendors";

export const onCallShift = pgTable(
  "on_call_shift",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    shiftStartsAt: timestamp("shift_starts_at", { withTimezone: true }).notNull(),
    shiftEndsAt: timestamp("shift_ends_at", { withTimezone: true }).notNull(),
    discipline: oncallShiftDiscipline("discipline").notNull(),

    /** Direct model: M17's `tonightsOnCallRoster` result. NULL exactly when `discipline = 'external'`. */
    primaryOnCallMembershipId: uuid("primary_on_call_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    backupMembershipId: uuid("backup_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    /** Hybrid / Centralized: the vendor binding covering this window. */
    externalActorId: uuid("external_actor_id").references(() => externalTriageVendor.id, {
      onDelete: "restrict",
    }),
    /** The vendor's own operator label ("TouchPoint night desk"); never a WardenX identity. */
    externalActorLabel: text("external_actor_label"),

    /** M17 visit-assignment provenance — LOGICAL uuid; no SQL constraint across a module boundary. */
    m17VisitAssignmentRef: uuid("m17_visit_assignment_ref"),

    /** D7 — the `tenant_oncall_policy` row as it stood when this shift opened. */
    policySnapshot: jsonb("policy_snapshot").notNull(),
    status: oncallShiftStatus("status").notNull().default("scheduled"),
    /** Free text — §3.6 audit-denylisted. */
    cancellationReason: text("cancellation_reason"),

    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    /** Payroll-equivalent PII — §3.6 audit-denylisted. */
    compensationMetadata: jsonb("compensation_metadata").notNull().default(sql`'{}'::jsonb`),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // §3.4 — the coverage-gap watchdog scans for RN coverage at any future point.
    activeRnCoverageIdx: index("on_call_shift_active_rn_idx")
      .on(t.providerEntityId, t.shiftStartsAt, t.shiftEndsAt)
      .where(sql`discipline = 'clinical_rn' AND status = 'active'`),
    byOrgWindowIdx: index("on_call_shift_org_window_idx").on(
      t.organizationId,
      t.shiftStartsAt,
      t.shiftEndsAt,
    ),
    // §2.3 — exactly one actor kind per shift, both directions. A vendor shift that also names a
    // membership would resolve to two recipient sets in M36's `on_call` channel; a non-vendor shift with
    // no membership names nobody at all.
    actorIntegrity: check(
      "m19_on_call_shift_actor_integrity",
      sql`("discipline" = 'external' AND "external_actor_id" IS NOT NULL AND "primary_on_call_membership_id" IS NULL)
          OR ("discipline" <> 'external' AND "primary_on_call_membership_id" IS NOT NULL AND "external_actor_id" IS NULL)`,
    ),
    rangeIntegrity: check("m19_on_call_shift_range", sql`"shift_ends_at" > "shift_starts_at"`),
    // A shift that reached `active` has an open timestamp; one that reached a terminal state has a close
    // timestamp. Without this the §4.3 roster read cannot tell "opened at 19:00" from "never opened".
    openedWhenActive: check(
      "m19_on_call_shift_opened_at",
      sql`"status" = 'scheduled' OR "status" = 'cancelled' OR "opened_at" IS NOT NULL`,
    ),
    closedWhenTerminal: check(
      "m19_on_call_shift_closed_at",
      sql`"status" <> 'completed' OR "closed_at" IS NOT NULL`,
    ),
  }),
);

export type OnCallShiftRow = typeof onCallShift.$inferSelect;
export type NewOnCallShiftRow = typeof onCallShift.$inferInsert;
