// apps/backend/src/modules/32-ai-platform/jobs/triage-followup-worker.ts - M32 §4.8 `ai:hallucination-triage-followup`
// (GAP-161).
//
// R20 records a triage decision and returns the follow-up it implies; this is the consumer that EXECUTES it. The
// service function `executeAiHallucinationFollowUp` has existed since M32-T05 (its own header says "T07's worker
// binds the AI Safety Owner from the triage row and walks the demotion") - the queue, the producer and that
// binding did not. The worker:
//   1. runs the plan (the platform kill switch, idempotent against an already-active switch);
//   2. walks the §2.2 demotion the plan or the kill implies, attributed to the triage owner on the report row
//      (never an unattributed ledger row), as an `incident_demotion` edge;
//   3. raises the §4.9 `ai.hallucination_triage_escalation` alert for every action but `none` (system-locked).
// Jobs carry `organizationId` (the report is tenant-scoped); a failed demotion throws so BullMQ retries and the
// DLQ keeps the evidence - a half-executed incident response must be loud, not swallowed.
import type { AiHallucinationFollowUpPlan } from "@chartwarden/ai-platform";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type AiAlertPort, emitAiAlert } from "../alerts";
import { type AiGovernanceServiceDeps, transitionAiCapability } from "../governance/service";
import { type AiSafetyServiceDeps, executeAiHallucinationFollowUp } from "../safety/service";

export const M32_TRIAGE_FOLLOWUP_QUEUE = "ai-hallucination-triage-followup";

export interface TriageFollowUpJob {
  readonly organizationId: string;
  readonly reportId: string;
  readonly capabilityId: string;
  readonly plan: AiHallucinationFollowUpPlan;
}

export interface TriageFollowUpDeps {
  readonly safety: AiSafetyServiceDeps;
  readonly governance: AiGovernanceServiceDeps;
  /** Absent => the seam-resolved M36 bus (`emitAiAlert`'s default). */
  readonly alerts?: AiAlertPort | null;
}

export interface TriageFollowUpResult {
  readonly action: AiHallucinationFollowUpPlan["action"];
  readonly killSwitchActivated: boolean;
  readonly killSwitchAlreadyActive: boolean;
  readonly demotedTo: string | null;
  readonly alertEmitted: boolean;
}

export async function runTriageFollowUp(
  deps: TriageFollowUpDeps,
  job: TriageFollowUpJob,
): Promise<TriageFollowUpResult> {
  const { plan } = job;
  if (plan.action === "none") {
    return {
      action: "none",
      killSwitchActivated: false,
      killSwitchAlreadyActive: false,
      demotedTo: null,
      alertEmitted: false,
    };
  }

  const outcome = await executeAiHallucinationFollowUp(deps.safety, plan, job.capabilityId);

  let demotedTo: string | null = null;
  if (outcome.demotion.required && outcome.demotion.toState !== null) {
    const report = await deps.safety.reports.findReport(job.organizationId, job.reportId);
    const signer = report?.triageOwnerMembershipId ?? null;
    if (signer === null) {
      // Walking a lifecycle edge with no accountable signer would put an unattributed row in the ledger D2
      // exists to keep attributable: fail the job so a human sees it.
      throw new Error(
        `triage follow-up for report ${job.reportId}: demotion required but the report has no triage owner`,
      );
    }
    await transitionAiCapability(deps.governance, {
      capabilityId: job.capabilityId,
      toState: outcome.demotion.toState,
      approvalKind: "incident_demotion",
      actorRole: "ai_safety_owner",
      rationaleText: outcome.demotion.rationaleText,
      linkedEvaluationRunId: null,
      actorMembershipId: signer,
    });
    demotedTo = outcome.demotion.toState;
  }

  const capability = await deps.governance.registry.findCapabilityById(job.capabilityId);
  const alertEmitted = await emitAiAlert(
    {
      alertType: "ai.hallucination_triage_escalation",
      reportId: job.reportId,
      capabilityId: job.capabilityId,
      capabilityKey: capability?.capabilityKey ?? job.capabilityId,
      organizationId: job.organizationId,
      followUpAction: plan.action,
    },
    deps.alerts,
  );

  return {
    action: plan.action,
    killSwitchActivated: outcome.killSwitch !== null,
    killSwitchAlreadyActive: outcome.killSwitchAlreadyActive,
    demotedTo,
    alertEmitted,
  };
}

/** The producer the triage route enqueues through (R20 / spec §4.8: producer = the R20 endpoint). */
export interface TriageFollowUpEnqueuePort {
  enqueue(job: TriageFollowUpJob): Promise<void>;
}

/** BullMQ producer; the jobId is deterministic per report so a retried route cannot double-fire the plan. */
export function buildTriageFollowUpQueue(connection: ConnectionOptions): {
  readonly port: TriageFollowUpEnqueuePort;
  readonly queue: Queue;
} {
  const queue = new Queue(M32_TRIAGE_FOLLOWUP_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      // §4.8 retention: success 30d, failed 90d.
      removeOnComplete: { age: 30 * 24 * 3600 },
      removeOnFail: { age: 90 * 24 * 3600 },
    },
  });
  return {
    queue,
    port: {
      async enqueue(job) {
        await queue.add("followup", job, { jobId: `${job.organizationId}.${job.reportId}` });
      },
    },
  };
}

export function registerM32TriageFollowUpWorker(
  deps: TriageFollowUpDeps & { readonly connection: ConnectionOptions },
): Worker {
  return new Worker(
    M32_TRIAGE_FOLLOWUP_QUEUE,
    async (job) => runTriageFollowUp(deps, job.data as TriageFollowUpJob),
    // §4.8: concurrency 2.
    { connection: deps.connection, concurrency: 2 },
  );
}
