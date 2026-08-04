// @wardenx/cost-report · repositories — the shared Drizzle surface every M27 repository takes.
//
// CONVENTION (mirrors @wardenx/quality + @wardenx/reporting + @wardenx/saas-tenant-platform): each repo
// takes the Drizzle client (`CostReportDb`) in its constructor and issues plain Drizzle queries; the
// read/write SERVICE layer wraps each call in `withOrgContext` (M1 @wardenx/tenancy) so Postgres RLS
// scopes every statement to `app.org_id`. The repo therefore accepts either the pooled `DbClient` or a
// transaction handle opened by `withOrgContext` — both satisfy `CostReportDb` structurally. The repo
// never opens its own transaction and never sets RLS GUCs: scoping is the service's job (single home).
import type { DbClient } from "@wardenx/db";

/**
 * The minimal Drizzle surface every M27 repository needs: the pooled client or a transaction handle
 * opened by `withOrgContext`. Typed as `DbClient` so both satisfy it structurally; the service decides
 * which to pass.
 */
export type CostReportDb = DbClient;

/**
 * The optimistic-concurrency outcome of a version-checked update (§2.5): the freshly-updated row, or a
 * `VERSION_CONFLICT` signal carrying the CURRENT persisted version so the client can re-read + retry.
 * `cost_report` and `cost_report_worksheet` both carry a `version int` and use `WHERE id = ? AND
 * version = ?` semantics; the service surfaces the conflict as the M27 `VERSION_CONFLICT` error envelope.
 */
export type VersionedUpdateResult<TRow> =
  | { readonly ok: true; readonly row: TRow }
  | {
      readonly ok: false;
      readonly conflict: "VERSION_CONFLICT";
      readonly currentVersion: number | null;
    };
