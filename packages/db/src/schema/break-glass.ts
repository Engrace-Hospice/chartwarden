// @wardenx/db — `break_glass_event` (M3 Authorization §3.5). Emergency-access record:
// an actor opens "glass" to reach PHI outside their normal ABAC scope (§7.4). Org-scoped
// on organization_id; `target_organization_id` marks the rare cross-tenant (WardenX
// platform) invocation, readable only in platform context + the target tenant's Compliance
// Officer (§3.6). Time-boxed via `expires_at` (default +4h, D1) and accountable via
// actor/cosign columns. Not a PHI table itself (carries only the target *reference*), so it
// is org-scoped without the PE/location columns; standard app.org_id RLS lands in M3-T04.
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { breakGlassStatus } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const breakGlassEvents = pgTable(
  "break_glass_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    targetOrganizationId: uuid("target_organization_id"), // cross-tenant (WardenX) only
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    targetPatientId: uuid("target_patient_id"), // null = scope-level glass
    reason: text("reason").notNull(),
    status: breakGlassStatus("status").notNull().default("active"),
    cosignRequired: boolean("cosign_required").notNull().default(false),
    cosignedBy: uuid("cosigned_by").references(() => users.id),
    consentRef: uuid("consent_ref"), // tenant consent for cross-tenant
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // default +4h
  },
  (t) => ({
    orgIdx: index("break_glass_org_idx").on(t.organizationId),
    actorIdx: index("break_glass_actor_idx").on(t.actorUserId),
    activeIdx: index("break_glass_active_idx").on(t.status, t.expiresAt),
    // §7.4 two-person control (migration 0210): when a tenant sets `breakglass_cosign_required`,
    // the co-signature IS the control — so the invoker may never be their own co-signer. Enforced
    // at rest as well as in the store so the invariant survives a future caller (a backfill, an
    // admin script, a second store implementation) that never sees the app-layer guard.
    cosignerDistinct: check(
      "bge_cosigner_distinct",
      sql`cosigned_by IS NULL OR cosigned_by <> actor_user_id`,
    ),
  }),
);

export type BreakGlassEvent = typeof breakGlassEvents.$inferSelect;
export type NewBreakGlassEvent = typeof breakGlassEvents.$inferInsert;
