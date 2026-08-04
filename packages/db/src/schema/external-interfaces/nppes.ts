// @wardenx/db — `nppes_provider` + `nppes_sync_run` (M29 §3.3). The cached CMS NPPES public-directory
// records and the nightly-sync orchestration log (W-XI-11/12).
//
// PLATFORM-SHARED (NO organization_id) BY DESIGN — the NPPES registry is the same public directory for
// every tenant, so both are READ-ALL `USING (true)` to wardenx_app and WRITTEN only by wardenx_admin under
// the platform-role nightly sync (D11; the M28 fhir_capability_snapshot / M38 code_system precedent). Both
// are listed in check-tenancy's NON_ORG_SCOPED set with that justification. They are NOT partitioned.
//
// `nppes_provider` is keyed by the 10-char NPI (natural key, not a synthetic uuid) and carries public
// directory data only (no PHI) — its write-audit trail files `operational` (rebuildable from a re-sync),
// so it uses a GENERATED audit function stamping `operational` (M1's baseline stamps `compliance`).
// `nppes_sync_run` files `compliance` (the data-sharing-agreement audit horizon) and uses the baseline.
import {
  char,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  nppesEnumerationType,
  nppesProviderStatus,
  nppesSyncKind,
  nppesSyncStatus,
  nppesSyncTrigger,
} from "./enums";

export const nppesProvider = pgTable(
  "nppes_provider",
  {
    npi: char("npi", { length: 10 }).primaryKey(),
    enumerationType: nppesEnumerationType("enumeration_type").notNull(),
    status: nppesProviderStatus("status").notNull(),
    deactivationDate: date("deactivation_date"),
    deactivationReason: text("deactivation_reason"),
    reactivationDate: date("reactivation_date"),
    basic: jsonb("basic").notNull(),
    addresses: jsonb("addresses").notNull().default([]),
    taxonomies: jsonb("taxonomies").notNull().default([]),
    identifiers: jsonb("identifiers").notNull().default([]),
    endpoints: jsonb("endpoints").notNull().default([]),
    lastUpdatedInNppes: date("last_updated_in_nppes"),
    /** The M5 D9 cert-eligibility rule reads this against a 90-day freshness window. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("idx_np_status").on(t.status),
    fetchedAtIdx: index("idx_np_fetched_at").on(t.fetchedAt),
    lastUpdatedIdx: index("idx_np_last_updated").on(t.lastUpdatedInNppes),
  }),
);

export const nppesSyncRun = pgTable(
  "nppes_sync_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: nppesSyncKind("kind").notNull(),
    triggeredBy: nppesSyncTrigger("triggered_by").notNull(),
    /** Logical M2 ref; null for a cron-triggered run. */
    triggeredByMembershipId: uuid("triggered_by_membership_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: nppesSyncStatus("status").notNull().default("in_progress"),
    providersFetchedCount: integer("providers_fetched_count").notNull().default(0),
    providersUpdatedCount: integer("providers_updated_count").notNull().default(0),
    providersDeactivatedCount: integer("providers_deactivated_count").notNull().default(0),
    errorsCount: integer("errors_count").notNull().default(0),
    errorDetails: jsonb("error_details"),
    sourceFileUrl: text("source_file_url"),
  },
  (t) => ({
    startedIdx: index("idx_nsr_started").on(t.startedAt),
    statusIdx: index("idx_nsr_status").on(t.status),
  }),
);

export type NppesProviderRow = typeof nppesProvider.$inferSelect;
export type NewNppesProviderRow = typeof nppesProvider.$inferInsert;
export type NppesSyncRunRow = typeof nppesSyncRun.$inferSelect;
export type NewNppesSyncRunRow = typeof nppesSyncRun.$inferInsert;
