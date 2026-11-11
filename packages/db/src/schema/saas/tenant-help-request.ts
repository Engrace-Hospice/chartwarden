// @chartwarden/db — `tenant_help_request` (M34, migration 1482; slice 7). A member of the tenant asks ChartWarden for help during
// onboarding (and after go-live, on the non-PHI `assist` consent only); the organization's org_admin or compliance officer
// approves it (which creates the `assist` support_consent_grant and links it here), and it ends when either side says so, when the
// grant expires, or when an unanswered request is 14 days old. ORG-SCOPED (`organization_id` NOT NULL, canonical app.org_id RLS, FORCEd).
// `status` and `closed_by_actor_kind` are text + CHECK (no pg enum) so the code-side mirrors are the exported unions below.
//
// The tenant role may INSERT a request (pinned: open, the session user as requester through an active membership), UPDATE the approve
// and close columns (each pinned by policy), and read its own rows; the platform carrier reads every row and UPDATEs the close columns
// only (an operator's Resolve and the sweep). The message and the operator's note are free text: the row-audit trigger records them
// as `<changed>` and nothing else (no outbox payload, log line or error carries them). One LIVE request per tenant account is the
// partial unique index below (a 23505 on it reads as 409 HELP_REQUEST_ALREADY_OPEN, with the live request's id, in the service).
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { organizations } from "../organizations";
import { supportConsentGrant } from "./support-consent-grant";

/** The rule the database is the authority for: a second live request on a tenant account (a 23505 reads as a 409, not a 500). */
export const TENANT_HELP_REQUEST_LIVE_IDX = businessRule(
  "tenant_help_request_live_uq",
  "This organization already has a help request that is open or approved.",
);

export const TENANT_HELP_REQUEST_STATUSES = ["open", "approved", "resolved", "cancelled"] as const;
export type TenantHelpRequestStatus = (typeof TENANT_HELP_REQUEST_STATUSES)[number];

/** Who ended a request (`closed_by_actor_kind`; the same three values as a grant revocation's source). */
export const TENANT_HELP_REQUEST_CLOSER_KINDS = ["tenant", "platform_ops", "system"] as const;
export type TenantHelpRequestCloserKind = (typeof TENANT_HELP_REQUEST_CLOSER_KINDS)[number];

/** How long a closed request's message and note are kept; after it the sweep nulls both at rest. */
export const TENANT_HELP_REQUEST_TEXT_RETENTION_DAYS = 90;
/** What the API projects for a message migration 1483 has nulled at rest. */
export const TENANT_HELP_REQUEST_PURGED_MESSAGE = "[removed after 90 days]";

/** The live statuses: the ones the unique index admits one of per tenant account. */
export const TENANT_HELP_REQUEST_LIVE_STATUSES = ["open", "approved"] as const;

export const tenantHelpRequest = pgTable(
  "tenant_help_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Intra-M34 parent; the composite SQL FK (tenant_account_id, organization_id) lands in the migration.
    tenantAccountId: uuid("tenant_account_id").notNull(),
    // The wizard step the question is about (an onboarding_task_template key), or null for a general one.
    stepKey: text("step_key"),
    // Free text the member typed (btrim 8..1000, PHI-screened by the service). Never in audit detail, events, logs or errors.
    message: text("message"),
    status: text("status").$type<TenantHelpRequestStatus>().notNull().default("open"),
    // Plain uuids like every M34 cross-module reference (no SQL FK to M2); the INSERT policy checks them against each other.
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    // The non-PHI `assist` consent grant approval created; the grant does not carry the request id (an old table, no column added).
    supportConsentGrantId: uuid("support_consent_grant_id").references(
      () => supportConsentGrant.id,
      {
        onDelete: "restrict",
      },
    ),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    closedByActorKind: text("closed_by_actor_kind").$type<TenantHelpRequestCloserKind>(),
    // The person who ended it; null for the system (the sweep).
    closedByUserId: uuid("closed_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // The operator's tenant-visible note on a Resolve (btrim 8..500, PHI-screened by the service); only an operator writes one.
    closeNote: text("close_note"),
    // Migration 1483: stamped when the retention sweep nulled a closed request's message (90 days after it
    // closed). The guard trigger lets a closed request change in exactly this one way.
    messagePurgedAt: timestamp("message_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one live (open or approved) request per tenant account; an ended one is history.
    liveUnique: uniqueIndex(TENANT_HELP_REQUEST_LIVE_IDX)
      .on(t.tenantAccountId)
      .where(sql`status IN ('open', 'approved')`),
    // Leads with the composite FK's columns (fk-index-coverage); the requested_at tail serves "newest first".
    tenantIdx: index("tenant_help_request_tenant_ix").on(
      t.tenantAccountId,
      t.organizationId,
      t.requestedAt.desc(),
    ),
    orgIdx: index("tenant_help_request_org_ix").on(t.organizationId),
    grantIdx: index("tenant_help_request_grant_ix").on(t.supportConsentGrantId),
    // Migration 1483: one request per consent grant.
    grantUnique: uniqueIndex("tenant_help_request_grant_uq")
      .on(t.supportConsentGrantId)
      .where(sql`support_consent_grant_id IS NOT NULL`),
    // Migration 1483: the retention sweep's scan (closed requests whose text is still there, oldest first).
    purgeIdx: index("tenant_help_request_purge_ix")
      .on(t.closedAt)
      .where(sql`message_purged_at IS NULL AND status IN ('resolved', 'cancelled')`),
    statusIdx: index("tenant_help_request_status_ix").on(t.status, t.requestedAt.desc()),
  }),
);

/**
 * The columns the tenant role may INSERT (migration 1482's column-level grant), as a narrower table object over the same table:
 * Drizzle lists EVERY column of the table it inserts into (`values (default, $1, default, ...)`) and `DEFAULT` still needs INSERT
 * privilege on its column, so a column grant is only usable through an insert that names just these; `status`, `requested_at` and
 * every approve / close column then take their database defaults.
 */
export const tenantHelpRequestCreate = pgTable("tenant_help_request", {
  organizationId: uuid("organization_id").notNull(),
  tenantAccountId: uuid("tenant_account_id").notNull(),
  stepKey: text("step_key"),
  message: text("message").notNull(),
  requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull(),
});
export type NewTenantHelpRequestCreate = typeof tenantHelpRequestCreate.$inferInsert;

export type TenantHelpRequest = typeof tenantHelpRequest.$inferSelect;
export type NewTenantHelpRequest = typeof tenantHelpRequest.$inferInsert;
