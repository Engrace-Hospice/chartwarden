// apps/backend/src/modules/29-external-interfaces/listener/ingest-sink.ts — GAP-086. The REAL `MllpIngestSink`
// (§4.11.3 steps 3-6): the Drizzle implementation that persists one `hl7_message_inbound` row per received frame.
//
//   isDuplicate     D14 — `(feed_id, message_control_id)` already stored (accepted OR rejected) ⇒ the listener ACKs `AA`
//                   without a second row.
//   ingest          seal the wire payload under the tenant DEK, summarise its segment SHAPE (names + byte counts, no
//                   PHI), insert the row `parse_status='in_progress'` and resolve `aa` ONLY after the tx commits (the
//                   `withOrgContext` promise resolves post-COMMIT). A durable-write failure resolves `ae` — never a
//                   silent `aa` — so the sender re-sends and D14 dedupes the re-send once the transient clears.
//   recordRejected  the sender-allowlist refusal: a `parse_status='rejected'` row with the reason, for the §164.528
//                   disclosure record (the listener NAKs `AR`).
//
// The queue IS the table: the parse worker (`inbound/parse-worker.ts`) claims `in_progress` rows with
// `FOR UPDATE SKIP LOCKED`, so nothing is lost if Valkey or the worker is down at ingest time.
//
// CONCURRENCY. `hl7_message_inbound` is partitioned, so a UNIQUE (feed_id, message_control_id) cannot be declared
// (a partitioned unique index must include the partition key). The dedup is therefore enforced here: a per-key
// transaction-scoped advisory lock serialises two simultaneous copies of one MSH-10, and the second sees the first's
// committed row.
import { createHash, randomUUID } from "node:crypto";

import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, sql } from "drizzle-orm";

import type { InboundCipher } from "../inbound/inbound-crypto";
import type { InboundAckDisposition } from "./ack";
import type { MllpIngestSink } from "./connection";
import type { MshEnvelope } from "./mllp-framing";
import type { SupervisorFeedDescriptor } from "./supervisor";

const INBOUND = schema.hl7MessageInbound;
const SYSTEM_USER_ID = "";

export interface IngestSinkDeps {
  readonly db: DbClient;
  readonly cipher: InboundCipher;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly log?: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
}

/** `{segments:[{name,byteCount}]}` — segment SHAPE only; never a field value. */
export function summarizeInboundSegments(payload: string): {
  segments: { name: string; byteCount: number }[];
} {
  const segments = payload
    .split(/\r\n|\r|\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({
      name: line.slice(0, 3),
      byteCount: Buffer.byteLength(line, "utf8"),
    }));
  return { segments };
}

/** `MSH-9` recombined: `ADT^A01`; the bare code when MSH-9 has no trigger event. */
export function messageTypeOf(envelope: MshEnvelope): string {
  return envelope.triggerEvent
    ? `${envelope.messageCode}^${envelope.triggerEvent}`
    : envelope.messageCode;
}

/** The M1 idempotency-style key: hash of the sender identity and the control id (D14). */
export function inboundIdempotencyKey(feedId: string, envelope: MshEnvelope): string {
  return createHash("sha256")
    .update(`${feedId}\u0000${envelope.sendingFacility}\u0000${envelope.messageControlId}`)
    .digest("hex");
}

/** Build the per-feed sink factory — `connectionDeps(feed)` calls it once per bound feed. */
export function createDrizzleIngestSinkFactory(
  deps: IngestSinkDeps,
): (feed: SupervisorFeedDescriptor) => MllpIngestSink {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? (() => {});

  return (feed) => {
    const orgCtx = { organizationId: feed.organizationId, userId: SYSTEM_USER_ID };

    const exists = async (
      tx: DbClient,
      input: { feedId: string; messageControlId: string },
    ): Promise<boolean> => {
      const rows = await tx
        .select({ id: INBOUND.id })
        .from(INBOUND)
        .where(
          and(
            eq(INBOUND.organizationId, feed.organizationId),
            eq(INBOUND.feedId, input.feedId),
            eq(INBOUND.messageControlId, input.messageControlId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    };

    /** Insert once per (feed, control id) under an advisory lock. Resolves true when a row was written. */
    const persist = async (input: {
      envelope: MshEnvelope;
      payload: string;
      sha256: string;
      parseStatus: "in_progress" | "rejected";
      parseError: Record<string, unknown> | null;
    }): Promise<boolean> => {
      const sealed = await deps.cipher.encrypt(
        feed.organizationId,
        "hl7_message_inbound.payload",
        input.payload,
      );
      return withOrgContext(deps.db, orgCtx, async (scoped) => {
        const tx = scoped as DbClient;
        const lockKey = `${feed.id}:${input.envelope.messageControlId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        if (
          await exists(tx, { feedId: feed.id, messageControlId: input.envelope.messageControlId })
        ) {
          return false;
        }
        await tx.insert(INBOUND).values({
          id: newId(),
          organizationId: feed.organizationId,
          feedId: feed.id,
          messageType: messageTypeOf(input.envelope),
          messageControlId: input.envelope.messageControlId,
          payloadCipher: sealed,
          payloadSha256: input.sha256,
          segmentsSummary: summarizeInboundSegments(input.payload),
          receivedAt: now(),
          parseStatus: input.parseStatus,
          parseError: input.parseError,
          sendingFacilityRawId: input.envelope.sendingFacility,
          idempotencyKey: inboundIdempotencyKey(feed.id, input.envelope),
        });
        return true;
      });
    };

    return {
      async isDuplicate(input) {
        return withOrgContext(deps.db, orgCtx, (scoped) => exists(scoped as DbClient, input));
      },

      async ingest(input): Promise<InboundAckDisposition> {
        try {
          const written = await persist({
            envelope: input.envelope,
            payload: input.payload,
            sha256: input.sha256,
            parseStatus: "in_progress",
            parseError: null,
          });
          if (!written) {
            log("info", "hl7.inbound.duplicate_dropped", {
              feedId: feed.id,
              messageControlId: input.envelope.messageControlId,
            });
          }
          return "aa";
        } catch (err) {
          // Durable write failed — NAK `AE` so the sender re-sends; never ACK what was not committed.
          log("warn", "hl7.inbound.persist_failed", {
            feedId: feed.id,
            errorName: err instanceof Error ? err.name : "unknown",
          });
          return "ae";
        }
      },

      async recordRejected(input) {
        try {
          await persist({
            envelope: input.envelope,
            payload: input.payload,
            sha256: input.sha256,
            parseStatus: "rejected",
            parseError: { code: "sender_not_allowlisted", reason: input.reason },
          });
        } catch (err) {
          // The NAK still goes out; the refusal is also on the structured log the listener already wrote.
          log("warn", "hl7.inbound.reject_record_failed", {
            feedId: feed.id,
            errorName: err instanceof Error ? err.name : "unknown",
          });
        }
      },
    };
  };
}
