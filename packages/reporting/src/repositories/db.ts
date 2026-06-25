// @wardenx/reporting · repositories — the shared Drizzle surface every M33 repository takes.
//
// CONVENTION (mirrors @wardenx/saas-tenant-platform repositories + packages/audit drizzle-audit-query):
// each repo takes the Drizzle client (`ReportingDb`) in its constructor and issues plain Drizzle queries;
// the SERVICE layer wraps each call in `withOrgContext` / `withPlatformContext` (M1 @wardenx/tenancy) so
// Postgres RLS scopes every statement to `app.org_id` (or runs platform-context for the org-less catalog
// reads + the nullable-org MV-refresh ledger). The repo therefore accepts either the pooled `DbClient` or
// a transaction handle from `withOrgContext` — both satisfy `ReportingDb` structurally. The repo never
// opens its own transaction and never sets RLS GUCs: scoping is the service's job (single home for it).
import type { DbClient } from "@wardenx/db";

/**
 * The minimal Drizzle surface every M33 repository needs: the pooled client or a transaction handle
 * opened by `withOrgContext` / `withPlatformContext`. Typed as `DbClient` so both satisfy it
 * structurally; the service decides which to pass.
 */
export type ReportingDb = DbClient;
