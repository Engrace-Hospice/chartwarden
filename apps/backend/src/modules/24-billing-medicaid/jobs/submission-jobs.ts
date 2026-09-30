// apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.ts — WX-PR-011: the M24 §4.9 LIVE
// submit/poll worker wiring. Mirrors apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts's
// submit/retry processor shape file-for-file (per-job `withOrgContext`, RULE 4 fail-closed-unbound ports,
// D2 outbox-only state transitions) — the one structural difference is M24's `dependsOn` DOES include M1, so
// this file imports `@wardenx/db` directly instead of a package-level repository layer.
//
// Unlike M23's platform-wide X12/MAC gateway (one bearer/URL pair from env), Oregon's OHA MMIS endpoint is
// PER-PROVIDER-ENTITY (each PE's own `state_medicaid_trading_partner_credential` row, §3.3) — so the
// `credentials` port here resolves + decrypts the ACTIVE credential row per job, not a fixed config.
//
// SCOPE (documented, WX-PR-011): this drives the wire mechanics (submit → accept/reject/pending-async →
// poll → terminal ack) for whatever claim a caller submits, including a header-only zero-line DRAFT claim
// (per-line assembly from M6/M8 is a separate, still-open follow-up — see write-service-drizzle.ts's
// assembleClaim comment). Real per-tenant OHA/CCO certification remains external-sandbox pending (same
// posture as WX-PR-006/007/008): this binds against the launch-gateway's real HTTP transport when configured,
// and is fully exercised against a fake transport in tests.
import { type DbClient, schema } from "@wardenx/db";
import type {
  MedicaidAdapterRegistry,
  TradingPartnerCredentials,
} from "@wardenx/medicaid-adapters";
import { medicaidClaimMachine } from "@wardenx/medicaid-adapters";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import type { CredentialCipherPort } from "../credential-crypto";
import { isUsableCipher } from "../credential-crypto";
import { M24_QUEUES, M24_QUEUE_PARAMS } from "./queues";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const M24_WORKER_SYSTEM_USER_ID = "";

export interface ClaimSubmitJob {
  readonly organizationId: string;
  readonly claimId: string;
  readonly submissionId: string;
}
export interface ClaimPollJob {
  readonly organizationId: string;
  readonly claimId: string;
  readonly submissionId: string;
}

export interface WorkerOutboxPort {
  publish(tx: Tx, event: { eventName: string; payload: Record<string, unknown> }): Promise<void>;
}

/** Resolve + decrypt the PE's ACTIVE trading-partner credential for a state (fail-closed: null = none). */
export interface CredentialResolverPort {
  resolve(input: {
    organizationId: string;
    providerEntityId: string;
    serviceState: string;
  }): Promise<TradingPartnerCredentials | null>;
}

/** The Drizzle-backed production resolver — decrypts under the injected §8.7 cipher port. */
export function buildDrizzleCredentialResolver(
  db: DbClient,
  cipher: CredentialCipherPort,
): CredentialResolverPort {
  const TP = schema.stateMedicaidTradingPartnerCredential;
  return {
    async resolve({ organizationId, providerEntityId, serviceState }) {
      const rows = await db
        .select()
        .from(TP)
        .where(
          and(
            eq(TP.organizationId, organizationId),
            eq(TP.providerEntityId, providerEntityId),
            eq(TP.serviceState, serviceState),
          ),
        );
      const now = new Date();
      const row = rows.find((r) => r.activeTo === null || r.activeTo >= now);
      if (!row) return null;
      return {
        providerEntityId,
        serviceState,
        channel: row.channel,
        mcoId: row.mcoId,
        tradingPartnerId: row.tradingPartnerId,
        clientId: row.clientId,
        clientSecret: isUsableCipher(row.clientSecretCipher)
          ? cipher.open(organizationId, row.clientSecretCipher as string)
          : null,
        sftpHost: row.sftpHost,
        sftpUser: row.sftpUser,
        sftpKey: isUsableCipher(row.sftpKeyCipher)
          ? cipher.open(organizationId, row.sftpKeyCipher as string)
          : null,
        portalUrl: row.portalUrl,
        additionalConfig: null,
      };
    },
  };
}

export interface M24SubmissionWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  now?: () => Date;
  readonly outbox: WorkerOutboxPort;
  readonly adapters: MedicaidAdapterRegistry;
  readonly credentials: CredentialResolverPort;
}

/** Update the submission row + drive the claim-state transition (no outbox — callers publish the exact
 * event their outcome needs; the five §4.11 events this worker can reach have five different shapes). */
async function terminalizeSubmissionAndTransition(
  tx: Tx,
  claim: typeof schema.medicaidClaim.$inferSelect,
  submissionId: string,
  now: Date,
  submissionUpdate: Partial<typeof schema.medicaidSubmission.$inferInsert>,
  // A sync accept/reject is TWO §2.2 edges in one worker tick (e.g. SUBMITTED→ACK_PENDING→ACK_ACCEPTED,
  // the "accepted_sync" wire result immediately implying "ack_accepted" — no separate ack file arrives for
  // a synchronous channel), applied in order; the chain stops at the first illegal/guard-failed hop.
  events: readonly Parameters<typeof medicaidClaimMachine.reduce>[1][],
): Promise<{ toState: string }> {
  const C = schema.medicaidClaim;
  const SUB = schema.medicaidSubmission;
  await tx
    .update(SUB)
    .set({
      ...submissionUpdate,
      terminalAt: submissionUpdate.result === "pending_async" ? null : now,
    })
    .where(eq(SUB.id, submissionId));
  let fromState = claim.state;
  let version = claim.version;
  for (const event of events) {
    const reduced = medicaidClaimMachine.reduce(fromState, event);
    if (reduced.error) break;
    await tx
      .update(C)
      .set({ state: reduced.state, version: version + 1, updatedAt: now })
      .where(eq(C.id, claim.id));
    await tx.insert(schema.medicaidClaimStateHistory).values({
      organizationId: claim.organizationId,
      medicaidClaimId: claim.id,
      fromState,
      toState: reduced.state,
      reason: event,
      triggerSource: "system",
      // F-144 (#248) — `medicaid_claim_state_history.actor_membership_id` is a NULLABLE uuid, commented
      // "null when worker/cron"; this reused `M24_WORKER_SYSTEM_USER_ID` (`""`, the `withOrgContext`
      // `userId` GUC sentinel one call below) for a column that is not a session GUC — every single
      // worker-driven claim transition threw 22P02 ("invalid input syntax for type uuid") on this
      // INSERT, so `runClaimSubmit`/`runClaimPoll` had never completed a single tick in any environment.
      // Found writing this suite's first live test of this file (it has none). `null` is the honest,
      // already-documented value for a system-driven transition.
      actorMembershipId: null,
    });
    fromState = reduced.state;
    version += 1;
  }
  return { toState: fromState };
}

/** `medicaid-claim.submit` (§4.9): drain a `pending` submission — assemble + submit through the state
 * adapter, record the vendor result, and drive SUBMITTED → {ACK_PENDING|POLLING|ACK_REJECTED}. Idempotent:
 * a submission already terminalized (duplicate delivery / redelivery) is a silent no-op. */
export async function runClaimSubmit(
  tx: Tx,
  deps: M24SubmissionWorkerDeps,
  job: ClaimSubmitJob,
): Promise<void> {
  const C = schema.medicaidClaim;
  const SUB = schema.medicaidSubmission;
  const L = schema.medicaidClaimLine;
  const now = (deps.now ?? (() => new Date()))();

  const claimRows = await tx.select().from(C).where(eq(C.id, job.claimId)).limit(1);
  const claim = claimRows[0];
  if (!claim) throw new Error(`M24 claim.submit: claim ${job.claimId} not found`);
  const subRows = await tx.select().from(SUB).where(eq(SUB.id, job.submissionId)).limit(1);
  const submission = subRows[0];
  if (!submission) throw new Error(`M24 claim.submit: submission ${job.submissionId} not found`);
  if (submission.result !== "pending") return; // already terminalized — idempotent no-op

  const adapter = deps.adapters.adapterForState(claim.serviceState);
  const credentials = adapter
    ? await deps.credentials.resolve({
        organizationId: job.organizationId,
        providerEntityId: claim.providerEntityId,
        serviceState: claim.serviceState,
      })
    : null;
  if (!adapter || !credentials) {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      {
        result: "transport_failure",
        errorCode: "NO_CREDENTIAL",
        errorMessage: adapter
          ? "no active trading-partner credential is configured for this provider entity / state"
          : `no adapter registered for state ${claim.serviceState}`,
      },
      ["submission_failed"],
    );
    await publishSubmissionFailed(
      deps,
      tx,
      claim,
      job.submissionId,
      submission.attemptIndex,
      "no adapter or credential bound",
    );
    return;
  }

  const lineRows = await tx
    .select()
    .from(L)
    .where(eq(L.medicaidClaimId, claim.id))
    .orderBy(L.lineNumber);

  let result: Awaited<ReturnType<typeof adapter.submit>>;
  try {
    const assembled = await adapter.assembleSubmissionPayload({
      orgId: job.organizationId,
      claimId: claim.id,
      claimSnapshot: {
        claimId: claim.id,
        patientId: claim.patientId,
        serviceState: claim.serviceState,
        tob: claim.tob,
        serviceFrom: claim.serviceFrom.toISOString().slice(0, 10),
        serviceTo: claim.serviceTo.toISOString().slice(0, 10),
        mcoId: claim.mcoId,
        medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
        lines: lineRows.map((l) => ({
          lineNumber: l.lineNumber,
          serviceDate: l.serviceDate.toISOString().slice(0, 10),
          levelOfCare: l.levelOfCare,
          revenueCode: l.revenueCode,
          qCode: l.qCode,
          modifiers: [
            l.hcpcsModifier1,
            l.hcpcsModifier2,
            l.hcpcsModifier3,
            l.hcpcsModifier4,
          ].filter((m): m is string => typeof m === "string" && m.length > 0),
          units: l.units,
          rateCents: l.rateAtAssemblyCents,
          chargesCents: l.chargesCents,
          isRb: l.isRb,
        })),
      },
      credentials,
    });
    result = await adapter.submit({
      body: assembled.body,
      idempotencyKey: assembled.idempotencyKey,
      channel: assembled.channel,
      credentials,
    });
  } catch (err) {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      {
        result: "transport_failure",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      ["submission_failed"],
    );
    await publishSubmissionFailed(
      deps,
      tx,
      claim,
      job.submissionId,
      submission.attemptIndex,
      "transport error",
    );
    return;
  }

  await tx
    .update(SUB)
    .set({ adapterVendor: adapter.vendor, adapterVersion: adapter.version })
    .where(eq(SUB.id, job.submissionId));

  if (result.result === "accepted_sync") {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      {
        result: "accepted_sync",
        vendorTransactionId: result.vendorTransactionId,
        submittedAt: now,
      },
      ["accepted_sync", "ack_accepted"],
    );
    const ack = result.ack999 ?? result.ack277ca ?? null;
    const ackId = ack
      ? await writeAck(tx, claim, job.submissionId, ack)
      : await writeAck(tx, claim, job.submissionId, {
          kind: "async_state_specific",
          outcome: "accepted",
          payerClaimControlNumber: null,
        });
    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.acknowledged",
      payload: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        acknowledgmentId: ackId,
        payerClaimControlNumber: ack?.payerClaimControlNumber ?? null,
      },
    });
    await publishAcknowledgmentLetterRequest(deps, tx, claim, ack?.payerClaimControlNumber ?? null);
  } else if (result.result === "pending_async") {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      {
        result: "pending_async",
        vendorTransactionId: result.vendorTransactionId,
        submittedAt: now,
        nextPollAt: new Date(result.nextPollAt),
      },
      ["pending_async"],
    );
    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.submitted",
      payload: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        submissionId: job.submissionId,
        medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
        state: "POLLING",
        channel: claim.mcoId ? "cco_clearinghouse" : "direct_mmis",
        mcoId: claim.mcoId,
        submittedAt: now.toISOString(),
      },
    });
  } else if (result.result === "rejected_sync") {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      {
        result: "rejected_sync",
        vendorTransactionId: result.vendorTransactionId,
        errorCode: result.rejectionCode,
        errorMessage: result.rejectionReason,
      },
      ["rejected_sync"],
    );
    const ackId = await writeAck(tx, claim, job.submissionId, {
      kind: "async_state_specific",
      outcome: "rejected",
      payerClaimControlNumber: null,
      errorCodes: [{ code: result.rejectionCode, message: result.rejectionReason }],
    });
    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.rejected",
      payload: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        acknowledgmentId: ackId,
        rejectionStage: "submit",
        rejectionCodes: [result.rejectionCode],
      },
    });
  } else {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      { result: "transport_failure" },
      ["submission_failed"],
    );
    await publishSubmissionFailed(
      deps,
      tx,
      claim,
      job.submissionId,
      submission.attemptIndex,
      "adapter reported a transport failure",
    );
  }
}

async function publishSubmissionFailed(
  deps: M24SubmissionWorkerDeps,
  tx: Tx,
  claim: typeof schema.medicaidClaim.$inferSelect,
  submissionId: string,
  attemptIndex: number,
  reason: string,
): Promise<void> {
  await deps.outbox.publish(tx, {
    eventName: "m24.medicaid_claim.submission_failed",
    payload: {
      organizationId: claim.organizationId,
      claimId: claim.id,
      submissionId,
      attemptIndex,
      reason,
    },
  });
}

/**
 * F-144 (#248) — M24's own §4.10 transition table gives ACK_ACCEPTED exactly one document-relevant
 * effect ("Document render request to M22"), routed through the dedicated
 * `m24.medicaid_billing.document_render_requested` event M23's §4.10 sibling already established the
 * shape for. Co-emitted in the SAME transaction as `m24.medicaid_claim.acknowledged`, never a separate
 * consumer of that event. `patientId` is `claim.patientId` (NOT NULL) — the same identity the claim row
 * was already filed under, never fabricated (F-099).
 */
async function publishAcknowledgmentLetterRequest(
  deps: M24SubmissionWorkerDeps,
  tx: Tx,
  claim: typeof schema.medicaidClaim.$inferSelect,
  payerClaimControlNumber: string | null,
): Promise<void> {
  await deps.outbox.publish(tx, {
    eventName: "m24.medicaid_billing.document_render_requested",
    payload: {
      organizationId: claim.organizationId,
      kind: "claim_acknowledgment_letter",
      aggregateId: claim.id,
      payload: {
        patientId: claim.patientId,
        medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
        payerClaimControlNumber,
        acknowledgedAt: new Date().toISOString(),
      },
    },
  });
}

/** `medicaid-claim.poll` (§4.9): drain a `pending_async` submission — poll the adapter and drive
 * POLLING → {ACK_ACCEPTED|ACK_REJECTED|ACK_TIMEOUT|POLLING (re-enqueued by the cron)}. */
export async function runClaimPoll(
  tx: Tx,
  deps: M24SubmissionWorkerDeps,
  job: ClaimPollJob,
): Promise<void> {
  const C = schema.medicaidClaim;
  const SUB = schema.medicaidSubmission;
  const now = (deps.now ?? (() => new Date()))();

  const claimRows = await tx.select().from(C).where(eq(C.id, job.claimId)).limit(1);
  const claim = claimRows[0];
  if (!claim) throw new Error(`M24 claim.poll: claim ${job.claimId} not found`);
  const subRows = await tx.select().from(SUB).where(eq(SUB.id, job.submissionId)).limit(1);
  const submission = subRows[0];
  if (!submission) throw new Error(`M24 claim.poll: submission ${job.submissionId} not found`);
  if (submission.result !== "pending_async") return; // already terminal — idempotent no-op
  if (claim.state !== "POLLING") return; // already advanced past polling — idempotent no-op

  const adapter = deps.adapters.adapterForState(claim.serviceState);
  const credentials = adapter
    ? await deps.credentials.resolve({
        organizationId: job.organizationId,
        providerEntityId: claim.providerEntityId,
        serviceState: claim.serviceState,
      })
    : null;
  if (!adapter || !credentials || !submission.vendorTransactionId) return; // nothing pollable — cron retries

  let result: Awaited<ReturnType<typeof adapter.poll>>;
  try {
    result = await adapter.poll({
      vendorTransactionId: submission.vendorTransactionId,
      credentials,
    });
  } catch {
    return; // transport hiccup — the cron will re-tick and retry
  }

  if (result.result === "still_pending") return; // no state change; cron re-ticks
  if (result.result === "accepted") {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      { result: "accepted_sync" },
      ["poll_accepted"],
    );
    const ackId = await writeAck(tx, claim, job.submissionId, result.ack);
    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.acknowledged",
      payload: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        acknowledgmentId: ackId,
        payerClaimControlNumber: result.ack.payerClaimControlNumber ?? null,
      },
    });
    await publishAcknowledgmentLetterRequest(
      deps,
      tx,
      claim,
      result.ack.payerClaimControlNumber ?? null,
    );
  } else if (result.result === "rejected") {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      {
        result: "rejected_sync",
        errorCode: result.rejectionCode,
        errorMessage: result.rejectionReason,
      },
      ["poll_rejected"],
    );
    const ackId = await writeAck(tx, claim, job.submissionId, {
      kind: "async_state_specific",
      outcome: "rejected",
      payerClaimControlNumber: null,
      errorCodes: [{ code: result.rejectionCode, message: result.rejectionReason }],
    });
    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.rejected",
      payload: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        acknowledgmentId: ackId,
        rejectionStage: "poll",
        rejectionCodes: [result.rejectionCode],
      },
    });
  } else {
    await terminalizeSubmissionAndTransition(
      tx,
      claim,
      job.submissionId,
      now,
      { result: "timeout" },
      ["poll_timeout"],
    );
    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.poll_timeout",
      payload: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        submissionId: job.submissionId,
        lastPolledAt: now.toISOString(),
      },
    });
  }
}

async function writeAck(
  tx: Tx,
  claim: typeof schema.medicaidClaim.$inferSelect,
  submissionId: string,
  ack: {
    readonly kind: "sync_999" | "sync_277ca" | "async_state_specific";
    readonly outcome: "accepted" | "rejected" | "partial";
    readonly payerClaimControlNumber?: string | null;
    readonly acceptedLineNumbers?: readonly number[];
    readonly rejectedLineNumbers?: readonly number[];
    readonly errorCodes?: ReadonlyArray<{ code: string; message: string; lineNumber?: number }>;
  },
): Promise<string> {
  const inserted = await tx
    .insert(schema.medicaidAcknowledgment)
    .values({
      organizationId: claim.organizationId,
      medicaidClaimId: claim.id,
      medicaidSubmissionId: submissionId,
      kind: ack.kind,
      outcome: ack.outcome,
      payerClaimControlNumber: ack.payerClaimControlNumber ?? null,
      acceptedLineNumbers: ack.acceptedLineNumbers ?? null,
      rejectedLineNumbers: ack.rejectedLineNumbers ?? null,
      errorCodes: ack.errorCodes ?? null,
    })
    .returning({ id: schema.medicaidAcknowledgment.id });
  return inserted[0]!.id;
}

/** Construct the submit + poll workers. Requires a real adapter registry + credential resolver (the
 * composition root only calls this when a launch gateway is configured — RULE 4 mirrors M23). */
export function registerM24LaunchWorkers(deps: M24SubmissionWorkerDeps): Worker[] {
  const orgWorker = <D extends { organizationId: string }>(
    queue: string,
    concurrency: number,
    run: (tx: Tx, workerDeps: M24SubmissionWorkerDeps, data: D) => Promise<void>,
  ) =>
    new Worker(
      queue,
      async (job) => {
        const data = job.data as D;
        if (!data.organizationId) throw new Error(`M24 ${queue}: job.data.organizationId missing`);
        await withOrgContext(
          deps.db,
          { organizationId: data.organizationId, userId: M24_WORKER_SYSTEM_USER_ID },
          (tx) => run(tx as unknown as Tx, deps, data),
        );
      },
      { connection: deps.connection, concurrency },
    );
  return [
    orgWorker<ClaimSubmitJob>(
      M24_QUEUES.submit,
      M24_QUEUE_PARAMS.submit.concurrency,
      runClaimSubmit,
    ),
    orgWorker<ClaimPollJob>(M24_QUEUES.poll, M24_QUEUE_PARAMS.poll.concurrency, runClaimPoll),
  ];
}

/** The queue-producer side (durable outbox → BullMQ handoff consumes this, see outbox-consumers/). */
export function buildM24SubmissionQueuePort(connection: ConnectionOptions): {
  readonly port: {
    enqueue(
      queueName: "medicaid-claim.submit" | "medicaid-claim.poll",
      jobId: string,
      payload: Record<string, unknown>,
    ): Promise<void>;
  };
  readonly queues: readonly Queue[];
} {
  const cache = new Map<string, Queue>();
  const queueFor = (name: string) => {
    let queue = cache.get(name);
    if (!queue) {
      queue = new Queue(name, { connection });
      cache.set(name, queue);
    }
    return queue;
  };
  return {
    port: {
      async enqueue(queueName, jobId, payload) {
        await queueFor(queueName).add(queueName, payload, {
          jobId: `m24:${queueName}:${jobId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        });
      },
    },
    get queues() {
      return [...cache.values()];
    },
  };
}

export function buildM24SubmissionWorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  now?: () => Date;
  outbox: WorkerOutboxPort;
  adapters: MedicaidAdapterRegistry;
  credentials: CredentialResolverPort;
}): M24SubmissionWorkerDeps {
  return deps;
}
