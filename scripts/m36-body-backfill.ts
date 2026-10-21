#!/usr/bin/env bun
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
/**
 * WardenX — re-seal ONE tenant's legacy message bodies under the M34 ring DEK (M36 WP 2.13 / ADR-0058 P1).
 *
 * OPERATOR TOOL. Never run in CI, never scheduled. Read docs/runbooks/m36-body-key-ring.md first: in a production
 * environment a real run is REFUSED unless M36_BODY_BACKFILL_ESCROW_DRILL_CONFIRMED=true, which you set only after the
 * MESSAGING_ENCRYPTION_KEY / M34_TENANT_KEK escrow restore drill has passed and is on record. A dry run is always allowed.
 *
 *   bun run m36:body-backfill -- --org <organization-uuid> [--dry-run] [--batch 100] [--max-rows 5000]
 *                                [--pause-ms 250] [--deadline-sec 600]
 *
 * Needs DATABASE_URL (the tenant role), DATABASE_PLATFORM_URL (reads tenant_key_ring), DATABASE_BODY_BACKFILL_URL (real runs: the
 * wardenx_body_backfill_login that alone may re-seal a revision), M34_TENANT_KEK (+ _RETIRED) and
 * MESSAGING_ENCRYPTION_KEY (the legacy key that still opens the old rows). It is safe to stop and re-run: it resumes.
 * Prints the JSON completion report (counts per table, rows remaining on the legacy envelope). Exit 1 if any row failed
 * or mismatched its plaintext hash; the run is `complete` only when zero legacy rows remain.
 */
import {
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../apps/backend/src/bootstrap/tenant-kek";
import { buildKeyProvider } from "../apps/backend/src/modules/34-saas-tenant-platform/seam-registration";
import {
  BodyBackfillRefusedError,
  assertBodyBackfillAllowed,
  backfillBodiesForOrg,
} from "../apps/backend/src/modules/36-messaging/jobs/body-backfill";
import { createMessageBodyCipher } from "../apps/backend/src/modules/36-messaging/messaging-write-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORM_ACTOR = "m36-body-backfill";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function intFlag(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

async function main(): Promise<number> {
  const org = flag("org");
  if (!org || !UUID.test(org)) {
    console.error("--org <organization-uuid> is required (one tenant per run)");
    return 1;
  }
  const dryRun = process.argv.includes("--dry-run");
  assertBodyBackfillAllowed(process.env, dryRun);
  const { DATABASE_URL, DATABASE_PLATFORM_URL, DATABASE_BODY_BACKFILL_URL } = process.env;
  if (!DATABASE_URL || !DATABASE_PLATFORM_URL) {
    console.error("DATABASE_URL and DATABASE_PLATFORM_URL are required");
    return 1;
  }
  if (!dryRun && !DATABASE_BODY_BACKFILL_URL) {
    console.error(
      "DATABASE_BODY_BACKFILL_URL (login wardenx_body_backfill_login, member of wardenx_m36_reseal) is required for a real run: revisions are append-only for every other role",
    );
    return 1;
  }
  const kekRing = loadPlatformKekRing();
  if (!kekRing) {
    console.error("M34_TENANT_KEK is required (the platform KEK that unwraps the tenant ring DEK)");
    return 1;
  }
  const tenant = createDbClient({ connectionString: DATABASE_URL });
  const platform = createDbClient({ connectionString: DATABASE_PLATFORM_URL });
  const reseal = DATABASE_BODY_BACKFILL_URL
    ? createDbClient({ connectionString: DATABASE_BODY_BACKFILL_URL })
    : undefined;
  try {
    const keys = buildKeyProvider({
      kekUnwrap: createPlatformKekAdapter(kekRing),
      runInKeyRingContext: (orgId, fn) =>
        withOrgContext(platform.db, { organizationId: orgId, userId: PLATFORM_ACTOR }, fn),
    });
    if (!dryRun && (process.env.M36_BODY_SEAL_SCHEME ?? "legacy").trim().toLowerCase() !== "ring") {
      console.warn(
        "warning: M36_BODY_SEAL_SCHEME is not 'ring' on this deployment, so new writes keep creating legacy rows and the backfill can only converge once it is",
      );
    }
    const deadlineSec = intFlag("deadline-sec");
    const report = await backfillBodiesForOrg(
      {
        db: tenant.db,
        cipher: createMessageBodyCipher({ keys, sealScheme: "ring" }),
        ...(reseal ? { resealDb: reseal.db } : {}),
      },
      org,
      {
        dryRun,
        batchSize: intFlag("batch"),
        maxRows: intFlag("max-rows"),
        pauseMs: intFlag("pause-ms"),
        deadlineMs: deadlineSec === undefined ? undefined : deadlineSec * 1000,
        onBatch: (p) =>
          console.error(`batch ${p.table}: scanned ${p.scanned}, migrated ${p.migrated}`),
      },
    );
    console.log(JSON.stringify(report, null, 2));
    const bad = Object.values(report.tables).some((t) => t.failed > 0 || t.hashMismatch > 0);
    return bad ? 1 : 0;
  } finally {
    await tenant.close();
    await platform.close();
    await reseal?.close();
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(
    err instanceof BodyBackfillRefusedError
      ? err.message
      : `backfill failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
