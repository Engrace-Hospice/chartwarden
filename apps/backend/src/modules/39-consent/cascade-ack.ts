// apps/backend/src/modules/39-consent/cascade-ack.ts — M39 §2.2.3 revocation-cascade ACK tracking (GAP-171).
//
// WHAT WAS BROKEN. `consent_revocation.cascade_status` starts `pending` with `{consumer: false}` for the four
// §2.2.3 consumers and NOTHING ever wrote an ACK, so a cascade could never reach `completed`; the only way to
// `partial_failed` was the manual route's budget count, and the `m39.consent.revoked_cascade_failed` alert was
// never emitted. This module is the single writer of the ACK state:
//   • `recordCascadeAckForOrg` — an org-explicit seam a consumer calls AFTER its own effect committed.
//   • `evaluateCascade` — the pure status arbiter over the consumers that can ACK (below), used by the ACK
//     writer, the retry cron and the manual retry route so the three can never disagree.
//
// WHICH CONSUMERS COUNT. All four §2.2.3 consumers (`CASCADE_CONSUMERS`) now have a live `m39.consent.revoked`
// binding that ACKs after its leg ran (M31 grants; M22 disclosure restriction; M28 / M36 pull-path attestations —
// see each consumer's header), so a cascade completes only when every one has ACKed. A consumer with NO binding
// must NOT be listed live: it could never ACK, every cascade would burn its budget and raise a CRITICAL "cascade
// failed" alert that is always true, and an alarm that is always true is ignored. Such a consumer goes in
// {@link CASCADE_DEFERRED_CONSUMERS} (empty today) until it gains a binding (no data migration: rows keep every
// key, the arbiter just filters).
import { CASCADE_MAX_ATTEMPTS, nextCascadeStatus } from "@chartwarden/consent";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

const REV = schema.consentRevocation;

/** Consumers with a live `m39.consent.revoked` binding (each ACKs after its leg); completion requires them all. */
export const CASCADE_LIVE_CONSUMERS: readonly string[] = [
  "m31_portal",
  "m36_messaging",
  "m28_fhir",
  "m22_documents",
];

/** §2.2.3 consumers with NO subscription — they cannot ACK, so they do not gate completion. Empty today. */
export const CASCADE_DEFERRED_CONSUMERS: Readonly<Record<string, string>> = {};

/** Bookkeeping keys that live beside the consumer flags in `cascade_consumer_status_jsonb`. */
export const CASCADE_ATTEMPTS_KEY = "__attempts";

/** The M36 AlertEmitter seam, restated structurally (M39 imports nothing from M36). */
export interface M39AlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: string;
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

export type CascadeStatus = "pending" | "in_progress" | "completed" | "partial_failed";

export interface CascadeSnapshot {
  readonly status: CascadeStatus;
  /** The raw jsonb: consumer → ACKed, plus the `__attempts` counter. */
  readonly consumerJson: Readonly<Record<string, boolean | number>>;
}

export interface CascadeEvaluation {
  readonly status: CascadeStatus;
  readonly attempts: number;
  /** Live consumers that have not ACKed (the ones named in the failure alert). */
  readonly pendingConsumers: readonly string[];
  readonly consumers: Readonly<Record<string, boolean>>;
}

/** The ACK flags of the live consumers only (a missing key reads as not ACKed). */
export function liveConsumerAcks(
  consumerJson: Readonly<Record<string, boolean | number>>,
): Record<string, boolean> {
  return Object.fromEntries(CASCADE_LIVE_CONSUMERS.map((c) => [c, consumerJson[c] === true]));
}

export function attemptsOf(consumerJson: Readonly<Record<string, boolean | number>>): number {
  const n = consumerJson[CASCADE_ATTEMPTS_KEY];
  return typeof n === "number" ? n : 0;
}

/**
 * The pure arbiter. `attemptsAfter` is the attempt count INCLUDING the sweep being decided (the ACK writer
 * passes the current count unchanged; a retry sweep passes current + 1). A terminal status never moves.
 */
export function evaluateCascade(
  snapshot: CascadeSnapshot,
  attemptsAfter: number,
): CascadeEvaluation {
  const consumers = liveConsumerAcks(snapshot.consumerJson);
  const pendingConsumers = Object.entries(consumers)
    .filter(([, acked]) => !acked)
    .map(([name]) => name);
  const next = nextCascadeStatus({ status: snapshot.status, consumers, attempts: attemptsAfter });
  // `nextCascadeStatus` DENIES (not ok) when the budget is exhausted with stragglers → partial_failed.
  const status: CascadeStatus = next.ok ? next.value : "partial_failed";
  return { status, attempts: attemptsAfter, pendingConsumers, consumers };
}

/** True once a cascade has spent its whole retry budget. */
export const cascadeBudgetSpent = (attempts: number): boolean => attempts >= CASCADE_MAX_ATTEMPTS;

export interface CascadeAckInput {
  readonly organizationId: string;
  readonly consentRecordId: string;
  /** One of the §2.2.3 consumer names (`m31_portal`, …). */
  readonly consumer: string;
  readonly now?: Date;
}

export interface CascadeAckResult {
  /** False when the consent has no revocation row yet (the consumer ran ahead of the commit — never expected). */
  readonly recorded: boolean;
  readonly status: CascadeStatus | null;
}

/**
 * Record one consumer's ACK for the consent's revocation and complete the cascade when every live consumer has
 * ACKed. Idempotent (a repeat ACK rewrites the same flag) and never moves a terminal status. Runs in its own
 * org-scoped transaction with the revocation row locked, so two consumers ACKing concurrently cannot lose a flag.
 */
export async function recordCascadeAckForOrg(
  db: DbClient,
  input: CascadeAckInput,
): Promise<CascadeAckResult> {
  if (!CASCADE_LIVE_CONSUMERS.includes(input.consumer)) {
    throw new Error(
      `M39_CASCADE_ACK: '${input.consumer}' is not a live cascade consumer (live: ${CASCADE_LIVE_CONSUMERS.join(", ")})`,
    );
  }
  const now = input.now ?? new Date();
  return withOrgContext(
    db,
    { organizationId: input.organizationId, userId: "" },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const [rev] = await tx
        .select()
        .from(REV)
        .where(
          and(
            eq(REV.organizationId, input.organizationId),
            eq(REV.consentRecordId, input.consentRecordId),
          ),
        )
        .limit(1)
        .for("update");
      if (!rev) return { recorded: false, status: null };
      const current = rev.cascadeConsumerStatusJsonb as Record<string, boolean | number>;
      const status = rev.cascadeStatus as CascadeStatus;
      const consumerJson = { ...current, [input.consumer]: true };
      if (status === "completed" || status === "partial_failed") {
        // Terminal: the status never moves, but a late ACK is still the truth about that consumer.
        await tx
          .update(REV)
          .set({ cascadeConsumerStatusJsonb: consumerJson })
          .where(eq(REV.id, rev.id));
        return { recorded: true, status };
      }
      const evaluation = evaluateCascade({ status, consumerJson }, attemptsOf(consumerJson));
      // An ACK only ever COMPLETES a cascade or leaves it open; declaring it failed is the retry cron's call
      // (it owns the budget and the alert), so a "budget spent" verdict here maps back to in_progress.
      const nextStatus: CascadeStatus =
        evaluation.status === "completed" ? "completed" : "in_progress";
      await tx
        .update(REV)
        .set({
          cascadeStatus: nextStatus,
          cascadeStartedAt: rev.cascadeStartedAt ?? now,
          cascadeCompletedAt: nextStatus === "completed" ? now : null,
          cascadeConsumerStatusJsonb: consumerJson,
        })
        .where(eq(REV.id, rev.id));
      return { recorded: true, status: nextStatus };
    },
  );
}
