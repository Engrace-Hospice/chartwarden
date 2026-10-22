// M24 state trading-partner credential: the three `*_cipher` text columns share one HKDF-label DEK (no AAD). A row is "current"
// only when every usable column opens.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import {
  deriveOrgCredentialDek,
  isUsableCipher,
  openCredentialSecret,
} from "../../../apps/backend/src/modules/24-billing-medicaid/credential-crypto";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

const COLUMNS = ["client_secret_cipher", "sftp_key_cipher", "additional_config_cipher"] as const;
type Column = (typeof COLUMNS)[number];

interface CredentialRow {
  readonly id: string;
  readonly ciphers: Readonly<Record<Column, string | null>>;
}

export function m24TradingPartnerScan(
  deps: { readonly db: DbClient; readonly kek: Buffer },
  organizationId: string,
): Scan<CredentialRow> {
  const { db, kek } = deps;
  const dek = deriveOrgCredentialDek(kek, organizationId);
  const usable = (row: CredentialRow): Array<[Column, string]> =>
    COLUMNS.flatMap((c) => {
      const value = row.ciphers[c];
      return isUsableCipher(value) ? [[c, value as string] as [Column, string]] : [];
    });

  return {
    module: "m24",
    table: "state_medicaid_trading_partner_credential",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(db, organizationId, async (tx) =>
        rowsOf<{ id: string } & Record<Column, string | null>>(
          await tx.execute(sql`
            SELECT id::text AS id, client_secret_cipher, sftp_key_cipher, additional_config_cipher
              FROM state_medicaid_trading_partner_credential
             WHERE organization_id = ${organizationId}
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id
             LIMIT ${limit}`),
        ).map((r) => ({
          id: r.id,
          ciphers: {
            client_secret_cipher: r.client_secret_cipher,
            sftp_key_cipher: r.sftp_key_cipher,
            additional_config_cipher: r.additional_config_cipher,
          },
        })),
      );
    },
    async classify(row): Promise<RowClass> {
      const columns = usable(row);
      if (columns.length === 0) return "ignore"; // empty or the pre-crypto "ENC:deferred" placeholder
      for (const [, cipher] of columns) {
        if ((await tryOpen(() => openCredentialSecret(cipher, dek))) === undefined)
          return "unreadable";
      }
      return "current";
    },
  };
}
