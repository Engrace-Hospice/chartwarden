// M23 MAC portal credential (`mac_submitter_credential.client_secret_cipher`): HKDF DEK label + AAD label.
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { MacSecretCipher } from "../../../apps/backend/src/modules/23-billing-medicare/routes/secret-cipher";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

interface MacCredentialRow {
  readonly id: string;
  readonly providerEntityId: string;
  readonly macJurisdiction: string;
  readonly cipher: string;
}

export function m23MacCredentialScan(
  deps: { readonly db: DbClient; readonly cipher: MacSecretCipher },
  organizationId: string,
): Scan<MacCredentialRow> {
  const { db, cipher } = deps;
  const context = (row: MacCredentialRow) => ({
    providerEntityId: row.providerEntityId,
    // The DB enum text is the cipher's context value (the write path passes the same enum member).
    macJurisdiction: row.macJurisdiction as never,
  });
  const open = (row: MacCredentialRow) => cipher.decrypt(organizationId, context(row), row.cipher);

  return {
    module: "m23",
    table: "mac_submitter_credential",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(db, organizationId, async (tx) =>
        rowsOf<{
          id: string;
          provider_entity_id: string;
          mac_jurisdiction: string;
          client_secret_cipher: string;
        }>(
          await tx.execute(sql`
            SELECT id::text AS id, provider_entity_id::text AS provider_entity_id,
                   mac_jurisdiction::text AS mac_jurisdiction, client_secret_cipher
              FROM mac_submitter_credential
             WHERE organization_id = ${organizationId}
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id
             LIMIT ${limit}`),
        ).map((r) => ({
          id: r.id,
          providerEntityId: r.provider_entity_id,
          macJurisdiction: r.mac_jurisdiction,
          cipher: r.client_secret_cipher,
        })),
      );
    },
    async classify(row): Promise<RowClass> {
      return (await tryOpen(() => open(row))) !== undefined ? "current" : "unreadable";
    },
  };
}
