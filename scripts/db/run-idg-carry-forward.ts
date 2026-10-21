/**
 * WardenX — one-shot run of the REAL M14 `idg.carry-forward` (`compute-carry-forward`) handler for the demo org
 * (local dev). NOT for prod. The same `runCarryForwardCron` the BullMQ worker runs, with the org supplied
 * explicitly, over the real `wardenx_app` connection and the real catalog-validating outbox publisher. Idempotent:
 * a second run carries nothing and increments nothing.
 *
 *   DATABASE_URL="postgres://wardenx_app:wardenx-app-dev-password@localhost:5432/wardenx" bun run db:idg:carry-forward
 */
import { createDbClient } from "@chartwarden/db";
import {
  buildBootOutboxCatalog,
  buildTxOutboxPublisher,
} from "../../apps/backend/src/bootstrap/outbox-persister";
import type { IdgWriteOutboxPort } from "../../apps/backend/src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  runCarryForwardCron,
} from "../../apps/backend/src/modules/14-idg/index";

const ORG_ID = process.env.IDG_SEED_ORG_ID ?? "b991d9e6-c459-4831-9543-cc00fb4cf6e2"; // wardenx-demo

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (the wardenx_app role URL) is required");
  const handle = createDbClient({ connectionString: url });
  try {
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
    const outbox: IdgWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m14" }),
    };
    await runCarryForwardCron({
      db: handle.db,
      outbox,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_ID }] },
    });
    console.log("✓ idg.carry-forward handler ran for the demo org");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
