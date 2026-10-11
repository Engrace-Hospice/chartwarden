// apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts — M23 LIVE BullMQ wiring for the §4.8 jobs.
//
// The thin, infra-touching adapter that turns the @wardenx/billing PURE domain (the claim/noe/notr lifecycle
// reducers, the validation rule registry, the HIPPS/SIA/sequestration/TOB calculators, the control-number
// deriver) into running BullMQ `Worker`s + the cron-schedule `Queue`s. @wardenx/billing ships NO BullMQ
// catalog (P1/P2 = pure), so this file holds BOTH the worker construction AND the processor LOGIC — mirroring
// apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts file-for-file in posture:
//   • `new Worker(queue, processor, { connection, concurrency })` + `new Queue(...)`; injected connection; the
//     caller owns lifecycle/`close()`. NOTHING runs at import (constructing a Worker is what opens the Valkey
//     connection — that happens only inside these functions, never in tests / at module load).
//   • per-job `withOrgContext(orgId)` RLS envelope (every §4.8 WORK queue is ORG-scoped, F09): the worker opens
//     the tx on the org from the job payload and REBUILDS the repos over that tx so every write carries
//     `app.org_id` (without it the RLS WITH CHECK denies the insert).
//   • RULE 4 — FAIL-CLOSED-UNBOUND: every x12 / MAC-portal / MBI-unlock / HETS / cross-module seam port is bound
//     to a LAZY `() => unboundWorkerPort(...)` thunk so the throw happens only when a JOB RUNS, never at
//     port-bundle construction. The host boots clean even when no adapter is bound. Real MAC-portal HTTP + x12
//     generation (the x12-837-client `ngs-j6` client) is a follow-up; the worker structure + the outbox-drain +
//     the state transitions are built NOW with those calls placed behind the fail-closed binds.
//   • D2 outbox-only: every state transition emits its §4.10 `m23.*` event through the injected outbox IN THE
//     SAME transaction as the mutation (the composition root binds the catalog-validating tx publisher with
//     `bindCallerModule("m23")`).
//
// IMPORT BOUNDARY (the M23 kernel lesson — differs from M27): M23 `dependsOn = [6,8,22,38,40]` does NOT include
// M1, so this module may NOT import the `@wardenx/db` ROOT barrel. The Drizzle handle is the package-kernel
// `repositories.BillingDb`; the one row/insert TYPE it needs is DERIVED from the repo's own method param
// (`NewClaimAck`) so the module takes no `@wardenx/db/schema` leaf import at all.
//
// M23 carries NO PHI and NEVER the MBI digit (D13 / §3.6 / §8.7) — every payload is IDs + aggregate billing
// facts only. The MBI is unlocked + zeroed entirely inside the bound HETS seam, never crossing into this file.
// The actor id a §4.8 worker's `withOrgContext` carries is the empty-string system sentinel (M4 NULLIFs it).
//
// AI-BLOCK (D13): no `@wardenx/ai-platform` import anywhere here; a background job has no acting user.
import { createHash } from "node:crypto";
import {
  type ClaimDocument837i,
  type ClaimState,
  type ClaimTransitionEvent,
  DDE_WATCHDOG_LOOKAHEAD_DAYS,
  type EligibilityOutcome,
  type NoticeState,
  canTransition as canClaimTransition,
  deriveControlNumber,
  medicareReceiptDay,
  noeMachine,
  notrMachine,
  parseControlNumber,
  reduce as reduceClaim,
  repositories,
} from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { type HospiceHistory, assertNoMbi } from "@wardenx/x12-837-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { DdeWatchdogPort } from "../services/dde-watchdog";
import { type AckPayerDates, applyNoticeAck, sanitizeAckReasonCodes } from "./notice-ack-jobs";
import {
  type M23CronQueueName,
  M23_CRON_QUEUES,
  M23_JOB_SCHEDULES,
  M23_QUEUES,
  M23_QUEUE_PARAMS,
  m23JobId,
} from "./queues";
import {
  type GenerateTransferNotice,
  type TransferNoticeSubmitJob,
  applyTransferNoticeAck,
  runTransferNoticeSubmit,
} from "./transfer-notice-jobs";

const {
  ClaimRepository,
  ClaimSubmissionRepository,
  ClaimAcknowledgmentRepository,
  EligibilityCheckRepository,
  NoeRepository,
  NotrRepository,
  ValidationRunRepository,
  ValidationResultRepository,
  ValidationOverrideRepository,
} = repositories;

/** The package-kernel Drizzle handle (a `withOrgContext` tx satisfies it structurally). */
type BillingDb = repositories.BillingDb;

const M23_CRON_LOCK_DURATION_MS = 10 * 60_000;

/**
 * The `claim_acknowledgment` insert shape — DERIVED from the repo's own `append` param (rather than importing
 * the M1-owned db schema leaf) so this module takes no schema-leaf import at all (the M23 import boundary +
 * the table-ownership check's import-token false-positive both stay satisfied).
 */
type NewClaimAck = Parameters<InstanceType<typeof ClaimAcknowledgmentRepository>["append"]>[0];

// ── the fail-closed unbound-port thunk (the M27 `unboundWorkerPort` precedent) ────────────────────────────

/**
 * Throw a typed `M23WorkerPortUnbound` for a still-missing infra/seam port. Called LAZILY inside a port method
 * body so the throw happens only when a JOB RUNS — never at port-bundle construction. NEVER fails open: a
 * missing port denies + fails the job rather than fabricating a submission / acknowledgment / eligibility result.
 */
export function unboundWorkerPort(portName: string, hint: string): never {
  throw new Error(`M23WorkerPortUnbound: ${portName} — ${hint}`);
}

// ── §4.8 job payloads (the producer fans these onto the WORK queues) ──────────────────────────────────────
//
// INTEGRATION CONTRACT: the ALREADY-BUILT `routes/write-service-drizzle.ts` producer enqueues payloads WITHOUT
// `organizationId` (its dedupe key `${org}:${id}…` carries it). Because every §4.8 WORK queue is ORG-scoped,
// the composition-root `JobEnqueuePort` adapter MUST enrich each job's `data` with `organizationId` (parse it
// from the dedupe key) before `Queue.add`. The workers below read `organizationId` from `job.data` and
// fail-closed when it is absent.

export interface ClaimSubmitJob {
  readonly organizationId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly claimControlNumber: string;
  readonly attemptIndex: number;
}
export interface ClaimSubmitRetryJob {
  readonly organizationId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly attemptIndex: number;
}
export interface NoeSubmitJob {
  readonly organizationId: string;
  readonly noeId: string;
}
export interface NotrSubmitJob {
  readonly organizationId: string;
  readonly notrId: string;
}
export interface EligibilityRefreshJob {
  readonly organizationId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly asOfServiceDate: string;
}
export interface ValidationRunJob {
  readonly organizationId: string;
  readonly claimId: string;
  readonly validationRunId: string;
  readonly trigger: string;
}
export interface RevalidateConsumerJob {
  readonly organizationId: string;
  /** The originating outbox event id (the §4.8 `(event_id, target_claim_id)` idempotency tuple). */
  readonly eventId: string;
  readonly eventName: string;
  /** The changed upstream fact's payload (id-keyed; the resolver maps it to affected claims). */
  readonly eventPayload: Record<string, unknown>;
}

// ── injected ports (the composition root binds; every genuinely-missing one carries a lazy fail-closed thunk) ──

/** A single §4.10 `m23.*` outbox emission (mirrors the M23 service `OutboxEmitInput`). */
export interface WorkerOutboxInput {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  /** `null` only for a genuinely platform-wide event (no single tenant it belongs to, e.g. the MAC-portal
   *  health probe — a MAC jurisdiction serves many provider entities across many orgs) — mirrors
   *  {@link OutboxPublishInput.organizationId} (apps/backend/src/bootstrap/outbox-persister.ts) exactly;
   *  widened from `string` (F-1xx, #248) so `runMacPortalHealth`'s platform-status emit type-checks against
   *  the SAME `deps.outbox` binding every org-scoped `m23.*` emit in this file already uses. */
  readonly organizationId: string | null;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The §4.10 `m23.*` transactional-outbox emitter (writes the `outbox_event` row on the worker's tx). */
export interface WorkerOutboxPort {
  publish(tx: BillingDb, input: WorkerOutboxInput): Promise<void>;
}

/** The §4.9 M36 typed-alert dispatcher (the alert rules in `@wardenx/billing` alerts fire through M36). */
export interface WorkerAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

/** The x12-837-client sidecar (`generate-837i`/`generate-noe`/`generate-notr`/`eligibility-270`/`parse-*`). */
export interface X12ClientPort {
  generate837i(input: {
    readonly organizationId: string;
    readonly claimId: string;
    readonly claimControlNumber: string;
    /** The claim facts the gateway renders (`@wardenx/billing` `ClaimDocument837i`): today the TOB, the
     *  service window and the CMS Pub. 100-04 Ch. 11 §30.3 discharge codes → CL103 / HI*BG / HI*BH. */
    readonly claimDocument: ClaimDocument837i;
  }): Promise<{ readonly x12: string; readonly correlationId: string }>;
  generateNoe(input: {
    readonly organizationId: string;
    readonly noeId: string;
    readonly noeControlNumber: string;
  }): Promise<{ readonly x12: string; readonly correlationId: string }>;
  generateNotr(input: {
    readonly organizationId: string;
    readonly notrId: string;
    readonly notrControlNumber: string;
  }): Promise<{ readonly x12: string; readonly correlationId: string }>;
  /** The 8xC / 8xD transfer notice (`POST /generate-transfer-notice`); the reference rendering is
   *  `build837iTransferNotice` in `@wardenx/x12-837-client`. Optional so older bindings stay valid —
   *  an absent binding fails the job closed (`unboundWorkerPort`). */
  generateTransferNotice?: GenerateTransferNotice;
  parse999(input: {
    readonly macJurisdiction: string;
    readonly rawFileUri: string;
  }): Promise<readonly Parsed999[]>;
  parse277ca(input: {
    readonly macJurisdiction: string;
    readonly rawFileUri: string;
  }): Promise<readonly Parsed277ca[]>;
}

/** A parsed 999 result line (PHI-free: control number + functional-group ack status + reason codes). */
export interface Parsed999 {
  readonly organizationId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly claimControlNumber: string;
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly ackFileUri: string;
  /** The 999's own GS04 functional group date (ISO) — a 999 has no status date (`read999EnvelopeDates`). */
  readonly functionalGroupDate?: string | null;
  /** The 999's ISA09 interchange date (ISO), the fallback when GS04 is absent. */
  readonly interchangeDate?: string | null;
  /**
   * Set by a clearinghouse adapter (`routeAckEvent`, ADR-0053 D2): the answer is the clearinghouse's, not the MAC's. It
   * rides the 999 edge, so it can reach `ack_pending` but never `ack_accepted`, and is recorded as such.
   */
  readonly stage?: "clearinghouse";
}

/** A parsed 277CA result (PHI-free: claim-level accept/reject/partial + payer control number + reason codes). */
export interface Parsed277ca {
  readonly organizationId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly outcome: "accepted" | "rejected" | "partial";
  readonly payerClaimControlNumber: string;
  readonly reasonCodes: readonly string[];
  readonly ackFileUri: string;
  /** STC02 — the MAC's status information effective date (ISO) for this claim / notice (`read277caStatusDates`). */
  readonly statusEffectiveDate?: string | null;
}

/** The MAC-portal transport (upload generated files; pull pending ack files; probe availability). */
export interface MacPortalPort {
  upload(input: {
    readonly organizationId: string;
    /** The submitting provider entity (M40); the transport resolves the MAC jurisdiction from its credential. */
    readonly providerEntityId: string;
    readonly kind: "claim_837i" | "noe" | "notr" | "transfer_notice";
    readonly x12: string;
    readonly controlNumber: string;
  }): Promise<{
    readonly accepted: boolean;
    readonly generatedFileUri: string;
  }>;
  /** List pending 999 ack files for a MAC jurisdiction (the cron poller's source). */
  pullPending999(macJurisdiction: string): Promise<readonly { readonly rawFileUri: string }[]>;
  pullPending277ca(macJurisdiction: string): Promise<readonly { readonly rawFileUri: string }[]>;
  /** HEAD on the portal-status-page; `true` when up (the §4.8 mac-portal.health probe). */
  probeHealth(macJurisdiction: string): Promise<boolean>;
}

/**
 * The hospice election / benefit-period history derived from a HETS 271 (Companion Guide §7.16). Built by
 * `deriveHospiceHistory` in `@wardenx/x12-837-client`; carries no MBI (NPIs + dates + codes only).
 */
export type HetsHospiceHistory = HospiceHistory;

/** One HETS round-trip result. PHI-minimal: no MBI, no name, no DOB (D13 / §3.6 / §8.7). */
export interface HetsEligibilityResult {
  readonly outcome: EligibilityOutcome;
  /** PHI-free reason code when the outcome is not a resolved Part A answer (`mbi_not_on_file`, `HETS_TIMEOUT`, …). */
  readonly reason: string | null;
  readonly partAEffectiveDate: string | null;
  readonly partATerminationDate: string | null;
  readonly hospiceElectionOnFile: boolean;
  /** The hospice history, or null when no usable 271 came back (transport error, AAA, 999, no MBI on file). */
  readonly hospice: HetsHospiceHistory | null;
  /** AAA rejections as `<loop>:<AAA03>` (e.g. `2100C:72`). */
  readonly rejectionCodes: readonly string[];
  /** Which transport answered — `sandbox` results are synthetic and flagged as such downstream. */
  readonly transport: "core_mime" | "sandbox";
  /** The TRN trace number of the 270 (PHI-free), stored as `worker_correlation_id`. */
  readonly correlationId: string | null;
  /** Always null today: the raw 271 echoes the MBI, so it is never stored (D13). */
  readonly responseFileUri: string | null;
  readonly staleAt: Date;
}

/**
 * The HETS 270/271 eligibility seam (§4.4). The bound impl (`hets-eligibility.ts`) unlocks the patient MBI via
 * the M5 `MbiUnlockReader`, builds + sends the 270, parses the 271 and releases the MBI — so the MBI NEVER
 * crosses into this file (D13 / §3.6). Unbound (no `M23_HETS_TRANSPORT`) it fails closed on call.
 */
export interface HetsEligibilityPort {
  check(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly providerEntityId: string;
    readonly asOfServiceDate: string;
  }): Promise<HetsEligibilityResult>;
}

/** The §2.2 NOE/NOTR window stamp — sets `window_breached_at` (the append-only repos expose no plain update). */
export interface NoticeWindowPort {
  recordBreach(input: {
    readonly tx: BillingDb;
    readonly kind: "noe" | "notr";
    readonly noticeId: string;
    readonly expectedVersion: number;
    readonly breachedAt: Date;
  }): Promise<void>;
}

/**
 * The validation-run executor (the `validation-run` queue's processor delegate). Bound by the composition root
 * to the M23 `claim-validation-service` so the rule-library run + result persistence + claim transition live in
 * ONE home (not duplicated here). Runs inside the worker's `withOrgContext` tx. FAIL-CLOSED until bound.
 */
export interface ClaimValidationRunnerPort {
  run(input: {
    readonly tx: BillingDb;
    readonly organizationId: string;
    readonly claimId: string;
    readonly validationRunId: string;
    readonly trigger: string;
  }): Promise<void>;
}

/**
 * The §4.8 revalidation target resolver (the `revalidate.consumer` shaping seam). Given a consumed upstream
 * event (`m5.patient.*`, `m6.election.*`, `m8.encounter.signed`, `m40.canonical.updated`, …), it returns every
 * M23 claim in VALIDATING or READY that depends on the changed fact. FAIL-CLOSED until bound (the consumer
 * skips no claim silently — it throws so a missing resolver is a loud no-op, never a fabricated empty set).
 */
export interface RevalidationTargetResolverPort {
  resolve(input: {
    readonly tx: BillingDb;
    readonly organizationId: string;
    readonly eventName: string;
    readonly eventPayload: Record<string, unknown>;
  }): Promise<readonly { readonly claimId: string }[]>;
}

/** Enqueue a follow-on `validation-run` job (the revalidate consumer's producer side). FAIL-CLOSED until bound. */
export interface JobEnqueuePort {
  enqueue(
    queueName: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly jobId: string }>;
}

/** The platform active-org enumerator the per-org crons fan across (M2; under `withPlatformContext`). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The MAC-jurisdiction enumerator the per-jurisdiction ack-pull + portal-health crons fan across. */
export interface MacJurisdictionListPort {
  listJurisdictions(): Promise<readonly { readonly macJurisdiction: string }[]>;
}

/** BullMQ sink used by the transactional-outbox submission-request consumer. */
export function buildM23SubmissionQueuePort(connection: ConnectionOptions): {
  readonly port: {
    enqueue(
      queueName:
        | "claim.submit"
        | "claim.submit.retry"
        | "noe.submit"
        | "notr.submit"
        | "transfer_notice.submit",
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
        const params =
          queueName === "claim.submit"
            ? M23_QUEUE_PARAMS.claimSubmit
            : queueName === "claim.submit.retry"
              ? M23_QUEUE_PARAMS.claimSubmitRetry
              : queueName === "noe.submit"
                ? M23_QUEUE_PARAMS.noeSubmit
                : queueName === "transfer_notice.submit"
                  ? M23_QUEUE_PARAMS.transferNoticeSubmit
                  : M23_QUEUE_PARAMS.notrSubmit;
        await queueFor(queueName).add(queueName, payload, {
          jobId: m23JobId(queueName, jobId),
          attempts: params.attempts,
          backoff: params.backoff,
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

/**
 * F-153 (#248) — the `revalidate.consumer` PRODUCER: a BullMQ sink for the six live
 * `outbox-consumers/m23-revalidate-triggers.ts` bindings. `runRevalidateConsumer` (this file, above) has been
 * a registered, running worker since the launch-worker set landed; nothing has ever added a job to this
 * queue. The jobId is the ORIGINATING OUTBOX EVENT id — a redelivery of the same upstream event is a
 * BullMQ-level no-op before the resolver ever runs a second time (the per-target `validation-run` fan-out
 * inside `runRevalidateConsumer` carries its own, separate `(org, claim, event)` idempotency key regardless).
 */
export function buildM23RevalidateEnqueuePort(connection: ConnectionOptions | undefined): {
  readonly port: {
    enqueue(job: RevalidateConsumerJob): Promise<{ readonly jobId: string }>;
  };
  readonly queues: readonly Queue[];
} {
  if (!connection) {
    return {
      port: {
        async enqueue() {
          unboundWorkerPort(
            "revalidateEnqueue",
            "no Valkey connection configured — cannot enqueue 'revalidate.consumer' (set the queue connection at boot)",
          );
        },
      },
      queues: [],
    };
  }
  const queue = new Queue(M23_QUEUES.revalidateConsumer, { connection });
  return {
    port: {
      async enqueue(job) {
        const jobId = `m23:${M23_QUEUES.revalidateConsumer}:${job.eventId}`;
        await queue.add(M23_QUEUES.revalidateConsumer, job, {
          jobId,
          attempts: M23_QUEUE_PARAMS.revalidateConsumer.attempts,
          backoff: M23_QUEUE_PARAMS.revalidateConsumer.backoff,
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        });
        return { jobId };
      },
    },
    queues: [queue],
  };
}

// ── the dep bag the composition root injects ──────────────────────────────────────────────────────────────

/**
 * The dependencies the live M23 worker wiring binds the §4.8 worker/cron ports over. The bindable infra (the
 * Valkey connection + the org-scoped Drizzle client) is wired to real adapters; every still-missing
 * cross-module / platform / x12 / portal port carries a LAZY fail-closed thunk default until the integrator
 * binds it — so the host boots green with zero adapters present (RULE 4).
 */
export interface M23WorkerDeps {
  /** The Valkey/Redis connection the `Worker`/`Queue` open over (injected; the M27 jobs shape). */
  readonly connection: ConnectionOptions;
  /** The Drizzle client the repos run under (wrapped per-job in `withOrgContext` by the worker). */
  readonly db: BillingDb;
  /** Injected clock (deterministic in tests; every instant is stamped through this). */
  now?: () => Date;
  // ── bindable cross-module / platform / x12 / portal ports (lazy fail-closed default until bound) ──
  readonly outbox?: WorkerOutboxPort;
  readonly alerts?: WorkerAlertPort;
  readonly x12?: X12ClientPort;
  readonly macPortal?: MacPortalPort;
  readonly hets?: HetsEligibilityPort;
  readonly noticeWindow?: NoticeWindowPort;
  readonly validationRunner?: ClaimValidationRunnerPort;
  readonly revalidationTargets?: RevalidationTargetResolverPort;
  readonly enqueue?: JobEnqueuePort;
  readonly activeOrgs?: ActiveOrgListPort;
  readonly jurisdictions?: MacJurisdictionListPort;
  /** ADR-0052 — files a DDE work item for each at-risk NOE/NOTR the window-watch crons walk (absent ⇒ no item). */
  readonly ddeWatchdog?: DdeWatchdogPort;
  /** Structured logger for failures that must not abort the cron (ids only, never PHI). */
  readonly logger?: { error(fields: Record<string, unknown>, message: string): void };
}

/** The empty-string system sentinel `withOrgContext` carries — the M4 trigger NULLIFs it (no acting user). */
const M23_WORKER_SYSTEM_USER_ID = "";

// ── the bound port bundles (bind what we can; lazy throw-on-call for the genuinely-missing infra) ───────────

function outboxOf(deps: M23WorkerDeps): WorkerOutboxPort {
  return (
    deps.outbox ?? {
      publish: () =>
        unboundWorkerPort(
          "outbox.publish",
          "bind the live transactional-outbox dispatcher (bindCallerModule('m23') — every §4.10 m23.* emit)",
        ),
    }
  );
}

function alertsOf(deps: M23WorkerDeps): WorkerAlertPort {
  return (
    deps.alerts ?? {
      dispatch: () =>
        unboundWorkerPort(
          "alerts.dispatch",
          "bind the M36 alert router (the §4.9 M23_ALERT_RULES typed alerts)",
        ),
    }
  );
}

function x12Of(deps: M23WorkerDeps): X12ClientPort {
  const u = (fn: string) =>
    unboundWorkerPort(
      `x12.${fn}`,
      "bind the x12-837-client sidecar (generate-837i/noe/notr, parse-999/277ca)",
    );
  return (
    deps.x12 ?? {
      generate837i: () => u("generate837i"),
      generateNoe: () => u("generateNoe"),
      generateNotr: () => u("generateNotr"),
      parse999: () => u("parse999"),
      parse277ca: () => u("parse277ca"),
    }
  );
}

function macPortalOf(deps: M23WorkerDeps): MacPortalPort {
  const u = (fn: string) =>
    unboundWorkerPort(
      `macPortal.${fn}`,
      "bind the MAC-portal transport (x12-837-client/mac-portal/<juris>.ts)",
    );
  return (
    deps.macPortal ?? {
      upload: () => u("upload"),
      pullPending999: () => u("pullPending999"),
      pullPending277ca: () => u("pullPending277ca"),
      probeHealth: () => u("probeHealth"),
    }
  );
}

function hetsOf(deps: M23WorkerDeps): HetsEligibilityPort {
  return (
    deps.hets ?? {
      check: () =>
        unboundWorkerPort(
          "hets.check",
          "bind the HETS 270/271 seam (unlocks the M5 MbiUnlockReader MBI + zeroes it; MBI never persists, §3.6)",
        ),
    }
  );
}

function noticeWindowOf(deps: M23WorkerDeps): NoticeWindowPort {
  return (
    deps.noticeWindow ?? {
      recordBreach: () =>
        unboundWorkerPort(
          "noticeWindow.recordBreach",
          "bind the noe-notr-state-service window-breach stamp (sets window_breached_at version-checked)",
        ),
    }
  );
}

function validationRunnerOf(deps: M23WorkerDeps): ClaimValidationRunnerPort {
  return (
    deps.validationRunner ?? {
      run: () =>
        unboundWorkerPort(
          "validationRunner.run",
          "bind the M23 claim-validation-service (runs the rule library + persists results + transitions the claim)",
        ),
    }
  );
}

function revalidationTargetsOf(deps: M23WorkerDeps): RevalidationTargetResolverPort {
  return (
    deps.revalidationTargets ?? {
      resolve: () =>
        unboundWorkerPort(
          "revalidationTargets.resolve",
          "bind the revalidation-target resolver (changed-fact event → affected VALIDATING/READY claims)",
        ),
    }
  );
}

function enqueueOf(deps: M23WorkerDeps): JobEnqueuePort {
  return (
    deps.enqueue ?? {
      enqueue: () =>
        unboundWorkerPort(
          "enqueue.enqueue",
          "bind the JobEnqueuePort producer (the revalidate consumer's fan-out)",
        ),
    }
  );
}

function activeOrgsOf(deps: M23WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unboundWorkerPort(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the per-org cron fan-out) under withPlatformContext",
        ),
    }
  );
}

function jurisdictionsOf(deps: M23WorkerDeps): MacJurisdictionListPort {
  return (
    deps.jurisdictions ?? {
      listJurisdictions: () =>
        unboundWorkerPort(
          "jurisdictions.listJurisdictions",
          "bind the MAC-jurisdiction enumerator (the per-jurisdiction ack-pull + portal-health crons)",
        ),
    }
  );
}

// ── shared helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Drive the pure §2.2 claim reducer for a worker-side transition; returns the next state or throws on illegal. */
function nextClaimState(from: ClaimState, event: ClaimTransitionEvent): ClaimState {
  const result = reduceClaim(from, event);
  if (result.error) {
    throw new Error(`illegal claim transition ${from} --${event}--> (${result.error})`);
  }
  return result.state;
}

/**
 * The unresolved BLOCKING (error-severity, un-overridden) failures of a claim's latest validation run
 * (§2.3) — the SAME query `routes/write-service-drizzle.ts`'s `submitClaim` runs before enqueueing the
 * `claim.submit` job. Duplicated rather than imported: the route slice and the worker slice don't share a
 * module, and the guard the pure reducer enforces on `submit` needs this recomputed HERE too, at the
 * moment the worker is about to actually transition READY → SUBMITTED (not just at enqueue time).
 */
async function unresolvedBlockingFailuresForClaim(tx: BillingDb, claimId: string): Promise<number> {
  const run = await new ValidationRunRepository(tx).findLatestForClaim(claimId);
  if (!run) return Number.POSITIVE_INFINITY; // never validated → cannot be READY-clean
  const failures = await new ValidationResultRepository(tx).listFailuresForRun(run.id);
  if (failures.length === 0) return 0;
  const overrides = await new ValidationOverrideRepository(tx).listByResultIds(
    failures.map((f) => f.id),
  );
  const overridden = new Set(overrides.map((o) => o.resultId));
  return failures.filter((f) => f.severity === "error" && !overridden.has(f.id)).length;
}

/**
 * Preflight the pure §2.3 `submit` guard against the claim's LIVE unresolved-blocking-failure count
 * BEFORE the worker physically transmits anything to the MAC. Without this, `nextClaimState(claim.state,
 * "submit")` always fails `GUARD_FAILED` (the guard is fail-closed on an omitted context — see
 * `packages/billing/src/machines/claim.ts`), which used to throw only AFTER the real 837I upload had
 * already happened, rolling back the terminalize write inside the same tx with no retry and no alert
 * (the claim stayed stuck in `ready` forever while the MAC had already received it). Returns the
 * post-submit state on success, or the reducer's error code when the claim is no longer submit-eligible
 * (a concurrent `revalidate` moved it out of `ready`, or a new blocking failure appeared since the route
 * enqueued the job) — callers MUST check this before calling the x12/MAC-portal ports.
 */
async function preflightClaimSubmit(
  tx: BillingDb,
  claim: repositories.ClaimRecord,
): Promise<{ readonly to: ClaimState } | { readonly error: string }> {
  const unresolvedBlockingFailures = await unresolvedBlockingFailuresForClaim(tx, claim.id);
  const result = reduceClaim(claim.state, "submit", {
    unresolvedBlockingFailures,
  });
  return result.error ? { error: result.error } : { to: result.state };
}

/** A stable RFC-4122-shaped uuid derived from a seed (sha256 → v4 layout), so replays collapse to one id. */
export function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] as string;
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The NOE/NOTR filing window (days). `m23.{noe,notr}.window_warning` reports how far into it a notice is. */
const NOTICE_WINDOW_DAYS = 5;

/** Whole-day count from `now` to a `yyyy-mm-dd` window target (negative when past). */
function daysToTarget(targetDate: string, now: Date): number {
  const target = new Date(`${targetDate}T00:00:00.000Z`).getTime();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

/**
 * The generate-837i claim document for a persisted claim. THROWS when the discharge codes are not resolved
 * (`patient_status_code` NULL) — the submit preflight already requires a passing validation run, whose
 * `bereavement_discharge_legitimacy` rule blocks unresolved codes, so this is defense in depth: the throw
 * lands in the caller's catch and fails the attempt (`failed_worker`) rather than sending a claim without
 * a patient status.
 */
export function claimDocumentFor(
  claim: {
    readonly id: string;
    readonly tob: string;
    readonly serviceFrom: string;
    readonly serviceTo: string;
    readonly patientStatusCode: string | null;
    readonly conditionCodes: unknown;
    readonly occurrenceCodes: unknown;
    /** Migration 0378 — the derived occurrence spans (late-NOE OSC 77). Absent on a pre-0378 caller shape. */
    readonly occurrenceSpans?: unknown;
    /** Migration 1057 — UB-04 FL 14 / FL 15, from the M6 admission. Absent on a pre-1057 caller shape. */
    readonly admissionTypeCode?: string | null;
    readonly admissionSourceCode?: string | null;
    /** Migration 1059 — wage-index value codes 61 / G8. Absent on a pre-1059 caller shape. */
    readonly valueCodes?: unknown;
  },
  claimControlNumber: string,
): ClaimDocument837i {
  if (claim.patientStatusCode === null) {
    throw new Error(`claim ${claim.id} has no patient discharge status (re-validate the claim)`);
  }
  const conditionCodes = Array.isArray(claim.conditionCodes)
    ? claim.conditionCodes.filter((c): c is string => typeof c === "string")
    : [];
  const occurrenceCodes = Array.isArray(claim.occurrenceCodes)
    ? claim.occurrenceCodes.flatMap((o: unknown) => {
        const r = o as { code?: unknown; date?: unknown } | null;
        return r && typeof r.code === "string" && typeof r.date === "string"
          ? [{ code: r.code, date: r.date }]
          : [];
      })
    : [];
  const occurrenceSpans = Array.isArray(claim.occurrenceSpans)
    ? claim.occurrenceSpans.flatMap((o: unknown) => {
        const r = o as { code?: unknown; from?: unknown; through?: unknown } | null;
        return r &&
          typeof r.code === "string" &&
          typeof r.from === "string" &&
          typeof r.through === "string"
          ? [{ code: r.code, from: r.from, through: r.through }]
          : [];
      })
    : [];
  return {
    claimId: claim.id,
    claimControlNumber,
    tob: claim.tob,
    serviceFrom: claim.serviceFrom,
    serviceTo: claim.serviceTo,
    admissionTypeCode: claim.admissionTypeCode ?? null,
    admissionSourceCode: claim.admissionSourceCode ?? null,
    valueCodes: Array.isArray(claim.valueCodes)
      ? claim.valueCodes.flatMap((v: unknown) => {
          const r = v as { code?: unknown; cbsaCode?: unknown } | null;
          return r && typeof r.code === "string" && typeof r.cbsaCode === "string"
            ? [{ code: r.code, cbsaCode: r.cbsaCode }]
            : [];
        })
      : [],
    dischargeCodes: { patientStatus: claim.patientStatusCode, conditionCodes, occurrenceCodes },
    occurrenceSpans,
  };
}

// ── the §4.8 WORK processors (each runs INSIDE the worker's per-job withOrgContext tx) ──────────────────────

/**
 * `claim.submit` (§4.8): drain `m23.claim.submit_requested` — generate the 837I via the x12 sidecar, upload to
 * the MAC portal, drive the §2.2 READY/DRAFT → SUBMITTED transition (pure reducer, version-checked), and emit
 * `m23.claim.submitted`. On a portal failure emit `m23.claim.submission_failed` (the retry queue pickup signal)
 * and rethrow so BullMQ records the failed attempt. All x12/portal calls sit behind the fail-closed binds.
 */
export async function runClaimSubmit(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: ClaimSubmitJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const claims = new ClaimRepository(tx);
  const submissions = new ClaimSubmissionRepository(tx);
  const now = (deps.now ?? (() => new Date()))();

  const claim = await claims.findById(job.claimId);
  if (!claim) throw new Error(`claim ${job.claimId} not found`);

  // Preflight the §2.3 submit guard BEFORE transmitting anything — never physically upload a claim that
  // is no longer submit-eligible (see {@link preflightClaimSubmit}).
  const preflight = await preflightClaimSubmit(tx, claim);
  if ("error" in preflight) {
    const reason = `claim is no longer submit-eligible (${preflight.error}, state=${claim.state})`;
    await submissions.terminalize(job.submissionId, {
      outcome: "failed_worker",
      outcomeReason: reason,
      generatedFileUri: null,
      submittedAt: null,
      workerCorrelationId: null,
    });
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: {
        claimId: job.claimId,
        submissionId: job.submissionId,
        attemptIndex: job.attemptIndex,
        reason,
      },
    });
    return;
  }

  let generated: {
    readonly x12: string;
    readonly correlationId: string;
  } | null = null;
  let uploaded: {
    readonly accepted: boolean;
    readonly generatedFileUri: string;
  } | null = null;
  try {
    generated = await x12Of(deps).generate837i({
      organizationId: job.organizationId,
      claimId: job.claimId,
      claimControlNumber: job.claimControlNumber,
      claimDocument: claimDocumentFor(claim, job.claimControlNumber),
    });
    uploaded = await macPortalOf(deps).upload({
      organizationId: job.organizationId,
      providerEntityId: claim.providerEntityId,
      kind: "claim_837i",
      x12: generated.x12,
      controlNumber: job.claimControlNumber,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await submissions.terminalize(job.submissionId, {
      outcome: generated ? "failed_portal" : "failed_worker",
      outcomeReason: reason,
      generatedFileUri: null,
      submittedAt: null,
      workerCorrelationId: generated?.correlationId ?? null,
    });
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: {
        claimId: job.claimId,
        submissionId: job.submissionId,
        attemptIndex: job.attemptIndex,
        reason,
      },
    });
    return;
  }

  if (!uploaded || !generated) {
    throw new Error("submission transport returned without a complete result");
  }
  if (!uploaded.accepted) {
    const reason = "MAC portal rejected the 837I upload";
    await submissions.terminalize(job.submissionId, {
      outcome: "failed_portal",
      outcomeReason: reason,
      generatedFileUri: uploaded.generatedFileUri,
      submittedAt: null,
      workerCorrelationId: generated.correlationId,
    });
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: {
        claimId: job.claimId,
        submissionId: job.submissionId,
        attemptIndex: job.attemptIndex,
        reason,
      },
    });
    return;
  }

  await submissions.terminalize(job.submissionId, {
    outcome: "submitted",
    outcomeReason: null,
    generatedFileUri: uploaded.generatedFileUri,
    submittedAt: now,
    workerCorrelationId: generated.correlationId,
  });

  const result = await claims.transitionToState(job.claimId, claim.version, preflight.to);
  if (!result.ok)
    throw new Error(`claim ${job.claimId} version conflict on submit (${result.currentVersion})`);

  await outbox.publish(tx, {
    eventName: "m23.claim.submitted",
    organizationId: job.organizationId,
    aggregateKind: "claim",
    aggregateId: job.claimId,
    payload: {
      claimId: job.claimId,
      submissionId: job.submissionId,
      claimControlNumber: job.claimControlNumber,
      macJurisdiction: claim.macJurisdiction,
      submittedAt: now.toISOString(),
    },
  });
}

/**
 * `claim.submit.retry` (§4.8): retry the MAC-portal upload with exponential backoff (BullMQ-managed, max 5
 * attempts via {@link M23_QUEUE_PARAMS}). Appends a NEW `claim_submission` attempt row, re-uploads, and on
 * success transitions the claim. When the attempt budget is exhausted it emits `m23.claim.submission_stalled`
 * (severity=critical) so the §4.9 stalled alert fires. Mirrors {@link runClaimSubmit}'s submit path.
 */
export async function runClaimSubmitRetry(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: ClaimSubmitRetryJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const claims = new ClaimRepository(tx);
  const submissions = new ClaimSubmissionRepository(tx);
  const now = (deps.now ?? (() => new Date()))();
  const attemptIndex = job.attemptIndex + 1;

  const claim = await claims.findById(job.claimId);
  if (!claim) throw new Error(`claim ${job.claimId} not found`);
  const priorSubmission = await submissions.findById(job.submissionId);
  if (
    !priorSubmission ||
    priorSubmission.claimId !== job.claimId ||
    priorSubmission.attemptIndex !== job.attemptIndex
  ) {
    throw new Error(`claim submission ${job.submissionId} does not match the retry request`);
  }

  if (attemptIndex >= M23_QUEUE_PARAMS.claimSubmitRetry.attempts) {
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_stalled",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: {
        claimId: job.claimId,
        submissionId: job.submissionId,
        attemptIndex,
        reason: "retry budget exhausted",
      },
    });
    await alertsOf(deps).dispatch({
      alertCode: "m23.claim.submission_stalled",
      severity: "critical",
      organizationId: job.organizationId,
      payload: {
        claimId: job.claimId,
        submissionId: job.submissionId,
        attemptIndex,
      },
    });
    return;
  }

  // Preflight the §2.3 submit guard BEFORE transmitting anything — mirrors {@link runClaimSubmit}. A
  // concurrent `revalidate` (or a new blocking failure) since the last attempt means this claim must not
  // be re-transmitted; fail this attempt instead (the retry budget check above still applies on the next
  // delivery, so a permanently-ineligible claim eventually stalls+alerts rather than retrying forever).
  const preflight = await preflightClaimSubmit(tx, claim);
  if ("error" in preflight) {
    const reason = `claim is no longer submit-eligible (${preflight.error}, state=${claim.state})`;
    await submissions.append({
      organizationId: job.organizationId,
      providerEntityId: claim.providerEntityId,
      kind: "claim_837i",
      claimId: job.claimId,
      claimControlNumber: priorSubmission.claimControlNumber,
      attemptIndex,
      outcome: "failed_worker",
      outcomeReason: reason,
      generatedFileUri: null,
      submittedAt: null,
      workerCorrelationId: null,
    });
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: {
        claimId: job.claimId,
        submissionId: job.submissionId,
        attemptIndex,
        reason,
      },
    });
    return;
  }

  const parsedControlNumber = parseControlNumber(priorSubmission.claimControlNumber);
  if (!parsedControlNumber) {
    throw new Error(`claim submission ${job.submissionId} has an invalid control number`);
  }
  const claimControlNumber = deriveControlNumber({
    ccn: parsedControlNumber.ccn,
    serviceFrom: claim.serviceFrom,
    claimId: claim.id,
    attemptIndex,
  });

  let generated: {
    readonly x12: string;
    readonly correlationId: string;
  } | null = null;
  let uploaded: {
    readonly accepted: boolean;
    readonly generatedFileUri: string;
  } | null = null;
  let failureReason: string | null = null;
  try {
    generated = await x12Of(deps).generate837i({
      organizationId: job.organizationId,
      claimId: job.claimId,
      claimControlNumber,
      claimDocument: claimDocumentFor(claim, claimControlNumber),
    });
    uploaded = await macPortalOf(deps).upload({
      organizationId: job.organizationId,
      providerEntityId: claim.providerEntityId,
      kind: "claim_837i",
      x12: generated.x12,
      controlNumber: claimControlNumber,
    });
    if (!uploaded.accepted) failureReason = "MAC portal rejected the retry upload";
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
  }

  const submission = await submissions.append({
    organizationId: job.organizationId,
    providerEntityId: claim.providerEntityId,
    kind: "claim_837i",
    claimId: job.claimId,
    claimControlNumber,
    attemptIndex,
    outcome: failureReason ? (generated ? "failed_portal" : "failed_worker") : "submitted",
    outcomeReason: failureReason,
    generatedFileUri: uploaded?.generatedFileUri ?? null,
    submittedAt: failureReason ? null : now,
    workerCorrelationId: generated?.correlationId ?? null,
  });

  if (failureReason) {
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: {
        claimId: job.claimId,
        submissionId: submission.id,
        attemptIndex,
        reason: failureReason,
      },
    });
    return;
  }

  const result = await claims.transitionToState(job.claimId, claim.version, preflight.to);
  if (!result.ok) throw new Error(`claim ${job.claimId} version conflict on retry submit`);
  await outbox.publish(tx, {
    eventName: "m23.claim.submitted",
    organizationId: job.organizationId,
    aggregateKind: "claim",
    aggregateId: job.claimId,
    payload: {
      claimId: job.claimId,
      submissionId: submission.id,
      claimControlNumber,
      macJurisdiction: claim.macJurisdiction,
      submittedAt: now.toISOString(),
    },
  });
}

/**
 * Record a NOE / NOTR transmission attempt. The submit route already appended the attempt as QUEUED (same
 * `(provider_entity, control_number, attempt 0)` key), so the idempotent append collapses onto that row and
 * returns it unchanged: terminalize it with this transmission's outcome (the transfer-notice precedent) instead of
 * leaving a transmitted notice's attempt QUEUED forever.
 */
async function recordNoticeTransmission(
  submissions: InstanceType<typeof ClaimSubmissionRepository>,
  values: Parameters<InstanceType<typeof ClaimSubmissionRepository>["append"]>[0],
): Promise<Awaited<ReturnType<InstanceType<typeof ClaimSubmissionRepository>["append"]>>> {
  const appended = await submissions.append(values);
  if (appended.outcome !== "queued") return appended;
  return submissions.terminalize(appended.id, {
    outcome: values.outcome,
    outcomeReason: null,
    generatedFileUri: values.generatedFileUri ?? null,
    submittedAt: values.submittedAt ?? null,
    workerCorrelationId: values.workerCorrelationId ?? null,
  });
}

/**
 * `noe.submit` (§4.8): drain `m23.noe.submit_requested` — generate the NOE via the x12 sidecar, upload to the
 * MAC portal, append the `claim_submission` (kind='noe') row, drive the §2.2 NOE READY → SUBMITTED transition
 * (pure `noeMachine.reduce`, version-checked), and emit `m23.noe.submitted`.
 */
export async function runNoeSubmit(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: NoeSubmitJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const noes = new NoeRepository(tx);
  const submissions = new ClaimSubmissionRepository(tx);
  const now = (deps.now ?? (() => new Date()))();

  const noe = await noes.findById(job.noeId);
  if (!noe) throw new Error(`noe_record ${job.noeId} not found`);

  const generated = await x12Of(deps).generateNoe({
    organizationId: job.organizationId,
    noeId: job.noeId,
    noeControlNumber: noe.noeControlNumber,
  });
  const uploaded = await macPortalOf(deps).upload({
    organizationId: job.organizationId,
    providerEntityId: noe.providerEntityId,
    kind: "noe",
    x12: generated.x12,
    controlNumber: noe.noeControlNumber,
  });
  const submission = await recordNoticeTransmission(submissions, {
    organizationId: job.organizationId,
    providerEntityId: noe.providerEntityId,
    kind: "noe",
    noeId: job.noeId,
    claimControlNumber: noe.noeControlNumber,
    attemptIndex: 0,
    outcome: uploaded.accepted ? "submitted" : "failed_portal",
    generatedFileUri: uploaded.generatedFileUri,
    submittedAt: uploaded.accepted ? now : null,
    workerCorrelationId: generated.correlationId,
  });
  if (!uploaded.accepted) throw new Error("MAC portal rejected the NOE upload");

  const next = noeMachine.reduce(noe.state, "submit");
  if (next.error)
    throw new Error(`illegal NOE transition ${noe.state} --submit--> (${next.error})`);
  const result = await noes.transitionToState(job.noeId, noe.version, next.state as NoticeState, {
    latestSubmissionId: submission.id,
  });
  if (!result.ok) throw new Error(`noe ${job.noeId} version conflict on submit`);

  await outbox.publish(tx, {
    eventName: "m23.noe.submitted",
    organizationId: job.organizationId,
    aggregateKind: "noe",
    aggregateId: job.noeId,
    payload: {
      noeId: job.noeId,
      submissionId: submission.id,
      submittedAt: now.toISOString(),
    },
  });
}

/** `notr.submit` (§4.8): the NOTR twin of {@link runNoeSubmit} (parallel state machine + control number). */
export async function runNotrSubmit(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: NotrSubmitJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const notrs = new NotrRepository(tx);
  const submissions = new ClaimSubmissionRepository(tx);
  const now = (deps.now ?? (() => new Date()))();

  const notr = await notrs.findById(job.notrId);
  if (!notr) throw new Error(`notr_record ${job.notrId} not found`);

  const generated = await x12Of(deps).generateNotr({
    organizationId: job.organizationId,
    notrId: job.notrId,
    notrControlNumber: notr.notrControlNumber,
  });
  const uploaded = await macPortalOf(deps).upload({
    organizationId: job.organizationId,
    providerEntityId: notr.providerEntityId,
    kind: "notr",
    x12: generated.x12,
    controlNumber: notr.notrControlNumber,
  });
  const submission = await recordNoticeTransmission(submissions, {
    organizationId: job.organizationId,
    providerEntityId: notr.providerEntityId,
    kind: "notr",
    notrId: job.notrId,
    claimControlNumber: notr.notrControlNumber,
    attemptIndex: 0,
    outcome: uploaded.accepted ? "submitted" : "failed_portal",
    generatedFileUri: uploaded.generatedFileUri,
    submittedAt: uploaded.accepted ? now : null,
    workerCorrelationId: generated.correlationId,
  });
  if (!uploaded.accepted) throw new Error("MAC portal rejected the NOTR upload");

  const next = notrMachine.reduce(notr.state, "submit");
  if (next.error)
    throw new Error(`illegal NOTR transition ${notr.state} --submit--> (${next.error})`);
  const result = await notrs.transitionToState(
    job.notrId,
    notr.version,
    next.state as NoticeState,
    {
      latestSubmissionId: submission.id,
    },
  );
  if (!result.ok) throw new Error(`notr ${job.notrId} version conflict on submit`);

  await outbox.publish(tx, {
    eventName: "m23.notr.submitted",
    organizationId: job.organizationId,
    aggregateKind: "notr",
    aggregateId: job.notrId,
    payload: {
      notrId: job.notrId,
      submissionId: submission.id,
      submittedAt: now.toISOString(),
    },
  });
}

/**
 * `transfer_notice.submit`: the 8xC / 8xD processor (`jobs/transfer-notice-jobs.ts`) over this bundle's ports.
 * Exported for the live suite, which drives it directly (the `runClaimSubmit` posture).
 */
export async function runTransferNoticeSubmitJob(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: TransferNoticeSubmitJob,
): Promise<void> {
  const x12 = x12Of(deps);
  const portal = macPortalOf(deps);
  await runTransferNoticeSubmit(
    tx,
    {
      generate: (input) =>
        x12.generateTransferNotice
          ? x12.generateTransferNotice(input)
          : unboundWorkerPort(
              "x12.generateTransferNotice",
              "bind the X12 gateway's generate-transfer-notice operation",
            ),
      upload: (input) => portal.upload(input),
      outbox: outboxOf(deps),
      now: deps.now ?? (() => new Date()),
    },
    job,
  );
}

/**
 * The `eligibility_check.parsed_payload` (§3.6) — coverage flags + the structured hospice history. NO MBI / NO
 * name / NO DOB. `hospicePeriods` is null when HETS returned no usable hospice section (so a reader can tell
 * "no history" from "not asked"). The hospice fields are what `GET /billing/eligibility/hospice-periods` reads.
 */
export function eligibilityParsedPayload(result: HetsEligibilityResult): Record<string, unknown> {
  const h = result.hospice;
  return {
    partAActive: result.outcome === "active_part_a",
    partAEffectiveDate: result.partAEffectiveDate,
    partATerminationDate: result.partATerminationDate,
    hospiceElectionOnFile: result.hospiceElectionOnFile,
    hospicePeriods: h ? h.periods.map((p) => ({ ...p })) : null,
    hospiceElectionOpen: h ? h.electionOpen : null,
    hospiceHistoryTruncated: h ? h.truncated : null,
    hospiceNextPeriodNumber: h ? h.nextPeriodNumber : null,
    hospiceNextPeriodBasis: h ? h.nextPeriodBasis : null,
    rejectionCodes: [...result.rejectionCodes],
    reason: result.reason,
    transport: result.transport,
  };
}

/**
 * `eligibility.refresh` (§4.4 / §4.8): drain `m23.eligibility.refresh_requested` — run the HETS 270/271 check
 * (the bound seam unlocks + zeroes the MBI internally; the MBI never crosses this file), APPEND the
 * `eligibility_check` row (append-only; outcome codec mapped at the repo boundary), and emit
 * `m23.eligibility.checked`.
 */
export async function runEligibilityRefresh(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: EligibilityRefreshJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const checks = new EligibilityCheckRepository(tx);

  const result = await hetsOf(deps).check({
    organizationId: job.organizationId,
    patientId: job.patientId,
    providerEntityId: job.providerEntityId,
    asOfServiceDate: job.asOfServiceDate,
  });

  const parsedPayload = eligibilityParsedPayload(result);
  // Persistence-boundary guard (§8.7): an MBI-shaped token in the payload aborts the write (no row, no event).
  assertNoMbi(parsedPayload);
  const row = await checks.append({
    organizationId: job.organizationId,
    providerEntityId: job.providerEntityId,
    patientId: job.patientId,
    asOfServiceDate: job.asOfServiceDate,
    outcome: result.outcome,
    parsedPayload,
    rawResponseFileUri: result.responseFileUri,
    workerCorrelationId: result.correlationId,
    staleAt: result.staleAt,
  });

  await outbox.publish(tx, {
    eventName: "m23.eligibility.checked",
    organizationId: job.organizationId,
    aggregateKind: "patient",
    aggregateId: job.patientId,
    // The §4.10 catalog shape (`checkId`, `checkedAt`, `staleAt`) — the real catalog-validating publisher
    // refuses a payload missing any of them, which would roll the freshly-appended check back.
    payload: {
      checkId: row.id,
      patientId: job.patientId,
      asOfServiceDate: job.asOfServiceDate,
      outcome: result.outcome,
      checkedAt: row.checkedAt.toISOString(),
      staleAt: result.staleAt.toISOString(),
    },
  });
}

/**
 * `validation-run` (§4.8): drain a validation-run job (the `validateClaim` route + the revalidate consumer both
 * enqueue this). Delegates to the bound {@link ClaimValidationRunnerPort} (the M23 claim-validation-service) so
 * the rule-library run + result persistence + claim transition + `m23.claim.*` emits live in ONE home. The
 * runner runs inside this worker's `withOrgContext` tx. FAIL-CLOSED until the runner is bound.
 */
async function runValidationRun(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: ValidationRunJob,
): Promise<void> {
  await validationRunnerOf(deps).run({
    tx,
    organizationId: job.organizationId,
    claimId: job.claimId,
    validationRunId: job.validationRunId,
    trigger: job.trigger,
  });
}

/**
 * `revalidate.consumer` (§4.8): for a consumed upstream change event, resolve every M23 claim in VALIDATING or
 * READY that depends on the changed fact (the fail-closed {@link RevalidationTargetResolverPort}) and enqueue a
 * `validation-run` per target with trigger `re_validation_after_correction`. Idempotent on (event_id, claim_id)
 * via the {@link M23_IDEMPOTENCY_KEYS.revalidateConsumer} dedupe key so redelivery is a no-op.
 */
export async function runRevalidateConsumer(
  tx: BillingDb,
  deps: M23WorkerDeps,
  job: RevalidateConsumerJob,
): Promise<void> {
  const claims = new ClaimRepository(tx);
  const enqueue = enqueueOf(deps);

  const targets = await revalidationTargetsOf(deps).resolve({
    tx,
    organizationId: job.organizationId,
    eventName: job.eventName,
    eventPayload: job.eventPayload,
  });

  for (const { claimId } of targets) {
    const claim = await claims.findById(claimId);
    if (!claim || (claim.state !== "validating" && claim.state !== "ready")) continue;
    // Deterministic per (event, claim) — idempotent — and a real uuid: it becomes `validation_run.id`.
    const validationRunId = deterministicUuid(`${job.eventId}:${claimId}`);
    await enqueue.enqueue(
      M23_QUEUES.validationRun,
      `${job.organizationId}:${claimId}:${job.eventId}`,
      {
        organizationId: job.organizationId,
        claimId,
        validationRunId,
        trigger: "re_validation_after_correction",
      },
    );
  }
}

// ── the §4.8 CRON processors (per-MAC-jurisdiction ack pulls + per-org watchdogs) ──────────────────────────

// `ack.pull-999` / `ack.pull-277ca` (§4.8 cron): for each MAC jurisdiction, pull pending ack files from the
// portal, parse them via the x12 sidecar and, per result under that result's own org `withOrgContext`, route
// the ack by its submission's subject kind (claim / NOE / NOTR / transfer notice): APPEND a
// `claim_acknowledgment` row and drive the subject's §2.2 transition. 999 advances ACK staging; 277CA drives
// ACK_PENDING → ACK_ACCEPTED / ACK_REJECTED (/ ACK_PARTIAL for a claim). Portal/x12 calls sit behind fail-closed
// binds.

/** The submission an acknowledgment answers. Under the ack's own org (RLS), so another org's reads as unknown. */
type AckedSubmission = NonNullable<
  Awaited<ReturnType<InstanceType<typeof ClaimSubmissionRepository>["findById"]>>
>;

/** Every parsed acknowledgment line the two crons route (999 and 277CA, normalised). */
interface RoutedAck {
  readonly organizationId: string;
  readonly kind: "ack_999" | "ack_277ca";
  /** Omitted = derived from `kind` (999 = clearinghouse, 277CA = payer). */
  readonly stage?: "clearinghouse" | "payer";
  readonly outcome: "accepted" | "rejected" | "partial";
  readonly payerControlNumber: string | null;
  readonly reasonCodes: readonly string[];
  readonly macJurisdiction: string;
  readonly ackFileUri: string;
  readonly receivedAt: Date;
  /** The payer-stamped dates the gateway parsed (a notice's `payer_status_date`). */
  readonly payerDates?: AckPayerDates;
}

/**
 * Route one acknowledgment by its submission's subject kind: a transfer notice (8xC / 8xD), a NOE, a NOTR or a
 * claim. An ack whose submission is unknown (or another org's) is skipped — there is nothing to record it
 * against, and the `claim_acknowledgment.submission_id` FK would refuse it.
 */
async function routeAck(
  tx: BillingDb,
  deps: M23WorkerDeps,
  submissionId: string,
  parsed: RoutedAck,
): Promise<void> {
  const submission = await new ClaimSubmissionRepository(tx).findById(submissionId);
  if (!submission) return;
  // Only code-shaped reason codes go on, whichever subject they land on (no free text / PHI from the gateway).
  const ack = { ...parsed, reasonCodes: sanitizeAckReasonCodes(parsed.reasonCodes) };
  if (submission.kind === "transfer_notice") {
    await applyTransferNoticeAck(tx, outboxOf(deps), { ...ack, submissionId });
    return;
  }
  if (submission.kind === "noe" || submission.kind === "notr") {
    await applyNoticeAck(
      tx,
      { outbox: outboxOf(deps), alerts: alertsOf(deps) },
      {
        id: submission.id,
        kind: submission.kind,
        noeId: submission.noeId ?? null,
        notrId: submission.notrId ?? null,
      },
      ack,
    );
    return;
  }
  await applyClaimAck(tx, deps, submission, ack);
}

/**
 * ADR-0052: a claim the MAC rejected at the payer stage (277CA) becomes ONE `rtp_correction` DDE item. Runs in its own
 * savepoint AFTER the rejection is recorded: a queue failure is logged (ids only) and rolled back alone, so it can never
 * undo the acknowledgment or the claim transition (which have already been decided and published). A missed item is
 * recoverable by hand (`POST /dde-items`, type `rtp_correction`). Idempotent: an item already open for the claim, or a
 * replayed ack (the claim is no longer `ack_pending`, so this is never reached twice), creates nothing.
 */
async function queueRtpCorrection(
  deps: M23WorkerDeps,
  tx: BillingDb,
  claim: { readonly providerEntityId: string; readonly patientId: string },
  organizationId: string,
  acknowledgmentId: string,
  rejectionCodes: readonly string[],
  claimId: string,
): Promise<void> {
  const watchdog = deps.ddeWatchdog;
  if (!watchdog) return;
  try {
    await tx.transaction(async (savepoint) => {
      await watchdog.ensureClaimRtpItem(savepoint as unknown as BillingDb, {
        organizationId,
        claimId,
        providerEntityId: claim.providerEntityId,
        patientId: claim.patientId,
        acknowledgmentId,
        rejectionCodes,
      });
    });
  } catch (err) {
    // Never log `err.message`: a Postgres error can embed row/key detail (patient or claim ids, an MBI). Ids plus the
    // error class and SQLSTATE/constraint are enough to find the failure. `logger` is optional on the worker deps; when
    // absent the failure is deliberately not reported (the rollback and the by-hand `POST /dde-items` path still hold).
    const pgError = err as { code?: unknown; constraint?: unknown } | null;
    deps.logger?.error(
      {
        organizationId,
        claimId,
        errorName: err instanceof Error ? err.name : typeof err,
        ...(typeof pgError?.code === "string" ? { code: pgError.code } : {}),
        ...(typeof pgError?.constraint === "string" ? { constraint: pgError.constraint } : {}),
      },
      "dde rtp queueing failed",
    );
  }
}

/** The claim twin of {@link applyNoticeAck}: 999 advances ACK staging; 277CA drives ACK_PENDING → accepted/rejected/partial. */
async function applyClaimAck(
  tx: BillingDb,
  deps: M23WorkerDeps,
  submission: AckedSubmission,
  ack: RoutedAck,
): Promise<void> {
  const claimId = submission.claimId;
  if (!claimId) return;
  const reasonCodes = [...ack.reasonCodes];
  if (ack.stage === "clearinghouse" && ack.kind !== "ack_999") {
    throw new Error(
      "claim ack: a clearinghouse-stage answer must be an ack_999 (it cannot reach ack_accepted)",
    );
  }
  const recorded = await new ClaimAcknowledgmentRepository(tx).append({
    organizationId: ack.organizationId,
    submissionId: submission.id,
    claimId,
    kind: ack.kind,
    stage: ack.stage ?? (ack.kind === "ack_999" ? "clearinghouse" : "payer"),
    macJurisdiction: ack.macJurisdiction as NewClaimAck["macJurisdiction"],
    ackFileUri: ack.ackFileUri,
    ackReceivedAt: ack.receivedAt,
    parsedPayload:
      ack.kind === "ack_999"
        ? { accepted: ack.outcome === "accepted", reasonCodes }
        : { outcome: ack.outcome, payerClaimControlNumber: ack.payerControlNumber, reasonCodes },
    outcomeStatus: ack.outcome,
  });
  const claims = new ClaimRepository(tx);
  const claim = await claims.findById(claimId);
  if (!claim) return;
  const event: ClaimTransitionEvent =
    ack.kind === "ack_999"
      ? ack.outcome === "accepted"
        ? "ack_999_accepted"
        : "ack_999_rejected"
      : ack.outcome === "accepted"
        ? "ack_277ca_accepted"
        : ack.outcome === "partial"
          ? "ack_277ca_partial"
          : "ack_277ca_rejected";
  if (!canClaimTransition(claim.state, event)) return;
  await claims.transitionToState(
    claimId,
    claim.version,
    nextClaimState(claim.state, event),
    event === "ack_999_accepted" ? { clearinghouseAcceptedAt: ack.receivedAt } : {},
  );
  const emit = (eventName: string, payload: Record<string, unknown>) =>
    outboxOf(deps).publish(tx, {
      eventName,
      organizationId: ack.organizationId,
      aggregateKind: "claim",
      aggregateId: claimId,
      payload: { claimId, acknowledgmentId: recorded.id, ...payload },
    });
  // Payloads match the catalog (`events-by-m23.ts`) — the catalog-validating publisher refuses anything else.
  if (event === "ack_999_rejected" || event === "ack_277ca_rejected") {
    await emit("m23.claim.rejected", {
      rejectionStage:
        event === "ack_277ca_rejected"
          ? "277ca"
          : ack.stage === "clearinghouse"
            ? "clearinghouse"
            : "999",
      rejectionCodes: reasonCodes,
    });
    if (event === "ack_277ca_rejected") {
      await queueRtpCorrection(
        deps,
        tx,
        claim,
        ack.organizationId,
        recorded.id,
        reasonCodes,
        claimId,
      );
    }
  } else if (event === "ack_277ca_accepted") {
    await emit("m23.claim.acknowledged", { payerClaimControlNumber: ack.payerControlNumber ?? "" });
  } else if (event === "ack_277ca_partial") {
    // The 277CA parse carries no per-line accept/reject sets yet.
    await emit("m23.claim.acknowledgment_partial", {
      acceptedLineNumbers: [],
      rejectedLineNumbers: [],
      rejectionCodes: reasonCodes,
    });
  }
}

/**
 * Apply every parsed ack of a run, each in its own org's `withOrgContext`. One failing ack (a version conflict, an
 * unavailable alert router) must not strand the acks behind it: it is collected, the rest are applied, and the run
 * then fails with a PHI-free summary so BullMQ retries it (every ack is idempotent, so a retry re-applies only what
 * failed).
 */
async function applyAcks(
  deps: M23WorkerDeps,
  acks: readonly { readonly submissionId: string; readonly ack: RoutedAck }[],
): Promise<void> {
  const failures: string[] = [];
  for (const { submissionId, ack } of acks) {
    try {
      await withOrgContext(
        deps.db,
        { organizationId: ack.organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
        (txAny) => routeAck(txAny as unknown as BillingDb, deps, submissionId, ack),
      );
    } catch (err) {
      failures.push(`${ack.kind} for submission ${submissionId}: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${acks.length} acknowledgment(s) failed: ${failures.join("; ")}`,
    );
  }
}

/** `ack.pull-999` (§4.8 cron). Exported for the transfer-notice and NOE/NOTR live suites. */
export async function runAckPull999(deps: M23WorkerDeps): Promise<void> {
  const portal = macPortalOf(deps);
  const x12 = x12Of(deps);
  const now = deps.now ?? (() => new Date());
  const acks: { submissionId: string; ack: RoutedAck }[] = [];
  for (const { macJurisdiction } of await jurisdictionsOf(deps).listJurisdictions()) {
    for (const file of await portal.pullPending999(macJurisdiction)) {
      for (const result of await x12.parse999({ macJurisdiction, rawFileUri: file.rawFileUri })) {
        acks.push({
          submissionId: result.submissionId,
          ack: {
            organizationId: result.organizationId,
            kind: "ack_999",
            ...(result.stage ? { stage: result.stage } : {}),
            outcome: result.accepted ? "accepted" : "rejected",
            payerControlNumber: null,
            reasonCodes: result.reasonCodes,
            macJurisdiction,
            ackFileUri: result.ackFileUri,
            receivedAt: now(),
            payerDates: {
              functionalGroupDate: result.functionalGroupDate ?? null,
              interchangeDate: result.interchangeDate ?? null,
            },
          },
        });
      }
    }
  }
  await applyAcks(deps, acks);
}

/** `ack.pull-277ca` (§4.8 cron): the 277CA twin of {@link runAckPull999} (accepted/rejected/partial outcomes). */
export async function runAckPull277ca(deps: M23WorkerDeps): Promise<void> {
  const portal = macPortalOf(deps);
  const x12 = x12Of(deps);
  const now = deps.now ?? (() => new Date());
  const acks: { submissionId: string; ack: RoutedAck }[] = [];
  for (const { macJurisdiction } of await jurisdictionsOf(deps).listJurisdictions()) {
    for (const file of await portal.pullPending277ca(macJurisdiction)) {
      for (const result of await x12.parse277ca({ macJurisdiction, rawFileUri: file.rawFileUri })) {
        acks.push({
          submissionId: result.submissionId,
          ack: {
            organizationId: result.organizationId,
            kind: "ack_277ca",
            outcome: result.outcome,
            payerControlNumber: result.payerClaimControlNumber,
            reasonCodes: result.reasonCodes,
            macJurisdiction,
            ackFileUri: result.ackFileUri,
            receivedAt: now(),
            payerDates: { statusEffectiveDate: result.statusEffectiveDate ?? null },
          },
        });
      }
    }
  }
  await applyAcks(deps, acks);
}

/**
 * ADR-0052 — file a DDE work item for each in-flight notice whose filing window is near, via the bound watchdog.
 * Each notice runs in its OWN savepoint: one that makes the watchdog throw (a "poison" notice) is rolled back alone and
 * reported, and the notices after it still get their items. Returns the failures instead of throwing, so the
 * transaction commits what succeeded.
 */
async function queueDdeWork(
  deps: M23WorkerDeps,
  tx: BillingDb,
  organizationId: string,
  kind: "noe" | "notr",
  now: Date,
): Promise<unknown[]> {
  const watchdog = deps.ddeWatchdog;
  if (!watchdog) return [];
  // The lookahead is counted from the Eastern (CMS) calendar day, not the UTC date.
  const today = new Date(`${medicareReceiptDay(now)}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() + DDE_WATCHDOG_LOOKAHEAD_DAYS);
  const through = today.toISOString().slice(0, 10);
  const notices =
    kind === "noe"
      ? await new NoeRepository(tx).listDdeWatchCandidates(organizationId, through)
      : await new NotrRepository(tx).listDdeWatchCandidates(organizationId, through);
  const failures: unknown[] = [];
  for (const notice of notices) {
    try {
      await tx.transaction(async (savepoint) => {
        await watchdog.ensureNoticeItem(savepoint as unknown as BillingDb, {
          organizationId,
          itemType: kind,
          noticeId: notice.id,
          providerEntityId: notice.providerEntityId,
          patientId: notice.patientId,
          deadlineAt: notice.windowTargetAt,
        });
      });
    } catch (err) {
      failures.push(err);
    }
  }
  return failures;
}

/**
 * Run {@link queueDdeWork} for one org in its OWN transaction, AFTER the window warnings / breach stamps committed, so
 * a failure here can never roll back a window alert. Returns every failure (a whole-transaction error, or one per poison
 * notice) instead of throwing, so the other orgs still get their warnings and items; the cron throws one
 * `AggregateError` once every org has been served.
 */
async function queueDdeWorkIsolated(
  deps: M23WorkerDeps,
  organizationId: string,
  kind: "noe" | "notr",
  now: Date,
): Promise<unknown[]> {
  if (!deps.ddeWatchdog) return [];
  try {
    return await withOrgContext(
      deps.db,
      { organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
      async (txAny) => queueDdeWork(deps, txAny as unknown as BillingDb, organizationId, kind, now),
    );
  } catch (err) {
    return [err];
  }
}

/** Collect the DDE failures across orgs, log each with its org id (ids only, no PHI), then throw them together. */
function reportDdeFailures(
  deps: M23WorkerDeps,
  kind: "noe" | "notr",
  byOrg: readonly { organizationId: string; failures: readonly unknown[] }[],
): void {
  const all: unknown[] = [];
  for (const { organizationId, failures } of byOrg) {
    for (const err of failures) {
      all.push(err);
      // The message only: a database error can embed bound parameters, and the full set is already in the AggregateError.
      deps.logger?.error(
        { organizationId, kind, error: err instanceof Error ? err.message : String(err) },
        "dde watchdog failed",
      );
    }
  }
  if (all.length === 0) return;
  const orgs = [
    ...new Set(byOrg.filter((o) => o.failures.length > 0).map((o) => o.organizationId)),
  ];
  throw new AggregateError(
    all,
    `dde watchdog (${kind}) failed for ${all.length} notice(s)/org(s): ${orgs.join(", ")}`,
  );
}

/**
 * `noe.window-watch` (§4.8 cron, every 30 min): for each active org, walk the NOE rows whose 5-day window is
 * approaching and still un-acknowledged — emit `m23.noe.window_warning` at day 3 and, at day 5+1 (past target),
 * stamp `window_breached_at` (the fail-closed {@link NoticeWindowPort}) + emit `m23.noe.window_breached` and the
 * §4.9 system-locked alert. Pure day math + the candidate repo are real; the breach stamp is the one lazy seam.
 */
export async function runNoeWindowWatch(deps: M23WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const asOf = now.toISOString().slice(0, 10);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  const ddeFailures: { organizationId: string; failures: readonly unknown[] }[] = [];
  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
      async (txAny) => {
        const tx = txAny as unknown as BillingDb;
        const noes = new NoeRepository(tx);
        const outbox = outboxOf(deps);
        const candidates = await noes.listWindowWatchCandidates(organizationId, asOf);
        for (const noe of candidates) {
          const days = daysToTarget(noe.windowTargetAt, now);
          if (days < 0) {
            await noticeWindowOf(deps).recordBreach({
              tx,
              kind: "noe",
              noticeId: noe.id,
              expectedVersion: noe.version,
              breachedAt: now,
            });
            await outbox.publish(tx, {
              eventName: "m23.noe.window_breached",
              organizationId,
              aggregateKind: "noe",
              aggregateId: noe.id,
              payload: {
                noeId: noe.id,
                admissionId: noe.admissionId,
                breachedAt: now.toISOString(),
              },
            });
            await alertsOf(deps).dispatch({
              alertCode: "m23.noe.window_breached",
              severity: "critical",
              organizationId,
              payload: { noeId: noe.id, admissionId: noe.admissionId },
            });
          } else if (days <= 2) {
            await outbox.publish(tx, {
              eventName: "m23.noe.window_warning",
              organizationId,
              aggregateKind: "noe",
              aggregateId: noe.id,
              payload: {
                noeId: noe.id,
                admissionId: noe.admissionId,
                daysIntoWindow: NOTICE_WINDOW_DAYS - days,
              },
            });
            await alertsOf(deps).dispatch({
              alertCode: "m23.noe.window_warning",
              severity: "warn",
              organizationId,
              payload: {
                noeId: noe.id,
                admissionId: noe.admissionId,
                daysIntoWindow: NOTICE_WINDOW_DAYS - days,
              },
            });
          }
        }
      },
    );
    // ADR-0052: after (and apart from) the warnings / breach stamps above, so a failure here cannot undo them.
    ddeFailures.push({
      organizationId,
      failures: await queueDdeWorkIsolated(deps, organizationId, "noe", now),
    });
  }
  reportDdeFailures(deps, "noe", ddeFailures);
}

/** `notr.window-watch` (§4.8 cron): the NOTR twin of {@link runNoeWindowWatch}. */
export async function runNotrWindowWatch(deps: M23WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const asOf = now.toISOString().slice(0, 10);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  const ddeFailures: { organizationId: string; failures: readonly unknown[] }[] = [];
  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
      async (txAny) => {
        const tx = txAny as unknown as BillingDb;
        const notrs = new NotrRepository(tx);
        const outbox = outboxOf(deps);
        const candidates = await notrs.listWindowWatchCandidates(organizationId, asOf);
        for (const notr of candidates) {
          const days = daysToTarget(notr.windowTargetAt, now);
          if (days < 0) {
            await noticeWindowOf(deps).recordBreach({
              tx,
              kind: "notr",
              noticeId: notr.id,
              expectedVersion: notr.version,
              breachedAt: now,
            });
            await outbox.publish(tx, {
              eventName: "m23.notr.window_breached",
              organizationId,
              aggregateKind: "notr",
              aggregateId: notr.id,
              payload: {
                notrId: notr.id,
                admissionId: notr.admissionId,
                breachedAt: now.toISOString(),
              },
            });
            await alertsOf(deps).dispatch({
              alertCode: "m23.notr.window_breached",
              severity: "critical",
              organizationId,
              payload: { notrId: notr.id },
            });
          } else if (days <= 2) {
            await outbox.publish(tx, {
              eventName: "m23.notr.window_warning",
              organizationId,
              aggregateKind: "notr",
              aggregateId: notr.id,
              payload: {
                notrId: notr.id,
                admissionId: notr.admissionId,
                daysIntoWindow: NOTICE_WINDOW_DAYS - days,
              },
            });
            await alertsOf(deps).dispatch({
              alertCode: "m23.notr.window_warning",
              severity: "warn",
              organizationId,
              payload: {
                notrId: notr.id,
                admissionId: notr.admissionId,
                daysIntoWindow: NOTICE_WINDOW_DAYS - days,
              },
            });
          }
        }
      },
    );
    // ADR-0052: after (and apart from) the warnings / breach stamps above, so a failure here cannot undo them.
    ddeFailures.push({
      organizationId,
      failures: await queueDdeWorkIsolated(deps, organizationId, "notr", now),
    });
  }
  reportDdeFailures(deps, "notr", ddeFailures);
}

/**
 * `eligibility.stale-watch` (§4.8 cron, daily 06:00 org TZ): for each active org, list `eligibility_check` rows
 * past `stale_at` and emit `m23.eligibility.expired` + the §4.9 alert per affected patient (the row is
 * append-only, so "marking stale" is the emitted signal, not a row mutation — the next refresh appends a fresh row).
 */
export async function runEligibilityStaleWatch(deps: M23WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
      async (txAny) => {
        const tx = txAny as unknown as BillingDb;
        const checks = new EligibilityCheckRepository(tx);
        const outbox = outboxOf(deps);
        const stale = await checks.listStaleForOrg(organizationId, now);
        for (const check of stale) {
          // The table is append-only: an older stale row is superseded by a fresher check, and a patient
          // whose LATEST check is current is not expired — only the latest row decides (and it is unique
          // per patient, so no further de-duplication is needed).
          const latest = await checks.findLatestForPatient(organizationId, check.patientId);
          if (latest && latest.id !== check.id) continue;
          await outbox.publish(tx, {
            eventName: "m23.eligibility.expired",
            organizationId,
            aggregateKind: "patient",
            aggregateId: check.patientId,
            payload: {
              patientId: check.patientId,
              lastCheckedAt: check.checkedAt.toISOString(),
            },
          });
          await alertsOf(deps).dispatch({
            alertCode: "m23.eligibility.expired",
            severity: "warn",
            organizationId,
            payload: { patientId: check.patientId },
          });
        }
      },
    );
  }
}

/** Per-jurisdiction breaker state (§4.8 mac-portal.health): `lastUpAt` is refreshed on EVERY up tick (not
 *  only at a transition), so the `lastSeenUpAt` fact the `.unavailable` payload carries is the actual last
 *  observed-up instant, not merely "since the current streak began." `downedAt` is the instant the CURRENT
 *  down streak began (set once, at the down transition; carried forward on subsequent still-down ticks so
 *  the eventual `.recovered` payload reports the true outage start rather than the last tick before it). */
export interface MacPortalBreakerState {
  readonly up: boolean;
  readonly lastUpAt: Date | null;
  readonly downedAt: Date | null;
}

/** Deterministic per-jurisdiction synthetic aggregate id — MAC jurisdictions have no uuid PK anywhere in
 *  the schema (`MacJurisdictionListPort.listJurisdictions()` returns a plain code like `"ngs-j6"`, and
 *  `outbox_event.aggregate_id` is a NOT NULL `uuid` column). Stable across ticks/restarts (the same
 *  jurisdiction code always hashes to the same id) and formatted as a valid v4/variant-8 uuid literal — the
 *  `LAG_PROBE_SINGLETON_AGGREGATE_ID` precedent (`33-reporting/jobs/m33-jobs.ts`) extended to a per-key
 *  derivation rather than one fixed literal, since MAC-portal health is per-jurisdiction, not a platform
 *  singleton like the replica-lag probe. */
function macPortalAggregateId(macJurisdiction: string): string {
  const hex = createHash("sha256").update(`m23.mac_portal:${macJurisdiction}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `mac-portal.health` (§4.8 cron, every 5 min): per MAC jurisdiction probe the portal (HEAD via the bound
 * transport) and, on a state TRANSITION, emit `m23.mac_portal.unavailable` (down) or `m23.mac_portal.recovered`
 * (back up) to the outbox — the catalogued `declaredConsumers: ["m1"]` event M1's `system_status`-writing
 * platform consumer binds to — plus the §4.9 system-locked alert. A simple in-memory circuit-breaker holds
 * last-known state across ticks (the worker process is the breaker's home; a durable store is the follow-up).
 *
 * Platform-scoped (no org tx, no single tenant this event belongs to — `organizationId: null`). This goes
 * through the SAME `deps.outbox` (`bindCallerModule(txOutboxPublisher, "m23")`) every org-scoped `m23.*` emit
 * in this file already uses: a `null` organizationId does NOT need a `withPlatformContext`-opened tx the way
 * an ordinary platform-scoped READ does — `buildTxOutboxPublisher`'s persist step routes a null-org record
 * through the `report_writer_insert_platform_outbox_event` SECURITY DEFINER function (migration 0186),
 * EXECUTE-granted directly to `wardenx_app` with no GUC precondition, so the plain `deps.db` handle (never
 * wrapped in `withOrgContext` here) is the correct tx to pass — the exact same shape M33's own platform-wide
 * `m33.lag.exceeded`/`.recovered` emits already use (`deps.outboxPublisher!.publish(db, {organizationId: null,
 * ...})`, `m33-jobs.ts`).
 */
export async function runMacPortalHealth(
  deps: M23WorkerDeps,
  breaker: Map<string, MacPortalBreakerState>,
): Promise<void> {
  const portal = macPortalOf(deps);
  const alerts = alertsOf(deps);
  const outbox = outboxOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  const jurisdictions = await jurisdictionsOf(deps).listJurisdictions();

  for (const { macJurisdiction } of jurisdictions) {
    const up = await portal.probeHealth(macJurisdiction);
    const prev = breaker.get(macJurisdiction);

    if (prev === undefined) {
      // First probe for this jurisdiction this process lifetime: seed state, no transition to report.
      breaker.set(macJurisdiction, {
        up,
        lastUpAt: up ? now : null,
        downedAt: up ? null : now,
      });
      continue;
    }

    if (prev.up === up) {
      // No transition — still refresh `lastUpAt` on every up tick so it reflects the true last-observed-up
      // instant (not merely "since the streak began") the next time this jurisdiction goes down.
      if (up) breaker.set(macJurisdiction, { up: true, lastUpAt: now, downedAt: null });
      continue;
    }

    const aggregateId = macPortalAggregateId(macJurisdiction);
    if (up) {
      const downedAt = prev.downedAt ?? now; // prev.up === false guarantees this was set at the down transition
      await outbox.publish(deps.db, {
        eventName: "m23.mac_portal.recovered",
        organizationId: null,
        aggregateKind: "mac_jurisdiction",
        aggregateId,
        payload: {
          macJurisdiction,
          downedAt: downedAt.toISOString(),
          recoveredAt: now.toISOString(),
        },
      });
      breaker.set(macJurisdiction, { up: true, lastUpAt: now, downedAt: null });
    } else {
      await outbox.publish(deps.db, {
        eventName: "m23.mac_portal.unavailable",
        organizationId: null,
        aggregateKind: "mac_jurisdiction",
        aggregateId,
        payload: {
          macJurisdiction,
          lastSeenUpAt: prev.lastUpAt ? prev.lastUpAt.toISOString() : null,
          downedAt: now.toISOString(),
        },
      });
      breaker.set(macJurisdiction, { up: false, lastUpAt: prev.lastUpAt, downedAt: now });
    }
    await alerts.dispatch({
      alertCode: up ? "m23.mac_portal.recovered" : "m23.mac_portal.unavailable",
      severity: up ? "info" : "critical",
      organizationId: "", // platform-status event (no single tenant)
      payload: { macJurisdiction, up },
    });
  }
}

// ── live worker construction (the M27 m27-jobs.ts template) ────────────────────────────────────────────────

/**
 * Construct one BullMQ `Worker` per §4.8 WORK queue, each opening the per-job `withOrgContext(orgId)` RLS
 * envelope (every §4.8 work queue is ORG-scoped, F09) on the org from the job payload and running the matching
 * processor inside it over a tx-scoped repo set. Returns the workers so the composition root can `close()` them
 * on shutdown — the caller owns the lifecycle; nothing here runs at import (constructing a Worker opens the
 * Valkey connection, which must happen only in production wiring, never in tests).
 */
export function registerM23Workers(deps: M23WorkerDeps): Worker[] {
  const { connection } = deps;
  const orgScoped = <D extends { organizationId: string }>(
    queue: string,
    concurrency: number,
    run: (tx: BillingDb, deps: M23WorkerDeps, data: D) => Promise<void>,
  ): Worker =>
    new Worker(
      queue,
      async (job) => {
        const data = job.data as D;
        if (!data.organizationId) {
          throw new Error(
            `M23 worker ${queue}: job.data.organizationId missing (the JobEnqueuePort must enrich it)`,
          );
        }
        return withOrgContext(
          deps.db,
          {
            organizationId: data.organizationId,
            userId: M23_WORKER_SYSTEM_USER_ID,
          },
          (tx) => run(tx as unknown as BillingDb, deps, data),
        );
      },
      { connection, concurrency },
    );

  return [
    orgScoped<ClaimSubmitJob>(
      M23_QUEUES.claimSubmit,
      M23_QUEUE_PARAMS.claimSubmit.concurrency,
      runClaimSubmit,
    ),
    orgScoped<ClaimSubmitRetryJob>(
      M23_QUEUES.claimSubmitRetry,
      M23_QUEUE_PARAMS.claimSubmitRetry.concurrency,
      runClaimSubmitRetry,
    ),
    orgScoped<NoeSubmitJob>(
      M23_QUEUES.noeSubmit,
      M23_QUEUE_PARAMS.noeSubmit.concurrency,
      runNoeSubmit,
    ),
    orgScoped<NotrSubmitJob>(
      M23_QUEUES.notrSubmit,
      M23_QUEUE_PARAMS.notrSubmit.concurrency,
      runNotrSubmit,
    ),
    orgScoped<TransferNoticeSubmitJob>(
      M23_QUEUES.transferNoticeSubmit,
      M23_QUEUE_PARAMS.transferNoticeSubmit.concurrency,
      runTransferNoticeSubmitJob,
    ),
    orgScoped<EligibilityRefreshJob>(
      M23_QUEUES.eligibilityRefresh,
      M23_QUEUE_PARAMS.eligibilityRefresh.concurrency,
      runEligibilityRefresh,
    ),
    orgScoped<ValidationRunJob>(
      M23_QUEUES.validationRun,
      M23_QUEUE_PARAMS.validationRun.concurrency,
      runValidationRun,
    ),
    orgScoped<RevalidateConsumerJob>(
      M23_QUEUES.revalidateConsumer,
      M23_QUEUE_PARAMS.revalidateConsumer.concurrency,
      runRevalidateConsumer,
    ),
  ];
}

/**
 * The three §4.8 WORK queues that need no X12 / MAC-portal infrastructure: `eligibility.refresh`,
 * `validation-run` and `revalidate.consumer` (GAP-070). The composition root constructs them whenever a queue
 * connection exists — NOT behind the launch gateway, which only the submission workers need. Before this nothing
 * built a Worker for any of them (the registrar that did had no caller), so revalidation jobs piled up in the
 * queue and every validation/eligibility request was refused with 503.
 */
export function registerM23DomainWorkers(deps: M23WorkerDeps): Worker[] {
  const orgWorker = <D extends { organizationId: string }>(
    queue: string,
    concurrency: number,
    run: (tx: BillingDb, workerDeps: M23WorkerDeps, data: D) => Promise<void>,
  ): Worker =>
    new Worker(
      queue,
      async (job) => {
        const data = job.data as D;
        if (!data.organizationId) throw new Error(`M23 ${queue} organizationId missing`);
        await withOrgContext(
          deps.db,
          { organizationId: data.organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
          (tx) => run(tx as unknown as BillingDb, deps, data),
        );
      },
      { connection: deps.connection, concurrency },
    );
  return [
    orgWorker<EligibilityRefreshJob>(
      M23_QUEUES.eligibilityRefresh,
      M23_QUEUE_PARAMS.eligibilityRefresh.concurrency,
      runEligibilityRefresh,
    ),
    orgWorker<ValidationRunJob>(
      M23_QUEUES.validationRun,
      M23_QUEUE_PARAMS.validationRun.concurrency,
      runValidationRun,
    ),
    orgWorker<RevalidateConsumerJob>(
      M23_QUEUES.revalidateConsumer,
      M23_QUEUE_PARAMS.revalidateConsumer.concurrency,
      runRevalidateConsumer,
    ),
  ];
}

/**
 * The per-org watchdog crons that need only the database, the outbox, the alert router and the active-org
 * enumerator (GAP-069): NOE window-watch, NOTR window-watch and eligibility stale-watch. Separate from the
 * ack-pull / portal-health crons (which need the MAC portal) so a deployment without the launch gateway still
 * watches its filing windows.
 */
export function registerM23WatchCronWorkers(deps: M23WorkerDeps): Worker[] {
  const cron = (queue: string, concurrency: number, run: () => Promise<void>): Worker =>
    new Worker(queue, async () => run(), {
      connection: deps.connection,
      concurrency,
      lockDuration: M23_CRON_LOCK_DURATION_MS,
    });
  return [
    cron(M23_CRON_QUEUES.noeWindowWatch, M23_QUEUE_PARAMS.noeWindowWatch.concurrency, () =>
      runNoeWindowWatch(deps),
    ),
    cron(M23_CRON_QUEUES.notrWindowWatch, M23_QUEUE_PARAMS.notrWindowWatch.concurrency, () =>
      runNotrWindowWatch(deps),
    ),
    cron(
      M23_CRON_QUEUES.eligibilityStaleWatch,
      M23_QUEUE_PARAMS.eligibilityStaleWatch.concurrency,
      () => runEligibilityStaleWatch(deps),
    ),
  ];
}

/** The MAC-portal health cron (needs the portal transport; the composition root builds it behind the launch gateway). */
export function registerM23PortalHealthWorker(deps: M23WorkerDeps): Worker[] {
  const portalBreaker = new Map<string, MacPortalBreakerState>();
  return [
    new Worker(
      M23_CRON_QUEUES.macPortalHealth,
      async () => runMacPortalHealth(deps, portalBreaker),
      {
        connection: deps.connection,
        concurrency: M23_QUEUE_PARAMS.macPortalHealth.concurrency,
        lockDuration: M23_CRON_LOCK_DURATION_MS,
      },
    ),
  ];
}

/** Launch slice: one claim submission worker plus the 999/277CA reconciliation workers. */
export function registerM23LaunchWorkers(deps: M23WorkerDeps): Worker[] {
  if (!deps.x12 || !deps.macPortal || !deps.outbox || !deps.jurisdictions) {
    throw new Error(
      "M23LaunchCapabilityIncomplete: x12, macPortal, outbox, and jurisdictions are required",
    );
  }
  const orgWorker = <D extends { organizationId: string }>(
    queue: string,
    concurrency: number,
    run: (tx: BillingDb, workerDeps: M23WorkerDeps, data: D) => Promise<void>,
  ) =>
    new Worker(
      queue,
      async (job) => {
        const data = job.data as D;
        if (!data.organizationId) throw new Error(`M23 ${queue} organizationId missing`);
        await withOrgContext(
          deps.db,
          {
            organizationId: data.organizationId,
            userId: M23_WORKER_SYSTEM_USER_ID,
          },
          (tx) => run(tx as unknown as BillingDb, deps, data),
        );
      },
      { connection: deps.connection, concurrency },
    );
  const cron = (queue: string, run: () => Promise<void>) =>
    new Worker(queue, async () => run(), {
      connection: deps.connection,
      concurrency: 1,
      lockDuration: M23_CRON_LOCK_DURATION_MS,
    });
  return [
    orgWorker(M23_QUEUES.claimSubmit, M23_QUEUE_PARAMS.claimSubmit.concurrency, runClaimSubmit),
    orgWorker(
      M23_QUEUES.claimSubmitRetry,
      M23_QUEUE_PARAMS.claimSubmitRetry.concurrency,
      runClaimSubmitRetry,
    ),
    orgWorker(M23_QUEUES.noeSubmit, M23_QUEUE_PARAMS.noeSubmit.concurrency, runNoeSubmit),
    orgWorker(M23_QUEUES.notrSubmit, M23_QUEUE_PARAMS.notrSubmit.concurrency, runNotrSubmit),
    cron(M23_CRON_QUEUES.ackPull999, () => runAckPull999(deps)),
    cron(M23_CRON_QUEUES.ackPull277ca, () => runAckPull277ca(deps)),
  ];
}

/**
 * Construct the §4.8 CRON workers (the per-MAC-jurisdiction ack pulls + portal health, and the per-org window /
 * stale watchdogs). The cron tick carries no payload — each processor reads its own ports (the org / jurisdiction
 * enumerators) and opens `withOrgContext` INSIDE itself (it fans across orgs). Concurrency 1 — a cron tick is a
 * singleton. Returns the workers; the caller owns `close()`. Mirrors `registerM23Workers`; nothing runs at import.
 */
export function registerM23CronWorkers(deps: M23WorkerDeps): Worker[] {
  const { connection } = deps;
  const cron = (queue: string, concurrency: number, run: () => Promise<void>): Worker =>
    new Worker(queue, async () => run(), {
      connection,
      concurrency,
      lockDuration: M23_CRON_LOCK_DURATION_MS,
    });

  return [
    cron(M23_CRON_QUEUES.ackPull999, M23_QUEUE_PARAMS.ackPull999.concurrency, () =>
      runAckPull999(deps),
    ),
    cron(M23_CRON_QUEUES.ackPull277ca, M23_QUEUE_PARAMS.ackPull277ca.concurrency, () =>
      runAckPull277ca(deps),
    ),
    ...registerM23WatchCronWorkers(deps),
    ...registerM23PortalHealthWorker(deps),
  ];
}

/**
 * Register the §4.8 repeatable cron schedules ({@link M23_JOB_SCHEDULES}) on their dedicated
 * {@link M23_CRON_QUEUES}. Returns the schedule `Queue`s so the composition root can `close()` them. Mirrors
 * `scheduleM27Jobs`: one `Queue` per cron, `add('scheduled', {}, { repeat: { pattern } })`. Each tick is consumed
 * by the matching `registerM23CronWorkers` worker. Nothing runs at import.
 */
export async function scheduleM23Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [
    M23CronQueueName,
    string,
    (typeof M23_QUEUE_PARAMS)[keyof typeof M23_QUEUE_PARAMS],
  ][] = [
    [M23_CRON_QUEUES.ackPull999, M23_JOB_SCHEDULES.ackPull999, M23_QUEUE_PARAMS.ackPull999],
    [M23_CRON_QUEUES.ackPull277ca, M23_JOB_SCHEDULES.ackPull277ca, M23_QUEUE_PARAMS.ackPull277ca],
    [
      M23_CRON_QUEUES.noeWindowWatch,
      M23_JOB_SCHEDULES.noeWindowWatch,
      M23_QUEUE_PARAMS.noeWindowWatch,
    ],
    [
      M23_CRON_QUEUES.notrWindowWatch,
      M23_JOB_SCHEDULES.notrWindowWatch,
      M23_QUEUE_PARAMS.notrWindowWatch,
    ],
    [
      M23_CRON_QUEUES.eligibilityStaleWatch,
      M23_JOB_SCHEDULES.eligibilityStaleWatch,
      M23_QUEUE_PARAMS.eligibilityStaleWatch,
    ],
    [
      M23_CRON_QUEUES.macPortalHealth,
      M23_JOB_SCHEDULES.macPortalHealth,
      M23_QUEUE_PARAMS.macPortalHealth,
    ],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern, params] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern },
        attempts: params.attempts,
        backoff: params.backoff,
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}

/** Schedule only the three watchdog crons (window-watch x2, eligibility stale-watch). */
export async function scheduleM23WatchJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [
    M23CronQueueName,
    string,
    (typeof M23_QUEUE_PARAMS)[keyof typeof M23_QUEUE_PARAMS],
  ][] = [
    [
      M23_CRON_QUEUES.noeWindowWatch,
      M23_JOB_SCHEDULES.noeWindowWatch,
      M23_QUEUE_PARAMS.noeWindowWatch,
    ],
    [
      M23_CRON_QUEUES.notrWindowWatch,
      M23_JOB_SCHEDULES.notrWindowWatch,
      M23_QUEUE_PARAMS.notrWindowWatch,
    ],
    [
      M23_CRON_QUEUES.eligibilityStaleWatch,
      M23_JOB_SCHEDULES.eligibilityStaleWatch,
      M23_QUEUE_PARAMS.eligibilityStaleWatch,
    ],
  ];
  return Promise.all(
    schedules.map(async ([name, pattern, params]) => {
      const queue = new Queue(name, { connection });
      await queue.add(
        "scheduled",
        {},
        {
          repeat: { pattern },
          attempts: params.attempts,
          backoff: params.backoff,
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      );
      return queue;
    }),
  );
}

/** Schedule only the launch acknowledgment reconciliation ticks. */
export async function scheduleM23LaunchJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [
    M23CronQueueName,
    string,
    (typeof M23_QUEUE_PARAMS)[keyof typeof M23_QUEUE_PARAMS],
  ][] = [
    [M23_CRON_QUEUES.ackPull999, M23_JOB_SCHEDULES.ackPull999, M23_QUEUE_PARAMS.ackPull999],
    [M23_CRON_QUEUES.ackPull277ca, M23_JOB_SCHEDULES.ackPull277ca, M23_QUEUE_PARAMS.ackPull277ca],
  ];
  return Promise.all(
    schedules.map(async ([name, pattern, params]) => {
      const queue = new Queue(name, { connection });
      await queue.add(
        "scheduled",
        {},
        {
          repeat: { pattern },
          attempts: params.attempts,
          backoff: params.backoff,
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      );
      return queue;
    }),
  );
}

/** Build the {@link M23WorkerDeps} from the composition-root primitives (the M27 `buildM27WorkerDeps` shape). */
export function buildM23WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: BillingDb;
  now?: () => Date;
  outbox?: WorkerOutboxPort;
  alerts?: WorkerAlertPort;
  x12?: X12ClientPort;
  macPortal?: MacPortalPort;
  hets?: HetsEligibilityPort;
  noticeWindow?: NoticeWindowPort;
  validationRunner?: ClaimValidationRunnerPort;
  revalidationTargets?: RevalidationTargetResolverPort;
  enqueue?: JobEnqueuePort;
  activeOrgs?: ActiveOrgListPort;
  jurisdictions?: MacJurisdictionListPort;
  ddeWatchdog?: DdeWatchdogPort;
  logger?: { error(fields: Record<string, unknown>, message: string): void };
}): M23WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    now: deps.now ?? (() => new Date()),
    outbox: deps.outbox,
    alerts: deps.alerts,
    x12: deps.x12,
    macPortal: deps.macPortal,
    hets: deps.hets,
    noticeWindow: deps.noticeWindow,
    validationRunner: deps.validationRunner,
    revalidationTargets: deps.revalidationTargets,
    enqueue: deps.enqueue,
    activeOrgs: deps.activeOrgs,
    jurisdictions: deps.jurisdictions,
    ddeWatchdog: deps.ddeWatchdog,
    logger: deps.logger,
  };
}

// BOUND ONLY WHEN CONFIGURED (these throw only when a job runs, RULE 4):
//   • the HETS 270/271 seam (`deps.hets`) — bound by the composition root over `hets-eligibility.ts` when
//     `M23_HETS_TRANSPORT` is set (CORE MIME to CMS / a clearinghouse, or the dev/test sandbox) and M5's
//     `MbiUnlockReader` is registered. Unset, it stays unbound and the route-side gate refuses eligibility
//     checks (503), so no request is accepted that this worker cannot complete.
// STILL UNBOUND:
//   • the x12-837-client sidecar (`deps.x12`) + MAC-portal transport (`deps.macPortal`) outside the launch
//     gateway, and the MAC-jurisdiction enumerator beyond the single launch jurisdiction.
// BOUND in the composition root (apps/backend/src/index.ts): outbox, alerts (M36), activeOrgs (M23 platform job),
// noticeWindow, validationRunner, revalidationTargets and the validation-run/eligibility enqueue producer.
