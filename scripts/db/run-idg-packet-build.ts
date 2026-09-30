/**
 * WardenX — one-shot run of the REAL M14 `idg.packets-cron` handler for the demo org (local dev). NOT for prod.
 *
 * WHY THIS EXISTS. The hourly `idg.packets-cron` BullMQ worker fans out over `listActiveOrgs()`, and the
 * composition root (apps/backend/src/index.ts, `m14ActiveOrgs = buildActiveOrgEnumerator({ platformDb:
 * dbHandle.db ... })`) binds that enumerator to the TENANT pool (`wardenx_app`) instead of the platform
 * pool. `organization` RLS (`organization_self`: id = app.org_id) hides every row from a connection with no
 * tenant context, so the enumerator returns [] and the cron completes in ~7 ms having built nothing —
 * meetings sit in `packets_building` forever and `idg_patient_packet` stays empty. (Enqueue a job and watch:
 * `completed`, no packets.) That is a code defect outside this seed's remit; this script is the honest
 * workaround: it runs the SAME `runPacketBuildCron` the worker runs, with the org supplied explicitly, over
 * the real `wardenx_app` connection, real M5/M6/M7/M8 seams and the real catalog-validating outbox publisher.
 *
 * Run (host; needs the app-role URL that the Docker stack uses):
 *   DATABASE_URL="$(docker compose exec -T worker printenv DATABASE_URL | sed 's/@postgres:/@localhost:/')" \
 *   REDIS_URL=redis://localhost:6379 bun run db:idg:packet-build
 */
import { createDbClient } from "@wardenx/db";
import IORedis from "ioredis";
import { registerSeam } from "../../apps/backend/src/bootstrap/index";
import {
  buildBootOutboxCatalog,
  buildTxOutboxPublisher,
} from "../../apps/backend/src/bootstrap/outbox-persister";
import { siteDisplayForOrg } from "../../apps/backend/src/bootstrap/site-display-for-org";
import { membershipDisplayForOrg } from "../../apps/backend/src/modules/02-identity/index";
import {
  createDrizzlePatientReaderStore,
  registerPatientSeams,
} from "../../apps/backend/src/modules/05-patient/index";
import {
  idgCurrentLevelOfCareForOrg,
  idgHospitalEventsForOrg,
  idgPacketInclusionForOrg,
  idgRecertWindowsForOrg,
} from "../../apps/backend/src/modules/06-admission/index";
import { idgPacketCarePlanContextForOrg } from "../../apps/backend/src/modules/07-care-plan/index";
import {
  createDrizzleEncounterReaderStore,
  registerEncounterSeams,
} from "../../apps/backend/src/modules/08-encounters/index";
import { idgHopeContextForOrg } from "../../apps/backend/src/modules/10-hope/index";
import { idgMedicationHistoryForOrg } from "../../apps/backend/src/modules/12-dosespot/index";
import { idgMissedDosesForOrg } from "../../apps/backend/src/modules/13-emar/index";
import type { IdgWriteOutboxPort } from "../../apps/backend/src/modules/14-idg/idg-route-service-db";
import { M14_OUTBOX_EVENTS, runPacketBuildCron } from "../../apps/backend/src/modules/14-idg/index";
import { idgTriageCarePlanChangesForOrg } from "../../apps/backend/src/modules/19-oncall/index";
import { idgQualityFlaggedEventsForOrg } from "../../apps/backend/src/modules/30-quality/index";

void registerSeam;
const ORG_ID = process.env.IDG_SEED_ORG_ID ?? "b991d9e6-c459-4831-9543-cc00fb4cf6e2"; // wardenx-demo

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (the wardenx_app role URL) is required");
  const handle = createDbClient({ connectionString: url });
  const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  try {
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
    const outbox: IdgWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m14" }),
    };
    registerPatientSeams({ readerStore: createDrizzlePatientReaderStore(handle.db) });
    registerEncounterSeams({ store: createDrizzleEncounterReaderStore(handle.db) });
    await runPacketBuildCron({
      db: handle.db,
      outbox,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_ID }] },
      redis,
      m6: {
        inclusionForOrg: (o, l, asOf, wrap) =>
          idgPacketInclusionForOrg(handle.db, o, l, asOf, wrap),
        currentLevelOfCareForOrg: (o, a, asOf) =>
          idgCurrentLevelOfCareForOrg(handle.db, o, a, asOf),
      },
      m7: {
        carePlanContextForOrg: (o, p, asOf) =>
          idgPacketCarePlanContextForOrg(handle.db, o, p, asOf),
      },
      recertWindows: {
        recertWindowsForOrg: (o, ids, asOf) =>
          idgRecertWindowsForOrg(handle.db, o, ids, new Date(asOf)),
      },
      flaggedEventSources: [
        {
          source: "m6.hospital",
          flaggedEventsForOrg: (o, ids, since) => idgHospitalEventsForOrg(handle.db, o, ids, since),
        },
        {
          source: "m13.missed_dose",
          flaggedEventsForOrg: (o, ids, since) => idgMissedDosesForOrg(handle.db, o, ids, since),
        },
        {
          source: "m30.fall_infection",
          flaggedEventsForOrg: (o, ids, since) =>
            idgQualityFlaggedEventsForOrg(handle.db, o, ids, since),
        },
        {
          source: "m19.triage_care_plan_change",
          flaggedEventsForOrg: (o, ids, since) =>
            idgTriageCarePlanChangesForOrg(handle.db, o, ids, since),
        },
      ],
      hope: { hopeContextForOrg: (o, ids) => idgHopeContextForOrg(handle.db, o, ids) },
      medicationHistory: {
        medicationHistoryForOrg: (o, ids) => idgMedicationHistoryForOrg(handle.db, o, ids),
      },
      siteDisplay: { displayForSite: (o, ids) => siteDisplayForOrg(handle.db, o, ids) },
      membershipDisplay: {
        displayForMemberships: (o, ids) => membershipDisplayForOrg(handle.db, o, ids),
      },
    });
    console.log("✓ idg.packets-cron handler ran for the demo org");
  } finally {
    await redis.quit();
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
