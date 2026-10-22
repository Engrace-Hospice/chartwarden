// M34 tenant key ring (`tenant_key_ring`): every tenant's PHI is encrypted under the DEK that this row wraps, so a wrapped entry
// that no longer unwraps is an unreadable tenant. READ-ONLY: each wrapped entry (the current DEK and every `prior_dek_versions`
// entry) must unwrap under the one remaining wrap label. Nothing is written and no plaintext DEK is kept past the check.
import { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { PlatformKekAdapter } from "../../../apps/backend/src/bootstrap/tenant-kek";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

interface PriorEntry {
  readonly version: string;
  readonly kekWrappedCiphertext: string;
  readonly kekId: string;
  readonly [other: string]: unknown;
}

interface RingRow {
  readonly id: string;
  readonly organizationId: string;
  readonly currentCiphertext: Buffer | null;
  readonly currentKekId: string | null;
  readonly priors: readonly PriorEntry[];
}

/** Every wrapped entry of the ring as (wrapped bytes, kek id). */
function entriesOf(row: RingRow): Array<{ wrapped: Buffer; kekId: string }> {
  const entries: Array<{ wrapped: Buffer; kekId: string }> = [];
  if (row.currentCiphertext && row.currentKekId) {
    entries.push({ wrapped: row.currentCiphertext, kekId: row.currentKekId });
  }
  for (const prior of row.priors) {
    entries.push({
      wrapped: Buffer.from(prior.kekWrappedCiphertext, "base64"),
      kekId: prior.kekId,
    });
  }
  return entries;
}

type RingQueryRow = {
  id: string;
  organization_id: string;
  current_dek_kek_wrapped_ciphertext: Buffer | null;
  current_dek_kek_id: string | null;
  prior_dek_versions: PriorEntry[] | null;
};

const toRing = (r: RingQueryRow): RingRow => ({
  id: r.id,
  organizationId: r.organization_id,
  currentCiphertext: r.current_dek_kek_wrapped_ciphertext,
  currentKekId: r.current_dek_kek_id,
  priors: r.prior_dek_versions ?? [],
});

export function m34KeyRingScan(
  deps: { readonly platformDb: DbClient; readonly kek: PlatformKekAdapter },
  organizationId: string,
): Scan<RingRow> {
  const { platformDb, kek } = deps;
  return {
    module: "m34",
    table: "tenant_key_ring",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(platformDb, organizationId, async (tx) =>
        rowsOf<RingQueryRow>(
          await tx.execute(sql`
            SELECT id::text AS id, organization_id::text AS organization_id,
                   current_dek_kek_wrapped_ciphertext, current_dek_kek_id, prior_dek_versions
              FROM tenant_key_ring
             WHERE organization_id = ${organizationId} AND destroyed_at IS NULL
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id
             LIMIT ${limit}`),
        ).map(toRing),
      );
    },
    async classify(row): Promise<RowClass> {
      const entries = entriesOf(row);
      if (entries.length === 0) return "ignore";
      for (const entry of entries) {
        const dek = await tryOpen(() =>
          kek.unwrap({
            organizationId: row.organizationId,
            kekWrappedCiphertext: entry.wrapped,
            kekId: entry.kekId,
          }),
        );
        if (!dek) return "unreadable";
        dek.fill(0);
      }
      return "current";
    },
  };
}
