// @wardenx/db — `ai_routing_override` (M32 §3.2.13 / W8). The tenant's standing instruction to route a
// capability somewhere other than its default backend — the local-only sovereignty case.
//
// TENANT-SCOPED: organization_id NOT NULL, RLS keyed ONLY on app.org_id (0116). No PHI: the row names a
// backend and a reason, never a patient.
//
// THE ONE DEVIATION FROM §3.2.13, AND IT IS FORCED. The spec's active-override rule is a partial unique
// index `(organization_id, capability_id) WHERE expires_at IS NULL OR expires_at > now()`. PostgreSQL
// CANNOT CREATE THAT: an index predicate may only call IMMUTABLE functions, and `now()` is STABLE — the
// migration fails outright with "functions in index predicate must be marked IMMUTABLE". The rule is also
// not what a time-varying predicate would give you even if it were legal, because an index predicate is
// evaluated at WRITE time and never re-evaluated: an override that expired yesterday would still occupy
// the slot today.
//
// The rule expressed so a database can hold it is a no-overlap EXCLUDE over the validity WINDOW —
// `EXCLUDE USING gist (organization_id WITH =, capability_id WITH =, tstzrange(effective_at, expires_at)
// WITH &&)`, declared in migration 0113 because Drizzle cannot express EXCLUDE (the M17
// `visit_no_overlap` / M26 `cap_period_no_overlap` / M24 precedent; needs btree_gist for the uuid
// equality opclass). It is STRICTLY STRONGER than the spec's intent: an unexpired open-ended row is
// `tstzrange(effective_at, NULL)` = unbounded above, so two live overrides for one (org, capability)
// overlap and the second is refused — and a scheduled future override no longer silently collides with
// the current one. Expiry itself stays a query predicate at the routing gate (T04); the constraint
// governs which rows may COEXIST, not which one is in force right now.
//
// `override_reason` is TEXT with a value CHECK rather than a pgEnum: §3.1 declares twenty-one enums and
// this vocabulary is not among them (`AiRoutingOverrideReason` in @wardenx/types). It is NOT NULL because
// a routing override that stops PHI reaching a cloud vendor is a compliance decision, and "why" is the
// part a later audit reads.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { aiCapability } from "./ai-capabilities";

export const aiRoutingOverride = pgTable(
  "ai_routing_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),

    /** Resolved against `ai_model_backend.backend_key`; must be in the capability's allowed set (T04). */
    backendKeyPreference: text("backend_key_preference").notNull(),
    overrideReason: text("override_reason").notNull(),

    /** Logical FK → M2 membership. */
    setByMembershipId: uuid("set_by_membership_id").notNull(),

    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The lookup index. UNIQUENESS is the `ai_routing_override_no_overlap` EXCLUDE in 0113 (see header),
    // which Drizzle cannot express — this is the plain read path the routing gate scans.
    orgCapabilityIdx: index("ai_routing_override_org_cap_idx").on(
      t.organizationId,
      t.capabilityId,
      t.effectiveAt.desc(),
    ),

    reasonCheck: check(
      "ai_routing_override_reason_check",
      sql`override_reason IN ('tenant_sovereignty','tenant_cost','tenant_pilot','fallback_after_outage')`,
    ),
    // An override that expires before it takes effect is a configuration error that would otherwise sit
    // in the table looking live.
    windowCheck: check(
      "ai_routing_override_window_check",
      sql`expires_at IS NULL OR expires_at > effective_at`,
    ),
  }),
);

export type AiRoutingOverrideRow = typeof aiRoutingOverride.$inferSelect;
export type NewAiRoutingOverrideRow = typeof aiRoutingOverride.$inferInsert;
