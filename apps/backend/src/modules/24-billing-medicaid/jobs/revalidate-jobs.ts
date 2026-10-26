// apps/backend/src/modules/24-billing-medicaid/jobs/revalidate-jobs.ts — F-165 (#248, m24 group): the M24
// `medicaid-revalidate` queue's real producer-enqueue port AND its real worker/processor — the
// "trigger-revalidate" third of the m24 `handlers-unbound` deferred-consumers group
// (`m5.patient.updated` / `m5.patient.address_changed` / `m8.encounter.signed`). M24's own
// `M24_SUBSCRIPTION_MAP` (`consumers/subscription-map.ts`) has named all three for this exact action
// since F-140 — a real handler (`handleUpstreamChange` → `enqueueRevalidation`) with no live store or
// worker anywhere behind it (F-155's own finding: "`jobs/m24-jobs.ts` has no worker for the
// `medicaid-revalidate` queue `jobs/queues.ts` names").
//
// Mirrors `submission-jobs.ts`'s shape (BullMQ + Drizzle + per-job `withOrgContext`, the same
// `orgWorker` pattern) and the F-153 M23 `revalidate.consumer` precedent
// (`23-billing-medicare/jobs/m23-jobs.ts`'s `runRevalidateConsumer` / `buildM23RevalidateEnqueuePort`)
// — one structural difference from M23: M23's revalidate trigger fed an ALREADY-registered
// `revalidate.consumer` worker (`runValidationRun`, delegating to a separately-bound
// `ClaimValidationRunnerPort`); M24 had NEITHER half wired, so this file builds both the enqueue
// port AND the processor, reusing the EXACT rule-run + transition logic
// `routes/write-service-drizzle.ts`'s `validateClaim` already performs for a manual click
// (`runMedicaidRules` over `DEFAULT_MEDICAID_RULES`, the identical `MedicaidValidationContext` shape,
// every unbound reader seam degrading honestly to its null/false default) — no new validation rule or
// financial semantics are introduced here, only the SAME cycle triggered by an upstream fact change
// instead of a button click.
//
// SYSTEM-ACTOR SAFE (the F-144 lesson, applied a second time in this module): `medicaid_claim
// .updated_by_membership_id` is NOT NULL with no consumer escape hatch, so this worker's claim UPDATE
// never touches it (a partial `.set()`, exactly like `terminalizeSubmissionAndTransition` in
// `submission-jobs.ts` already does for the identical reason) — the claim's last real human editor
// stays on record rather than a fabricated one. `medicaid_validation_run.actor_membership_id` and
// `medicaid_claim_state_history.actor_membership_id` are BOTH nullable
// (`packages/db/src/schema/medicaid-billing/validation.ts` / `claim-history.ts`, the latter's own
// comment: "null when worker/cron") — both are written `null` here, `triggerSource: "consumer"`.
//
// REVALIDATE-ELIGIBLE STATES ARE DERIVED, NOT HARDCODED: `REVALIDATE_SOURCE_STATES` is computed from
// the pure `medicaidClaimMachine.MEDICAID_CLAIM_TRANSITIONS` table itself (every `from` state with a
// `revalidate` edge — today READY / FAILED_VALIDATION / ACK_REJECTED) rather than a second, hand-kept
// list that could drift from the machine's own definition. A claim not in one of those states when its
// job runs is silently skipped (idempotent — it already advanced past the fact this job reacts to).
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  DEFAULT_MEDICAID_RULES,
  DEFAULT_MEDICAID_RULE_SET_VERSION,
  type MedicaidValidationContext,
  medicaidClaimMachine,
  runMedicaidRules,
} from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { M24_QUEUES, M24_QUEUE_PARAMS } from "./queues";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const M24_WORKER_SYSTEM_USER_ID = "";

const day = (d: Date | string): string =>
  (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

/** Every `medicaid_claim.state` from which the pure machine's own table legalizes a `revalidate` edge. */
const REVALIDATE_SOURCE_STATES = Array.from(
  new Set(
    medicaidClaimMachine.MEDICAID_CLAIM_TRANSITIONS.filter((t) => t.event === "revalidate").map(
      (t) => t.from,
    ),
  ),
) as (typeof schema.medicaidClaim.state.enumValues)[number][];

export interface RevalidateJob {
  readonly organizationId: string;
  /** The originating outbox event id — the BullMQ jobId + the per-run idempotency key both derive from it. */
  readonly eventId: string;
  readonly eventName: string;
  readonly patientId: string;
}

/** The `medicaid-revalidate` outbox emitter — the caller-facing shape `bindCallerModule` actually
 *  provides (organizationId/aggregateKind/aggregateId REQUIRED, the F-102 write-service.ts lesson —
 *  NOT the narrower 2-field shape `submission-jobs.ts`'s `WorkerOutboxPort` declares). */
export interface RevalidateWorkerOutboxPort {
  publish(
    tx: Tx,
    event: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface RevalidateWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  now?: () => Date;
  readonly outbox: RevalidateWorkerOutboxPort;
}

/**
 * `medicaid-revalidate` (§4.9): for one patient's claims currently in a revalidate-eligible state,
 * re-run the SAME §2.3 rule cycle `validateClaim` runs for a manual click. Idempotent per claim — a
 * claim no longer eligible (already advanced past it, e.g. submitted between enqueue and processing)
 * is silently skipped, never forced back into VALIDATING.
 */
export async function runMedicaidRevalidate(
  tx: Tx,
  deps: RevalidateWorkerDeps,
  job: RevalidateJob,
): Promise<void> {
  const C = schema.medicaidClaim;
  const L = schema.medicaidClaimLine;
  const VR = schema.medicaidValidationRun;
  const VRES = schema.medicaidValidationResult;
  const SH = schema.medicaidClaimStateHistory;
  const now = (deps.now ?? (() => new Date()))();
  const RULES_BY_KEY = new Map(DEFAULT_MEDICAID_RULES.map((r) => [r.key, r]));

  const claims = await tx
    .select()
    .from(C)
    .where(
      and(
        eq(C.organizationId, job.organizationId),
        eq(C.patientId, job.patientId),
        inArray(C.state, REVALIDATE_SOURCE_STATES),
      ),
    )
    // Lock every claim up front, in id order: applyOverride / validateClaim lock one claim, so a consistent order
    // here means no deadlock between two workers on the same patient. FOR UPDATE re-checks the state filter after
    // a wait, so a claim a concurrent validate already advanced is skipped, and an override racing this run
    // blocks until we commit and then sees the new validationRunIdLatest (409 superseded).
    .orderBy(C.id)
    .for("update");

  for (const claim of claims) {
    const lineRows = await tx
      .select()
      .from(L)
      .where(eq(L.medicaidClaimId, claim.id))
      .orderBy(L.lineNumber);

    // The identical context shape `write-service-drizzle.ts`'s `validateClaim` builds — every reader
    // seam is UNBOUND here too (this worker has no seam ports of its own), so the seam-gated rules
    // SKIP `seam_not_bound` exactly as they do for a manual validate. No new rule input is invented.
    const ctx: MedicaidValidationContext = {
      orgId: job.organizationId,
      asOfDate: day(claim.serviceFrom),
      serviceState: claim.serviceState,
      claim: {
        claimId: claim.id,
        providerEntityId: claim.providerEntityId,
        patientId: claim.patientId,
        serviceState: claim.serviceState,
        kind: claim.kind,
        tob: claim.tob as MedicaidValidationContext["claim"]["tob"],
        serviceFrom: day(claim.serviceFrom),
        serviceTo: day(claim.serviceTo),
        replacesClaimId: claim.replacesClaimId ?? null,
        medicareClaimId: claim.medicareClaimId ?? null,
        rbArrangementId: claim.rbArrangementId ?? null,
        isDualEligible: claim.medicareClaimId != null,
      },
      lines: lineRows.map((l) => ({
        claimLineId: l.id,
        serviceDate: day(l.serviceDate),
        levelOfCare: l.levelOfCare,
        revenueCode: l.revenueCode,
        qCode: l.qCode,
        modifiers: [l.hcpcsModifier1, l.hcpcsModifier2, l.hcpcsModifier3, l.hcpcsModifier4].filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        ),
        rateAtAssemblyCents: l.rateAtAssemblyCents,
        isRb: l.isRb,
        backingEncounterIds: [],
      })),
      eligibility: null,
      recipientIdFormatValid: null,
      mcoRouting: null,
      nfResidentDays: [],
      rbArrangement: null,
      rbDays: [],
      rateLookups: [],
      medicareSecondary: null,
      evvBrackets: [],
      capProjection: null,
      modifiersSatisfied: null,
      documentationSatisfied: null,
      adapterMetadata: {
        acceptsDocumentedMissingEvv: false,
        combinesHospiceAndRb: claim.kind === "combined_hospice_rb",
        supportedTobs: [claim.tob],
      },
      seams: {
        eligibilityBound: false,
        rbBound: false,
        rateScheduleBound: false,
        medicareClaimBound: false,
        capProjectionBound: false,
        mdmBound: false,
        adapterBound: false,
      },
    };

    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, ctx);
    const runId = randomUUID();
    const fromState = claim.state;

    await tx.insert(VR).values({
      id: runId,
      organizationId: job.organizationId,
      medicaidClaimId: claim.id,
      ruleRegistryVersion: DEFAULT_MEDICAID_RULE_SET_VERSION,
      triggeredBy: "re_validation_after_correction",
      triggerSignalId: job.eventId,
      claimStateAtTrigger: fromState,
      idempotencyKey: `${claim.id}:${job.eventId}`,
      actorMembershipId: null,
      completedAt: now,
      totalResults: summary.results.length,
      failedResults: summary.failedCount,
      warnedResults: summary.warningCount,
    });

    const failedRuleKeys: string[] = [];
    for (const r of summary.results) {
      const skipReason = r.annotations?.skipReason;
      const outcome = skipReason
        ? ("skip_not_applicable" as const)
        : r.passed
          ? ("pass" as const)
          : r.severity === "warn"
            ? ("warn" as const)
            : r.severity === "info"
              ? ("info" as const)
              : ("fail" as const);
      if (outcome === "fail") failedRuleKeys.push(r.ruleKey);
      await tx.insert(VRES).values({
        organizationId: job.organizationId,
        medicaidValidationRunId: runId,
        ruleKey: r.ruleKey,
        ruleVersion: RULES_BY_KEY.get(r.ruleKey)?.version ?? 1,
        outcome,
        remediationSummary: r.message.length > 0 ? r.message : null,
      });
    }

    const nextState = summary.blockingFailures === 0 ? "READY" : "FAILED_VALIDATION";
    // NOT `updatedByMembershipId` (NOT NULL, no system-actor escape hatch — F-144). A partial UPDATE
    // leaves the claim's last real human editor on record instead of fabricating one.
    await tx
      .update(C)
      .set({ state: nextState, validationRunIdLatest: runId, updatedAt: now })
      .where(eq(C.id, claim.id));
    await tx.insert(SH).values({
      organizationId: job.organizationId,
      medicaidClaimId: claim.id,
      fromState,
      toState: "VALIDATING",
      reason: job.eventName,
      triggerSource: "consumer",
      actorMembershipId: null,
    });
    await tx.insert(SH).values({
      organizationId: job.organizationId,
      medicaidClaimId: claim.id,
      fromState: "VALIDATING",
      toState: nextState,
      reason: null,
      triggerSource: "consumer",
      actorMembershipId: null,
    });

    await deps.outbox.publish(tx, {
      eventName: "m24.medicaid_claim.validation_started",
      organizationId: job.organizationId,
      aggregateKind: "medicaid_claim",
      aggregateId: claim.id,
      payload: {
        organizationId: job.organizationId,
        claimId: claim.id,
        validationRunId: runId,
        trigger: "re_validation_after_correction",
      },
    });
    await deps.outbox.publish(
      tx,
      nextState === "READY"
        ? {
            eventName: "m24.medicaid_claim.ready_for_submission",
            organizationId: job.organizationId,
            aggregateKind: "medicaid_claim",
            aggregateId: claim.id,
            payload: {
              organizationId: job.organizationId,
              claimId: claim.id,
              validationRunId: runId,
            },
          }
        : {
            eventName: "m24.medicaid_claim.validation_failed",
            organizationId: job.organizationId,
            aggregateKind: "medicaid_claim",
            aggregateId: claim.id,
            payload: {
              organizationId: job.organizationId,
              claimId: claim.id,
              validationRunId: runId,
              failedRuleKeys,
            },
          },
    );
  }
}

/** Construct the `medicaid-revalidate` BullMQ worker. Requires only a queue connection — unlike
 *  `registerM24LaunchWorkers`, this needs no per-state adapter registry or credential resolver. */
export function registerM24RevalidateWorker(deps: RevalidateWorkerDeps): Worker {
  return new Worker(
    M24_QUEUES.revalidate,
    async (job) => {
      const data = job.data as RevalidateJob;
      if (!data.organizationId) {
        throw new Error(`M24 ${M24_QUEUES.revalidate}: job.data.organizationId missing`);
      }
      await withOrgContext(
        deps.db,
        { organizationId: data.organizationId, userId: M24_WORKER_SYSTEM_USER_ID },
        (tx) => runMedicaidRevalidate(tx as unknown as Tx, deps, data),
      );
    },
    { connection: deps.connection, concurrency: M24_QUEUE_PARAMS.revalidate.concurrency },
  );
}

/** The `medicaid-revalidate` queue producer — mirrors `buildM23RevalidateEnqueuePort` exactly (fails
 *  closed, per-call, with no Valkey connection configured — RULE 4). */
export function buildM24RevalidateEnqueuePort(connection: ConnectionOptions | undefined): {
  readonly port: { enqueue(job: RevalidateJob): Promise<{ readonly jobId: string }> };
  readonly queue: Queue | null;
} {
  if (!connection) {
    return {
      port: {
        async enqueue() {
          throw new Error(
            "M24RevalidateEnqueueUnbound: no Valkey connection configured — cannot enqueue 'medicaid-revalidate' (set REDIS_URL)",
          );
        },
      },
      queue: null,
    };
  }
  const queue = new Queue(M24_QUEUES.revalidate, { connection });
  return {
    port: {
      async enqueue(job) {
        const jobId = `m24:${M24_QUEUES.revalidate}:${job.eventId}`;
        await queue.add(M24_QUEUES.revalidate, job, {
          jobId,
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        });
        return { jobId };
      },
    },
    queue,
  };
}
