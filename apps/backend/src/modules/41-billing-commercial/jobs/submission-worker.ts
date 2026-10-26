// apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts - send queued commercial submissions through the platform
// ClearinghouseTransport (ADR-0053 D10, ADR-0100 D4/D5/D9). Mirrors M23's `transportUpload` posture:
//   - ONE path: `binding.transport.submitClaim`. No direct-to-payer channel, no fallback. `CLEARINGHOUSE_VENDOR` unset
//     (`binding.vendor === null`) means nothing is sent and the tick FAILS while anything is waiting (never a silent skip).
//   - the send gate is judged AGAIN at send time on the current facts (an authorization voided or an enrollment ended since the
//     request); a refusal ends the submission as `failed` and the claim stays `ready`.
//   - `submitted` is written only from the transport's receipt, in the same transaction as the submission's `sent`, the history row and
//     `m41.claim.submitted`. A degraded answer never moves the claim.
//   - the attempt store behind the transport is the idempotency authority (D6): the idempotency key is `m41.claim.<submissionId>`, the
//     payload is deterministic (interchange number and stamp come from the submission row), so a retry after a crash between
//     the transport's accept and our record replays the original receipt instead of sending twice.
//   - an ambiguous answer (CH_IN_DOUBT, or the transport throwing) is `in_doubt`: it is never resent automatically; the
//     live-submission slot stays held until reconciled. A send is never retried blind.
// The 837I (it carries the member id) exists only in a local variable between render and send: never stored, never logged.
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

/** Submissions leased per org per tick. */
export const DRAIN_BATCH = 20;
/** A leased submission is not due again for this long (covers render + the transport call; a crash re-delivers after it). */
export const LEASE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export const FAILURE = {
  RENDER_INCOMPLETE: "COMMERCIAL_837I_INCOMPLETE",
  BILLING_NPI_MISSING: "COMMERCIAL_BILLING_NPI_MISSING",
  EXHAUSTED: "COMMERCIAL_SUBMISSION_EXHAUSTED",
  TRANSPORT_FAULT: "COMMERCIAL_TRANSPORT_FAULT",
} as const;

export type SendOutcome =
  | { readonly kind: "retry"; readonly code: string }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "in_doubt"; readonly code: string };

/** What a degraded transport answer means for the submission. Pure. */
export function classifyTransportRefusal(code: string): SendOutcome {
  if (code === CH.UNAVAILABLE) return { kind: "retry", code };
  if (code === CH.IN_DOUBT) return { kind: "in_doubt", code };
  return { kind: "failed", code };
}

/** Delay before attempt `n + 1` after `n` failed attempts: 1, 2, 4 ... minutes, capped at one hour. Pure. */
export function retryDelayMs(attemptsMade: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1));
}

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

/** Take due queued submissions: bump the attempt count and push `next_attempt_at` out by the lease. Rows over the cap are returned apart. */
async function lease(
  deps: SubmissionWorkerDeps,
  organizationId: string,
): Promise<{ readonly due: SubmissionRow[]; readonly exhausted: SubmissionRow[] }> {
  return inOrg(deps, organizationId, async (tx) => {
    const at = nowOf(deps);
    const S = schema.commercialSubmissions;
    const rows = await tx
      .select()
      .from(S)
      .where(and(eq(S.status, "queued"), lte(S.nextAttemptAt, at)))
      .orderBy(asc(S.nextAttemptAt))
      .limit(DRAIN_BATCH)
      .for("update", { skipLocked: true });
    const due: SubmissionRow[] = [];
    const exhausted: SubmissionRow[] = [];
    for (const row of rows) {
      if (row.attemptCount >= COMMERCIAL_SUBMISSION_MAX_ATTEMPTS) {
        exhausted.push(row);
        continue;
      }
      const [leased] = await tx
        .update(S)
        .set({
          attemptCount: row.attemptCount + 1,
          nextAttemptAt: new Date(at.getTime() + LEASE_MS),
          updatedAt: at,
        })
        .where(eq(S.id, row.id))
        .returning();
      if (leased) due.push(leased);
    }
    return { due, exhausted };
  });
}

/** End a submission without a send: `failed` or `in_doubt`, with a stable code and the event. The claim is left as it is. */
async function endSubmission(
  deps: SubmissionWorkerDeps,
  sub: SubmissionRow,
  status: "failed" | "in_doubt",
  code: string,
): Promise<void> {
  const stable = safeCode(code);
  await inOrg(deps, sub.organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const [ended] = await tx
      .update(S)
      .set({ status, lastFailureCode: stable, updatedAt: nowOf(deps) })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")))
      .returning({ id: S.id });
    if (!ended) return; // another tick already settled it
    await deps.outbox.publish(tx, {
      eventName: "m41.claim.submit_failed",
      organizationId: sub.organizationId,
      aggregateKind: "commercial_submission",
      aggregateId: sub.id,
      payload: { claimId: sub.claimId, submissionId: sub.id, status, code: stable },
    });
  });
  deps.log?.({ event: `submission.${status}`, code: stable, submissionId: sub.id });
}

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
        clearinghouseSubmissionId: receiptId.slice(0, 256),
        sentAt: at,
        lastFailureCode: null,
        updatedAt: at,
      })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")))
      .returning({ id: S.id });
    if (!sent) return; // settled by another tick (its own transaction wrote the claim move)
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

/** Put a retryable failure back in the queue after its backoff. */
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
        lastFailureCode: safeCode(code),
        updatedAt: at,
      })
      .where(and(eq(S.id, sub.id), eq(S.status, "queued")));
  });
  deps.log?.({ event: "submission.retry", code: safeCode(code), submissionId: sub.id });
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

async function sendOne(deps: SubmissionWorkerDeps, sub: SubmissionRow): Promise<void> {
  const refusal = await regate(deps, sub);
  if (refusal !== null) return endSubmission(deps, sub, "failed", refusal);

  const context = await deps.contexts.contextFor(
    sub.organizationId,
    sub.providerEntityId,
    sub.clearinghousePayerId,
  );
  if (context === null) return endSubmission(deps, sub, "failed", FAILURE.BILLING_NPI_MISSING);

  let rendered: Render837iResult;
  try {
    rendered = await deps.renderer.render(workerActor(sub), {
      claimId: sub.claimId,
      interchangeControlNumber: sub.interchangeControlNumber,
      usage: context.usage === "production" ? "P" : "T",
      createdAt: sub.requestedAt,
    });
  } catch (err) {
    // A typed refusal (blocked since the gate, no longer ready) is final; anything else is unexpected and re-delivered by the lease.
    if (err instanceof ChartWardenError) return endSubmission(deps, sub, "failed", err.code);
    throw err;
  }
  if (!rendered.ok) return endSubmission(deps, sub, "failed", FAILURE.RENDER_INCOMPLETE);

  let outcome: SendOutcome | { readonly kind: "accepted"; readonly receiptId: string };
  try {
    const result = await deps.binding.transport.submitClaim(context, {
      kind: "claim",
      controlNumber: sub.controlNumber,
      idempotencyKey: `m41.claim.${sub.id}`,
      payload: { format: "x12", x12: rendered.x12 },
    });
    outcome = result.ok
      ? { kind: "accepted", receiptId: result.data.clearinghouseSubmissionId }
      : classifyTransportRefusal(result.degraded.code);
  } catch {
    // The port promises never to throw; if it does, whether the file left is unknown. Never resent blind.
    outcome = { kind: "in_doubt", code: FAILURE.TRANSPORT_FAULT };
  }
  if (outcome.kind === "accepted") return recordAccepted(deps, sub, outcome.receiptId);
  if (outcome.kind === "retry") return requeue(deps, sub, outcome.code);
  return endSubmission(deps, sub, outcome.kind, outcome.code);
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
  const { due, exhausted } = await lease(deps, organizationId);
  for (const sub of exhausted) await endSubmission(deps, sub, "failed", FAILURE.EXHAUSTED);
  let sent = 0;
  for (const sub of due) {
    try {
      await sendOne(deps, sub);
      sent += 1;
    } catch (err) {
      failures.push(`submission ${sub.id}: ${err instanceof Error ? err.name : "failed"}`);
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
      const waiting = await dueCount(deps, organizationId);
      if (waiting > 0)
        failures.push(`org ${organizationId}: CH_NOT_WIRED (${waiting} submission(s) waiting)`);
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
  if (failures.length > 0)
    throw new Error(`commercial submission drain failed: ${failures.join("; ")}`);
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
