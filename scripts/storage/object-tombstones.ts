#!/usr/bin/env bun
/**
 * CW-DS-01 — export the object destruction tombstones (every object a certificate destroyed) as NDJSON, for the tools that
 * must not bring a destroyed object back: `scripts/object-store-copy.ts --tombstones <file>` on the forward copy AND on a
 * restore, and the DR/BCP §6.3 step 5 replay after a hand load from the off-site mirror.
 *
 *   DATABASE_ADMIN_URL   a connection that reads every organization's rows (a superuser or BYPASSRLS role, the operator's, as for
 *                        scripts/backfill-tenant-buckets.ts). There is NO fallback to DATABASE_URL: the application role sees no
 *                        row at all without an organization context, and an empty export would read as "nothing destroyed". The
 *                        script refuses a connection that is subject to row security. READ-ONLY: it runs a few SELECTs.
 *   bun run scripts/storage/object-tombstones.ts > tombstones.ndjson.tmp && mv tombstones.ndjson.tmp tombstones.ndjson
 *
 * Only a FINISHED erase is exported: a tombstone whose object key a document version still records (the erase was cut short, or a
 * hold was placed after it failed and the document is kept) is counted as `pending` on stderr and left out, so a held document's
 * copy is never destroyed on the strength of it. The file ends with a trailer line holding the record count and a SHA-256 over the
 * records; the loaders refuse a file without a matching count (and one whose checksum is wrong). An export refuses, naming the record
 * and never the key, a key whose form the loaders would refuse (not a form the document store writes), so it never writes a list that
 * cannot be applied. Keys carry the patient's opaque id (D11): keep the file with the operator, not in a ticket or a chat.
 */
import { type DbClient, createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { type TombstoneRecord, exportText } from "../lib/object-tombstones";

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] }).rows ??
    (result as Record<string, unknown>[])) as Record<string, unknown>[];

export interface TombstoneExport {
  /** The NDJSON file: one line per destroyed object, then the trailer. */
  readonly text: string;
  readonly exported: number;
  /** Tombstones whose erase has not finished (a document version still records the key): not exported. */
  readonly pending: number;
}

/** Every finished tombstone, oldest first. Throws on a connection that cannot see every organization's rows. */
export async function exportTombstones(db: DbClient): Promise<TombstoneExport> {
  const role = rowsOf(
    await db.execute(
      sql`SELECT (rolsuper OR rolbypassrls) AS reads_all FROM pg_roles WHERE rolname = current_user`,
    ),
  )[0];
  if (role?.reads_all !== true)
    throw new Error(
      "the connection is subject to row security and would read no tombstones: use the operator's superuser or BYPASSRLS connection (DATABASE_ADMIN_URL)",
    );
  const finished = rowsOf(
    await db.execute(sql`
      SELECT t.bucket AS bucket, t.object_key AS object_key
        FROM object_destruction_tombstone t
       WHERE NOT EXISTS (
         SELECT 1 FROM document_version v
          WHERE v.organization_id = t.organization_id AND v.object_key = t.object_key)
       ORDER BY t.destroyed_at, t.id`),
  );
  const pending = rowsOf(
    await db.execute(sql`
      SELECT count(*)::int AS n
        FROM object_destruction_tombstone t
       WHERE EXISTS (
         SELECT 1 FROM document_version v
          WHERE v.organization_id = t.organization_id AND v.object_key = t.object_key)`),
  )[0]?.n;
  const records: TombstoneRecord[] = finished.map((r) => ({
    bucket: String(r.bucket),
    objectKey: String(r.object_key),
  }));
  return { text: exportText(records), exported: records.length, pending: Number(pending ?? 0) };
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) {
    console.error(
      "DATABASE_ADMIN_URL must be set (the operator's connection; there is no fallback)",
    );
    process.exit(1);
  }
  const { db, close } = createDbClient({ connectionString });
  try {
    const result = await exportTombstones(db);
    process.stdout.write(result.text);
    process.stderr.write(
      `exported ${result.exported} tombstone(s); ${result.pending} pending (an erase that has not finished: not exported)\n`,
    );
  } finally {
    await close();
  }
}
