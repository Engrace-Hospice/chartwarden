// apps/backend/src/modules/18-evv/jobs/submission-worker.ts — the §4.8 `m18.aggregator-submitter` drain and
// `m18.aggregator-response-poller` per-org workers (GAP-056). Both drive ONE row at a time through the pure
// D7 machine via `dispatchSubmission` / `pollSubmissionOnce`; the aggregator is reached ONLY through the injected
// `EvvAggregatorAdapter` (resolved by `StateAggregatorRegistry`) and credentials through `AggregatorCredentialStore`
// — this file never names a vendor or an endpoint (§25.14).
//
// CONCURRENCY. No DB transaction spans an external call. Each row is CLAIMED with a version-checked
// `queued → submitting` update (a competing tick, or an operator cancel, loses the compare-and-set and the row is
// skipped), the adapter is called with no tx open, then the result is applied with a second version-checked update
// + the outbox events in one tx. A crash between the two leaves `submitting`; the next tick re-queues a stale one
// (`circuit_retry`). The adapter idempotency key (the event-pair hash) makes the re-submit a vendor-side no-op.
//
// RETRY. A transport failure re-queues with exponential backoff (`submitBackoffMs`); once `attempt_count` reaches
// `M18_SUBMIT_MAX_ATTEMPTS` the machine's `retries_exhausted` lands the row in `timeout` (the DLQ-equivalent: the
// critical `m18.evv.aggregator_timeout` event fires and an operator resubmits). A pre-call failure (credentials or a
// fact unavailable) releases the claim WITHOUT consuming an attempt and is rethrown at the end of the tick so the
// BullMQ job fails visibly (the failed set is the DLQ) — never a silent skip.
import { type DbClient, schema } from "@chartwarden/db";
import type { BuildSubmissionPayloadArgs } from "@chartwarden/evv-aggregators";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { submissionServiceTypeCode } from "../capture-classification";
import { transitionAggregatorSubmission } from "../domain/aggregator-submission";
import type { EvvSideEffect } from "../domain/effects";
import type { EvvWriteOutboxPort } from "../evv-route-service-db";
import {
  type SubmissionPassResult,
  dispatchSubmission,
  pollSubmissionOnce,
} from "../submission-flow";
import { type EvvAggregatorDeps, adapterFor } from "./ports";
import {
  M18_POLL_DEADLINE_MS,
  M18_SUBMITTING_STALE_MS,
  M18_SUBMIT_MAX_ATTEMPTS,
  M18_TICK_BATCH_LIMIT,
  submitBackoffMs,
} from "./queues";

const AGG = schema.evvAggregatorSubmission;
const EVENT = schema.evvEvent;
const REGISTRATION = schema.evvVisitRegistrations;

type SubmissionRow = typeof AGG.$inferSelect;

export interface AggregatorWorkerDeps {
  readonly db: DbClient;
  readonly outbox: EvvWriteOutboxPort;
  readonly aggregator: EvvAggregatorDeps;
  readonly now?: () => Date;
}

export interface AggregatorTickResult {
  readonly processed: number;
}

const MS_PER_MINUTE = 60_000;
const nowOf = (deps: AggregatorWorkerDeps): Date => (deps.now ?? (() => new Date()))();

/** Run `fn` per row, collect row failures, and rethrow them together after the batch (one bad row never blocks the rest). */
async function eachRow(
  label: string,
  rows: readonly SubmissionRow[],
  fn: (row: SubmissionRow) => Promise<boolean>,
): Promise<AggregatorTickResult> {
  const errors: unknown[] = [];
  let processed = 0;
  for (const row of rows) {
    try {
      if (await fn(row)) processed += 1;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `${label}: ${errors.length} of ${rows.length} submission(s) failed`,
    );
  }
  return { processed };
}

// ── submitter ────────────────────────────────────────────────────────────────────────────────────────────

/** One org's submitter tick: re-queue stale `submitting` rows, then drain due `queued` rows (bounded). */
export async function runAggregatorSubmitterForOrg(
  deps: AggregatorWorkerDeps,
  organizationId: string,
): Promise<AggregatorTickResult> {
  const now = nowOf(deps);
  await requeueStaleSubmitting(deps, organizationId, now);
  const due = await withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) =>
    (raw as DbClient)
      .select()
      .from(AGG)
      .where(
        and(
          eq(AGG.organizationId, organizationId),
          eq(AGG.status, "queued"),
          or(isNull(AGG.nextRetryAt), lte(AGG.nextRetryAt, now)),
        ),
      )
      .orderBy(asc(AGG.createdAt))
      .limit(M18_TICK_BATCH_LIMIT),
  );
  return eachRow("M18_AGGREGATOR_SUBMITTER", due, (row) =>
    submitOne(deps, organizationId, row, now),
  );
}

async function requeueStaleSubmitting(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  now: Date,
): Promise<void> {
  const staleBefore = new Date(now.getTime() - M18_SUBMITTING_STALE_MS);
  await withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const tx = raw as DbClient;
    const stale = await tx
      .select()
      .from(AGG)
      .where(
        and(
          eq(AGG.organizationId, organizationId),
          eq(AGG.status, "submitting"),
          lte(AGG.lastAttemptAt, staleBefore),
        ),
      )
      .limit(M18_TICK_BATCH_LIMIT);
    for (const row of stale) {
      const t = transitionAggregatorSubmission("submitting", { type: "circuit_retry" });
      await tx
        .update(AGG)
        .set({ status: t.status, version: row.version + 1, updatedAt: now })
        .where(and(eq(AGG.id, row.id), eq(AGG.version, row.version)));
    }
  });
}

/** Claim, call the adapter, apply. Returns false when the claim was lost (nothing was submitted). */
async function submitOne(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
  now: Date,
): Promise<boolean> {
  const claimed = await claimForSubmit(deps, organizationId, row, now);
  if (!claimed) return false;

  let pass: SubmissionPassResult;
  try {
    const ctx = await resolveSubmitContext(deps, organizationId, claimed);
    pass = await dispatchSubmission({
      adapter: ctx.adapter,
      credentials: ctx.credentials,
      payloadArgs: ctx.payloadArgs,
    });
  } catch (error) {
    await releaseClaim(deps, organizationId, claimed, now, error);
    throw error;
  }
  await applySubmitPass(deps, organizationId, claimed, pass, now);
  return true;
}

async function claimForSubmit(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
  now: Date,
): Promise<SubmissionRow | null> {
  const t = transitionAggregatorSubmission("queued", { type: "dispatch" });
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const [claimed] = await (raw as DbClient)
      .update(AGG)
      .set({
        status: t.status,
        attemptCount: row.attemptCount + (t.incrementsAttempt ? 1 : 0),
        lastAttemptAt: now,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(and(eq(AGG.id, row.id), eq(AGG.version, row.version), eq(AGG.status, "queued")))
      .returning();
    return claimed ?? null;
  });
}

interface SubmitContext {
  readonly adapter: NonNullable<ReturnType<typeof adapterFor>>;
  readonly credentials: Awaited<ReturnType<EvvAggregatorDeps["credentials"]["resolve"]>>;
  readonly payloadArgs: BuildSubmissionPayloadArgs;
}

async function resolveSubmitContext(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
): Promise<SubmitContext> {
  const adapter = adapterFor(deps.aggregator.registry, row.stateCode);
  if (!adapter) throw new Error(`no aggregator adapter for state ${row.stateCode}`);
  if (!row.checkInEventId || !row.checkOutEventId) {
    throw new Error(`submission ${row.id} has no event pair`);
  }
  const { checkIn, checkOut, providerEntityId, registrationServiceTypeCode } = await loadEventPair(
    deps,
    organizationId,
    row,
  );
  const patientStateIdentifier = await deps.aggregator.facts.patientStateIdentifier(
    organizationId,
    checkOut.patientId,
  );
  if (patientStateIdentifier === null) {
    throw new Error(`patient state identifier unavailable for submission ${row.id}`);
  }
  const clinicianNpi = await deps.aggregator.facts.clinicianNpi(
    organizationId,
    checkOut.postingMembershipId,
  );
  const credentials = await deps.aggregator.credentials.resolve({
    providerEntityId,
    vendor: row.aggregatorVendor,
    stateCode: row.stateCode,
  });
  const minutes = Math.round(
    (checkOut.capturedAt.getTime() - checkIn.capturedAt.getTime()) / MS_PER_MINUTE,
  );
  return {
    adapter,
    credentials,
    payloadArgs: {
      orgId: organizationId as BuildSubmissionPayloadArgs["orgId"],
      visitId: row.visitId as BuildSubmissionPayloadArgs["visitId"],
      checkInEventId: row.checkInEventId,
      checkOutEventId: row.checkOutEventId,
      serviceTypeCode: submissionServiceTypeCode(
        checkOut.serviceTypeCode,
        registrationServiceTypeCode,
      ),
      clinicianNpi,
      patientStateIdentifier,
      encounterDurationMinutes: Math.max(0, minutes),
    },
  };
}

async function loadEventPair(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
) {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const tx = raw as DbClient;
    const events = await tx
      .select({
        id: EVENT.id,
        patientId: EVENT.patientId,
        postingMembershipId: EVENT.postingMembershipId,
        serviceTypeCode: EVENT.serviceTypeCode,
        capturedAt: EVENT.capturedAt,
      })
      .from(EVENT)
      .where(
        and(
          eq(EVENT.organizationId, organizationId),
          inArray(EVENT.id, [row.checkInEventId as string, row.checkOutEventId as string]),
        ),
      );
    const checkIn = events.find((e) => e.id === row.checkInEventId);
    const checkOut = events.find((e) => e.id === row.checkOutEventId);
    const [registration] = await tx
      .select({
        providerEntityId: REGISTRATION.providerEntityId,
        serviceTypeCode: REGISTRATION.serviceTypeCode,
      })
      .from(REGISTRATION)
      .where(
        and(eq(REGISTRATION.organizationId, organizationId), eq(REGISTRATION.visitId, row.visitId)),
      )
      .limit(1);
    if (!checkIn || !checkOut || !registration) {
      throw new Error(
        `submission ${row.id}: event pair or visit registration not found in this org`,
      );
    }
    return {
      checkIn,
      checkOut,
      providerEntityId: registration.providerEntityId,
      registrationServiceTypeCode: registration.serviceTypeCode,
    };
  });
}

/** A pre-call failure consumed no attempt: back to `queued` with a backoff so the tick does not hot-loop. */
async function releaseClaim(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  claimed: SubmissionRow,
  now: Date,
  _error: unknown,
): Promise<void> {
  const t = transitionAggregatorSubmission("submitting", { type: "circuit_retry" });
  await withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    await (raw as DbClient)
      .update(AGG)
      .set({
        status: t.status,
        attemptCount: Math.max(0, claimed.attemptCount - 1),
        nextRetryAt: new Date(now.getTime() + submitBackoffMs(claimed.attemptCount)),
        version: claimed.version + 1,
        updatedAt: now,
      })
      .where(and(eq(AGG.id, claimed.id), eq(AGG.version, claimed.version)));
  });
}

async function applySubmitPass(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  claimed: SubmissionRow,
  pass: SubmissionPassResult,
  now: Date,
): Promise<void> {
  if (pass.status !== "queued") {
    await persistPass(deps, organizationId, claimed, pass, now, {
      submittedAt: pass.status === "rejected" ? null : now,
    });
    return;
  }
  // transport_failure → the machine says `queued`; either schedule the retry or spend the budget.
  const exhausted = claimed.attemptCount >= M18_SUBMIT_MAX_ATTEMPTS;
  const t = transitionAggregatorSubmission(
    "submitting",
    exhausted ? { type: "retries_exhausted" } : { type: "circuit_retry" },
  );
  const vendorRetryAt = pass.nextActionAt ? new Date(pass.nextActionAt) : null;
  const backoffAt = new Date(now.getTime() + submitBackoffMs(claimed.attemptCount));
  const nextRetryAt =
    t.status === "queued"
      ? vendorRetryAt && vendorRetryAt > backoffAt
        ? vendorRetryAt
        : backoffAt
      : null;
  await persistPass(
    deps,
    organizationId,
    claimed,
    {
      ...pass,
      status: t.status,
      effects: t.effects,
      nextActionAt: nextRetryAt?.toISOString() ?? null,
    },
    now,
    {},
  );
}

// ── poller ───────────────────────────────────────────────────────────────────────────────────────────────

/** One org's poller tick: poll every due `submitted` row once; a row past the vendor SLA window times out. */
export async function runAggregatorPollerForOrg(
  deps: AggregatorWorkerDeps,
  organizationId: string,
): Promise<AggregatorTickResult> {
  const now = nowOf(deps);
  const due = await withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) =>
    (raw as DbClient)
      .select()
      .from(AGG)
      .where(
        and(
          eq(AGG.organizationId, organizationId),
          eq(AGG.status, "submitted"),
          or(isNull(AGG.nextRetryAt), lte(AGG.nextRetryAt, now)),
        ),
      )
      .orderBy(asc(AGG.submittedAt))
      .limit(M18_TICK_BATCH_LIMIT),
  );
  return eachRow("M18_AGGREGATOR_POLLER", due, (row) => pollOne(deps, organizationId, row, now));
}

async function pollOne(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
  now: Date,
): Promise<boolean> {
  const pastDeadline =
    row.submittedAt !== null && now.getTime() - row.submittedAt.getTime() > M18_POLL_DEADLINE_MS;
  const pass = pastDeadline ? timeoutPass(row) : await pollVendor(deps, organizationId, row);
  return persistPass(deps, organizationId, row, pass, now, {});
}

function timeoutPass(row: SubmissionRow): SubmissionPassResult {
  const t = transitionAggregatorSubmission("submitted", {
    type: "poll_result",
    result: { result: "timeout" },
  });
  return {
    status: t.status,
    transactionId: row.aggregatorTransactionId,
    rejectionCode: null,
    rejectionReason: null,
    nextActionAt: null,
    effects: t.effects,
    awaitingPoll: false,
  };
}

async function pollVendor(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
): Promise<SubmissionPassResult> {
  const adapter = adapterFor(deps.aggregator.registry, row.stateCode);
  if (!adapter) throw new Error(`no aggregator adapter for state ${row.stateCode}`);
  if (!row.aggregatorTransactionId)
    throw new Error(`submission ${row.id} has no transaction id to poll`);
  const reg = await withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const [r] = await (raw as DbClient)
      .select({ providerEntityId: REGISTRATION.providerEntityId })
      .from(REGISTRATION)
      .where(
        and(eq(REGISTRATION.organizationId, organizationId), eq(REGISTRATION.visitId, row.visitId)),
      )
      .limit(1);
    return r ?? null;
  });
  if (!reg) throw new Error(`submission ${row.id}: visit registration not found in this org`);
  const credentials = await deps.aggregator.credentials.resolve({
    providerEntityId: reg.providerEntityId,
    vendor: row.aggregatorVendor,
    stateCode: row.stateCode,
  });
  return pollSubmissionOnce({ adapter, credentials, transactionId: row.aggregatorTransactionId });
}

// ── shared persistence ───────────────────────────────────────────────────────────────────────────────────

interface PersistExtras {
  readonly submittedAt?: Date | null;
}

/** Apply a pass result with a version-checked update + its outbox effects in ONE tx. False when the CAS was lost. */
async function persistPass(
  deps: AggregatorWorkerDeps,
  organizationId: string,
  row: SubmissionRow,
  pass: SubmissionPassResult,
  now: Date,
  extras: PersistExtras,
): Promise<boolean> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const tx = raw as DbClient;
    const nextAt = pass.nextActionAt ? new Date(pass.nextActionAt) : null;
    const [updated] = await tx
      .update(AGG)
      .set({
        status: pass.status,
        aggregatorTransactionId: pass.transactionId ?? row.aggregatorTransactionId,
        aggregatorResponseAt: now,
        aggregatorRejectionCode: pass.rejectionCode,
        aggregatorRejectionReason: pass.rejectionReason,
        submittedAt: extras.submittedAt ?? row.submittedAt,
        nextRetryAt: pass.status === "queued" || pass.status === "submitted" ? nextAt : null,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(and(eq(AGG.id, row.id), eq(AGG.version, row.version)))
      .returning({ id: AGG.id, attemptCount: AGG.attemptCount });
    if (!updated) return false;
    await publishEffects(deps.outbox, tx, organizationId, row, pass, updated.attemptCount, now);
    return true;
  });
}

async function publishEffects(
  outbox: EvvWriteOutboxPort,
  tx: DbClient,
  organizationId: string,
  row: SubmissionRow,
  pass: SubmissionPassResult,
  attemptCount: number,
  now: Date,
): Promise<void> {
  const base = {
    submissionId: row.id,
    visitId: row.visitId,
    stateCode: row.stateCode,
  };
  const transactionId = pass.transactionId ?? row.aggregatorTransactionId;
  const payloads: Record<string, Record<string, unknown>> = {
    "m18.evv.aggregator_submitted": {
      ...base,
      aggregatorVendor: row.aggregatorVendor,
      aggregatorTransactionId: transactionId,
    },
    "m18.evv.aggregator_accepted": {
      ...base,
      aggregatorTransactionId: transactionId,
      acceptedAt: now.toISOString(),
    },
    "m18.evv.aggregator_rejected": {
      ...base,
      rejectionCode: pass.rejectionCode ?? "UNSPECIFIED",
      rejectionReason: pass.rejectionReason ?? "",
    },
    "m18.evv.aggregator_timeout": { ...base, attemptCount },
  };
  for (const effect of pass.effects as readonly EvvSideEffect[]) {
    if (effect.kind !== "outbox") continue;
    const payload = payloads[effect.event];
    if (!payload) continue;
    await outbox.publish(tx, {
      eventName: effect.event,
      organizationId,
      aggregateKind: "evv_aggregator_submission",
      aggregateId: row.id,
      payload,
    });
  }
}
