// M5 sensitive identifiers (`patient_identifier.value_encrypted` AAD label + the SSN blind index HKDF label).
// A row is "current" only when BOTH its envelope opens and (for an SSN) its stored blind index equals the one recomputed from
// the plaintext; a mismatch (e.g. an index still under the removed legacy label) cannot be found by lookup, so it is reported.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type {
  PatientIdentifierCipher,
  SensitiveIdentifierKind,
} from "../../../apps/backend/src/modules/05-patient/identifiers/identifier-cipher";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

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
  const open = (row: IdentifierRow) =>
    cipher.open(organizationId, row.id, row.kind, row.valueEncrypted);

  async function indexMatches(row: IdentifierRow, plaintext: string): Promise<boolean> {
    if (row.kind !== "ssn") return true; // state_id has no blind index
    if (!row.valueBlindIndex || !row.valueDekVersion) return false;
    const token = await cipher.blindIndex(organizationId, plaintext, row.valueDekVersion);
    return token.token.equals(row.valueBlindIndex);
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
      const plaintext = await tryOpen(() => open(row));
      if (plaintext === undefined) return "unreadable";
      return (await tryOpen(() => indexMatches(row, plaintext))) === true
        ? "current"
        : "unreadable";
    },
  };
}
