#!/usr/bin/env bun
/**
 * WardenX - backfill the inpatient 20% cap's day ledger for claims paid BEFORE the day-ledger fixes (GAP-038).
 *
 * Re-announces `m23.claim.line_finalized` for every still-paid claim in a cap year the tenant has opened (M26's
 * ledger dedups, and stamps the claim identity on rows that predate it), and takes back the day lines of claims
 * that were paid and later replaced / voided / recouped. Cap years without an open `cap_period`, and sealed
 * ones, are reported and left alone. Platform-ops only: there is no tenant HTTP route for this.
 *
 * AFTER it runs: let the outbox dispatcher drain the replayed events, then the nightly projection (or any
 * `recompute`) rebuilds the roll-up from the ledger and recomputes utilisation. It re-delivers to EVERY declared
 * consumer of `m23.claim.line_finalized`, not only M26.
 *
 * Idempotent: safe to re-run.
 *
 * Run:   bun run scripts/backfill-line-finalized.ts [--org <uuid>] [--page-size <n>] [--operator <label>]
 * Env:   DATABASE_URL (the RLS-enforced app role); DATABASE_ADMIN_URL (optional, used only to list organizations)
 */
import { createDbClient, schema } from "@wardenx/db";
import {
  buildBootOutboxCatalog,
  buildTxOutboxPublisher,
} from "../apps/backend/src/bootstrap/outbox-persister";
import { M23_OUTBOX_EVENTS } from "../apps/backend/src/modules/23-billing-medicare/index";
import { createCapBackfillPorts } from "../apps/backend/src/modules/26-cap/consumers/backfill-ports";
import { createDrizzleCapConsumerStore } from "../apps/backend/src/modules/26-cap/consumers/drizzle-store";
import { M26_WORKER_SYSTEM_USER_ID } from "../apps/backend/src/modules/26-cap/system-actor";
import { runLineFinalizedBackfill } from "./lib/line-finalized-backfill";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    console.error("DATABASE_URL must be set (the RLS-enforced application role)");
    process.exit(1);
  }
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? appUrl;
  const operator = flag("operator") ?? "unspecified";
  const onlyOrg = flag("org");
  const pageSize = flag("page-size") ? Number(flag("page-size")) : undefined;

  const app = createDbClient({ connectionString: appUrl });
  const admin = adminUrl === appUrl ? app : createDbClient({ connectionString: adminUrl });
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
  // The backfill only reverses days and re-announces facts: the MBI / first-election ports are never called.
  const store = createDrizzleCapConsumerStore(app.db, {
    mbi: { mbiNormalizedForPatient: async () => null },
    firstElection: { firstElectionEffectiveDateInRange: async () => null },
  });
  try {
    const orgs = onlyOrg
      ? [{ id: onlyOrg }]
      : await admin.db.select({ id: schema.organizations.id }).from(schema.organizations);
    for (const org of orgs) {
      const report = await runLineFinalizedBackfill(
        {
          db: app.db,
          outbox: {
            publish: (tx, event) =>
              publisher.publish(tx as never, { ...event, callerModule: "m23" }),
          },
          store,
          capYears: createCapBackfillPorts(app.db, M26_WORKER_SYSTEM_USER_ID),
          ...(pageSize ? { pageSize } : {}),
        },
        org.id,
      );
      // PHI-free: ids and counts only. The ledger writes themselves are audited by the table triggers.
      console.log(JSON.stringify({ operator, ...report }));
    }
  } finally {
    await app.close();
    if (admin !== app) await admin.close();
  }
}

await main();
