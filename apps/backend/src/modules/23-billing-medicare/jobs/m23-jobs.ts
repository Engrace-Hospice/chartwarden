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
import {
  type ClaimState,
  type ClaimTransitionEvent,
  type EligibilityOutcome,
  type NoticeState,
  canTransition as canClaimTransition,
  noeMachine,
  notrMachine,
  reduce as reduceClaim,
  repositories,
} from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  M23_CRON_QUEUES,
  type M23CronQueueName,
  M23_JOB_SCHEDULES,
  M23_QUEUES,
  M23_QUEUE_PARAMS,
} from "./queues";

const {
  ClaimRepository,
  ClaimSubmissionRepository,
  ClaimAcknowledgmentRepository,
  EligibilityCheckRepository,
  NoeRepository,
  NotrRepository,
} = repositories;

/** The package-kernel Drizzle handle (a `withOrgContext` tx satisfies it structurally). */
type BillingDb = repositories.BillingDb;

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
  readonly organizationId: string;
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
  parse999(input: { readonly macJurisdiction: string; readonly rawFileUri: string }): Promise<readonly Parsed999[]>;
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
}

/** The MAC-portal transport (upload generated files; pull pending ack files; probe availability). */
export interface MacPortalPort {
  upload(input: {
    readonly organizationId: string;
    /** The submitting provider entity (M40); the transport resolves the MAC jurisdiction from its credential. */
    readonly providerEntityId: string;
    readonly kind: "claim_837i" | "noe" | "notr";
    readonly x12: string;
    readonly controlNumber: string;
  }): Promise<{ readonly accepted: boolean; readonly generatedFileUri: string }>;
  /** List pending 999 ack files for a MAC jurisdiction (the cron poller's source). */
  pullPending999(macJurisdiction: string): Promise<readonly { readonly rawFileUri: string }[]>;
  pullPending277ca(macJurisdiction: string): Promise<readonly { readonly rawFileUri: string }[]>;
  /** HEAD on the portal-status-page; `true` when up (the §4.8 mac-portal.health probe). */
  probeHealth(macJurisdiction: string): Promise<boolean>;
}

/**
 * The HETS 270/271 eligibility seam (§4.4). The bound impl unlocks the patient MBI via the M5 `MbiUnlockReader`
 * (deny-stub until M5's post-M23 lock revision), builds + sends the 270, parses the 271, and zeroes the MBI —
 * so the MBI NEVER crosses into this file (D13 / §3.6). Returns the domain-cased outcome + the persisted refs.
 */
export interface HetsEligibilityPort {
  check(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly providerEntityId: string;
    readonly asOfServiceDate: string;
  }): Promise<{
    readonly outcome: EligibilityOutcome;
    readonly partAEffectiveDate: string | null;
    readonly partATerminationDate: string | null;
    readonly hospiceElectionOnFile: boolean;
    readonly responseFileUri: string;
    readonly staleAt: Date;
  }>;
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
 * event (`m5.patient.*`, `m6.election.*`, `m8.encounter.signed`, `mdm.canonical_updated`, …), it returns every
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
  enqueue(queueName: string, dedupeKey: string, payload: Record<string, unknown>): Promise<{ readonly jobId: string }>;
}

/** The platform active-org enumerator the per-org crons fan across (M2; under `withPlatformContext`). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The MAC-jurisdiction enumerator the per-jurisdiction ack-pull + portal-health crons fan across. */
export interface MacJurisdictionListPort {
  listJurisdictions(): Promise<readonly { readonly macJurisdiction: string }[]>;
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
        unboundWorkerPort("alerts.dispatch", "bind the M36 alert router (the §4.9 M23_ALERT_RULES typed alerts)"),
    }
  );
}

function x12Of(deps: M23WorkerDeps): X12ClientPort {
  const u = (fn: string) =>
    unboundWorkerPort(`x12.${fn}`, "bind the x12-837-client sidecar (generate-837i/noe/notr, parse-999/277ca)");
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
    unboundWorkerPort(`macPortal.${fn}`, "bind the MAC-portal transport (x12-837-client/mac-portal/<juris>.ts)");
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
        unboundWorkerPort("enqueue.enqueue", "bind the JobEnqueuePort producer (the revalidate consumer's fan-out)"),
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

/** Whole-day count from `now` to a `yyyy-mm-dd` window target (negative when past). */
function daysToTarget(targetDate: string, now: Date): number {
  const target = new Date(`${targetDate}T00:00:00.000Z`).getTime();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

// ── the §4.8 WORK processors (each runs INSIDE the worker's per-job withOrgContext tx) ──────────────────────

/**
 * `claim.submit` (§4.8): drain `m23.claim.submit_requested` — generate the 837I via the x12 sidecar, upload to
 * the MAC portal, drive the §2.2 READY/DRAFT → SUBMITTED transition (pure reducer, version-checked), and emit
 * `m23.claim.submitted`. On a portal failure emit `m23.claim.submission_failed` (the retry queue pickup signal)
 * and rethrow so BullMQ records the failed attempt. All x12/portal calls sit behind the fail-closed binds.
 */
async function runClaimSubmit(tx: BillingDb, deps: M23WorkerDeps, job: ClaimSubmitJob): Promise<void> {
  const outbox = outboxOf(deps);
  const claims = new ClaimRepository(tx);
  const now = (deps.now ?? (() => new Date()))();

  const claim = await claims.findById(job.claimId);
  if (!claim) throw new Error(`claim ${job.claimId} not found`);

  try {
    const generated = await x12Of(deps).generate837i({
      organizationId: job.organizationId,
      claimId: job.claimId,
      claimControlNumber: job.claimControlNumber,
    });
    const uploaded = await macPortalOf(deps).upload({
      organizationId: job.organizationId,
      providerEntityId: claim.providerEntityId,
      kind: "claim_837i",
      x12: generated.x12,
      controlNumber: job.claimControlNumber,
    });
    if (!uploaded.accepted) throw new Error("MAC portal rejected the 837I upload");

    const to = nextClaimState(claim.state, "submit");
    const result = await claims.transitionToState(job.claimId, claim.version, to);
    if (!result.ok) throw new Error(`claim ${job.claimId} version conflict on submit (${result.currentVersion})`);

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
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: { claimId: job.claimId, submissionId: job.submissionId, attemptIndex: job.attemptIndex, reason },
    });
    throw err;
  }
}

/**
 * `claim.submit.retry` (§4.8): retry the MAC-portal upload with exponential backoff (BullMQ-managed, max 5
 * attempts via {@link M23_QUEUE_PARAMS}). Appends a NEW `claim_submission` attempt row, re-uploads, and on
 * success transitions the claim. When the attempt budget is exhausted it emits `m23.claim.submission_stalled`
 * (severity=critical) so the §4.9 stalled alert fires. Mirrors {@link runClaimSubmit}'s submit path.
 */
async function runClaimSubmitRetry(tx: BillingDb, deps: M23WorkerDeps, job: ClaimSubmitJob): Promise<void> {
  const outbox = outboxOf(deps);
  const claims = new ClaimRepository(tx);
  const submissions = new ClaimSubmissionRepository(tx);
  const now = (deps.now ?? (() => new Date()))();
  const attemptIndex = job.attemptIndex + 1;

  const claim = await claims.findById(job.claimId);
  if (!claim) throw new Error(`claim ${job.claimId} not found`);

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
      payload: { claimId: job.claimId, submissionId: job.submissionId, attemptIndex },
    });
    return;
  }

  const generated = await x12Of(deps).generate837i({
    organizationId: job.organizationId,
    claimId: job.claimId,
    claimControlNumber: job.claimControlNumber,
  });
  const uploaded = await macPortalOf(deps).upload({
    organizationId: job.organizationId,
    providerEntityId: claim.providerEntityId,
    kind: "claim_837i",
    x12: generated.x12,
    controlNumber: job.claimControlNumber,
  });

  await submissions.append({
    organizationId: job.organizationId,
    providerEntityId: claim.providerEntityId,
    kind: "claim_837i",
    claimId: job.claimId,
    claimControlNumber: job.claimControlNumber,
    attemptIndex,
    outcome: uploaded.accepted ? "submitted" : "failed_portal",
    generatedFileUri: uploaded.generatedFileUri,
    submittedAt: uploaded.accepted ? now : null,
    workerCorrelationId: generated.correlationId,
  });

  if (!uploaded.accepted) {
    await outbox.publish(tx, {
      eventName: "m23.claim.submission_failed",
      organizationId: job.organizationId,
      aggregateKind: "claim",
      aggregateId: job.claimId,
      payload: { claimId: job.claimId, submissionId: job.submissionId, attemptIndex, reason: "portal rejected" },
    });
    throw new Error("MAC portal rejected the retry upload");
  }

  const to = nextClaimState(claim.state, "submit");
  const result = await claims.transitionToState(job.claimId, claim.version, to);
  if (!result.ok) throw new Error(`claim ${job.claimId} version conflict on retry submit`);
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
 * `noe.submit` (§4.8): drain `m23.noe.submit_requested` — generate the NOE via the x12 sidecar, upload to the
 * MAC portal, append the `claim_submission` (kind='noe') row, drive the §2.2 NOE READY → SUBMITTED transition
 * (pure `noeMachine.reduce`, version-checked), and emit `m23.noe.submitted`.
 */
async function runNoeSubmit(tx: BillingDb, deps: M23WorkerDeps, job: NoeSubmitJob): Promise<void> {
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
  const submission = await submissions.append({
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
  if (next.error) throw new Error(`illegal NOE transition ${noe.state} --submit--> (${next.error})`);
  const result = await noes.transitionToState(job.noeId, noe.version, next.state as NoticeState, {
    latestSubmissionId: submission.id,
  });
  if (!result.ok) throw new Error(`noe ${job.noeId} version conflict on submit`);

  await outbox.publish(tx, {
    eventName: "m23.noe.submitted",
    organizationId: job.organizationId,
    aggregateKind: "noe",
    aggregateId: job.noeId,
    payload: { noeId: job.noeId, submissionId: submission.id, submittedAt: now.toISOString() },
  });
}

/** `notr.submit` (§4.8): the NOTR twin of {@link runNoeSubmit} (parallel state machine + control number). */
async function runNotrSubmit(tx: BillingDb, deps: M23WorkerDeps, job: NotrSubmitJob): Promise<void> {
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
  const submission = await submissions.append({
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
  if (next.error) throw new Error(`illegal NOTR transition ${notr.state} --submit--> (${next.error})`);
  const result = await notrs.transitionToState(job.notrId, notr.version, next.state as NoticeState, {
    latestSubmissionId: submission.id,
  });
  if (!result.ok) throw new Error(`notr ${job.notrId} version conflict on submit`);

  await outbox.publish(tx, {
    eventName: "m23.notr.submitted",
    organizationId: job.organizationId,
    aggregateKind: "notr",
    aggregateId: job.notrId,
    payload: { notrId: job.notrId, submissionId: submission.id, submittedAt: now.toISOString() },
  });
}

/**
 * `eligibility.refresh` (§4.4 / §4.8): drain `m23.eligibility.refresh_requested` — run the HETS 270/271 check
 * (the bound seam unlocks + zeroes the MBI internally; the MBI never crosses this file), APPEND the
 * `eligibility_check` row (append-only; outcome codec mapped at the repo boundary), and emit
 * `m23.eligibility.checked`.
 */
async function runEligibilityRefresh(tx: BillingDb, deps: M23WorkerDeps, job: EligibilityRefreshJob): Promise<void> {
  const outbox = outboxOf(deps);
  const checks = new EligibilityCheckRepository(tx);

  const result = await hetsOf(deps).check({
    organizationId: job.organizationId,
    patientId: job.patientId,
    providerEntityId: job.providerEntityId,
    asOfServiceDate: job.asOfServiceDate,
  });

  const row = await checks.append({
    organizationId: job.organizationId,
    providerEntityId: job.providerEntityId,
    patientId: job.patientId,
    asOfServiceDate: job.asOfServiceDate,
    outcome: result.outcome,
    // The §3.6 parsed 271 payload — coverage flags only, NO PHI / NO MBI (the MBI was zeroed in the seam).
    parsedPayload: {
      partAActive: result.outcome === "active_part_a",
      partAEffectiveDate: result.partAEffectiveDate,
      partATerminationDate: result.partATerminationDate,
      hospiceElectionOnFile: result.hospiceElectionOnFile,
    },
    rawResponseFileUri: result.responseFileUri,
    staleAt: result.staleAt,
  });

  await outbox.publish(tx, {
    eventName: "m23.eligibility.checked",
    organizationId: job.organizationId,
    aggregateKind: "patient",
    aggregateId: job.patientId,
    payload: {
      patientId: job.patientId,
      eligibilityCheckId: row.id,
      outcome: result.outcome,
      asOfServiceDate: job.asOfServiceDate,
    },
  });
}

/**
 * `validation-run` (§4.8): drain a validation-run job (the `validateClaim` route + the revalidate consumer both
 * enqueue this). Delegates to the bound {@link ClaimValidationRunnerPort} (the M23 claim-validation-service) so
 * the rule-library run + result persistence + claim transition + `m23.claim.*` emits live in ONE home. The
 * runner runs inside this worker's `withOrgContext` tx. FAIL-CLOSED until the runner is bound.
 */
async function runValidationRun(tx: BillingDb, deps: M23WorkerDeps, job: ValidationRunJob): Promise<void> {
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
async function runRevalidateConsumer(tx: BillingDb, deps: M23WorkerDeps, job: RevalidateConsumerJob): Promise<void> {
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
    const validationRunId = `${job.eventId}:${claimId}`; // deterministic per (event, claim) — idempotent
    await enqueue.enqueue("validation-run", `${job.organizationId}:${claimId}:${job.eventId}`, {
      organizationId: job.organizationId,
      claimId,
      validationRunId,
      trigger: "re_validation_after_correction",
    });
  }
}

// ── the §4.8 CRON processors (per-MAC-jurisdiction ack pulls + per-org watchdogs) ──────────────────────────

/**
 * `ack.pull-999` / `ack.pull-277ca` (§4.8 cron): for each MAC jurisdiction, pull pending ack files from the
 * portal, parse them via the x12 sidecar, APPEND a `claim_acknowledgment` row per result (under each result's
 * own org `withOrgContext`), and drive the matching §2.2 claim transition. 999 advances ACK staging; 277CA
 * drives ACK_PENDING → ACK_ACCEPTED / ACK_REJECTED / ACK_PARTIAL. Portal/x12 calls sit behind fail-closed binds.
 */
async function runAckPull999(deps: M23WorkerDeps): Promise<void> {
  const portal = macPortalOf(deps);
  const x12 = x12Of(deps);
  const jurisdictions = await jurisdictionsOf(deps).listJurisdictions();

  for (const { macJurisdiction } of jurisdictions) {
    const files = await portal.pullPending999(macJurisdiction);
    for (const file of files) {
      const parsed = await x12.parse999({ macJurisdiction, rawFileUri: file.rawFileUri });
      for (const result of parsed) {
        await withOrgContext(
          deps.db,
          { organizationId: result.organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
          async (txAny) => {
            const tx = txAny as unknown as BillingDb;
            const acks = new ClaimAcknowledgmentRepository(tx);
            const claims = new ClaimRepository(tx);
            const ack = await acks.append({
              organizationId: result.organizationId,
              submissionId: result.submissionId,
              claimId: result.claimId,
              kind: "ack_999",
              macJurisdiction: macJurisdiction as NewClaimAck["macJurisdiction"],
              ackFileUri: result.ackFileUri,
              ackReceivedAt: (deps.now ?? (() => new Date()))(),
              parsedPayload: { accepted: result.accepted, reasonCodes: result.reasonCodes },
              outcomeStatus: result.accepted ? "accepted" : "rejected",
            });
            const claim = await claims.findById(result.claimId);
            if (!claim) return;
            const event: ClaimTransitionEvent = result.accepted ? "ack_999_accepted" : "ack_999_rejected";
            if (!canClaimTransition(claim.state, event)) return;
            const to = nextClaimState(claim.state, event);
            await claims.transitionToState(result.claimId, claim.version, to);
            if (!result.accepted) {
              await outboxOf(deps).publish(tx, {
                eventName: "m23.claim.rejected",
                organizationId: result.organizationId,
                aggregateKind: "claim",
                aggregateId: result.claimId,
                payload: { claimId: result.claimId, acknowledgmentId: ack.id, reasonCodes: result.reasonCodes },
              });
            }
          },
        );
      }
    }
  }
}

/** `ack.pull-277ca` (§4.8 cron): the 277CA twin of {@link runAckPull999} (accepted/rejected/partial outcomes). */
async function runAckPull277ca(deps: M23WorkerDeps): Promise<void> {
  const portal = macPortalOf(deps);
  const x12 = x12Of(deps);
  const jurisdictions = await jurisdictionsOf(deps).listJurisdictions();

  for (const { macJurisdiction } of jurisdictions) {
    const files = await portal.pullPending277ca(macJurisdiction);
    for (const file of files) {
      const parsed = await x12.parse277ca({ macJurisdiction, rawFileUri: file.rawFileUri });
      for (const result of parsed) {
        await withOrgContext(
          deps.db,
          { organizationId: result.organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
          async (txAny) => {
            const tx = txAny as unknown as BillingDb;
            const acks = new ClaimAcknowledgmentRepository(tx);
            const claims = new ClaimRepository(tx);
            const ack = await acks.append({
              organizationId: result.organizationId,
              submissionId: result.submissionId,
              claimId: result.claimId,
              kind: "ack_277ca",
              macJurisdiction: macJurisdiction as NewClaimAck["macJurisdiction"],
              ackFileUri: result.ackFileUri,
              ackReceivedAt: (deps.now ?? (() => new Date()))(),
              parsedPayload: {
                outcome: result.outcome,
                payerClaimControlNumber: result.payerClaimControlNumber,
                reasonCodes: result.reasonCodes,
              },
              outcomeStatus: result.outcome,
            });
            const claim = await claims.findById(result.claimId);
            if (!claim) return;
            const event: ClaimTransitionEvent =
              result.outcome === "accepted"
                ? "ack_277ca_accepted"
                : result.outcome === "partial"
                  ? "ack_277ca_partial"
                  : "ack_277ca_rejected";
            if (!canClaimTransition(claim.state, event)) return;
            const to = nextClaimState(claim.state, event);
            await claims.transitionToState(result.claimId, claim.version, to);

            const eventName =
              result.outcome === "accepted"
                ? "m23.claim.acknowledged"
                : result.outcome === "partial"
                  ? "m23.claim.acknowledgment_partial"
                  : "m23.claim.rejected";
            await outboxOf(deps).publish(tx, {
              eventName,
              organizationId: result.organizationId,
              aggregateKind: "claim",
              aggregateId: result.claimId,
              payload: {
                claimId: result.claimId,
                acknowledgmentId: ack.id,
                payerClaimControlNumber: result.payerClaimControlNumber,
                reasonCodes: result.reasonCodes,
              },
            });
          },
        );
      }
    }
  }
}

/**
 * `noe.window-watch` (§4.8 cron, every 30 min): for each active org, walk the NOE rows whose 5-day window is
 * approaching and still un-acknowledged — emit `m23.noe.window_warning` at day 3 and, at day 5+1 (past target),
 * stamp `window_breached_at` (the fail-closed {@link NoticeWindowPort}) + emit `m23.noe.window_breached` and the
 * §4.9 system-locked alert. Pure day math + the candidate repo are real; the breach stamp is the one lazy seam.
 */
async function runNoeWindowWatch(deps: M23WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const asOf = now.toISOString().slice(0, 10);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M23_WORKER_SYSTEM_USER_ID }, async (txAny) => {
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
            payload: { noeId: noe.id, admissionId: noe.admissionId, windowTargetAt: noe.windowTargetAt },
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
            payload: { noeId: noe.id, admissionId: noe.admissionId, daysToTarget: days },
          });
          await alertsOf(deps).dispatch({
            alertCode: "m23.noe.window_warning",
            severity: "warn",
            organizationId,
            payload: { noeId: noe.id, admissionId: noe.admissionId, daysToTarget: days },
          });
        }
      }
    });
  }
}

/** `notr.window-watch` (§4.8 cron): the NOTR twin of {@link runNoeWindowWatch}. */
async function runNotrWindowWatch(deps: M23WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const asOf = now.toISOString().slice(0, 10);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M23_WORKER_SYSTEM_USER_ID }, async (txAny) => {
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
            payload: { notrId: notr.id, windowTargetAt: notr.windowTargetAt },
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
            payload: { notrId: notr.id, daysToTarget: days },
          });
          await alertsOf(deps).dispatch({
            alertCode: "m23.notr.window_warning",
            severity: "warn",
            organizationId,
            payload: { notrId: notr.id, daysToTarget: days },
          });
        }
      }
    });
  }
}

/**
 * `eligibility.stale-watch` (§4.8 cron, daily 06:00 org TZ): for each active org, list `eligibility_check` rows
 * past `stale_at` and emit `m23.eligibility.expired` + the §4.9 alert per affected patient (the row is
 * append-only, so "marking stale" is the emitted signal, not a row mutation — the next refresh appends a fresh row).
 */
async function runEligibilityStaleWatch(deps: M23WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M23_WORKER_SYSTEM_USER_ID }, async (txAny) => {
      const tx = txAny as unknown as BillingDb;
      const checks = new EligibilityCheckRepository(tx);
      const outbox = outboxOf(deps);
      const stale = await checks.listStaleForOrg(organizationId, now);
      const seenPatients = new Set<string>();
      for (const check of stale) {
        if (seenPatients.has(check.patientId)) continue;
        seenPatients.add(check.patientId);
        await outbox.publish(tx, {
          eventName: "m23.eligibility.expired",
          organizationId,
          aggregateKind: "patient",
          aggregateId: check.patientId,
          payload: { patientId: check.patientId, eligibilityCheckId: check.id, staleAt: check.staleAt.toISOString() },
        });
        await alertsOf(deps).dispatch({
          alertCode: "m23.eligibility.expired",
          severity: "warn",
          organizationId,
          payload: { patientId: check.patientId },
        });
      }
    });
  }
}

/**
 * `mac-portal.health` (§4.8 cron, every 5 min): per MAC jurisdiction probe the portal (HEAD via the bound
 * transport) and, on a state TRANSITION, emit `m23.mac_portal.unavailable` (down) or `m23.mac_portal.recovered`
 * (back up) + the §4.9 system-locked alert. A simple in-memory circuit-breaker holds last-known state across
 * ticks (the worker process is the breaker's home; a durable store is the follow-up). Platform-scoped (no org tx).
 */
async function runMacPortalHealth(deps: M23WorkerDeps, breaker: Map<string, boolean>): Promise<void> {
  const portal = macPortalOf(deps);
  const alerts = alertsOf(deps);
  const jurisdictions = await jurisdictionsOf(deps).listJurisdictions();

  for (const { macJurisdiction } of jurisdictions) {
    const up = await portal.probeHealth(macJurisdiction);
    const prev = breaker.get(macJurisdiction);
    breaker.set(macJurisdiction, up);
    if (prev === undefined || prev === up) continue; // first probe or no transition
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
          throw new Error(`M23 worker ${queue}: job.data.organizationId missing (the JobEnqueuePort must enrich it)`);
        }
        return withOrgContext(
          deps.db,
          { organizationId: data.organizationId, userId: M23_WORKER_SYSTEM_USER_ID },
          (tx) => run(tx as unknown as BillingDb, deps, data),
        );
      },
      { connection, concurrency },
    );

  return [
    orgScoped<ClaimSubmitJob>(M23_QUEUES.claimSubmit, M23_QUEUE_PARAMS.claimSubmit.concurrency, runClaimSubmit),
    orgScoped<ClaimSubmitJob>(
      M23_QUEUES.claimSubmitRetry,
      M23_QUEUE_PARAMS.claimSubmitRetry.concurrency,
      runClaimSubmitRetry,
    ),
    orgScoped<NoeSubmitJob>(M23_QUEUES.noeSubmit, M23_QUEUE_PARAMS.noeSubmit.concurrency, runNoeSubmit),
    orgScoped<NotrSubmitJob>(M23_QUEUES.notrSubmit, M23_QUEUE_PARAMS.notrSubmit.concurrency, runNotrSubmit),
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
 * Construct the §4.8 CRON workers (the per-MAC-jurisdiction ack pulls + portal health, and the per-org window /
 * stale watchdogs). The cron tick carries no payload — each processor reads its own ports (the org / jurisdiction
 * enumerators) and opens `withOrgContext` INSIDE itself (it fans across orgs). Concurrency 1 — a cron tick is a
 * singleton. Returns the workers; the caller owns `close()`. Mirrors `registerM23Workers`; nothing runs at import.
 */
export function registerM23CronWorkers(deps: M23WorkerDeps): Worker[] {
  const { connection } = deps;
  const portalBreaker = new Map<string, boolean>();
  const cron = (queue: string, concurrency: number, run: () => Promise<void>): Worker =>
    new Worker(queue, async () => run(), { connection, concurrency });

  return [
    cron(M23_CRON_QUEUES.ackPull999, M23_QUEUE_PARAMS.ackPull999.concurrency, () => runAckPull999(deps)),
    cron(M23_CRON_QUEUES.ackPull277ca, M23_QUEUE_PARAMS.ackPull277ca.concurrency, () => runAckPull277ca(deps)),
    cron(M23_CRON_QUEUES.noeWindowWatch, M23_QUEUE_PARAMS.noeWindowWatch.concurrency, () => runNoeWindowWatch(deps)),
    cron(M23_CRON_QUEUES.notrWindowWatch, M23_QUEUE_PARAMS.notrWindowWatch.concurrency, () =>
      runNotrWindowWatch(deps),
    ),
    cron(M23_CRON_QUEUES.eligibilityStaleWatch, M23_QUEUE_PARAMS.eligibilityStaleWatch.concurrency, () =>
      runEligibilityStaleWatch(deps),
    ),
    cron(M23_CRON_QUEUES.macPortalHealth, M23_QUEUE_PARAMS.macPortalHealth.concurrency, () =>
      runMacPortalHealth(deps, portalBreaker),
    ),
  ];
}

/**
 * Register the §4.8 repeatable cron schedules ({@link M23_JOB_SCHEDULES}) on their dedicated
 * {@link M23_CRON_QUEUES}. Returns the schedule `Queue`s so the composition root can `close()` them. Mirrors
 * `scheduleM27Jobs`: one `Queue` per cron, `add('scheduled', {}, { repeat: { pattern } })`. Each tick is consumed
 * by the matching `registerM23CronWorkers` worker. Nothing runs at import.
 */
export async function scheduleM23Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [M23CronQueueName, string][] = [
    [M23_CRON_QUEUES.ackPull999, M23_JOB_SCHEDULES.ackPull999],
    [M23_CRON_QUEUES.ackPull277ca, M23_JOB_SCHEDULES.ackPull277ca],
    [M23_CRON_QUEUES.noeWindowWatch, M23_JOB_SCHEDULES.noeWindowWatch],
    [M23_CRON_QUEUES.notrWindowWatch, M23_JOB_SCHEDULES.notrWindowWatch],
    [M23_CRON_QUEUES.eligibilityStaleWatch, M23_JOB_SCHEDULES.eligibilityStaleWatch],
    [M23_CRON_QUEUES.macPortalHealth, M23_JOB_SCHEDULES.macPortalHealth],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
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
  };
}

// TODO(integrator — the still-missing infra/seam ports the typed throws above name):
//   • the live transactional-outbox dispatcher (`deps.outbox`, bindCallerModule('m23')) — every §4.10 m23.* emit.
//   • the x12-837-client sidecar (`deps.x12`) + the MAC-portal transport (`deps.macPortal`,
//     x12-837-client/mac-portal/<juris>.ts) — until bound, claim/noe/notr submit + ack-pull + portal-health fail closed.
//   • the HETS 270/271 seam (`deps.hets`) — unlocks the M5 MbiUnlockReader MBI + zeroes it; MBI never persists (§3.6).
//   • the noe-notr-state-service window-breach stamp (`deps.noticeWindow`) + the M23 claim-validation-service
//     runner (`deps.validationRunner`) + the revalidation-target resolver (`deps.revalidationTargets`).
//   • the JobEnqueuePort producer (`deps.enqueue`) for the revalidate consumer's validation-run fan-out.
//   • the M2 active-org enumerator (`deps.activeOrgs`) + the MAC-jurisdiction enumerator (`deps.jurisdictions`)
//     under withPlatformContext; register the M23 cron jobIds in the @wardenx/tenancy PLATFORM_CONTEXT_ALLOWLIST.
//   • the §4.9 M36 alert router (`deps.alerts`) — the M23_ALERT_RULES typed alerts ship as defs + fire through M36.
