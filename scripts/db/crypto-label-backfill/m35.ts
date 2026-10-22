// M35 pseudonym HMAC key material (`patient_pseudonym_key.key_material_ciphertext`): platform-wide, no organization_id. Every
// epoch (active and retired) is checked, under the KEK that sealed it (`key_kms_ref`).
import type { DbClient } from "@chartwarden/db";
import { type PseudonymKekRing, openPseudonymKeyMaterial } from "@chartwarden/subscription-billing";
import { sql } from "drizzle-orm";
import { type RowClass, type Scan, rowsOf, tryOpen } from "./core";

interface PseudonymKeyRow {
  readonly id: string;
  readonly keyEpoch: string;
  readonly ciphertext: string;
  readonly kekId: string;
}

export function m35PseudonymKeyScan(deps: {
  readonly platformDb: DbClient;
  readonly ring: PseudonymKekRing;
}): Scan<PseudonymKeyRow> {
  const { platformDb, ring } = deps;
  const open = (row: PseudonymKeyRow) =>
    openPseudonymKeyMaterial(ring, row.kekId, row.keyEpoch, row.ciphertext);

  return {
    module: "m35",
    table: "patient_pseudonym_key",
    organizationId: null,
    idOf: (row) => row.id,
    async page(after, limit) {
      return rowsOf<{
        id: string;
        key_epoch: string;
        key_material_ciphertext: string;
        key_kms_ref: string;
      }>(
        await platformDb.execute(sql`
          SELECT id::text AS id, key_epoch, key_material_ciphertext, key_kms_ref
            FROM patient_pseudonym_key
           WHERE (${after}::uuid IS NULL OR id > ${after}::uuid)
           ORDER BY id
           LIMIT ${limit}`),
      ).map((r) => ({
        id: r.id,
        keyEpoch: r.key_epoch,
        ciphertext: r.key_material_ciphertext,
        kekId: r.key_kms_ref,
      }));
    },
    async classify(row): Promise<RowClass> {
      const key = await tryOpen(() => open(row));
      if (!key) return "unreadable";
      key.fill(0);
      return "current";
    },
  };
}
