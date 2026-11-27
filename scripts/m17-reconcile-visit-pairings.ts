#!/usr/bin/env bun
/**
 * ChartWarden - CW-PI-04: find, and optionally correct, older visits whose clinician discipline pairing today's
 * rules would refuse. DRY-RUN BY DEFAULT: it reports counts and visit ids and changes nothing.
 *
 *   bun run m17:reconcile-visit-pairings [--org <uuid> ...]                      dry run (report only)
 *   bun run m17:reconcile-visit-pairings --apply --operator <label> [--max-rows N] [--org <uuid> ...]
 *
 * What it changes with --apply: only an OPEN visit (proposed or published) whose own assignee holds, and is
 * credentialed for, exactly ONE discipline legal for the visit's purpose gets its stamped discipline corrected.
 * Everything else that is illegal is reported for a person ("review": the assignee holds no legal discipline,
 * none credentialed, more than one, or the visit is in progress) or as history ("historical": completed,
 * cancelled, no-show, rescheduled) and is never touched. It never deletes a visit, never moves a visit to
 * another clinician, and writes one `m17.visit.pairing_reconciled` audit event per changed visit. Re-running
 * finds nothing left to correct.
 *
 * --max-rows N   (default 25, ceiling 1000) the most visits ONE run may change across all tenants. A bigger plan
 *                is refused whole: nothing is written and the exit code is 3.
 * --org <uuid>   limit to a tenant (repeatable); without it every ACTIVE tenant listed through DATABASE_ADMIN_URL
 *                runs (a suspended or closed tenant is only touched when named with --org).
 * --operator     a short label recorded in the audit trail; required with --apply.
 *
 * Output is JSON on stdout: ids and codes only (no names, no clinical text). Messages go to stderr.
 * Exit codes: 0 done, 1 a tenant failed (earlier tenants stay committed; re-running is safe), 2 bad usage,
 * 3 plan refused (over the cap).
 *
 * Env:   DATABASE_URL (the RLS-enforced application role: every visit read and write runs under it, per tenant,
 *        inside withOrgContext; a superuser/BYPASSRLS role is refused)
 *        DATABASE_ADMIN_URL (only to list tenant ids when --org is not given)
 * Procedure and apply checklist: docs/runbooks/m17-visit-pairing-reconcile.md
 */
import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import {
  assertRlsEnforcedRole,
  parseRunArgs,
  runVisitPairingReconciliation,
} from "./lib/visit-pairing-run";

const USAGE_EXIT = 2;
const FAILURE_EXIT = 1;

async function main(): Promise<number> {
  const parsed = parseRunArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`m17-reconcile-visit-pairings: ${parsed.message}`);
    return USAGE_EXIT;
  }
  const { args } = parsed;
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    console.error("DATABASE_URL must be set (the RLS-enforced application role)");
    return USAGE_EXIT;
  }
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!args.orgIds && !adminUrl) {
    console.error("pass --org <uuid> (repeatable), or set DATABASE_ADMIN_URL to list every tenant");
    return USAGE_EXIT;
  }

  const app = createDbClient({ connectionString: appUrl });
  const admin = adminUrl ? createDbClient({ connectionString: adminUrl }) : null;
  try {
    await assertRlsEnforcedRole(app.db);
    const orgIds =
      args.orgIds ??
      (
        await (admin as NonNullable<typeof admin>).db
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.status, "active"))
          .orderBy(schema.organizations.id)
      ).map((row) => row.id);
    const { exitCode, summary } = await runVisitPairingReconciliation(
      app.db,
      orgIds,
      args,
      randomUUID(),
    );
    console.log(JSON.stringify(summary, null, 2));
    if (summary.refused) {
      console.error(
        `REFUSED: the plan changes ${summary.plannedRestamps} visit(s), more than --max-rows ${summary.maxRows}. Nothing was written. Review the dry-run report, then re-run with a deliberate --max-rows.`,
      );
    } else if (summary.error) {
      console.error(
        `FAILED: ${summary.error}. Tenants applied before it stay committed; re-running is safe.`,
      );
    } else if (!args.apply && summary.exceedsCap) {
      console.error(
        `NOTE: --apply would be refused under --max-rows ${summary.maxRows} (${summary.plannedRestamps} planned).`,
      );
    }
    return exitCode;
  } catch (error) {
    console.error(
      `m17-reconcile-visit-pairings failed: ${error instanceof Error ? error.message : "error"}`,
    );
    return FAILURE_EXIT;
  } finally {
    await app.close();
    await admin?.close();
  }
}

process.exitCode = await main();
