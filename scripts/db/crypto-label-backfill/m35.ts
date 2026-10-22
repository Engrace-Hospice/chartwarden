// M35 pseudonym HMAC key material (`patient_pseudonym_key.key_material_ciphertext`): platform-wide, no organization_id. Every
// epoch (active and retired) is re-sealed, under the SAME KEK that sealed it (`key_kms_ref` is untouched).
import type { DbClient } from "@chartwarden/db";
import {
  type PseudonymKekRing,
  openPseudonymKeyMaterial,
  sealPseudonymKeyMaterial,
} from "@chartwarden/subscription-billing";
import { sql } from "drizzle-orm";
import { type RowClass, type Scan, type WriteResult, rowsOf, tryOpen } from "./core";

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
  const open = (row: PseudonymKeyRow, ciphertext: string, generation?: "current" | "legacy") =>
    openPseudonymKeyMaterial(ring, row.kekId, row.keyEpoch, ciphertext, generation);

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
      const current = await tryOpen(() => open(row, row.ciphertext, "current"));
      if (current) {
        current.fill(0);
        return "current";
      }
      const legacy = await tryOpen(() => open(row, row.ciphertext, "legacy"));
      if (!legacy) return "unreadable";
      legacy.fill(0);
      return "legacy";
    },
    async reseal(row): Promise<WriteResult> {
      const kek = ring.byId.get(row.kekId);
      if (!kek) return "failed";
      let plaintext: Buffer | undefined;
      try {
        plaintext = open(row, row.ciphertext);
        // Seal under the row's OWN KEK, not the ring's active one: a label backfill must not also rotate the KEK.
        const sealed = sealPseudonymKeyMaterial(
          { active: { kekId: row.kekId, key: kek }, byId: ring.byId },
          row.keyEpoch,
          plaintext,
        );
        const reopened = open(row, sealed.ciphertextB64, "current");
        const same = reopened.equals(plaintext);
        reopened.fill(0);
        if (!same) return "failed";
        const swapped = rowsOf<{ id: string }>(
          await platformDb.execute(sql`
            UPDATE patient_pseudonym_key
               SET key_material_ciphertext = ${sealed.ciphertextB64}
             WHERE id = ${row.id}::uuid AND key_material_ciphertext = ${row.ciphertext}
            RETURNING id`),
        );
        return swapped.length === 1 ? "resealed" : "skipped";
      } catch {
        return "failed";
      } finally {
        plaintext?.fill(0);
      }
    },
  };
}
