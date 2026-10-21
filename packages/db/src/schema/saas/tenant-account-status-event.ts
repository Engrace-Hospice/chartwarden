// @chartwarden/db — `tenant_account_status_event` (M34 §3.3). The append-only audit ledger of every
// tenant lifecycle transition (from_status → to_status, with reason, actor, and the side effects
// recorded at the transition). ORG-SCOPED: per M34-F02 / ADR-0010 (§10.1 Expand/Contract) it carries
// its own `organization_id` NOT NULL so the canonical app.org_id RLS predicate applies directly
// (was FK-join-scoped via tenant_account; this phase requires the column). The intra-M34 parent ref
// (tenant_account_id) and the M1 organization spine carry SQL FKs; the M2 actor_membership_id is plain
// uuid app-validated. Standard app.org_id RLS + the M4 write-audit trigger land in 0052/0053.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { tenantAccount, tenantAccountStatus } from "./tenant-account";

export const tenantAccountStatusEvent = pgTable(
  "tenant_account_status_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantAccountId: uuid("tenant_account_id")
      .notNull()
      .references(() => tenantAccount.id, { onDelete: "restrict" }),
    // M34-F02 / ADR-0010: tenant-scoping key. Was FK-join-scoped via tenant_account;
    // now carries its own organization_id NOT NULL so the canonical app.org_id RLS
    // predicate applies directly (ADR-0010 D2/D3). Two-phase Expand/Contract per §10.1.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    fromStatus: tenantAccountStatus("from_status"),
    toStatus: tenantAccountStatus("to_status").notNull(),
    transitionReason: text("transition_reason").notNull(),
    actorMembershipId: uuid("actor_membership_id"), // M2 membership; app-validated, no SQL FK
    actorKind: text("actor_kind").notNull(), // platform_ops|org_admin|system_automated
    sideEffectsRecorded: jsonb("side_effects_recorded").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // M34-F02 / ADR-0010: SD-028 composite index leads with organization_id.
    orgOccurredIdx: index("tenant_account_status_event_org_occurred_idx").on(
      t.organizationId,
      t.occurredAt,
    ),
    tenantIdx: index("tenant_account_status_event_tenant_idx").on(t.tenantAccountId, t.occurredAt),
  }),
);

export type TenantAccountStatusEvent = typeof tenantAccountStatusEvent.$inferSelect;
export type NewTenantAccountStatusEvent = typeof tenantAccountStatusEvent.$inferInsert;
