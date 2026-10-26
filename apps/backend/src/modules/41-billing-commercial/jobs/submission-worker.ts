// apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts - send queued commercial submissions through the platform
// ClearinghouseTransport (ADR-0053 D10, ADR-0100 D4/D5/D9). Mirrors M23's `transportUpload` posture:
//   - ONE path: `binding.transport.submitClaim`. No direct-to-payer channel, no fallback. `CLEARINGHOUSE_VENDOR` unset
//     (`binding.vendor === null`) means nothing is sent and the tick FAILS while anything is waiting (never a silent skip).
//   - the send gate is judged AGAIN at send time on the current facts (an authorization voided or an enrollment ended since the
//     request); a refusal ends the submission as `failed` and the claim stays `ready`.
//   - `submitted` is written only from the transport's receipt, in the same transaction as the submission's `sent`, the history row and
//     `m41.claim.submitted`. A degraded answer never moves the claim.
//   - the attempt store behind the transport is the idempotency authority (D6). The transport key is ONE per claim (`m41.claim.<claimId>`)
//     and the payload is deterministic across the claim's whole lineage of submissions (interchange number and stamp are copied from the
//     first), so a retry, a re-lease after a crash, or a second submission row all REPLAY the original receipt instead of filing twice.
//
// AMBIGUITY. A send is ambiguous once an attempt may have reached the transport without a definite answer. The worker marks
// `transport_call_started_at` just before the call and clears it only on a definite answer; a lease that finds it still set knows the
// previous attempt was interrupted and sets the sticky `ambiguous` flag. An ambiguous submission NEVER ends `failed`: every way out
// (exhausted attempts, a later refusal, a fault after the transport accepted, a throwing transport, CH_IN_DOUBT) ends `in_doubt`, which
// is never resent automatically and has a human exit (`reconcile`) or is resolved by a later acknowledgment. Only a definite
// refusal BEFORE any send, or a definite CH_UNAVAILABLE, may fail or requeue a submission that was never ambiguous.
// The 837I (it carries the member id) exists only in a local variable between render and send: never stored, never logged.
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { COMMERCIAL_SUBMISSION_MAX_ATTEMPTS, ChartWardenError } from "@chartwarden/types";
import { CH, type ClearinghouseTransport } from "@chartwarden/x12-837-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { CommercialContextPort } from "../eligibility/service";
import type { Render837iArgs, Render837iResult } from "../services/render-837i";
import { evaluateGateForClaim } from "../services/submission-service";
import type { CommercialActor, CommercialOutboxPort, CommercialTx } from "../services/types";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";

type SubmissionRow = typeof schema.commercialSubmissions.$inferSelect;

/** Submissions looked at per org per tick. Each is leased on its own, just before it is sent. */
export const DRAIN_BATCH = 20;
/** A leased submission is not due again for this long. It covers ONE row's render and transport call (rows are leased one at a time). */
export const LEASE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export const FAILURE = {
  RENDER_INCOMPLETE: "COMMERCIAL_837I_INCOMPLETE",
  BILLING_NPI_MISSING: "COMMERCIAL_BILLING_NPI_MISSING",
  EXHAUSTED: "COMMERCIAL_SUBMISSION_EXHAUSTED",
  TRANSPORT_FAULT: "COMMERCIAL_TRANSPORT_FAULT",
  RECORD_FAULT: "COMMERCIAL_RECORD_FAULT",
  /** The facts the 837I is built from changed since the first attempt: void the claim and assemble it again. */
  PAYLOAD_CHANGED: "COMMERCIAL_PAYLOAD_CHANGED",
  INTERRUPTED: "COMMERCIAL_SEND_INTERRUPTED",
} as const;

export type SendOutcome =
  | { readonly kind: "retry"; readonly code: string }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "in_doubt"; readonly code: string };

/** What a degraded transport answer means for the submission. Pure. */
export function classifyTransportRefusal(code: string): SendOutcome {
  if (code === CH.UNAVAILABLE) return { kind: "retry", code };
  if (code === CH.IN_DOUBT) return { kind: "in_doubt", code };
  // The transport already holds this claim's key with a DIFFERENT payload (or the control number under another key): an earlier
  // attempt DID reach it, so this is not a clean refusal. A person decides (reconcile); the worker never marks it failed.
  if (code === CH.IDEMPOTENCY_CONFLICT) return { kind: "in_doubt", code };
  return { kind: "failed", code };
}

/** Delay before attempt `n + 1` after `n` failed attempts: 1, 2, 4 ... minutes, capped at one hour. Pure. */
export function retryDelayMs(attemptsMade: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1));
}

/** The status a submission that cannot go on ends with: an ambiguous one is NEVER `failed`. Pure. */
export function endingFor(ambiguous: boolean): "failed" | "in_doubt" {
  return ambiguous ? "in_doubt" : "failed";
}

/** The ONE transport key of a claim (see the header). */
export const transportKeyFor = (claimId: string): string => `m41.claim.${claimId}`;

const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const safeCode = (code: string): string => (SAFE_CODE.test(code) ? code : FAILURE.TRANSPORT_FAULT);

export interface SubmissionWorkerDeps {
  readonly db: DbClient;
  /** The platform clearinghouse binding. `vendor` null = unbound: the drain refuses to send anything. */
  readonly binding: {
    readonly vendor: string | null;
    readonly transport: Pick<ClearinghouseTransport, "submitClaim">;
  };
  readonly contexts: CommercialContextPort;
  readonly renderer: {
    render(actor: CommercialActor, args: Render837iArgs): Promise<Render837iResult>;
  };
  readonly outbox: CommercialOutboxPort;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
  /** PHI-free log sink (ids and codes only). */
  readonly log?: (event: {
    readonly event: string;
    readonly code?: string;
    readonly submissionId?: string;
  }) => void;
}

const nowOf = (deps: SubmissionWorkerDeps): Date => (deps.now ?? (() => new Date()))();

/** The system principal a worker acts as: organization-wide scope, no human, never a step-up. */
function workerActor(sub: SubmissionRow): CommercialActor {
  return {
    organizationId: sub.organizationId,
    userId: "",
    membershipId: sub.requestedByMembershipId,
    actorKind: "system",
    stepUpRecent: false,
    billingScope: { all: true, providerEntityIds: [] },
  };
}

const inOrg = <T>(
  deps: SubmissionWorkerDeps,
  organizationId: string,
  fn: (tx: CommercialTx) => Promise<T>,
): Promise<T> => withOrgContext(deps.db, systemOrgContext(organizationId), fn);

/** Ids of due queued submissions. No lock: each row is leased on its own just before it is sent. */
async function listDue(deps: SubmissionWorkerDeps, organizationId: string): Promise<string[]> {
  return inOrg(deps, organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const rows = await tx
      .select({ id: S.id })
      .from(S)
      .where(and(eq(S.status, "queued"), lte(S.nextAttemptAt, nowOf(deps))))
      .orderBy(asc(S.nextAttemptAt))
      .limit(DRAIN_BATCH);
    return rows.map((r) => r.id);
  });
}

async function publishFailed(
  deps: SubmissionWorkerDeps,
  tx: CommercialTx,
  sub: SubmissionRow,
  status: "failed" | "in_doubt",
  code: string,
): Promise<void> {
  await deps.outbox.publish(tx, {
    eventName: "m41.claim.submit_failed",
    organizationId: sub.organizationId,
    aggregateKind: "commercial_submission",
    aggregateId: sub.id,
    payload: { claimId: sub.claimId, submissionId: sub.id, status, code },
  });
}

type Leased =
  | { readonly kind: "send"; readonly sub: SubmissionRow }
  | { readonly kind: "ended" }
  | { readonly kind: "skip" };

/**
 * Take ONE due submission, just before it is sent: a row-locked, SKIP LOCKED claim of the row (another worker that already holds it
 * or has leased it is skipped), the attempt count bumped and `next_attempt_at` pushed out by the lease. A previous attempt that was
 * interrupted after it may have reached the transport (`transport_call_started_at` still set) makes the submission ambiguous; a
 * submission over the attempt cap ends here (`in_doubt` when ambiguous, `failed` otherwise).
 */
async function leaseOne(
  deps: SubmissionWorkerDeps,
  organizationId: string,
  id: string,
): Promise<Leased> {
  return inOrg(deps, organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const at = nowOf(deps);
    const [row] = await tx
      .select()
      .from(S)
      .where(and(eq(S.id, id), eq(S.status, "queued"), lte(S.nextAttemptAt, at)))
      .for("update", { skipLocked: true });
    if (!row) return { kind: "skip" };
    const interrupted = row.transportCallStartedAt !== null;
    const ambiguous = row.ambiguous || interrupted;
    if (row.attemptCount >= COMMERCIAL_SUBMISSION_MAX_ATTEMPTS) {
      const status = endingFor(ambiguous);
      const code = ambiguous ? FAILURE.INTERRUPTED : FAILURE.EXHAUSTED;
      await tx
        .update(S)
        .set({
          status,
          ambiguous,
          transportCallStartedAt: null,
          lastFailureCode: code,
          updatedAt: at,
        })
        .where(eq(S.id, row.id));
      await publishFailed(deps, tx, row, status, code);
      return { kind: "ended" };
    }
    const [leased] = await tx
      .update(S)
      .set({
        attemptCount: row.attemptCount + 1,
        nextAttemptAt: new Date(at.getTime() + LEASE_MS),
        ambiguous,
        transportCallStartedAt: null,
        updatedAt: at,
      })
      .where(eq(S.id, row.id))
      .returning();
    return leased ? { kind: "send", sub: leased } : { kind: "skip" };
  });
}

/** End a submission: `failed` or `in_doubt`, with a stable code and the event. The claim is left as it is. */
async function endSubmission(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
  status: "failed" | "in_doubt",
  code: string,
  receiptId?: string,
): Promise<void> {
  const stable = safeCode(code);
  await inOrg(deps, sub.organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const [ended] = await tx
      .update(S)
      .set({
        status,
        ambiguous: status === "in_doubt" ? true : sub.ambiguous,
        transportCallStartedAt: null,
        lastFailureCode: stable,
        ...(receiptId === undefined ? {} : { clearinghouseSubmissionId: receiptId.slice(0, 256) }),
        updatedAt: nowOf(deps),
      })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")))
      .returning({ id: S.id });
    if (!ended) return; // another tick already settled it
    await publishFailed(deps, tx, sub, status, stable);
  });
  deps.log?.({ event: `submission.${status}`, code: stable, submissionId: sub.id });
}

/** A definite refusal BEFORE anything was sent: `failed`, unless an earlier attempt was ambiguous (then `in_doubt`). */
const endWithoutSend = (deps: SubmissionWorkerDeps, sub: SubmissionRow, code: string) =>
  endSubmission(deps, sub, endingFor(sub.ambiguous), code);

/** The transport accepted: submission `sent`, claim `ready -> submitted`, history and event, in ONE transaction. */
async function recordAccepted(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
  receiptId: string,
): Promise<void> {
  await inOrg(deps, sub.organizationId, async (tx) => {
    const at = nowOf(deps);
    const S = schema.commercialSubmissions;
    const C = schema.commercialClaims;
    const [claim] = await tx.select().from(C).where(eq(C.id, sub.claimId)).for("update");
    const [sent] = await tx
      .update(S)
      .set({
        status: "sent",
        resolution: "receipt",
        clearinghouseSubmissionId: receiptId.slice(0, 256),
        sentAt: at,
        transportCallStartedAt: null,
        lastFailureCode: null,
        updatedAt: at,
      })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")))
      .returning({ id: S.id });
    if (!sent) {
      // An acknowledgment (or a person) settled the row first and its provenance stands, but the receipt id is still ours to keep.
      await tx
        .update(S)
        .set({ clearinghouseSubmissionId: receiptId.slice(0, 256), updatedAt: at })
        .where(
          and(eq(S.id, sub.id), eq(S.status, "sent"), sql`${S.clearinghouseSubmissionId} IS NULL`),
        );
      return;
    }
    if (claim?.state === "ready") {
      await tx.update(C).set({ state: "submitted", updatedAt: at }).where(eq(C.id, claim.id));
      await tx.insert(schema.commercialClaimStateHistory).values({
        organizationId: sub.organizationId,
        providerEntityId: sub.providerEntityId,
        locationId: sub.locationId,
        claimId: sub.claimId,
        fromState: "ready",
        toState: "submitted",
        actorKind: "system",
        actorMembershipId: null,
        validationRunId: null,
      });
    }
    await deps.outbox.publish(tx, {
      eventName: "m41.claim.submitted",
      organizationId: sub.organizationId,
      aggregateKind: "commercial_submission",
      aggregateId: sub.id,
      payload: {
        claimId: sub.claimId,
        submissionId: sub.id,
        controlNumber: sub.controlNumber,
        clearinghouseKey: sub.clearinghouseKey,
      },
    });
  });
  deps.log?.({ event: "submission.sent", submissionId: sub.id });
}

/** Put a definite CH_UNAVAILABLE back in the queue after its backoff. */
async function requeue(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
  code: string,
): Promise<void> {
  const at = nowOf(deps);
  await inOrg(deps, sub.organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    await tx
      .update(S)
      .set({
        nextAttemptAt: new Date(at.getTime() + retryDelayMs(sub.attemptCount)),
        transportCallStartedAt: null,
        lastFailureCode: safeCode(code),
        updatedAt: at,
      })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")));
  });
  deps.log?.({ event: "submission.retry", code: safeCode(code), submissionId: sub.id });
}

/** Mark that the transport is about to be called (so an interruption from here on is known to be ambiguous). */
async function markCallStarted(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
  payloadHash: string,
): Promise<void> {
  await inOrg(deps, sub.organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    await tx
      .update(S)
      .set({ transportCallStartedAt: nowOf(deps), payloadHash })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")));
  });
}

/** SHA-256 of the exact 837I. One-way, and the file itself is never stored. */
const hashOf = (x12: string): string => createHash("sha256").update(x12).digest("hex");

/**
 * The hash of the FIRST 837I of this claim that reached the transport call (any submission of the claim, this one included), or null.
 * Every later attempt must render the same bytes: the transport holds one key per claim, and a different payload under it is an
 * idempotency conflict that no retry can clear.
 */
async function firstPayloadHash(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
): Promise<string | null> {
  return inOrg(deps, sub.organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const [row] = await tx
      .select({ hash: S.payloadHash })
      .from(S)
      .where(and(eq(S.claimId, sub.claimId), sql`${S.payloadHash} IS NOT NULL`))
      .orderBy(asc(S.requestedAt))
      .limit(1);
    return row?.hash ?? null;
  });
}

/** Judge the gate again on the current facts. Returns the refusal code, or null when sending may go ahead. */
async function regate(deps: SubmissionWorkerDeps, sub: SubmissionRow): Promise<string | null> {
  return inOrg(deps, sub.organizationId, async (tx) => {
    const [claim] = await tx
      .select()
      .from(schema.commercialClaims)
      .where(eq(schema.commercialClaims.id, sub.claimId));
    if (!claim) return "COMMERCIAL_CLAIM_NOT_FOUND";
    const gate = await evaluateGateForClaim(tx, claim, deps.binding.vendor, {
      ignoreLiveSubmission: true,
      now: nowOf(deps),
    });
    if (!gate.ok) return gate.reasons[0]?.code ?? "COMMERCIAL_SEND_REFUSED";
    return gate.clearinghousePayerId === sub.clearinghousePayerId
      ? null
      : "COMMERCIAL_ROUTE_CHANGED";
  });
}

/** After the transport ACCEPTED: record it, or - if recording faults - end `in_doubt` with the receipt, never `failed`, never a blind re-lease. */
async function recordAcceptedOrDoubt(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
  receiptId: string,
): Promise<void> {
  try {
    await recordAccepted(deps, sub, receiptId);
  } catch {
    // The file IS at the clearinghouse; only our record failed. If even the in-doubt record cannot be written the error surfaces,
    // `transport_call_started_at` is still set, and the next lease replays the receipt under the same key and tries again.
    await endSubmission(deps, sub, "in_doubt", FAILURE.RECORD_FAULT, receiptId);
  }
}

async function sendOne(deps: SubmissionWorkerDeps, sub: SubmissionRow): Promise<void> {
  const refusal = await regate(deps, sub);
  if (refusal !== null) return endWithoutSend(deps, sub, refusal);

  const context = await deps.contexts.contextFor(
    sub.organizationId,
    sub.providerEntityId,
    sub.clearinghousePayerId,
  );
  if (context === null) return endWithoutSend(deps, sub, FAILURE.BILLING_NPI_MISSING);

  let rendered: Render837iResult;
  try {
    rendered = await deps.renderer.render(workerActor(sub), {
      claimId: sub.claimId,
      interchangeControlNumber: sub.interchangeControlNumber,
      usage: context.usage === "production" ? "P" : "T",
      createdAt: sub.payloadStamp,
    });
  } catch (err) {
    // A typed refusal (blocked since the gate, no longer ready) is final; anything else is unexpected and re-delivered by the lease.
    if (err instanceof ChartWardenError) return endWithoutSend(deps, sub, err.code);
    throw err;
  }
  if (!rendered.ok) return endWithoutSend(deps, sub, FAILURE.RENDER_INCOMPLETE);

  // Freeze what was sent: the facts this 837I is built from (address, coverage, ...) may have changed since an earlier attempt. Then
  // the transport would answer an opaque idempotency conflict forever; say so in a stable code instead, before anything is sent.
  const payloadHash = hashOf(rendered.x12);
  const earlier = await firstPayloadHash(deps, sub);
  if (earlier !== null && earlier !== payloadHash) {
    return endWithoutSend(deps, sub, FAILURE.PAYLOAD_CHANGED);
  }
  await markCallStarted(deps, sub, payloadHash);
  let outcome: SendOutcome | { readonly kind: "accepted"; readonly receiptId: string };
  try {
    const result = await deps.binding.transport.submitClaim(context, {
      kind: "claim",
      controlNumber: sub.controlNumber,
      idempotencyKey: transportKeyFor(sub.claimId),
      payload: { format: "x12", x12: rendered.x12 },
    });
    outcome = result.ok
      ? { kind: "accepted", receiptId: result.data.clearinghouseSubmissionId }
      : classifyTransportRefusal(result.degraded.code);
  } catch {
    // The port promises never to throw; if it does, whether the file left is unknown. Never resent blind.
    outcome = { kind: "in_doubt", code: FAILURE.TRANSPORT_FAULT };
  }
  switch (outcome.kind) {
    case "accepted":
      return recordAcceptedOrDoubt(deps, sub, outcome.receiptId);
    case "retry":
      return requeue(deps, sub, outcome.code);
    case "in_doubt":
      return endSubmission(deps, sub, "in_doubt", outcome.code);
    default:
      // a definite refusal: failed, unless an EARLIER attempt was ambiguous (that attempt's outcome is still unknown)
      return endSubmission(deps, sub, endingFor(sub.ambiguous), outcome.code);
  }
}

export interface DrainResult {
  readonly sent: number;
  readonly failures: readonly string[];
}

/** One org's tick. Failures are PHI-free labels (submission id and error class), collected so one bad row cannot stall the rest. */
export async function drainOrg(
  deps: SubmissionWorkerDeps,
  organizationId: string,
): Promise<DrainResult> {
  const failures: string[] = [];
  let sent = 0;
  for (const id of await listDue(deps, organizationId)) {
    try {
      const leased = await leaseOne(deps, organizationId, id);
      if (leased.kind !== "send") continue;
      await sendOne(deps, leased.sub);
      sent += 1;
    } catch (err) {
      failures.push(`submission ${id}: ${err instanceof Error ? err.name : "failed"}`);
    }
  }
  return { sent, failures };
}

/** How many queued submissions of the org are due (used only to decide whether an unbound tick has anything to refuse). */
async function dueCount(deps: SubmissionWorkerDeps, organizationId: string): Promise<number> {
  return inOrg(deps, organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(S)
      .where(and(eq(S.status, "queued"), lte(S.nextAttemptAt, nowOf(deps))));
    return row?.n ?? 0;
  });
}

/** The cron body. Throws after every org ran when anything failed, so BullMQ retries and the DLQ alert fires. */
export async function runSubmissionDrain(deps: SubmissionWorkerDeps): Promise<DrainResult> {
  const failures: string[] = [];
  let sent = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    if (deps.binding.vendor === null) {
      // Unbound: nothing may be sent and nothing is skipped silently. The route refuses to queue while unbound, so a waiting row
      // means the vendor was removed after queueing: fail loudly.
      try {
        const waiting = await dueCount(deps, organizationId);
        if (waiting > 0) {
          failures.push(`org ${organizationId}: CH_NOT_WIRED (${waiting} submission(s) waiting)`);
        }
      } catch (err) {
        failures.push(`org ${organizationId}: ${err instanceof Error ? err.name : "failed"}`);
      }
      continue;
    }
    try {
      const res = await drainOrg(deps, organizationId);
      sent += res.sent;
      failures.push(...res.failures);
    } catch (err) {
      failures.push(`org ${organizationId}: ${err instanceof Error ? err.name : "failed"}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`commercial submission drain failed: ${failures.join("; ")}`);
  }
  return { sent, failures };
}

const DRAIN_CONCURRENCY = 1;

/** Construct the drain worker (opens a Valkey connection; never at import). */
export function registerM41SubmissionWorker(
  connection: ConnectionOptions,
  deps: SubmissionWorkerDeps,
): Worker {
  return new Worker(M41_CRON_QUEUES.submissionDrain, async () => runSubmissionDrain(deps), {
    connection,
    concurrency: DRAIN_CONCURRENCY,
  });
}

/** Register the repeatable schedule. Returns the `Queue`s to `close()`. */
export async function scheduleM41Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M41_CRON_QUEUES.submissionDrain, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M41_JOB_SCHEDULES.submissionDrain }, removeOnComplete: true },
  );
  return [queue];
}
