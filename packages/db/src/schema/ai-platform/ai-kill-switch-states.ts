// @chartwarden/db — `ai_kill_switch_state` (M32 §3.2.12). W3: the switch that stops a capability, for one
// tenant or for everyone.
//
// THE ONLY MIXED-SCOPE TABLE IN M32, and the asymmetry IS the control. `organization_id` is NULLABLE and
// NULL means a PLATFORM-WIDE kill. RLS (0116) therefore splits by command rather than using one
// `FOR ALL` policy: SELECT admits the platform row plus the caller's own; INSERT and UPDATE admit only
// rows carrying the caller's own org. A single permissive `FOR ALL` policy would let any tenant admin
// mint a NULL-org row and kill the capability for every other tenant on the platform — so W3's
// platform-wide activation goes through `wardenx_admin`, never through `wardenx_app`. (Two permissive
// `FOR ALL` policies would also OR together, the shape ADR-0010 D3 forbids.)
//
// TWO PARTIAL UNIQUE INDEXES, NOT ONE. `ai_kill_org_cap_idx` is `(organization_id, capability_id)
// WHERE organization_id IS NOT NULL`; `ai_kill_platform_cap_idx` is `(capability_id)
// WHERE organization_id IS NULL`. A single unconditional unique index would not enforce the platform
// rule at all — NULLs are distinct in a PostgreSQL unique index, so two platform-wide kills for one
// capability would both be accepted, and the deactivation of one would read as "the switch is off".
//
// `active` IS THE SWITCH, NOT ROW EXISTENCE. A deactivated kill keeps its row with the full activation
// AND deactivation attribution (who, which kind of actor, why, when, on both sides) — the incident
// record of a SEV-1 pause is exactly the thing a post-mortem needs, and deleting the row to turn the
// capability back on would destroy it. The `active` partial index is what the invocation gate reads.
//
// The automated actor kinds (`automated_cost_watch`, `automated_drift_monitor`,
// `automated_vendor_health_monitor`, `automated_lifecycle_demotion`) are first-class values in the enum
// rather than a nullable membership plus a boolean: a cost-cap trip has no human to name, and modelling
// it as "membership id absent" would make an unattributed human activation indistinguishable from a
// machine one.
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
import { aiKillSwitchActivationActorKind, aiKillSwitchReason } from "../../enums";
import { organizations } from "../organizations";
import { aiCapability } from "./ai-capabilities";

export const aiKillSwitchState = pgTable(
  "ai_kill_switch_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULLABLE BY DESIGN: NULL = platform-wide kill (see header). */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),

    active: boolean("active").notNull().default(false),

    reason: aiKillSwitchReason("reason"),
    activationActorKind: aiKillSwitchActivationActorKind("activation_actor_kind"),
    /** Logical FK → M2 membership; absent for the automated actor kinds (see header). */
    activationActorMembershipId: uuid("activation_actor_membership_id"),
    activationMessage: text("activation_message"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),

    deactivationActorKind: aiKillSwitchActivationActorKind("deactivation_actor_kind"),
    deactivationActorMembershipId: uuid("deactivation_actor_membership_id"),
    deactivationMessage: text("deactivation_message"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCapabilityIdx: uniqueIndex("ai_kill_org_cap_idx")
      .on(t.organizationId, t.capabilityId)
      .where(sql`organization_id IS NOT NULL`),
    // Without this second partial index the one-platform-kill-per-capability rule does not exist:
    // NULLs are distinct, so the index above constrains nothing for platform rows (see header).
    platformCapabilityIdx: uniqueIndex("ai_kill_platform_cap_idx")
      .on(t.capabilityId)
      .where(sql`organization_id IS NULL`),
    activeIdx: index("ai_kill_active_idx")
      .on(t.capabilityId, t.organizationId)
      .where(sql`active = true`),

    // An ACTIVE kill must say who turned it on and why. An unattributed platform-wide stop is not an
    // incident record, and the automated actor kinds exist precisely so a machine trip is still named.
    activeAttributed: check(
      "ai_kill_active_attributed",
      sql`active = false OR (reason IS NOT NULL AND activation_actor_kind IS NOT NULL AND activated_at IS NOT NULL)`,
    ),
  }),
);

export type AiKillSwitchStateRow = typeof aiKillSwitchState.$inferSelect;
export type NewAiKillSwitchStateRow = typeof aiKillSwitchState.$inferInsert;
