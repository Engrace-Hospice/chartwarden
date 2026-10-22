// M5 sensitive identifiers (`patient_identifier.value_encrypted` AAD label + the SSN blind index HKDF label).
// A row is "current" only when BOTH its envelope and (for an SSN) its blind index are under the new label; a row that is
// half-and-half is legacy and is re-sealed whole. The re-seal uses the cipher's own `seal` / `blindIndex` (WRITE label,
// current DEK), so the stored `value_dek_version` moves to the DEK that sealed it.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type {
  PatientIdentifierCipher,
  SensitiveIdentifierKind,
} from "../../../apps/backend/src/modules/05-patient/identifiers/identifier-cipher";
import { type RowClass, type Scan, type WriteResult, inOrg, rowsOf, tryOpen } from "./core";

interface IdentifierRow {
  readonly id: string;
  readonly kind: SensitiveIdentifierKind;
  readonly valueEncrypted: Buffer;
  readonly valueBlindIndex: Buffer | null;
  readonly valueDekVersion: string | null;
}

export function m5IdentifierScan(
  deps: { readonly db: DbClient; readonly cipher: PatientIdentifierCipher },
  organizationId: string,
): Scan<IdentifierRow> {
  const { db, cipher } = deps;
  const open = (row: IdentifierRow, generation?: "current" | "legacy") =>
    cipher.open(organizationId, row.id, row.kind, row.valueEncrypted, generation);

  /** "current" | "legacy" for the blind index, or undefined when it matches neither token (corrupt). */
  async function indexGeneration(
    row: IdentifierRow,
    plaintext: string,
  ): Promise<"current" | "legacy" | undefined> {
    if (row.kind !== "ssn") return "current"; // state_id has no blind index
    if (!row.valueBlindIndex || !row.valueDekVersion) return undefined;
    for (const generation of ["current", "legacy"] as const) {
      const token = await cipher.blindIndex(
        organizationId,
        plaintext,
        row.valueDekVersion,
        generation,
      );
      if (token.token.equals(row.valueBlindIndex)) return generation;
    }
    return undefined;
  }

  return {
    module: "m5",
    table: "patient_identifier",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(db, organizationId, async (tx) => {
        const result = await tx.execute(sql`
          SELECT id::text AS id, kind::text AS kind, value_encrypted, value_blind_index, value_dek_version
            FROM patient_identifier
           WHERE organization_id = ${organizationId}
             AND kind IN ('ssn', 'state_id')
             AND value_encrypted IS NOT NULL AND octet_length(value_encrypted) > 0
             AND (${after}::uuid IS NULL OR id > ${after}::uuid)
           ORDER BY id
           LIMIT ${limit}`);
        return rowsOf<{
          id: string;
          kind: SensitiveIdentifierKind;
          value_encrypted: Buffer;
          value_blind_index: Buffer | null;
          value_dek_version: string | null;
        }>(result).map((r) => ({
          id: r.id,
          kind: r.kind,
          valueEncrypted: r.value_encrypted,
          valueBlindIndex: r.value_blind_index,
          valueDekVersion: r.value_dek_version,
        }));
      });
    },
    async classify(row): Promise<RowClass> {
      const asCurrent = await tryOpen(() => open(row, "current"));
      const plaintext = asCurrent ?? (await tryOpen(() => open(row, "legacy")));
      if (plaintext === undefined) return "unreadable";
      const index = await tryOpen(() => indexGeneration(row, plaintext));
      if (index === undefined) return "unreadable";
      return asCurrent !== undefined && index === "current" ? "current" : "legacy";
    },
    async reseal(row): Promise<WriteResult> {
      const plaintext = await tryOpen(() => open(row));
      if (plaintext === undefined) return "failed";
      try {
        const sealed = await cipher.seal(organizationId, row.id, row.kind, plaintext);
        // Verify under the NEW label alone before anything is written.
        const reopened = await open({ ...row, valueEncrypted: sealed.ciphertext }, "current");
        if (reopened !== plaintext) return "failed";
        const index =
          row.kind === "ssn"
            ? (await cipher.blindIndex(organizationId, plaintext, sealed.dekVersion, "current"))
                .token
            : null;
        const swapped = await inOrg(db, organizationId, async (tx) =>
          rowsOf<{ id: string }>(
            await tx.execute(sql`
              UPDATE patient_identifier
                 SET value_encrypted = ${sealed.ciphertext}::bytea,
                     value_blind_index = ${index}::bytea,
                     value_dek_version = ${sealed.dekVersion}
               WHERE organization_id = ${organizationId} AND id = ${row.id}::uuid
                 AND value_encrypted = ${row.valueEncrypted}::bytea
              RETURNING id`),
          ),
        );
        return swapped.length === 1 ? "resealed" : "skipped";
      } catch {
        return "failed";
      }
    },
  };
}
