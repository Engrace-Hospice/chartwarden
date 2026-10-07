// apps/backend/src/modules/28-fhir/jobs/capability-snapshot.ts — the `fhir.capability-snapshot-validator` cron
// (§2.2 / §3.3 / §4.8, W-FHIR-09). The spec says the platform-singleton `fhir_capability_snapshot` row is
// generated at boot, signed (HMAC-SHA256) with the platform signing key, and verified hourly; before this the
// table had NO writer anywhere (the `/metadata` endpoint recomputes the statement per request), so there was
// no signed "what the gateway advertised at the time of a disclosure" artifact to verify. One tick:
//
//   1. ENSURE — if no snapshot exists for the current `(fhir_version, release_tag)`, build the statement with
//      the SAME builder `/fhir/r4/metadata` serves, checksum + sign it and INSERT it under a transaction
//      advisory lock (two nodes ticking together persist exactly one row). Platform-shared writes go through the
//      audited platform pool (`runPlatform`); the tenant pool only holds SELECT on the table.
//   2. VERIFY — re-compute the checksum and the HMAC over the PERSISTED statement and compare to the persisted
//      checksum/signature in constant time. A mismatch is a tampering signal: logged at error level and the job
//      FAILS (retry -> DLQ -> the platform DLQ alert), never swallowed.
//   3. DRIFT — if the statement the running code would serve no longer matches the persisted one under the same
//      release tag, the gateway changed without a release-tag bump: reported (warn), not a tamper.
//
// Platform-shared: there is no org to fan out over (spec "n/a"), so there is no per-org loop. Bounded (one
// release tag, at most {@link VERIFY_ROW_LIMIT} rows), idempotent (a re-run with a row present writes nothing).
// No signing key bound => the tick FAILS LOUD rather than silently verifying nothing.
import { type DbClient, schema } from "@wardenx/db";
import {
  type FhirCapabilityStatement,
  capabilityChecksum,
  signCapabilitySnapshot,
  verifyCapabilitySnapshot,
} from "@wardenx/fhir";
import { FHIR_PHASE_1_VERSION } from "@wardenx/types";
import { and, desc, eq, sql } from "drizzle-orm";

const SNAPSHOT = schema.fhirCapabilitySnapshot;
/** The most recent rows of the current release the validator re-verifies per tick. */
const VERIFY_ROW_LIMIT = 10;

export interface CapabilitySnapshotDeps {
  /** The tenant pool: the table is `SELECT USING (true)` for it. */
  readonly db: DbClient;
  /** Runs `fn` on the audited platform pool (the only credential allowed to INSERT). Absent => no persist. */
  readonly runPlatform?: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
  /** The platform signing key (`FHIR_CAPABILITY_SIGNING_KEY`). */
  readonly signingKey: string | undefined;
  /** The statement the running code serves (shared with `GET /fhir/r4/metadata`). */
  readonly buildStatement: () => FhirCapabilityStatement;
  readonly releaseTag: string;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
  };
}

export interface CapabilitySnapshotResult {
  readonly persisted: boolean;
  readonly verified: number;
  readonly drifted: boolean;
}

const asTx = (tx: unknown): DbClient => tx as DbClient;
const utf8 = (hexSignature: string): Buffer => Buffer.from(hexSignature, "utf8");

async function countForRelease(db: DbClient, releaseTag: string): Promise<number> {
  const rows = await db
    .select({ id: SNAPSHOT.id })
    .from(SNAPSHOT)
    .where(and(eq(SNAPSHOT.fhirVersion, FHIR_PHASE_1_VERSION), eq(SNAPSHOT.releaseTag, releaseTag)))
    .limit(1);
  return rows.length;
}

/** Insert the snapshot for the current release if none exists. Returns whether a row was written. */
async function ensureSnapshot(deps: CapabilitySnapshotDeps, key: string): Promise<boolean> {
  if ((await countForRelease(deps.db, deps.releaseTag)) > 0) return false;
  if (deps.runPlatform === undefined) {
    deps.log?.warn({}, "m28 capability snapshot: no platform pool bound; snapshot not persisted");
    return false;
  }
  const statement = deps.buildStatement();
  return deps.runPlatform(async (tx) => {
    const t = asTx(tx);
    await t.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`fhir_capability_snapshot:${deps.releaseTag}`}))`,
    );
    // Re-check under the lock: a concurrent node may have persisted it between the read above and now.
    if ((await countForRelease(t, deps.releaseTag)) > 0) return false;
    await t.insert(SNAPSHOT).values({
      fhirVersion: FHIR_PHASE_1_VERSION,
      releaseTag: deps.releaseTag,
      capabilityStatement: statement,
      checksumSha256: capabilityChecksum(statement),
      signature: utf8(signCapabilitySnapshot(statement, key)),
    });
    return true;
  });
}

/** One validator tick. Throws on a tamper verdict or when no signing key is bound. */
export async function runCapabilitySnapshotValidator(
  deps: CapabilitySnapshotDeps,
): Promise<CapabilitySnapshotResult> {
  const key = deps.signingKey;
  if (key === undefined || key.length === 0) {
    throw new Error(
      "fhir.capability-snapshot-validator: FHIR_CAPABILITY_SIGNING_KEY is not bound; refusing to report an unverified snapshot as valid",
    );
  }
  const persisted = await ensureSnapshot(deps, key);
  if (persisted)
    deps.log?.info({ releaseTag: deps.releaseTag }, "m28 capability snapshot persisted");

  const rows = await deps.db
    .select()
    .from(SNAPSHOT)
    .where(
      and(eq(SNAPSHOT.fhirVersion, FHIR_PHASE_1_VERSION), eq(SNAPSHOT.releaseTag, deps.releaseTag)),
    )
    .orderBy(desc(SNAPSHOT.generatedAt))
    .limit(VERIFY_ROW_LIMIT);

  const tampered = rows.filter((row) => {
    const statement = row.capabilityStatement as FhirCapabilityStatement;
    return (
      capabilityChecksum(statement) !== row.checksumSha256 ||
      !verifyCapabilitySnapshot(statement, Buffer.from(row.signature).toString("utf8"), key)
    );
  });
  if (tampered.length > 0) {
    deps.log?.error(
      { releaseTag: deps.releaseTag, snapshotIds: tampered.map((r) => r.id) },
      "m28 capability snapshot FAILED verification (tampered, or signed with another key)",
    );
    throw new Error(
      `fhir.capability-snapshot-validator: ${tampered.length} snapshot row(s) failed signature verification`,
    );
  }

  const latest = rows[0];
  const drifted =
    latest !== undefined && latest.checksumSha256 !== capabilityChecksum(deps.buildStatement());
  if (drifted) {
    deps.log?.warn(
      { releaseTag: deps.releaseTag },
      "m28 capability snapshot drift: the served statement changed without a release-tag bump",
    );
  }
  return { persisted, verified: rows.length, drifted };
}
