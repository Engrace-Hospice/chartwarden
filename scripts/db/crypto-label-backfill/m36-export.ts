// M36 export jobs (`message_export_job.wrapped_dek`, "<kekId>:<base64>"): the artefact data key is wrapped through the same
// platform KEK adapter as the tenant key ring. READ-ONLY: a job's key must unwrap under the one remaining wrap label. The key is
// dropped when the job expires (24 h after ready), so a job still sealed under the removed legacy label simply cannot be served.
import { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { PlatformKekAdapter } from "../../../apps/backend/src/bootstrap/tenant-kek";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

interface ExportJobRow {
  readonly id: string;
  readonly wrapped: string;
}

function split(wrapped: string): { kekId: string; bytes: Buffer } | undefined {
  const at = wrapped.lastIndexOf(":");
  return at < 1
    ? undefined
    : { kekId: wrapped.slice(0, at), bytes: Buffer.from(wrapped.slice(at + 1), "base64") };
}

export function m36ExportJobScan(
  deps: { readonly db: DbClient; readonly kek: PlatformKekAdapter },
  organizationId: string,
): Scan<ExportJobRow> {
  const { db, kek } = deps;
  const unwrap = (row: ExportJobRow) => {
    const parts = split(row.wrapped);
    if (!parts) throw new Error("malformed");
    return kek.unwrap({ organizationId, kekId: parts.kekId, kekWrappedCiphertext: parts.bytes });
  };

  return {
    module: "m36-export",
    table: "message_export_job",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(db, organizationId, async (tx) =>
        rowsOf<{ id: string; wrapped_dek: string }>(
          await tx.execute(sql`
            SELECT id::text AS id, wrapped_dek FROM message_export_job
             WHERE organization_id = ${organizationId} AND wrapped_dek IS NOT NULL
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id LIMIT ${limit}`),
        ).map((r) => ({ id: r.id, wrapped: r.wrapped_dek })),
      );
    },
    async classify(row): Promise<RowClass> {
      const dek = await tryOpen(() => unwrap(row));
      if (!dek) return "unreadable";
      dek.fill(0);
      return "current";
    },
  };
}
