// @wardenx/db — `safety_supervisor_subscription` (M20 §3.3 / §2.2.5, D8). The PAGING layer: who gets woken
// up when this clinician's SOS fires. Dashboard VISIBILITY is RBAC + ABAC and is deliberately independent —
// a supervisor may see a board they are not paged for, and (the failure D8 exists to close) a clinician may
// be visible on every board and paged by nobody.
//
// TENANCY: organization_id NOT NULL and nothing else denormalized. `location_id` and `provider_entity_id`
// ARE on this table but they are SCOPE SELECTORS, not the three-column rule's tenancy columns — they say
// "this subscription covers that location", not "this row belongs to that location". The distinction
// matters because they are NULLABLE by design and a tenancy column that may be NULL on a PHI row is a hole;
// this table holds no patient data at all, so the question does not arise. It is workforce paging
// configuration, the M19 `tenant_oncall_policy` posture.
//
// `NULLS NOT DISTINCT` IS LOAD-BEARING. §2.2.5 requires the tuple (supervisor, clinician, location, PE) to
// be unique among ACTIVE rows, and three of those four are nullable. Under PostgreSQL's default NULL
// semantics two identical location-scoped rows — (sup, NULL, loc-A, NULL) twice — are DISTINCT and both
// insert, so the supervisor is paged twice for every alert and the "one row per pair" rule the resolver
// relies on is not a rule. The normative SQL declares the index `NULLS NOT DISTINCT` (PG 15+); the Drizzle
// `uniqueIndex` below is the ORM's view of it, exactly as the `.references()` on M2's `membership` is.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const safetySupervisorSubscription = pgTable(
  "safety_supervisor_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    supervisorMembershipId: uuid("supervisor_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    /** NULL for the location-, PE- and role-scoped models — the row then covers everyone in that scope. */
    clinicianMembershipId: uuid("clinician_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),

    /** `SafetySubscriptionScopeKind` — vocabulary + scope-integrity CHECKs below. */
    scopeKind: text("scope_kind").notNull(),
    /** `SafetyAlertKind[]` — which alert classes this row pages on; non-empty, members CHECKed. */
    alertKinds: text("alert_kinds").array().notNull(),

    isVacationForwarding: boolean("is_vacation_forwarding").notNull().default(false),
    vacationForwardToMembershipId: uuid("vacation_forward_to_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),

    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The normative SQL adds NULLS NOT DISTINCT; see the header.
    activePairUniq: uniqueIndex("sss_active_pair_uniq")
      .on(t.supervisorMembershipId, t.clinicianMembershipId, t.locationId, t.providerEntityId)
      .where(sql`superseded_at IS NULL AND deactivated_at IS NULL`),
    // §3.4 — the "who do I page?" resolver hot path, and its mirror for the coverage-gap watchdog.
    byClinicianIdx: index("sss_clinician_idx")
      .on(t.clinicianMembershipId)
      .where(sql`superseded_at IS NULL AND deactivated_at IS NULL`),
    bySupervisorIdx: index("sss_supervisor_idx")
      .on(t.supervisorMembershipId)
      .where(sql`superseded_at IS NULL AND deactivated_at IS NULL`),
    byScopeIdx: index("sss_scope_idx")
      .on(t.organizationId, t.scopeKind, t.locationId, t.providerEntityId)
      .where(sql`superseded_at IS NULL AND deactivated_at IS NULL`),

    scopeVocabulary: check(
      "m20_sss_scope_vocab",
      sql`"scope_kind" IN ('explicit','location','provider_entity','role')`,
    ),
    // A scope kind that does not carry the column it selects on covers NOBODY, and the resolver would
    // return an empty recipient set at 3 a.m. with nothing in the data saying it was misconfigured.
    scopeIntegrity: check(
      "m20_sss_scope_integrity",
      sql`("scope_kind" = 'explicit' AND "clinician_membership_id" IS NOT NULL)
          OR ("scope_kind" = 'location' AND "location_id" IS NOT NULL)
          OR ("scope_kind" = 'provider_entity' AND "provider_entity_id" IS NOT NULL)
          OR "scope_kind" = 'role'`,
    ),
    alertKindsNonEmpty: check(
      "m20_sss_alert_kinds_nonempty",
      sql`array_length("alert_kinds", 1) >= 1`,
    ),
    // A typo'd alert kind is a subscription that never fires and never errors — the exact shape of the
    // M3 named-predicate finding, one layer down.
    alertKindsVocabulary: check(
      "m20_sss_alert_kinds_vocab",
      sql`"alert_kinds" <@ ARRAY['sos','overdue','incident','high_risk_area']::text[]`,
    ),
    // Vacation forwarding names its target, in both directions: a forwarding row with no target drops
    // the page entirely, and a target with the flag off is a page that silently never forwards.
    vacationPair: check(
      "m20_sss_vacation_pair",
      sql`"is_vacation_forwarding" = ("vacation_forward_to_membership_id" IS NOT NULL)`,
    ),
    noSelfForward: check(
      "m20_sss_no_self_forward",
      sql`"vacation_forward_to_membership_id" IS NULL
          OR "vacation_forward_to_membership_id" <> "supervisor_membership_id"`,
    ),
    noSelfSupervision: check(
      "m20_sss_no_self_supervision",
      sql`"clinician_membership_id" IS NULL
          OR "clinician_membership_id" <> "supervisor_membership_id"`,
    ),
  }),
);

export type SafetySupervisorSubscriptionRow = typeof safetySupervisorSubscription.$inferSelect;
export type NewSafetySupervisorSubscriptionRow = typeof safetySupervisorSubscription.$inferInsert;
