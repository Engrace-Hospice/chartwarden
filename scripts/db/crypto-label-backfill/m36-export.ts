// M36 export jobs (`message_export_job.wrapped_dek`, "<kekId>:<base64>"): the artefact data key is wrapped through the same
// platform KEK adapter as the tenant key ring, so it carries the M34 wrap label. This module is COUNT-ONLY, on purpose: the job's
// guard trigger (migration 1147) refuses to change `wrapped_dek` on a ready job, and the key is dropped when the job expires
// (24 h after ready), so a legacy-wrapped key leaves the database by itself. `--verify` counts the ones still waiting (the
// release-3 gate must wait out that 24 h); `--apply` reports them as `skipped` and writes nothing.
import { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { PlatformKekAdapter } from "../../../apps/backend/src/bootstrap/tenant-kek";
import { type RowClass, type Scan, type WriteResult, inOrg, rowsOf, tryOpen } from "./core";

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
  const unwrap = (row: ExportJobRow, onlyGeneration: "current" | "legacy") => {
    const parts = split(row.wrapped);
    if (!parts) throw new Error("malformed");
    return kek.unwrap({
      organizationId,
      kekId: parts.kekId,
      kekWrappedCiphertext: parts.bytes,
      onlyGeneration,
    });
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
      const current = await tryOpen(() => unwrap(row, "current"));
      if (current) {
        current.fill(0);
        return "current";
      }
      const legacy = await tryOpen(() => unwrap(row, "legacy"));
      if (!legacy) return "unreadable";
      legacy.fill(0);
      return "legacy";
    },
    async reseal(): Promise<WriteResult> {
      return "skipped"; // see the file header: the key expires within 24 h and the job guard forbids rewriting it
    },
  };
}
