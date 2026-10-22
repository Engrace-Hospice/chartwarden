/**
 * Database-side and object-side probes for the M36 restore drill. The same probes run on the source at backup time
 * (producing the manifest) and on the restored copy (producing the verdict); the comparison itself is in ./report.ts.
 */
import { createHash } from "node:crypto";
import { createDbAuditChainReader } from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import {
  type ObjectStorePort,
  deriveTenantBucket,
} from "../../../apps/backend/src/modules/22-documents";
import { runHashVerifyForOrg } from "../../../apps/backend/src/modules/36-messaging/jobs/integrity-jobs";
import { createMessageBodyCipher } from "../../../apps/backend/src/modules/36-messaging/messaging-write-core";
import { MODULES } from "../../../architecture/module-manifest";
import type { AttachmentExpectation, Check, ObjectFingerprint, ReconcileFindings } from "./report";
import { objectId } from "./report";

const M36 = MODULES.find((m) => m.id === 36);
export const M36_TABLES: readonly string[] = M36 ? M36.ownedTables : [];
/** Beyond any real audit month: lists every month the org has events in. */
const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");
/** Larger than any drill table, so the sampled hash-verify job covers every row (demo scale). */
const FULL_COVERAGE = 100_000;

export async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function countM36Tables(adminUrl: string): Promise<Record<string, number>> {
  return withClient(adminUrl, async (c) => {
    const out: Record<string, number> = {};
    for (const table of M36_TABLES) {
      out[table] = (await c.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n as number;
    }
    return out;
  });
}

/** RLS flags, policies, grants to chartwarden_app and triggers per M36 table: what a lossy restore would silently drop. */
export async function catalogFingerprint(adminUrl: string): Promise<Record<string, string>> {
  return withClient(adminUrl, async (c) => {
    const out: Record<string, string> = {};
    for (const table of M36_TABLES) {
      const flags = (
        await c.query(
          `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass`,
          [`public."${table}"`],
        )
      ).rows[0];
      const policies = (
        await c.query(
          `SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE tablename=$1 ORDER BY 1`,
          [table],
        )
      ).rows;
      const grants = (
        await c.query(
          `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='chartwarden_app' ORDER BY 1`,
          [table],
        )
      ).rows.map((r) => r.privilege_type);
      const triggers = (
        await c.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY 1`,
          [`public."${table}"`],
        )
      ).rows.map((r) => r.tgname);
      out[table] = createHash("sha256")
        .update(JSON.stringify({ flags, policies, grants, triggers }))
        .digest("hex");
    }
    return out;
  });
}

export interface AuditFingerprint {
  readonly eventCount: number;
  readonly chainHash: string;
}

/** Per-org audit_event count plus the M4 hash chain over every month (the same digest the monthly seal uses). */
export async function auditFingerprints(
  appUrl: string,
  adminUrl: string,
  orgIds: readonly string[],
): Promise<Record<string, AuditFingerprint>> {
  const handle = createDbClient({ connectionString: appUrl });
  try {
    const reader = createDbAuditChainReader(handle.db);
    const out: Record<string, AuditFingerprint> = {};
    for (const orgId of orgIds) {
      let prev: string | null = null;
      let chainHash = "none";
      for (const month of await reader.listClosedMonths(orgId, FAR_FUTURE)) {
        const digest = await reader.digestMonth(orgId, month, prev);
        if (digest) {
          prev = digest.chainHash;
          chainHash = digest.chainHash;
        }
      }
      const eventCount = await withClient(
        adminUrl,
        async (c) =>
          (
            await c.query(`SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1`, [
              orgId,
            ])
          ).rows[0].n as number,
      );
      out[orgId] = { eventCount, chainHash };
    }
    return out;
  } finally {
    await handle.close();
  }
}

/** Ids (as text) returned by `sql`, whose first column is aliased `id`. */
async function ids(c: Client, sql: string): Promise<string[]> {
  return (await c.query(sql)).rows.map((r) => String(r.id));
}

const unaudited = (table: string): string =>
  `SELECT t.id FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM audit_event e WHERE e.event_type='${table}.insert' AND e.resource_id=t.id)`;

/**
 * Intrinsic reconcile (superuser read, so RLS does not hide anything): the M36 tables carry a generic `<table>.insert`
 * audit trigger, so every row must have its insert event, every such event must point at a row, and an attachment must
 * belong to an existing message of the same org (an upload not yet attached to a message has message_id NULL by design). Soft-deleted rows stay in the tables, so none of this expects removals.
 */
export async function reconcileFindings(adminUrl: string): Promise<ReconcileFindings> {
  return withClient(adminUrl, async (c) => ({
    messagesWithoutAudit: await ids(c, unaudited("message")),
    revisionsWithoutAudit: await ids(c, unaudited("message_revision")),
    attachmentsWithoutAudit: await ids(c, unaudited("message_attachment")),
    attachmentsWithoutMessage: await ids(
      c,
      `SELECT a.id FROM message_attachment a LEFT JOIN message m ON m.id=a.message_id WHERE a.message_id IS NOT NULL AND m.id IS NULL`,
    ),
    attachmentsCrossOrg: await ids(
      c,
      `SELECT a.id FROM message_attachment a JOIN message m ON m.id=a.message_id WHERE m.organization_id <> a.organization_id`,
    ),
    // ponytail: assumes M36 never hard-deletes message / message_revision / message_attachment rows. WP 5.6 destruction
    // (feat/m36-wp56-retention-finish) does, so a restore taken AFTER a destruction run reports those audit rows as orphans
    // BY DESIGN. Upgrade path once 5.6 merges: exempt ids named in an m36.retention_destruction.batch_completed audit record.
    orphanAudit: await ids(
      c,
      `SELECT e.resource_id AS id FROM audit_event e WHERE e.event_type IN ('message.insert','message_revision.insert','message_attachment.insert')
         AND NOT EXISTS (SELECT 1 FROM message t WHERE e.event_type='message.insert' AND t.id=e.resource_id)
         AND NOT EXISTS (SELECT 1 FROM message_revision t WHERE e.event_type='message_revision.insert' AND t.id=e.resource_id)
         AND NOT EXISTS (SELECT 1 FROM message_attachment t WHERE e.event_type='message_attachment.insert' AND t.id=e.resource_id)`,
    ),
  }));
}

export async function attachmentRows(adminUrl: string): Promise<AttachmentExpectation[]> {
  return withClient(adminUrl, async (c) => {
    const rows = (
      await c.query(
        `SELECT id, organization_id, object_key, byte_size, sha256_hex, completed_at, object_destroyed_at
           FROM message_attachment WHERE object_key IS NOT NULL ORDER BY id`,
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id as string,
      bucket: deriveTenantBucket(r.organization_id as never),
      objectKey: r.object_key as string,
      byteSize: r.byte_size as number,
      sha256Hex: r.sha256_hex as string,
      completed: r.completed_at !== null,
      destroyed: r.object_destroyed_at !== null,
    }));
  });
}

/** GET the object through a signed URL: size, sha256 of the BYTES (not the stored checksum header) and the etag. Null on 404. */
export async function fingerprintObject(
  store: ObjectStorePort,
  orgIdOfBucket: (bucket: string) => string,
  bucket: string,
  objectKey: string,
): Promise<ObjectFingerprint | null> {
  const signed = await store.presign({
    descriptor: { bucket, objectKey, ttlSeconds: 60, accessKind: "signed_url_issued" as const },
    organizationId: orgIdOfBucket(bucket) as never,
  });
  const res = await fetch(signed.url, { redirect: "error" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${bucket}/${objectKey} -> HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    etag: res.headers.get("etag"),
  };
}

export async function fingerprintAll(
  store: ObjectStorePort,
  rows: readonly AttachmentExpectation[],
  orgIds: readonly string[],
): Promise<Map<string, ObjectFingerprint>> {
  const byBucket = new Map(orgIds.map((o) => [deriveTenantBucket(o as never) as string, o]));
  const out = new Map<string, ObjectFingerprint>();
  for (const row of rows) {
    const got = await fingerprintObject(
      store,
      (b) => byBucket.get(b) as string,
      row.bucket,
      row.objectKey,
    );
    if (got) out.set(objectId(row.bucket, row.objectKey), got);
  }
  return out;
}

/** Message + revision body hash verification over the restored database, reusing the production job body. */
export async function hashVerifyAll(
  appUrl: string,
  kek: Buffer,
  orgIds: readonly string[],
  expectedRows: number,
): Promise<Check> {
  const handle = createDbClient({ connectionString: appUrl });
  try {
    let scanned = 0;
    let mismatched = 0;
    for (const orgId of orgIds) {
      const result = await runHashVerifyForOrg(
        {
          db: handle.db,
          cipher: createMessageBodyCipher({ kek }),
          // hash_verify only; the retention scan (and so the hold port) is not exercised here
          messageHolds: {
            activeHolds: async () => [],
            openCertificate: async () => ({ id: "", created: false }),
          },
          sampleLimit: FULL_COVERAGE,
          randomSampleSize: FULL_COVERAGE,
        },
        orgId,
      );
      scanned += result.scanned;
      mismatched += result.mismatched;
    }
    return {
      name: "message and message_revision body hashes verify (runHashVerifyForOrg, full coverage)",
      ok: mismatched === 0 && scanned >= expectedRows,
      detail: `${scanned} rows hashed (expected >= ${expectedRows}), ${mismatched} mismatched`,
    };
  } finally {
    await handle.close();
  }
}

/** As chartwarden_app on the restored DB: not superuser/bypassrls, no GUC => nothing, org A cannot see org B. */
export async function rlsChecks(appUrl: string, orgA: string, orgB: string): Promise<Check[]> {
  return withClient(appUrl, async (c) => {
    const role = (
      await c.query(
        `SELECT current_user AS u, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
      )
    ).rows[0];
    const asOrg = async (org: string | null, sql: string): Promise<number> => {
      await c.query("BEGIN");
      try {
        if (org) await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        return (await c.query(sql)).rows[0].n as number;
      } finally {
        await c.query("ROLLBACK");
      }
    };
    const msgs = "SELECT count(*)::int AS n FROM message";
    const noContext = await asOrg(null, msgs);
    const ownA = await asOrg(orgA, `${msgs} WHERE organization_id='${orgA}'`);
    const aSeesB = await asOrg(orgA, `${msgs} WHERE organization_id='${orgB}'`);
    const aSeesBAttach = await asOrg(
      orgA,
      `SELECT count(*)::int AS n FROM message_attachment WHERE organization_id='${orgB}'`,
    );
    const aSeesBChannels = await asOrg(
      orgA,
      `SELECT count(*)::int AS n FROM channel WHERE organization_id='${orgB}'`,
    );
    const aSeesBAudit = await asOrg(
      orgA,
      `SELECT count(*)::int AS n FROM audit_event WHERE organization_id='${orgB}'`,
    );
    const roleOk = role.u === "chartwarden_app" && !role.rolsuper && !role.rolbypassrls;
    return [
      {
        name: "restored DB: chartwarden_app logs in, is NOT superuser/BYPASSRLS",
        ok: roleOk,
        detail: `${role.u} super=${role.rolsuper} bypassrls=${role.rolbypassrls}`,
      },
      {
        name: "RLS holds after restore: no tenant context reads nothing; own tenant reads rows; cross-tenant reads nothing",
        ok:
          noContext === 0 &&
          ownA > 0 &&
          aSeesB === 0 &&
          aSeesBAttach === 0 &&
          aSeesBChannels === 0 &&
          aSeesBAudit === 0,
        detail: `no-context=${noContext}, A->A=${ownA}, A->B message=${aSeesB} attachment=${aSeesBAttach} channel=${aSeesBChannels} audit=${aSeesBAudit}`,
      },
    ];
  });
}

export function compareMaps(
  name: string,
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): Check {
  const diffs = Object.keys(expected).filter(
    (k) => JSON.stringify(expected[k]) !== JSON.stringify(actual[k]),
  );
  return {
    name,
    ok: diffs.length === 0,
    detail:
      diffs.length === 0
        ? `${Object.keys(expected).length} entries identical`
        : `differs: ${diffs.join(", ")}`,
  };
}
