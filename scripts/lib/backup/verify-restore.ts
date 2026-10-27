/**
 * The restored-snapshot verifier (#857): implements the DR/BCP §8.2 step-5 "restored-schema RLS smoke" plus the
 * migrations, schema, object/row and audit-chain checks. Read-only against an ISOLATED restore made by
 * deploy/production/backup/restore.sh (or the drill); never point it at a live database.
 *
 * Every check returns a {@link Check}; nothing here prints row data, object keys or credentials.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  type StoredSeal,
  compareSealToRecomputed,
  createDbAuditChainReader,
  monthForPartitionName,
  verifySealLinkage,
} from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import type { Client } from "pg";
import {
  createS3ObjectStore,
  deriveTenantBucket,
} from "../../../apps/backend/src/modules/22-documents";
import type { Check } from "../restore-drill/report";
import { fingerprintObject, withClient } from "../restore-drill/verify";
import {
  type LiveRef,
  type ManifestEntry,
  OBJECT_REF_COLUMN_PATTERN,
  OBJECT_REF_SOURCES,
  type RefFinding,
  indexManifest,
  locate,
  objectRefCheck,
  reconcileRef,
  unclassifiedRefColumns,
} from "./object-refs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FINGERPRINT_SQL = join(REPO_ROOT, "deploy", "production", "backup", "schema-fingerprint.sql");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "db", "migrations");
const LEDGER_TABLE = "_chartwarden_migration";

/** The fields of a snapshot marker (cw-backup.sh) the verifier relies on. */
export interface SnapshotMarker {
  readonly snapshotId: string;
  readonly db: {
    readonly lsn: string;
    readonly schemaFingerprint: string;
    readonly migrations: { readonly count: number; readonly last: string };
  };
  readonly objects: { readonly count: number };
}

export interface RestoreTarget {
  readonly adminUrl: string;
  readonly appUrl: string;
  readonly minioEndpoint: string;
  readonly minioAccessKey: string;
  readonly minioSecretKey: string;
  readonly marker: SnapshotMarker;
  readonly manifest: readonly ManifestEntry[];
}

export interface VerifyResult {
  readonly checks: readonly Check[];
  /** Per-org audit chain digest over every month (the drill compares it with the source). */
  readonly auditChains: Readonly<Record<string, string>>;
}

export function readManifestGz(bytes: Buffer): ManifestEntry[] {
  return gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ManifestEntry);
}

async function promotedAtLsn(c: Client, marker: SnapshotMarker): Promise<Check> {
  const r = (
    await c.query(
      "SELECT pg_is_in_recovery() AS rec, pg_current_wal_lsn() >= $1::pg_lsn AS past, current_setting('archive_mode') AS archive",
      [marker.db.lsn],
    )
  ).rows[0];
  return {
    name: "restored cluster replayed WAL to the snapshot LSN, promoted, and does not archive",
    ok: r.rec === false && r.past === true && r.archive === "off",
    detail: `in_recovery=${r.rec} wal>=${marker.db.lsn}:${r.past} archive_mode=${r.archive}`,
  };
}

async function migrationsLedger(c: Client, marker: SnapshotMarker): Promise<Check[]> {
  const rows = (await c.query(`SELECT filename, checksum FROM ${LEDGER_TABLE}`)).rows as Array<{
    filename: string;
    checksum: string;
  }>;
  const last =
    rows
      .map((r) => r.filename)
      .sort()
      .at(-1) ?? "";
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const fileSet = new Set(files);
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
  const pending = files.filter((f) => !applied.has(f));
  const unknown = rows.filter((r) => !fileSet.has(r.filename)).map((r) => r.filename);
  const drifted = rows
    .filter((r) => fileSet.has(r.filename))
    .filter(
      (r) =>
        createHash("sha256")
          .update(readFileSync(join(MIGRATIONS_DIR, r.filename), "utf8"))
          .digest("hex") !== r.checksum,
    )
    .map((r) => r.filename);
  return [
    {
      name: "migrations ledger equals the snapshot's (count and last applied file)",
      ok: rows.length === marker.db.migrations.count && last === marker.db.migrations.last,
      detail: `restored ${rows.length} / last ${last}; snapshot ${marker.db.migrations.count} / last ${marker.db.migrations.last}`,
    },
    {
      // A restore of an older snapshot onto a newer release legitimately has pending files (run migrate next);
      // an applied file that this release does not know, or whose bytes changed, is never legitimate.
      name: "migrations ledger is consistent with this release (no unknown or drifted file)",
      ok: unknown.length === 0 && drifted.length === 0,
      detail: `${pending.length} pending (apply with migrate), ${unknown.length} unknown, ${drifted.length} drifted`,
    },
  ];
}

async function schemaFingerprint(c: Client, marker: SnapshotMarker): Promise<Check> {
  const got = (await c.query(readFileSync(FINGERPRINT_SQL, "utf8"))).rows[0]
    .schema_fingerprint as string;
  return {
    name: "schema fingerprint (columns, constraints, indexes, RLS flags, policies, grants, triggers) equals the snapshot's",
    ok: got === marker.db.schemaFingerprint,
    detail:
      got === marker.db.schemaFingerprint
        ? got
        : `restored ${got} != snapshot ${marker.db.schemaFingerprint}`,
  };
}

/** Tenant tables: RLS enabled and an organization_id column. */
async function tenantTables(c: Client): Promise<string[]> {
  return (
    await c.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relrowsecurity
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
        ORDER BY 1`,
    )
  ).rows.map((r) => r.relname as string);
}

/** Two orgs with the most audit events: the cross-tenant probe pair. */
async function probeOrgs(c: Client): Promise<string[]> {
  return (
    await c.query(
      `SELECT organization_id AS id FROM audit_event WHERE organization_id IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 2`,
    )
  ).rows.map((r) => String(r.id));
}

interface RlsCounts {
  readonly visible: number;
  readonly denied: number;
}

/** count(*) of `where` per table in one transaction with app.org_id = org (or none); an error counts as denied. */
async function countAs(
  app: Client,
  tables: readonly string[],
  org: string | null,
  where: string,
): Promise<{ perTable: Map<string, number>; denied: number }> {
  const perTable = new Map<string, number>();
  let denied = 0;
  await app.query("BEGIN READ ONLY");
  try {
    if (org) await app.query("SELECT set_config('app.org_id', $1, true)", [org]);
    for (const t of tables) {
      await app.query("SAVEPOINT probe");
      try {
        const n = (
          await app.query(`SELECT count(*)::int AS n FROM "${t}" WHERE ${where}`, org ? [org] : [])
        ).rows[0].n as number;
        perTable.set(t, n);
        await app.query("RELEASE SAVEPOINT probe");
      } catch {
        denied += 1;
        await app.query("ROLLBACK TO SAVEPOINT probe");
      }
    }
  } finally {
    await app.query("ROLLBACK");
  }
  return { perTable, denied };
}

const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
const leaks = (m: Map<string, number>): string[] =>
  [...m].filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`);

/** DR/BCP §8.2 step 5: as the real NOBYPASSRLS login, over EVERY tenant table, not a sample. */
export async function rlsSmoke(adminUrl: string, appUrl: string): Promise<Check[]> {
  const { tables, orgs } = await withClient(adminUrl, async (c) => ({
    tables: await tenantTables(c),
    orgs: await probeOrgs(c),
  }));
  return withClient(appUrl, async (app) => {
    const role = (
      await app.query(
        "SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      )
    ).rows[0];
    const roleCheck: Check = {
      name: "restored DB: chartwarden_app logs in and is NOT superuser / BYPASSRLS",
      ok: role.u === "chartwarden_app" && role.rolsuper === false && role.rolbypassrls === false,
      detail: `${role.u} super=${role.rolsuper} bypassrls=${role.rolbypassrls}`,
    };
    if (orgs.length < 2) {
      return [
        roleCheck,
        {
          name: "cross-tenant RLS smoke",
          ok: false,
          detail: `needs 2 tenants with data, found ${orgs.length}`,
        },
      ];
    }
    const [a, b] = orgs as [string, string];
    const none = await countAs(app, tables, null, "organization_id IS NOT NULL");
    const own = await countAs(app, tables, a, "organization_id = $1::uuid");
    const cross = await countAs(
      app,
      tables,
      a,
      "organization_id IS DISTINCT FROM $1::uuid AND organization_id IS NOT NULL",
    );
    // Same probe from the other side, so a policy that only leaks one way is caught too.
    const crossBack = await countAs(
      app,
      tables,
      b,
      "organization_id IS DISTINCT FROM $1::uuid AND organization_id IS NOT NULL",
    );
    const leaked = [
      ...leaks(none.perTable).map((x) => `no-context ${x}`),
      ...leaks(cross.perTable),
      ...leaks(crossBack.perTable),
    ];
    return [
      roleCheck,
      {
        name: "RLS smoke over every tenant table: no tenant context reads no tenant row; tenant A reads its own rows and none of any other tenant (and B likewise)",
        ok: leaked.length === 0 && sum(own.perTable) > 0,
        detail:
          leaked.length === 0
            ? `${tables.length} tables; own rows visible to A: ${sum(own.perTable)}; other-tenant rows visible: 0 (A) / 0 (B); no-context rows: 0; probes refused by grants/policies: ${none.denied + cross.denied + crossBack.denied}`
            : `LEAK: ${leaked.slice(0, 10).join(", ")}${leaked.length > 10 ? ` (+${leaked.length - 10})` : ""}`,
      },
    ];
  });
}

async function liveRefs(c: Client): Promise<{ refs: LiveRef[]; discovered: string[] }> {
  const discovered = (
    await c.query(
      `SELECT c.relname || '.' || a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition AND a.attnum > 0
          AND NOT a.attisdropped AND a.attname ~ $1`,
      [OBJECT_REF_COLUMN_PATTERN],
    )
  ).rows.map((r) => r.col as string);
  const refs: LiveRef[] = [];
  for (const s of OBJECT_REF_SOURCES) {
    const sha = s.shaColumn ? `t."${s.shaColumn}"` : "NULL";
    const rows = (
      await c.query(
        `SELECT t.organization_id::text AS org, t."${s.keyColumn}" AS key, ${sha} AS sha
           FROM "${s.table}" t WHERE t."${s.keyColumn}" IS NOT NULL AND (${s.liveWhere})`,
      )
    ).rows;
    for (const r of rows) {
      refs.push({
        table: s.table,
        organizationId: r.org as string,
        key: r.key as string,
        sha256: (r.sha as string | null)?.trim() ?? null,
      });
    }
  }
  return { refs, discovered };
}

/** Object/row reconciliation + document retrieval through the app's own S3 adapter (presigned GET). */
export async function objectReconciliation(t: RestoreTarget): Promise<Check[]> {
  const { refs, discovered } = await withClient(t.adminUrl, liveRefs);
  const unclassified = unclassifiedRefColumns(discovered);
  const store = createS3ObjectStore({
    endpoint: t.minioEndpoint,
    accessKeyId: t.minioAccessKey,
    secretAccessKey: t.minioSecretKey,
  });
  const byKey = indexManifest(t.manifest);
  const findings: RefFinding[] = [];
  const perTable: Record<string, number> = {};
  for (const ref of refs) {
    perTable[ref.table] = (perTable[ref.table] ?? 0) + 1;
    const located = locate(byKey, ref, deriveTenantBucket(ref.organizationId as never));
    const got = located
      ? await fingerprintObject(store, () => ref.organizationId, located.bucket, ref.key)
      : null;
    const finding = reconcileRef(ref, located, got ? { sha256: got.sha256 } : null);
    if (finding) findings.push(finding);
  }
  const referenced = new Set(refs.map((r) => r.key));
  const unreferenced = t.manifest.filter((m) => !referenced.has(m.k)).length;
  return [
    {
      name: "every column that looks like an object reference is classified (registered for reconciliation or excluded with a reason)",
      ok: unclassified.length === 0,
      detail:
        unclassified.length === 0
          ? `${discovered.length} column(s) classified`
          : `unclassified: ${unclassified.join(", ")}`,
    },
    objectRefCheck(refs.length, findings, perTable),
    {
      name: "snapshot objects not referenced by a live row (informational: pending uploads, quarantined or platform objects)",
      ok: true,
      detail: `${unreferenced} of ${t.manifest.length}`,
    },
  ];
}

/** Stored seals link up and every sealed month recomputes to its seal; returns each org's full-chain digest too. */
export async function auditIntegrity(
  adminUrl: string,
  appUrl: string,
): Promise<{ check: Check; chains: Record<string, string> }> {
  const { orgs, seals } = await withClient(adminUrl, async (c) => ({
    orgs: (
      await c.query(
        "SELECT DISTINCT organization_id::text AS id FROM audit_event WHERE organization_id IS NOT NULL ORDER BY 1",
      )
    ).rows.map((r) => r.id as string),
    seals: (
      await c.query(
        `SELECT organization_id::text AS org, partition, prev_chain_hash, chain_hash, event_count, from_id::text, to_id::text
           FROM audit_seal WHERE organization_id IS NOT NULL ORDER BY organization_id, partition`,
      )
    ).rows,
  }));
  const handle = createDbClient({ connectionString: appUrl });
  try {
    const reader = createDbAuditChainReader(handle.db);
    const breaks: string[] = [];
    let sealed = 0;
    for (const org of new Set(seals.map((s) => s.org as string))) {
      const stored: StoredSeal[] = seals
        .filter((s) => s.org === org)
        .map((s) => ({
          partition: s.partition,
          prevChainHash: s.prev_chain_hash,
          chainHash: s.chain_hash,
          eventCount: s.event_count,
          fromId: s.from_id,
          toId: s.to_id,
        }));
      breaks.push(...verifySealLinkage(stored).map((b) => `${b.partition}:${b.reason}`));
      for (const seal of stored) {
        sealed += 1;
        const recomputed = await reader.digestMonth(
          org,
          monthForPartitionName(seal.partition),
          seal.prevChainHash,
        );
        const reason = recomputed
          ? compareSealToRecomputed(seal, recomputed)
          : "event_count_mismatch";
        if (reason) breaks.push(`${seal.partition}:${reason}`);
      }
    }
    const chains: Record<string, string> = {};
    for (const org of orgs) {
      let prev: string | null = null;
      for (const month of await reader.listClosedMonths(org, new Date("2100-01-01T00:00:00Z"))) {
        const d = await reader.digestMonth(org, month, prev);
        if (d) prev = d.chainHash;
      }
      chains[org] = prev ?? "none";
    }
    return {
      check: {
        name: "M4 audit hash chain: stored seals link up and every sealed month recomputes to its seal",
        ok: breaks.length === 0,
        detail:
          breaks.length === 0
            ? `${orgs.length} org(s), ${sealed} sealed month(s) recomputed, full chain digested per org`
            : `breaks: ${breaks.join(", ")}`,
      },
      chains,
    };
  } finally {
    await handle.close();
  }
}

export async function verifyRestore(t: RestoreTarget): Promise<VerifyResult> {
  const checks: Check[] = [];
  await withClient(t.adminUrl, async (c) => {
    checks.push(await promotedAtLsn(c, t.marker));
    checks.push(...(await migrationsLedger(c, t.marker)));
    checks.push(await schemaFingerprint(c, t.marker));
  });
  checks.push(...(await rlsSmoke(t.adminUrl, t.appUrl)));
  checks.push(...(await objectReconciliation(t)));
  const audit = await auditIntegrity(t.adminUrl, t.appUrl);
  checks.push(audit.check);
  return { checks, auditChains: audit.chains };
}
