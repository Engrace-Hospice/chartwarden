// @wardenx/quality · repositories — the shared Drizzle surface every M30 repository takes.
//
// CONVENTION (mirrors @wardenx/reporting repositories + @wardenx/saas-tenant-platform): each repo takes
// the Drizzle client (`QualityDb`) in its constructor and issues plain Drizzle queries; the read/write
// SERVICE layer wraps each call in `withOrgContext` (M1 @wardenx/tenancy) so Postgres RLS scopes every
// statement to `app.org_id`. The repo therefore accepts either the pooled `DbClient` or a transaction
// handle opened by `withOrgContext` — both satisfy `QualityDb` structurally. The repo never opens its
// own transaction and never sets RLS GUCs: scoping is the service's job (single home for it).
import type { DbClient } from "@wardenx/db";

/**
 * The minimal Drizzle surface every M30 repository needs: the pooled client or a transaction handle
 * opened by `withOrgContext`. Typed as `DbClient` so both satisfy it structurally; the service decides
 * which to pass.
 */
export type QualityDb = DbClient;
