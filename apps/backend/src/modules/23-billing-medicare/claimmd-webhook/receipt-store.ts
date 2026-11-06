// apps/backend/src/modules/23-billing-medicare/claimmd-webhook/receipt-store.ts — the durable receipt of a signed Claim.MD
// delivery (ADR-0053 amendment D7). ONE statement stores the whole batch (INSERT … ON CONFLICT DO NOTHING on
// (usage, acct_number, event_id)), so the route answers 200 only when every event, redeliveries included, is on disk;
// any database error propagates and the route answers 5xx, which makes Claim.MD retry.
//
// Each event element is encrypted before it lands (it can carry a provider TIN, which may be an SSN, and untrusted vendor
// text). Test events and malformed elements are settled terminal in the same statement; everything else waits for the
// sweep (`processed_at IS NULL`). Nothing here logs content: test receipts log usage + account only.
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import type { WebhookPayloadCipher } from "@chartwarden/shared";
import { type ClaimMdDelivery, parseClaimMdDelivery } from "@chartwarden/x12-837-client";
import { sql } from "drizzle-orm";

export type ClaimMdUsage = "test" | "production";

/** One allowlisted, audited withPlatformContext transaction (bound in index.ts over DATABASE_PLATFORM_URL). */
export type ClaimMdPlatformRunner = <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;

export interface ClaimMdReceiptDeps {
  readonly runner: ClaimMdPlatformRunner;
  readonly cipher: WebhookPayloadCipher;
  readonly now?: () => Date;
  /** PHI-free signal (usage + account only), e.g. `claimmd.webhook.test_received`. */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/** Store a verified delivery; resolves with the number of events it carried (duplicates included). */
export type ClaimMdReceive = (input: {
  readonly usage: ClaimMdUsage;
  readonly rawBody: Buffer;
}) => Promise<number>;

interface ReceiptRow {
  readonly acctNumber: string;
  readonly remoteAcctNumber: string | null;
  readonly eventId: string;
  readonly eventType: string | null;
  readonly eventTime: string | null;
  readonly plaintext: string;
  readonly outcome: "test_ack" | "malformed" | null;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function rowsOf(delivery: ClaimMdDelivery, rawBody: Buffer): ReceiptRow[] {
  if (delivery.kind === "unsplittable") {
    return [
      {
        acctNumber: delivery.acctNumber ?? "",
        remoteAcctNumber: null,
        eventId: `body:${delivery.bodySha256}`,
        eventType: null,
        eventTime: null,
        // The bytes may not be UTF-8: keep them exactly, base64-wrapped, so the receipt is evidence of what was sent.
        plaintext: JSON.stringify({ rawBodyBase64: rawBody.toString("base64") }),
        outcome: "malformed",
      },
    ];
  }
  return delivery.events.map((e) => ({
    acctNumber: delivery.acctNumber,
    remoteAcctNumber: delivery.remoteAcctNumber,
    eventId: e.eventId,
    eventType: e.eventType,
    eventTime: e.eventTime,
    plaintext: e.element,
    outcome: e.malformed ? "malformed" : e.eventType === "test" ? "test_ack" : null,
  }));
}

export function buildClaimMdReceiptStore(deps: ClaimMdReceiptDeps): ClaimMdReceive {
  const now = deps.now ?? (() => new Date());
  return async ({ usage, rawBody }) => {
    const delivery = parseClaimMdDelivery(rawBody);
    const rows = rowsOf(delivery, rawBody);
    const at = now();
    const values = rows.map((r) => {
      const sealed = deps.cipher.encrypt(r.plaintext);
      return sql`(${usage}, ${r.acctNumber}, ${r.eventId}, ${r.remoteAcctNumber}, ${r.eventType}, ${r.eventTime},
        ${at}, ${at}, ${sha256(r.plaintext)}, ${sealed.ciphertext}, ${sealed.dekRef},
        ${r.outcome === null ? null : at}, ${r.outcome})`;
    });
    const inserted = await deps.runner(async (tx) => {
      const res = (await tx.execute(sql`
        INSERT INTO claimmd_webhook_event (usage, acct_number, event_id, remote_acct_number, event_type, event_time,
          received_at, signature_verified_at, payload_sha256, payload_cipher, payload_key_ref, processed_at,
          processing_outcome)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (usage, acct_number, event_id) DO NOTHING
        RETURNING processing_outcome`)) as unknown as {
        rows: { processing_outcome: string | null }[];
      };
      return res.rows;
    });
    for (const row of inserted) {
      if (row.processing_outcome === "test_ack") {
        deps.log?.("claimmd.webhook.test_received", {
          usage,
          acctNumber: rows[0]?.acctNumber ?? "",
        });
      }
    }
    return rows.length;
  };
}
