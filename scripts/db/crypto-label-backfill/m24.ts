// M24 state trading-partner credential: the three `*_cipher` text columns share one HKDF-label DEK (no AAD). A row is
// re-sealed whole: every column that is legacy is re-sealed, the others are left as they are, and one UPDATE compares-and-swaps
// all of the old values.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import {
  deriveOrgCredentialDek,
  deriveOrgCredentialDekForGeneration,
  isUsableCipher,
  openCredentialSecret,
  sealCredentialSecret,
} from "../../../apps/backend/src/modules/24-billing-medicaid/credential-crypto";
import { type RowClass, type Scan, type WriteResult, inOrg, rowsOf, tryOpen } from "./core";

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
  const openUnder = (cipher: string, generation: "current" | "legacy") =>
    openCredentialSecret(
      cipher,
      deriveOrgCredentialDekForGeneration(kek, organizationId, generation),
    );
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
      let anyLegacy = false;
      for (const [, cipher] of columns) {
        if ((await tryOpen(() => openUnder(cipher, "current"))) !== undefined) continue;
        if ((await tryOpen(() => openUnder(cipher, "legacy"))) === undefined) return "unreadable";
        anyLegacy = true;
      }
      return anyLegacy ? "legacy" : "current";
    },
    async reseal(row): Promise<WriteResult> {
      try {
        const next: Partial<Record<Column, string>> = {};
        for (const [column, cipher] of usable(row)) {
          if ((await tryOpen(() => openUnder(cipher, "current"))) !== undefined) continue;
          const plaintext = openCredentialSecret(
            cipher,
            deriveOrgCredentialDekForGeneration(kek, organizationId, "legacy"),
          );
          const sealed = sealCredentialSecret(
            plaintext,
            deriveOrgCredentialDek(kek, organizationId),
          );
          if (openUnder(sealed, "current") !== plaintext) return "failed";
          next[column] = sealed;
        }
        const changed = COLUMNS.filter((c) => next[c] !== undefined);
        if (changed.length === 0) return "skipped";
        // One UPDATE; every old value is compared, so a concurrent edit of any of them makes it match nothing.
        const swapped = await inOrg(db, organizationId, async (tx) =>
          rowsOf<{ id: string }>(
            await tx.execute(sql`
              UPDATE state_medicaid_trading_partner_credential
                 SET client_secret_cipher = ${next.client_secret_cipher ?? row.ciphers.client_secret_cipher},
                     sftp_key_cipher = ${next.sftp_key_cipher ?? row.ciphers.sftp_key_cipher},
                     additional_config_cipher = ${next.additional_config_cipher ?? row.ciphers.additional_config_cipher}
               WHERE organization_id = ${organizationId} AND id = ${row.id}::uuid
                 AND client_secret_cipher IS NOT DISTINCT FROM ${row.ciphers.client_secret_cipher}
                 AND sftp_key_cipher IS NOT DISTINCT FROM ${row.ciphers.sftp_key_cipher}
                 AND additional_config_cipher IS NOT DISTINCT FROM ${row.ciphers.additional_config_cipher}
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
