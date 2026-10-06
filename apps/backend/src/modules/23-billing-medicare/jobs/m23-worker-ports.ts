// apps/backend/src/modules/23-billing-medicare/jobs/m23-worker-ports.ts
//
// The real implementations of the M23 worker ports the composition root binds (GAP-069 / GAP-070). They were
// left as fail-closed `unboundWorkerPort` thunks, so every NOE/NOTR window-watch tick, every validation run and
// every revalidation threw. Each port here is a thin adapter over an owner of the behaviour (the notice
// repositories, the claim-validation service, BullMQ) — no business rules live in this file.
import { createDefaultBillingRegistry, repositories } from "@wardenx/billing";
import type * as schema from "@wardenx/db/schema";
import { WardenXError } from "@wardenx/types";
import { type ConnectionOptions, Queue } from "bullmq";
import type { ClaimAssemblySeams } from "../services/claim-assembly";
import {
  type BillingTx,
  type BillingWriteActor,
  type WriteOutboxPort,
  buildClaimStateService,
} from "../services/claim-state-service";
import { buildClaimValidationContextPort } from "../services/claim-validation-context-port";
import {
  type ClaimValidationService,
  buildClaimValidationService,
} from "../services/claim-validation-service";
import type { ClaimValidationRunnerPort, JobEnqueuePort, NoticeWindowPort } from "./m23-jobs";
import { M23_QUEUES, M23_QUEUE_PARAMS } from "./queues";

/** `YYYY-MM-DD` — `window_breached_at` is a SQL `date`, not a timestamp. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The §2.2 window-breach stamp: a same-state, version-checked patch of `window_breached_at` on the worker's
 * own tx (the append-only repositories expose no plain update). The cron emits the breach event + alert itself;
 * this port only records the fact, so the watch's candidate query (which excludes already-stamped rows) stops
 * re-alerting the same notice on every tick.
 */
export function buildNoticeWindowPort(): NoticeWindowPort {
  return {
    async recordBreach({ tx, kind, noticeId, expectedVersion, breachedAt }) {
      const patch = { windowBreachedAt: isoDay(breachedAt) };
      if (kind === "noe") {
        const repo = new repositories.NoeRepository(tx);
        const row = await repo.findById(noticeId);
        if (!row) throw new WardenXError("NOT_FOUND", `noe ${noticeId} not found`, 404);
        const res = await repo.transitionToState(row.id, expectedVersion, row.state, patch);
        if (!res.ok) {
          throw new WardenXError("VERSION_CONFLICT", "the NOE was modified concurrently", 412);
        }
        return;
      }
      const repo = new repositories.NotrRepository(tx);
      const row = await repo.findById(noticeId);
      if (!row) throw new WardenXError("NOT_FOUND", `notr ${noticeId} not found`, 404);
      const res = await repo.transitionToState(row.id, expectedVersion, row.state, patch);
      if (!res.ok) {
        throw new WardenXError("VERSION_CONFLICT", "the NOTR was modified concurrently", 412);
      }
    },
  };
}

/** The org-scoped work queues the producer below may feed (the two that have no outbox-bridge consumer). */
const WORK_QUEUE_PARAMS = {
  [M23_QUEUES.validationRun]: M23_QUEUE_PARAMS.validationRun,
  [M23_QUEUES.eligibilityRefresh]: M23_QUEUE_PARAMS.eligibilityRefresh,
} as const;

type WorkQueueName = keyof typeof WORK_QUEUE_PARAMS;

const isWorkQueue = (name: string): name is WorkQueueName => name in WORK_QUEUE_PARAMS;

/**
 * BullMQ producer for the `validation-run` and `eligibility.refresh` work queues. Used by the revalidate
 * consumer's fan-out (`runRevalidateConsumer`) and by the outbox bridge. The job id derives from the caller's
 * dedupe key, so a redelivery of the same request is a BullMQ-level no-op. Refuses any other queue name loudly
 * rather than creating a queue no worker listens on.
 */
export function buildM23WorkQueueEnqueuePort(connection: ConnectionOptions): {
  readonly port: JobEnqueuePort;
  readonly queues: readonly Queue[];
} {
  const cache = new Map<string, Queue>();
  const queueFor = (name: string): Queue => {
    let queue = cache.get(name);
    if (!queue) {
      queue = new Queue(name, { connection });
      cache.set(name, queue);
    }
    return queue;
  };
  return {
    port: {
      async enqueue(queueName, dedupeKey, payload) {
        if (!isWorkQueue(queueName)) {
          throw new WardenXError(
            "SEAM_UNBOUND",
            `M23 work queue '${queueName}' has no producer`,
            503,
          );
        }
        const params = WORK_QUEUE_PARAMS[queueName];
        const jobId = `m23:${queueName}:${dedupeKey}`;
        await queueFor(queueName).add(queueName, payload, {
          jobId,
          attempts: params.attempts,
          backoff: params.backoff,
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        });
        return { jobId };
      },
    },
    get queues() {
      return [...cache.values()];
    },
  };
}

type ValidationRunTrigger = schema.ValidationRun["trigger"];

const VALIDATION_TRIGGERS: ReadonlySet<string> = new Set<ValidationRunTrigger>([
  "initial_assembly",
  "pre_submission",
  "re_validation_after_correction",
  "re_validation_after_override",
  "manual_re_run",
]);

/** The typed machine principal a validation job acts as: no membership, no step-up, never an AI kind. */
export function m23WorkerActor(organizationId: string): BillingWriteActor {
  return {
    organizationId,
    userId: "",
    roles: [],
    membershipId: "",
    stepUpRecent: false,
    actorKind: "worker",
  };
}

/**
 * The `validation-run` executor: delegates to the claim-validation service on the worker's own tx. A job whose
 * claim is gone, is no longer VALIDATING/READY, or whose run already exists is a SETTLED no-op (a redelivery or
 * a claim that moved on) — throwing would retry a decision that is already recorded.
 */
export function buildClaimValidationRunner(deps: {
  readonly validation: Pick<ClaimValidationService, "validateClaimInTx">;
}): ClaimValidationRunnerPort {
  return {
    async run({ tx, organizationId, claimId, validationRunId, trigger }) {
      if (!VALIDATION_TRIGGERS.has(trigger)) {
        throw new WardenXError(
          "VALIDATION_FAILED",
          `unknown validation-run trigger '${trigger}'`,
          422,
        );
      }
      const billingTx = tx as unknown as BillingTx;
      const claim = await new repositories.ClaimRepository(billingTx).findById(claimId);
      if (!claim || claim.organizationId !== organizationId) return;
      if (claim.state !== "validating" && claim.state !== "ready") return;
      const existing = await new repositories.ValidationRunRepository(billingTx).findById(
        validationRunId,
      );
      if (existing) return;
      await deps.validation.validateClaimInTx(billingTx, m23WorkerActor(organizationId), {
        claimId,
        trigger: trigger as ValidationRunTrigger,
        validationRunId,
      });
    },
  };
}

/**
 * Compose the production `validation-run` executor: the frozen platform rule registry, the claim-state service
 * (which drives the claim lifecycle and emits the §4.10 events through the catalog-validating publisher), and a
 * context port that re-reads the claim's facts through the same seams the assembly uses.
 */
export function buildM23ValidationRunner(deps: {
  readonly db: repositories.BillingDb;
  readonly outbox: WriteOutboxPort;
  readonly seams: ClaimAssemblySeams;
  /** True only when a HETS eligibility path is live; false makes the eligibility rule skip, never fail. */
  readonly eligibilityBound: boolean;
}): ClaimValidationRunnerPort {
  const claimState = buildClaimStateService(deps.db, { outbox: deps.outbox });
  const validation = buildClaimValidationService(
    deps.db,
    createDefaultBillingRegistry(),
    claimState,
    {
      contextPort: buildClaimValidationContextPort({
        seams: deps.seams,
        eligibilityBound: deps.eligibilityBound,
      }),
    },
  );
  return buildClaimValidationRunner({ validation });
}
