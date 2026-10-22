// M36 sealed message bodies: `message.body_cipher` (v1 HKDF-DEK label, or v2 ring AAD label). READ-ONLY.
//
// Only `message` is checked here. The other four tables that hold a value sealed by the same cipher (message_revision,
// message_poll_option, message_draft, scheduled_message) are append-only / owner-isolated for the app role and were reachable only
// through the audited functions of migration 1150, which the release-3 migration drops; their rows share the key, the label and the
// code path with `message`, and the gate for them was the release-2 `crypto-labels:verify` run.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import {
  type RingBodyDek,
  bodyEnvelopeScheme,
  deriveOrgDek,
  messageBodySha256,
  openMessageBody,
  openMessageBodyRing,
  ringEnvelopeVersion,
} from "@chartwarden/messaging";
import { sql } from "drizzle-orm";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

export interface M36BodyKit {
  /** MESSAGING_ENCRYPTION_KEY, for v1 bodies. Absent = v1 rows probe as unreadable (loudly). */
  readonly kek: Buffer | undefined;
  /** The M34 ring's DEK of a given version (v2 bodies). */
  readonly ringDek: (organizationId: string, version: string) => Promise<RingBodyDek>;
}

async function openBody(kit: M36BodyKit, organizationId: string, cipher: Buffer): Promise<string> {
  const scheme = bodyEnvelopeScheme(cipher);
  if (scheme === "legacy") {
    if (!kit.kek) throw new Error("no messaging KEK");
    return openMessageBody(cipher, deriveOrgDek(kit.kek, organizationId));
  }
  if (scheme === "ring") {
    const dek = await kit.ringDek(organizationId, ringEnvelopeVersion(cipher));
    return openMessageBodyRing(cipher, dek.key, organizationId);
  }
  throw new Error("not a sealed body");
}

interface BodyRow {
  readonly id: string;
  readonly cipher: Buffer;
  readonly sha256: string;
}

export function m36BodyScan(
  deps: { readonly db: DbClient; readonly kit: M36BodyKit },
  organizationId: string,
): Scan<BodyRow> {
  const { db, kit } = deps;
  return {
    module: "m36-body",
    table: "message",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(db, organizationId, async (tx) =>
        rowsOf<{ id: string; body_cipher: Buffer; body_sha256: string }>(
          await tx.execute(sql`
            SELECT id::text AS id, body_cipher, body_sha256 FROM message
             WHERE organization_id = ${organizationId} AND octet_length(body_cipher) > 0
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id LIMIT ${limit}`),
        ).map((r) => ({ id: r.id, cipher: r.body_cipher, sha256: r.body_sha256 })),
      );
    },
    async classify(row): Promise<RowClass> {
      if (bodyEnvelopeScheme(row.cipher) === "erased") return "ignore";
      const plaintext = await tryOpen(() => openBody(kit, organizationId, row.cipher));
      // A stored digest that does not match the decrypted body is evidence of tampering, not a healthy row.
      return plaintext !== undefined && messageBodySha256(plaintext) === row.sha256
        ? "current"
        : "unreadable";
    },
  };
}
