// M36 sealed message bodies: `message.body_cipher` (v1 HKDF-DEK label, or v2 ring AAD label) and the four other tables that hold
// a value sealed by the same cipher (message_revision, message_poll_option, message_draft, scheduled_message).
//
// The SCHEME is never changed here: a v1 body is re-sealed as v1 under the new HKDF label, a v2 body as v2 under the new AAD label
// and the SAME ring version, so this job does not depend on the legacy->ring migration (m36:body-backfill) and cannot be mistaken
// for it. `message` is rewritten by the app role (as the ring backfill does; a legal-held message is skipped and stays counted);
// the other four tables are append-only / owner-isolated for the app role and go through the two audited SECURITY DEFINER
// functions of migration 1148 on the operator's reseal credential.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import {
  type RingBodyDek,
  bodyEnvelopeScheme,
  deriveOrgDek,
  deriveOrgDekForGeneration,
  deriveOrgReadDeks,
  messageBodySha256,
  openMessageBody,
  openMessageBodyRing,
  ringEnvelopeVersion,
  sealMessageBody,
  sealMessageBodyRing,
} from "@chartwarden/messaging";
import { sql } from "drizzle-orm";
import { isLegalHoldViolation } from "../../../apps/backend/src/modules/36-messaging/governance/under-hold";
import { type RowClass, type Scan, type WriteResult, inOrg, rowsOf, tryOpen } from "./core";

export const M36_VIA_FUNCTION_TABLES = [
  "message_revision",
  "message_poll_option",
  "message_draft",
  "scheduled_message",
] as const;
export type M36ViaFunctionTable = (typeof M36_VIA_FUNCTION_TABLES)[number];
export type M36BodyTable = "message" | M36ViaFunctionTable;

export class MissingResealCredentialError extends Error {
  constructor() {
    super(
      "the message_revision / message_poll_option / message_draft / scheduled_message tables are only reachable with the reseal credential: set DATABASE_BODY_BACKFILL_URL (chartwarden_body_backfill_login)",
    );
    this.name = "MissingResealCredentialError";
  }
}

export interface M36BodyKit {
  /** MESSAGING_ENCRYPTION_KEY, for v1 bodies. Absent = v1 rows probe as unreadable (loudly). */
  readonly kek: Buffer | undefined;
  /** The M34 ring's DEK of a given version (v2 bodies). */
  readonly ringDek: (organizationId: string, version: string) => Promise<RingBodyDek>;
}

type Generation = "current" | "legacy";

async function openBody(
  kit: M36BodyKit,
  organizationId: string,
  cipher: Buffer,
  generation?: Generation,
): Promise<string> {
  const scheme = bodyEnvelopeScheme(cipher);
  if (scheme === "legacy") {
    if (!kit.kek) throw new Error("no messaging KEK");
    return openMessageBody(
      cipher,
      generation
        ? deriveOrgDekForGeneration(kit.kek, organizationId, generation)
        : deriveOrgReadDeks(kit.kek, organizationId),
    );
  }
  if (scheme === "ring") {
    const dek = await kit.ringDek(organizationId, ringEnvelopeVersion(cipher));
    return openMessageBodyRing(cipher, dek.key, organizationId, generation);
  }
  throw new Error("not a sealed body");
}

/** Seal with the same scheme (and ring version) as `like`, under the WRITE label. */
async function sealLike(
  kit: M36BodyKit,
  organizationId: string,
  like: Buffer,
  plaintext: string,
): Promise<Buffer> {
  if (bodyEnvelopeScheme(like) === "legacy") {
    if (!kit.kek) throw new Error("no messaging KEK");
    return sealMessageBody(plaintext, deriveOrgDek(kit.kek, organizationId));
  }
  const dek = await kit.ringDek(organizationId, ringEnvelopeVersion(like));
  return sealMessageBodyRing(plaintext, dek, organizationId);
}

interface BodyRow {
  readonly id: string;
  readonly cipher: Buffer;
  /** Only `message` carries the plaintext digest in the same row. */
  readonly sha256: string | null;
}

export function m36BodyScan(
  deps: {
    readonly db: DbClient;
    readonly resealDb: DbClient | undefined;
    readonly kit: M36BodyKit;
  },
  organizationId: string,
  table: M36BodyTable,
): Scan<BodyRow> {
  const { db, resealDb, kit } = deps;
  if (table !== "message" && !resealDb) throw new MissingResealCredentialError();

  return {
    module: "m36-body",
    table,
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      if (table === "message") {
        return inOrg(db, organizationId, async (tx) =>
          rowsOf<{ id: string; body_cipher: Buffer; body_sha256: string }>(
            await tx.execute(sql`
              SELECT id::text AS id, body_cipher, body_sha256 FROM message
               WHERE organization_id = ${organizationId} AND octet_length(body_cipher) > 0
                 AND (${after}::uuid IS NULL OR id > ${after}::uuid)
               ORDER BY id LIMIT ${limit}`),
          ).map((r) => ({ id: r.id, cipher: r.body_cipher, sha256: r.body_sha256 })),
        );
      }
      return inOrg(resealDb as DbClient, organizationId, async (tx) =>
        rowsOf<{ id: string; cipher: Buffer }>(
          await tx.execute(sql`
            SELECT row_id::text AS id, cipher
              FROM m36_label_backfill_page(${table}, ${organizationId}::uuid, ${after}::uuid, ${limit})`),
        ).map((r) => ({ id: r.id, cipher: r.cipher, sha256: null })),
      );
    },
    async classify(row): Promise<RowClass> {
      if (bodyEnvelopeScheme(row.cipher) === "erased") return "ignore";
      if (
        (await tryOpen(() => openBody(kit, organizationId, row.cipher, "current"))) !== undefined
      ) {
        return "current";
      }
      return (await tryOpen(() => openBody(kit, organizationId, row.cipher, "legacy"))) !==
        undefined
        ? "legacy"
        : "unreadable";
    },
    async reseal(row): Promise<WriteResult> {
      const plaintext = await tryOpen(() => openBody(kit, organizationId, row.cipher));
      if (plaintext === undefined) return "failed";
      // A stored digest that does not match the decrypted body is evidence of tampering: never "fix" it by re-sealing.
      if (row.sha256 !== null && messageBodySha256(plaintext) !== row.sha256) return "failed";
      try {
        const sealed = await sealLike(kit, organizationId, row.cipher, plaintext);
        const reopened = await openBody(kit, organizationId, sealed, "current");
        if (reopened !== plaintext) return "failed";
        if (table === "message") {
          const swapped = await inOrg(db, organizationId, async (tx) =>
            rowsOf<{ id: string }>(
              await tx.execute(sql`
                UPDATE message SET body_cipher = ${sealed}::bytea
                 WHERE organization_id = ${organizationId} AND id = ${row.id}::uuid
                   AND body_cipher = ${row.cipher}::bytea
                RETURNING id`),
            ),
          );
          return swapped.length === 1 ? "resealed" : "skipped";
        }
        const swapped = await inOrg(
          resealDb as DbClient,
          organizationId,
          async (tx) =>
            rowsOf<{ ok: boolean }>(
              await tx.execute(sql`
              SELECT m36_label_backfill_swap(${table}, ${organizationId}::uuid, ${row.id}::uuid, ${row.cipher}::bytea, ${sealed}::bytea) AS ok`),
            )[0]?.ok,
        );
        return swapped ? "resealed" : "skipped";
      } catch (error) {
        // Migration 1138's backstop refuses to rewrite a legal-held message: leave it for the next run (it stays counted).
        return isLegalHoldViolation(error) ? "skipped" : "failed";
      }
    },
  };
}
