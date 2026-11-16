// apps/backend/src/modules/10-hope/jobs/cron-workers.ts — the M10 §4.8 BullMQ cron worker construction
// (TASK-040D, the M25 `25-remittance/jobs/cron-workers.ts` template). Builds a live Worker for each of the three §4.8
// queues that are wired: `windows` (`hope-window-watchdog`), `sfv` (`sfv-watchdog`) — the clinical-path regulatory-clock
// watchdogs (HOPE timepoint window expiry, Symptom Follow-up Visit deadlines) — and `retention` (`hope-retention-scan`,
// GAP-181). The repeatable schedules for those three are registered in ./cron-schedule.ts. The watchdogs also bridge their
// alerts into M36 through an injected AlertEmitter seam; no M36 internals are imported here.
//
// RECOVERY NOTE (2026-09 merge of the lost Aug 25–30 history). F-058/F-072 (#176/#178/#196) built an
// automated three-stage §4.10 pipeline here (`assemble-hope-submission` → `iqies-submit-worker` →
// `iqies-reconcile-worker`) over the typed `IqiesAdapterPort`. The current architecture ships a MANUAL
// iQIES flow instead (route `assembleSubmission` packages CMS XML with the submission header into a
// `packaged` zip; the operator exports, uploads and imports the result). The automated stages are
// therefore NOT registered or scheduled: a nightly assemble pass would lock every eligible signed
// assessment into a header-less `queued` batch (via `uniq_hope_sub_item_assessment_active`) that the
// manual package path can then never pick up, and the submit stage has no live transport (deny-stub).
// The stage runners below are kept, exported and unit-tested for when a live iQIES transport exists.
//
// The two watchdog ticks themselves live in ./watchdog-ticks.ts (the alert planning and delivery they share in
// ./watchdog-alerts.ts; their header comments say what a tick guarantees and what it does not). Each tick fans out over
// the active orgs, opens a per-org `withOrgContext` RLS envelope, reads via ./cron-store, runs the PURE planner
// (planHopeWindowWatchdog / planSfvWatchdog from ./index), persists the transitions keyed on the status they were
// planned from, and publishes the planned events to the injected transactional-outbox port inside that same tx; the
// alerts are re-planned from the committed state and emitted AFTER the tx commits. This file wraps them
// (`runHopeWindowWatchdogCron` / `runSfvWatchdogCron`) and builds the Workers. Unlike M25's crons
// (which dispatch M36 business alerts), M10's watchdogs publish straight to the outbox; the `outbox` dependency is
// therefore NOT optional (the composition root always constructs one wherever a DB client exists). `activeOrgs`, `iqies`
// and `providerEntityCcn` carry the M25 lazy fail-closed default (an unbound-port rejection when a tick first reaches
// them); `retentionHolds` has no default and the retention scan refuses to run without it (the same unbound-port
// rejection, at run time). `M10_DLQ` is NOT constructed here as separate literal Queues — a
// later composition-root step attaches DLQ-promotion alerting externally to the Workers this file returns.
//
// Nothing here runs at import (constructing a Worker opens Valkey) — same posture as M25.
import type { DbClient } from "@chartwarden/db";
import { type HopeValidationFindingDescriptor, hasBlockingError } from "@chartwarden/hope";
import {
  type HopeSubmissionEnvelope,
  assembleEnvelopeCanonical,
  envelopeSha256,
} from "@chartwarden/iqies-client";
import { withOrgContext } from "@chartwarden/tenancy";
import type { HopeDischargeReason, HopeRfaKind } from "@chartwarden/types";
import { type ConnectionOptions, Worker } from "bullmq";
import { lockRecordKey } from "../hope-assessment-lock";
import { canonicalUuidOrNull, sameUuid } from "../hope-uuid";
import { runHopeAssessmentValidation } from "../validation/run-validation";
import { assemblableAssessmentsForOrg, persistAssembledSubmission } from "./assemble-store";
import { DeadlineError, M10_SEAM_READ_TIMEOUT_MS, withinDeadline } from "./deadline";
import { M10_JOB_PARAMS, M10_QUEUES } from "./index";
import { evaluateHopeRetention } from "./retention";
import {
  type RetentionReviewWrite,
  hopeRetentionFactsForOrg,
  insertRetentionReview,
  retentionReviewsForOrg,
  updateRetentionReview,
} from "./retention-store";
import {
  type SubmissionItemValidation,
  buildSubmissionEnvelope,
  decideSubmitReadiness,
  planReconcile,
  planTransmitResult,
} from "./submission";
import { planAssembleSubmissions } from "./submission";
import {
  applyItemTransition,
  claimSubmissionForTransmit,
  inFlightSubmissionsForOrg,
  lockInFlightSubmission,
  pendingItemsForSubmission,
  queuedSubmissionsForOrg,
  recordReconcileOutcome,
  recordTransmit,
  releaseSubmission,
  writeValidationFindings,
} from "./submission-store";
import {
  type HopeAlertEmitPort,
  type PlannedM10AlertEmission,
  describeError,
  planM10AlertEmissions,
} from "./watchdog-alerts";
import {
  type HopeOutboxPublishPort,
  type WatchdogTickDeps,
  boundCronLockWait,
  runSfvWatchdogTick,
  runWindowWatchdogTick,
} from "./watchdog-ticks";

// The alert planner and its ports live with the watchdog ticks; re-exported so existing importers keep working.
export {
  type HopeAlertEmitPort,
  type HopeOutboxPublishPort,
  type PlannedM10AlertEmission,
  planM10AlertEmissions,
};

/**
 * The `app.user_id` the crons stamp on their per-org `withOrgContext` reads (audit attribution), and so what a watchdog tick carries — the EMPTY-STRING system sentinel, which the M4 PHI
 * write-audit triggers `NULLIF(...)` to NULL. A cron transition has no acting user.
 *
 * #48 — this was the synthetic uuid `00000000-0000-0000-0000-000000000010`, which has no `user` row.
 * `audit_event.actor_user_id` is a nullable column with an FK to `user`, and the trigger NULLIFs only
 * the EMPTY string before casting to uuid — so the sentinel passed straight through and
 * every transition died on `audit_event_actor_user_id_user_id_fk`. NEITHER watchdog could complete a
 * single status change. `hope-window-watchdog` never showed it because the table it reads was always
 * empty (nothing wrote `hope_timepoint_schedule` at all); `sfv-watchdog` reads rows that DO exist, so
 * it has been failing every 15 minutes wherever an SFV went past due. Surfaced the moment this branch
 * gave the window watchdog a real row to expire. M10's own org-rollup store already used the empty
 * sentinel with this exact reasoning.
 */
const M10_WORKER_SYSTEM_USER_ID = "";

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/**
 * The M4 legal-hold read the retention scan is gated on (`activeLegalHoldScopeForOrg`, bound at the composition
 * root — M10 never reads M4's `legal_hold` table). FAIL-CLOSED: unbound, the scan refuses to run rather than
 * guess that nothing is held.
 */
export interface HopeRetentionHoldPort {
  activeLegalHoldScopeForOrg(
    organizationId: string,
  ): Promise<{ readonly orgWide: boolean; readonly patientIds: ReadonlySet<string> }>;
}

/**
 * A tenant/state retention override (years), or null. It can only LENGTHEN the architecture horizons (7y
 * standard / 10y submitted) — see `effectiveYears`. Optional: unbound means "no override", which is safe
 * because the base horizons already meet every regulatory floor.
 */
export interface HopeRetentionOverridePort {
  overrideYearsForOrg(organizationId: string): Promise<number | null>;
}

/** The dep bag the composition root injects. `outbox` is required; `activeOrgs` defaults to a fail-closed
 * thunk until the integrator binds it (the M25 pattern). */
export interface M10WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: HopeOutboxPublishPort;
  readonly activeOrgs?: ActiveOrgListPort;
  readonly alerts?: HopeAlertEmitPort;
  /** GAP-181 — the M4 legal-hold read the retention scan is gated on (fail-closed when unbound). */
  readonly retentionHolds?: HopeRetentionHoldPort;
  /** GAP-181 — optional tenant/state retention override (lengthen-only). */
  readonly retentionOverride?: HopeRetentionOverridePort;
  /**
   * F-072 - the D6 iQIES adapter. Optional and fail-closed by default, exactly like `activeOrgs`: with none bound,
   * `runIqiesSubmitCron` / `runIqiesReconcileCron` reject. Those stages are NOT registered, scheduled or given a Worker
   * today (RECOVERY NOTE in the file header), so nothing runs them, no job DLQs and no M36 DLQ alert fires; the
   * rejection is what a future wiring would surface.
   */
  readonly iqies?: IqiesAdapterPort;
  /** F-072 — the M1-owned CCN read the envelope is keyed on. See {@link ProviderEntityCcnPort}. */
  readonly providerEntityCcn?: ProviderEntityCcnPort;
  /** F-072 - injectable per-item CMS pre-submission validation (defaults to M10's production runner). */
  readonly validateItem?: SubmissionItemValidator;
  now?: () => Date;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M10_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

/**
 * Log one org's (or one batch's) cron failure with ids and the error label only, never the message (a driver message can
 * carry bound values). The failures are also collected and thrown once at the end of the run, but an `AggregateError`'s
 * message names no org, so this line is what says WHICH org or batch failed.
 */
function logCronFailure(job: string, scope: string, error: unknown): void {
  // A timed-out port read names the read (our own text, never a driver message).
  const read = error instanceof DeadlineError ? ` (${error.what})` : "";
  console.error(`m10: ${job} failed for ${scope}${read}: ${describeError(error)}.`);
}

/** A reconcile transition met an item that was no longer `pending`. Logged by class (see `describeError`); the warning before it names the ids. */
class ReconcileItemNotPendingError extends Error {
  constructor() {
    super("a reconcile transition met an item that was no longer pending");
    this.name = "ReconcileItemNotPendingError";
  }
}

/**
 * One READ through a port into another module (M1, M2, M4 or the iQIES adapter), raced against `M10_SEAM_READ_TIMEOUT_MS`.
 * The jobs below visit orgs and batches one after another, so a read that never answers would otherwise stall every later
 * org without a log line; a timeout throws a `DeadlineError`, which fails THAT org or batch like any thrown error. Not used
 * for a write (`iqies.submitBatch`: whether a local timeout may abandon a transmit in flight is a transport decision), nor
 * for `listActiveOrgs` (it runs once, before any org).
 */
const readThroughPort = <T>(what: string, read: () => Promise<T>): Promise<T> =>
  withinDeadline(
    read,
    M10_SEAM_READ_TIMEOUT_MS,
    () => new DeadlineError(what, M10_SEAM_READ_TIMEOUT_MS),
  );

function activeOrgsOf(deps: M10WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unbound(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the cron fan-out source) under withPlatformContext",
        ),
    }
  );
}

function iqiesOf(deps: M10WorkerDeps): IqiesAdapterPort {
  const hint =
    "bind the @chartwarden/iqies-client adapter (per-ProviderEntity CMS submitter credentials); createUnboundIqiesAdapter denies until a live transport exists";
  return (
    deps.iqies ?? {
      submitBatch: () => unbound("iqies.submitBatch", hint),
      fetchAcceptanceReport: () => unbound("iqies.fetchAcceptanceReport", hint),
    }
  );
}

function ccnOf(deps: M10WorkerDeps): ProviderEntityCcnPort {
  return (
    deps.providerEntityCcn ?? {
      ccnFor: () =>
        unbound(
          "providerEntityCcn.ccnFor",
          "bind the M1 provider-entity CCN resolver (bootstrap/provider-entity-resolver.ts); M10 may not read provider_entity directly",
        ),
    }
  );
}

/** Build the {@link M10WorkerDeps} from the composition-root primitives (the M25 `buildM25WorkerDeps` shape). */
export function buildM10WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: HopeOutboxPublishPort;
  activeOrgs?: ActiveOrgListPort;
  alerts?: HopeAlertEmitPort;
  iqies?: IqiesAdapterPort;
  providerEntityCcn?: ProviderEntityCcnPort;
  retentionHolds?: HopeRetentionHoldPort;
  retentionOverride?: HopeRetentionOverridePort;
}): M10WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    alerts: deps.alerts,
    iqies: deps.iqies,
    providerEntityCcn: deps.providerEntityCcn,
    retentionHolds: deps.retentionHolds,
    retentionOverride: deps.retentionOverride,
    now: () => new Date(),
  };
}

// ── the per-org cron runners (fan out over active orgs, RLS-scoped, outbox-publishing) ─────────────────────

/** The per-tick inputs the watchdog ticks (./watchdog-ticks.ts) take: the clock and the active org list are read once. */
async function watchdogTickDeps(deps: M10WorkerDeps): Promise<WatchdogTickDeps> {
  return {
    db: deps.db,
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    now: (deps.now ?? (() => new Date()))(),
    organizationIds: (await activeOrgsOf(deps).listActiveOrgs()).map((org) => org.organizationId),
    systemUserId: M10_WORKER_SYSTEM_USER_ID,
  };
}

/** `hope-window-watchdog` (§4.8, every 15 min): see `runWindowWatchdogTick`. */
export async function runHopeWindowWatchdogCron(deps: M10WorkerDeps): Promise<void> {
  await runWindowWatchdogTick(await watchdogTickDeps(deps));
}

/** `sfv-watchdog` (§4.8, every 15 min): see `runSfvWatchdogTick`. */
export async function runSfvWatchdogCron(deps: M10WorkerDeps): Promise<void> {
  await runSfvWatchdogTick(await watchdogTickDeps(deps));
}

// ── BullMQ construction ──────────────────────────────────────────────────────────────────────────────────

/** Construct one BullMQ `Worker` per wired §4.8 cron queue. The caller owns lifecycle (`close()` on shutdown). */
export function registerM10CronWorkers(deps: M10WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M10_QUEUES.windows, async () => runHopeWindowWatchdogCron(deps), {
      connection,
      concurrency: M10_JOB_PARAMS["hope-window-watchdog"].concurrency,
    }),
    new Worker(M10_QUEUES.sfv, async () => runSfvWatchdogCron(deps), {
      connection,
      concurrency: M10_JOB_PARAMS["sfv-watchdog"].concurrency,
    }),
    // GAP-181 — the `hope.retention` queue now has its worker. The monthly scan only FLAGS records past their
    // retention horizon; destruction stays on the M4 destruction-certificate pathway.
    new Worker(M10_QUEUES.retention, async () => runHopeRetentionCron(deps), {
      connection,
      concurrency: M10_JOB_PARAMS["hope-retention-scan"].concurrency,
    }),
    // The three §4.10 submission stages (`runSubmissionJob`) are deliberately NOT given a Worker: the
    // manual iQIES package flow is the transport (see the RECOVERY NOTE in the file header).
  ];
}

/**
 * The `hope.submission` queue carries THREE §4.10 jobs (the §4.8 catalog names one queue for the whole
 * submission pipeline), so the worker dispatches on the job name rather than on the queue.
 */
export async function runSubmissionJob(jobName: string, deps: M10WorkerDeps): Promise<void> {
  switch (jobName) {
    case "assemble-hope-submission":
      await runAssembleSubmissionCron(deps);
      return;
    case "iqies-submit-worker":
      await runIqiesSubmitCron(deps);
      return;
    case "iqies-reconcile-worker":
      await runIqiesReconcileCron(deps);
      return;
    default:
      // Not a silent no-op: an unrecognised job on this queue means the schedule and the dispatcher
      // disagree, and a worker that quietly succeeds on it would hide that forever.
      throw new Error(`M10_UNKNOWN_SUBMISSION_JOB: ${jobName}`);
  }
}

// ── F-072 (#177) — §4.10 stage 1 as a cron ────────────────────────────────────────────────────────────
//
// F-058 built the assembler and deliberately did NOT register it as a cron, because with no transmit
// stage a nightly pass would have created batches nothing could send and — through
// `uniq_hope_sub_item_assessment_active` — permanently excluded their assessments from every future
// batch, silently. Stages 2 and 3 exist now as runners, but they are NOT registered, scheduled or given a Worker either
// (RECOVERY NOTE in the file header), so that silence has NOT gone: nothing picks a batch up, nothing raises, no job
// DLQs and no M36 DLQ alert fires. What follows describes the pipeline as designed, for when the stages are wired (then
// an unconfigured deployment's batches would be picked up by the submit worker, the deny-stub would raise, the job would
// DLQ and the M36 DLQ alert would fire).

/** What one assemble tick did, per org. */
export interface AssembleTickOutcome {
  readonly submissionsCreated: number;
  readonly assessmentsBatched: number;
  readonly skippedUnsited: number;
}

/**
 * `assemble-hope-submission` (§4.10, catalog cadence daily 02:00; NOT scheduled today) — batch every eligible signed assessment in every
 * active org into one `hope_submission` per (ProviderEntity, CMS submission period), with its items.
 *
 * Org-wide, unlike the route, which assembles for ONE named provider entity: the cron has no operator
 * naming a CCN, so it groups across all of them, which is what `planAssembleSubmissions` was written to
 * do. Idempotent by the same rule the route relies on — an assessment already on a `pending` item is
 * reported as a skip, never re-included. Overlapping runs (a second tick, or the manual route) serialise on the same
 * per-provider-entity advisory key the route takes; the stage must not be registered without that key.
 */
export async function runAssembleSubmissionCron(deps: M10WorkerDeps): Promise<AssembleTickOutcome> {
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  let submissionsCreated = 0;
  let assessmentsBatched = 0;
  let skippedUnsited = 0;
  const errors: unknown[] = [];

  for (const { organizationId } of orgs) {
    try {
      await withOrgContext(
        deps.db,
        { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
        async (tx) => {
          const t = tx as unknown as DbClient;
          await boundCronLockWait(t);
          const scan = await assemblableAssessmentsForOrg(t, organizationId);
          skippedUnsited += scan.unsitedAssessmentIds.length;
          if (scan.unsitedAssessmentIds.length > 0) {
            // Never silent: an assessment with no `provider_entity_id` has no CCN to be batched under
            // and is excluded by arithmetic, not by a rule anyone can read in the row.
            console.warn(
              `m10: ${scan.unsitedAssessmentIds.length} signed assessment(s) in organization ${organizationId} have no provider entity and cannot be batched for iQIES.`,
            );
          }
          // The read above is unlocked: it only says WHICH provider entities have work. Each is then assembled behind the
          // advisory key the manual route takes for the same entity (`m10:assemble:<org>`), and its candidates are read
          // AGAIN behind that key, so a tick that overlaps another tick or `POST /hope/submissions/assemble` waits (at most
          // `M10_LOCK_TIMEOUT_MS`, then fails this org, logged) and then sees the winner's pending items as skips, instead of
          // inserting a second item for the same assessment (23505 on `uniq_hope_sub_item_assessment_active`, which would
          // roll back every batch of this org). Entities in a stable order, so two ticks cannot lock them crosswise.
          const providerEntityIds = [
            ...new Set(scan.eligible.map((e) => e.providerEntityId)),
          ].sort();
          for (const providerEntityId of providerEntityIds) {
            await lockRecordKey(t, `m10:assemble:${organizationId}`, providerEntityId);
            const locked = await assemblableAssessmentsForOrg(t, organizationId, providerEntityId);
            const plan = planAssembleSubmissions(locked.eligible);
            for (const planned of plan.submissions) {
              const { submission } = await persistAssembledSubmission(t, organizationId, planned);
              await deps.outbox.publish(t, {
                eventName: "m10.hope.submission_queued",
                payload: {
                  submissionId: submission.id,
                  providerEntityId: submission.providerEntityId,
                  itemCount: submission.itemCount,
                },
                organizationId,
                aggregateKind: "hope_submission",
                aggregateId: submission.id,
              });
              submissionsCreated += 1;
              assessmentsBatched += submission.itemCount;
            }
          }
        },
      );
    } catch (cause) {
      logCronFailure("assemble-hope-submission", `org ${organizationId}`, cause);
      errors.push(cause);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `m10 assemble-hope-submission: ${errors.length} organization(s) failed`,
    );
  }
  return { submissionsCreated, assessmentsBatched, skippedUnsited };
}

// ── F-072 (#177) — §4.10 stages 2 and 3: the iQIES submit + reconcile workers ──────────────────────────
//
// F-058 built stage 1 (assemble). These are the two that follow it, and building them gives production
// callers to five pure planners that had none — `decideSubmitReadiness`, `buildSubmissionEnvelope`,
// `planTransmitResult`, `planReconcile` — and to `hasBlockingError`, whose only purpose is to gate a
// transmit that previously had no transmit-time to run in.
//
// The iQIES WIRE PROTOCOL is still absent and is not invented here: the CMS endpoint, its auth flow and
// the HOPE submission XML schema are not in this repository, and `CHARTWARDEN_INTEGRATIONS_v0_1.md` §6.7
// specifies the integration's shape without them. Everything below runs against the typed `IqiesAdapter`
// port, so binding a real transport means implementing three methods — and until one is bound,
// `createUnboundIqiesAdapter` denies with `retryable: false`; once these stages are wired, the job would DLQ and the
// M36 DLQ alert would fire. Today they are not wired (RECOVERY NOTE in the file header), so that visible failure does not
// exist yet: a batch with no transport still sits `queued` in silence.

/** The rule id the pre-transmit gate records when it refuses to send a batch (§4.10). */
export const IQIES_SUBMIT_BLOCKED_RULE = "iqies.submission_blocked";

/** The `hope_validation_finding.section` a batch-level (non-item-section) finding is filed under. */
const SUBMISSION_FINDING_SECTION = "SUBMISSION";

/** How many batches one tick of each worker may touch. A backlog drains over successive ticks rather
 *  than in one transaction long enough to hold an RLS connection open for minutes. */
export const IQIES_BATCHES_PER_TICK = 25;

/**
 * The idempotency key for one batch's transmit — deterministic in the submission id.
 *
 * A retry after an ambiguous failure (a timeout where CMS may or may not have received the batch) must
 * be the SAME request, not a second one. That is what makes `releaseSubmission`'s roll-back-to-queued
 * safe, and it is the at-least-once-plus-idempotency-key posture `CHARTWARDEN_INTEGRATIONS_v0_1.md` §5
 * prescribes for every outbox-driven external call.
 */
export function transmitCorrelationId(submissionId: string): string {
  return submissionId;
}

/** The iQIES adapter port (D6) — `@chartwarden/iqies-client`'s three typed methods, narrowed to what these
 *  two workers call. Declared structurally so this file takes no import-time dependency on a binding. */
export interface IqiesAdapterPort {
  submitBatch(request: {
    readonly envelope: HopeSubmissionEnvelope;
    readonly envelopeSha256: string;
    readonly correlationId: string;
  }): Promise<{ readonly iqiesBatchId: string; readonly transmittedAt: string }>;
  fetchAcceptanceReport(iqiesBatchId: string): Promise<{
    readonly iqiesBatchId: string;
    readonly items: ReadonlyArray<{
      readonly hopeAssessmentId: string;
      readonly outcome: "accepted" | "rejected";
      readonly iqiesRecordId: string | null;
      readonly findings: ReadonlyArray<{ readonly ruleId: string; readonly message: string }>;
    }>;
  }>;
}

/**
 * F-072 — the CCN of one of this org's provider entities.
 *
 * `provider_entity` is an M1 FOUNDATION table M10 neither owns nor may import (`arch:tables`), and the
 * CMS Certification Number is the key the whole submission envelope is built on (§2.3 / §3). M10
 * declares the shape it needs; the composition root binds `buildProviderEntityCcnResolver`. The same
 * arrangement `buildPrimaryProviderEntityResolver` already provides for M6 and M30.
 *
 * `null` for a provider entity that does not resolve in this org — the batch is then skipped and said
 * so, rather than transmitted under a CCN nobody confirmed.
 */
export interface ProviderEntityCcnPort {
  ccnFor(organizationId: string, providerEntityId: string): Promise<string | null>;
}

/** The per-item validation the submit worker re-runs. Injectable so the orchestration can be tested
 *  without M38's terminology seam; defaults to M10's own production runner. */
export type SubmissionItemValidator = (item: {
  /** Carried into the log line of a failed M38 terminology read (an id only). */
  readonly hopeAssessmentId?: string;
  readonly rfaKind: HopeRfaKind;
  readonly dischargeReason: HopeDischargeReason | null;
  readonly data: unknown;
  readonly targetDate: Date;
}) => Promise<readonly HopeValidationFindingDescriptor[]>;

const defaultItemValidator: SubmissionItemValidator = (item) =>
  runHopeAssessmentValidation({
    assessmentId: item.hopeAssessmentId,
    rfaKind: item.rfaKind,
    dischargeReason: item.dischargeReason,
    data: item.data,
    targetDate: item.targetDate,
  });

/** What one submit tick did — returned so the caller (and the tests) can assert on it. */
export interface SubmitTickOutcome {
  readonly transmitted: readonly string[];
  readonly blocked: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}

/**
 * `iqies-submit-worker` (§4.10, catalog cadence every 30 min; NOT scheduled today).
 *
 * Per org, per queued batch, in its own transaction:
 *   1. re-run the CMS pre-submission validation for every pending item;
 *   2. `decideSubmitReadiness` — ANY blocking error refuses the WHOLE batch (never a partial transmit,
 *      §4.10) and records one `hope_validation_finding` per blocking assessment so the refusal is
 *      visible to the clinician who can fix it, not only in a log;
 *   3. otherwise CAS `queued → in_flight` and transmit.
 *
 * ORDER MATTERS. The CAS happens BEFORE the adapter call, so exactly one worker can transmit a batch.
 * One transaction PER BATCH, not per tick: a permanent failure on one batch must not roll back the transmit another batch
 * just recorded.
 *
 * THE CLAIM IS A ROW LOCK, NOT A COMMITTED STATUS. The claim, the CCN read, `iqies.submitBatch` and `recordTransmit` all run
 * in that ONE transaction, so `in_flight` is invisible to other workers until it commits, and the claim's UPDATE holds the
 * batch's row lock (and a pooled connection) across the external calls (`submitBatch` is not bounded here). An overlapping
 * tick's claim therefore WAITS on that lock and, past `M10_LOCK_TIMEOUT_MS`, fails that batch with SQLSTATE 55P03 (counted
 * in `failed`, raised in the AggregateError) instead of returning "CAS lost, skip". So this stage needs a SINGLE-FLIGHT tick
 * (no two runs overlapping), which `M10_JOB_PARAMS["iqies-submit-worker"].concurrency` (2) does not by itself guarantee:
 * revisit it when the stage is wired.
 * Committing the claim first would make the loser skip cleanly, but a crash after that commit would strand the batch
 * `in_flight` with no `iqies_batch_id` (the reconcile stage only reads batches that have one); with one transaction a crash
 * rolls the claim back and the next tick retries with the same correlation id. Which of the two to take is a decision for
 * whoever wires the stage.
 * `releaseSubmission` is guarded on `iqies_batch_id IS NULL`, so it can never un-transmit a batch CMS actually received;
 * where the transaction then ROLLS BACK (the catch below) it changes nothing, and where the transaction COMMITS (an
 * unresolved CCN) it is what un-claims.
 */
export async function runIqiesSubmitCron(deps: M10WorkerDeps): Promise<SubmitTickOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const validate = deps.validateItem ?? defaultItemValidator;
  const iqies = iqiesOf(deps);
  const ccns = ccnOf(deps);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  const transmitted: string[] = [];
  const blocked: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const errors: unknown[] = [];

  for (const { organizationId } of orgs) {
    // One org's batch list failing must not stop the orgs after it (the per-batch failures below are isolated the same way).
    let batches: Awaited<ReturnType<typeof queuedSubmissionsForOrg>>;
    try {
      batches = await withOrgContext(
        deps.db,
        { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
        async (tx) =>
          queuedSubmissionsForOrg(
            tx as unknown as DbClient,
            organizationId,
            IQIES_BATCHES_PER_TICK,
          ),
      );
    } catch (cause) {
      logCronFailure("iqies-submit-worker", `org ${organizationId}`, cause);
      errors.push(cause);
      continue;
    }

    for (const batch of batches) {
      try {
        await withOrgContext(
          deps.db,
          { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
          async (tx) => {
            const t = tx as unknown as DbClient;
            await boundCronLockWait(t);
            const items = await pendingItemsForSubmission(t, organizationId, batch.submissionId);
            if (items.length === 0) {
              // A queued batch with no pending items is already fully reconciled; leaving it queued
              // would re-pick it every tick forever.
              skipped.push(batch.submissionId);
              return;
            }

            const validations: SubmissionItemValidation[] = [];
            const blockingFindings: Parameters<typeof writeValidationFindings>[2][number][] = [];
            for (const item of items) {
              const findings = await validate(item);
              const isBlocking = hasBlockingError(findings);
              validations.push({
                hopeAssessmentId: item.hopeAssessmentId,
                hasBlockingError: isBlocking,
              });
              if (!isBlocking) continue;
              for (const f of findings.filter((x) => x.severity === "error")) {
                blockingFindings.push({
                  hopeAssessmentId: item.hopeAssessmentId,
                  providerEntityId: item.providerEntityId,
                  locationId: item.locationId,
                  ruleId: f.ruleId,
                  severity: "error",
                  section: f.section,
                  message: f.message,
                });
              }
            }

            const readiness = decideSubmitReadiness({ status: batch.status, items: validations });
            if (readiness.action === "skip") {
              skipped.push(batch.submissionId);
              return;
            }
            if (readiness.action === "rollback") {
              // The batch STAYS queued — no status write at all, which is the transition not happening.
              // The findings are what make the refusal actionable; without them a compliance officer
              // would see a batch that never moves and nothing saying why.
              const res = await writeValidationFindings(
                t,
                organizationId,
                blockingFindings.length > 0
                  ? blockingFindings
                  : readiness.blockingAssessmentIds.map((id) => ({
                      hopeAssessmentId: id,
                      providerEntityId:
                        items.find((i) => i.hopeAssessmentId === id)?.providerEntityId ?? null,
                      locationId: items.find((i) => i.hopeAssessmentId === id)?.locationId ?? null,
                      ruleId: IQIES_SUBMIT_BLOCKED_RULE,
                      severity: "error" as const,
                      section: SUBMISSION_FINDING_SECTION,
                      message:
                        "This assessment has an unresolved CMS pre-submission error, so its whole batch was held back from iQIES.",
                    })),
                now,
              );
              if (res.unsited > 0) {
                console.warn(
                  `m10: ${res.unsited} iQIES pre-submission finding(s) for submission ${batch.submissionId} could not be written (assessment has no provider entity / location).`,
                );
              }
              blocked.push(batch.submissionId);
              return;
            }

            const claimed = await claimSubmissionForTransmit(t, organizationId, batch.submissionId);
            if (!claimed) {
              // The CAS lost — another worker advanced this batch between the read and here. Exactly
              // the `not_queued` case `decideSubmitReadiness` models, arrived at concurrently.
              skipped.push(batch.submissionId);
              return;
            }

            const ccn = await readThroughPort("the M1 CCN read", () =>
              ccns.ccnFor(organizationId, batch.providerEntityId),
            );
            if (ccn === null) {
              // Never transmit under a CCN nobody confirmed: the envelope's CCN is what CMS matches the
              // submitter credential and `ccn_at_election` against. Put the batch back and say so.
              await releaseSubmission(t, organizationId, batch.submissionId);
              console.warn(
                `m10: submission ${batch.submissionId} not transmitted — provider entity ${batch.providerEntityId} has no resolvable CCN in organization ${organizationId}.`,
              );
              skipped.push(batch.submissionId);
              return;
            }
            const envelope = buildSubmissionEnvelope({
              providerEntityCcn: ccn,
              submissionPeriod: batch.submissionPeriod,
              items: items.map((i) => ({
                hopeAssessmentId: i.hopeAssessmentId,
                rfaKind: i.rfaKind,
                correctsIqiesRecordId: i.correctsIqiesRecordId,
              })),
            });
            const sha = envelopeSha256(assembleEnvelopeCanonical(envelope));

            try {
              const result = await iqies.submitBatch({
                envelope,
                envelopeSha256: sha,
                correlationId: transmitCorrelationId(batch.submissionId),
              });
              const plan = planTransmitResult({
                submissionId: batch.submissionId,
                iqiesBatchId: result.iqiesBatchId,
                // Null deliberately: the key names the RENDERED submission XML, and nothing renders it.
                // See TransmitResultPlan.
                envelopeStorageUri: null,
                envelopeSha256: sha,
                transmittedAt: result.transmittedAt,
              });
              await recordTransmit(t, organizationId, {
                submissionId: plan.submissionId,
                iqiesBatchId: plan.iqiesBatchId,
                envelopeStorageUri: plan.envelopeStorageUri,
                envelopeSha256: plan.envelopeSha256,
                transmittedAt: plan.transmittedAt,
              });
              await deps.outbox.publish(t, {
                eventName: plan.event.eventName,
                payload: plan.event.payload,
                organizationId,
                aggregateKind: "hope_submission",
                aggregateId: batch.submissionId,
              });
              transmitted.push(batch.submissionId);
            } catch (cause) {
              // The rethrow rolls this whole transaction back, claim included, so a later tick retries with the SAME
              // correlation id; the release is belt and braces. Guarded on `iqies_batch_id IS NULL`, so a batch CMS did
              // receive is never un-transmitted.
              await releaseSubmission(t, organizationId, batch.submissionId);
              throw cause;
            }
          },
        );
      } catch (cause) {
        logCronFailure(
          "iqies-submit-worker",
          `submission ${batch.submissionId} (org ${organizationId})`,
          cause,
        );
        failed.push(batch.submissionId);
        errors.push(cause);
      }
    }
  }

  if (errors.length > 0) {
    // Collected, not first-thrown: one unreachable provider entity must not stop every other org's
    // batches from being attempted on this tick. Once wired, BullMQ sees one failure and applies §4.8.1 retry/DLQ.
    throw new AggregateError(errors, `m10 iqies-submit-worker: ${errors.length} batch(es) failed`);
  }
  return { transmitted, blocked, skipped, failed };
}

/** What one reconcile tick did. */
export interface ReconcileTickOutcome {
  readonly reconciled: readonly string[];
  readonly failed: readonly string[];
}

/**
 * `iqies-reconcile-worker` (§4.10, catalog cadence hourly; NOT scheduled today).
 *
 * Per org, per `in_flight` batch that carries an `iqies_batch_id`: pull the acceptance report, run
 * `planReconcile`, apply the per-item transitions, write one `hope_validation_finding` per rejected
 * item, fold the batch-level outcome, and publish `submission_accepted` / `submission_rejected`.
 *
 * `planReconcile` folds the report ONLY over the items the report actually names. An item CMS did not
 * answer on stays `pending`, and its batch stays `in_flight`, so the next tick asks again — which is the
 * behaviour a partial report needs and the reason the plan's status is derived from counts rather than
 * assumed from the batch size.
 */
export async function runIqiesReconcileCron(deps: M10WorkerDeps): Promise<ReconcileTickOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const iqies = iqiesOf(deps);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const reconciled: string[] = [];
  const failed: string[] = [];
  const errors: unknown[] = [];

  for (const { organizationId } of orgs) {
    // One org's batch list failing must not stop the orgs after it (the per-batch failures below are isolated the same way).
    let batches: Awaited<ReturnType<typeof inFlightSubmissionsForOrg>>;
    try {
      batches = await withOrgContext(
        deps.db,
        { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
        async (tx) =>
          inFlightSubmissionsForOrg(
            tx as unknown as DbClient,
            organizationId,
            IQIES_BATCHES_PER_TICK,
          ),
      );
    } catch (cause) {
      logCronFailure("iqies-reconcile-worker", `org ${organizationId}`, cause);
      errors.push(cause);
      continue;
    }

    for (const batch of batches) {
      try {
        // The adapter call is OUTSIDE the transaction: an iQIES round-trip must not hold an RLS
        // connection open, and the report is a read — re-fetching it on a retry yields the same plan.
        const report = await readThroughPort("the iQIES acceptance-report read", () =>
          iqies.fetchAcceptanceReport(batch.iqiesBatchId),
        );
        await withOrgContext(
          deps.db,
          { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
          async (tx) => {
            const t = tx as unknown as DbClient;
            await boundCronLockWait(t);
            // The batch list was read unlocked: lock the batch and re-judge its status BEFORE reading the pending items, so
            // a tick that waited behind another one's reconcile does nothing instead of re-applying it and re-publishing.
            if (!(await lockInFlightSubmission(t, organizationId, batch.submissionId))) {
              console.warn(
                `m10: iqies-reconcile-worker found submission ${batch.submissionId} (org ${organizationId}) no longer in flight; another tick reconciled it, so nothing was written or published here.`,
              );
              return;
            }
            const items = await pendingItemsForSubmission(t, organizationId, batch.submissionId);
            if (items.length === 0) {
              reconciled.push(batch.submissionId);
              return;
            }
            // The report is an external payload: it names an item by the id as the adapter spells it, and the item is
            // matched on the database's id (canonical), never on that spelling. Everything below runs on the database's id.
            const dbIdByCanonical = new Map(
              items.map((i) => [
                canonicalUuidOrNull(i.hopeAssessmentId) ?? i.hopeAssessmentId,
                i.hopeAssessmentId,
              ]),
            );
            const outcomes = report.items.flatMap((i) => {
              const hopeAssessmentId = dbIdByCanonical.get(
                canonicalUuidOrNull(i.hopeAssessmentId) ?? i.hopeAssessmentId,
              );
              return hopeAssessmentId === undefined
                ? []
                : [
                    {
                      hopeAssessmentId,
                      outcome: i.outcome,
                      iqiesRecordId: i.iqiesRecordId,
                      findings: i.findings,
                    },
                  ];
            });
            if (outcomes.length === 0) {
              // The report named none of this batch's pending items. Leave everything alone rather than
              // folding an empty plan, which `planReconcile` would score as a wholly accepted batch. Said in the log: a
              // batch that stays in flight for this reason would otherwise look like one that is merely waiting.
              console.warn(
                `m10: iqies-reconcile-worker: the acceptance report for submission ${batch.submissionId} (org ${organizationId}) named none of its ${items.length} pending item(s); the batch was left in flight.`,
              );
              return;
            }
            const plan = planReconcile({ submissionId: batch.submissionId, outcomes });

            for (const transition of plan.itemTransitions) {
              const reported = report.items.find(
                (i) =>
                  i.hopeAssessmentId === transition.hopeAssessmentId ||
                  sameUuid(i.hopeAssessmentId, transition.hopeAssessmentId),
              );
              // `planReconcile` only emits accepted / rejected / pending; the item-status union was widened
              // by the manual-iQIES phase (accepted_with_warnings, blocked, unmatched) after this was written.
              const itemTransition = transition as Parameters<typeof applyItemTransition>[3];
              const applied = await applyItemTransition(
                t,
                organizationId,
                batch.submissionId,
                itemTransition,
                { outcome: reported?.outcome ?? null, findings: reported?.findings ?? [] },
              );
              if (applied === false) {
                // Unreachable behind the batch lock, so a settled item here means something wrote it without the lock. Folding
                // the batch over it would score an answer nobody recorded: fail this batch (rolled back, logged with ids).
                console.warn(
                  `m10: iqies-reconcile-worker found the item of assessment ${transition.hopeAssessmentId} in submission ${batch.submissionId} (org ${organizationId}) no longer pending; the batch was rolled back and left in flight.`,
                );
                throw new ReconcileItemNotPendingError();
              }
            }

            if (plan.findings.length > 0) {
              const res = await writeValidationFindings(
                t,
                organizationId,
                plan.findings.map((f) => ({
                  hopeAssessmentId: f.hopeAssessmentId,
                  providerEntityId:
                    items.find((i) => i.hopeAssessmentId === f.hopeAssessmentId)
                      ?.providerEntityId ?? null,
                  locationId:
                    items.find((i) => i.hopeAssessmentId === f.hopeAssessmentId)?.locationId ??
                    null,
                  ruleId: f.ruleId,
                  severity: f.severity,
                  section: f.section ?? SUBMISSION_FINDING_SECTION,
                  message: f.message,
                })),
                now,
              );
              if (res.unsited > 0) {
                console.warn(
                  `m10: ${res.unsited} iQIES rejection finding(s) for submission ${batch.submissionId} could not be written (assessment has no provider entity / location).`,
                );
              }
            }

            // Only a batch whose every pending item was answered reaches a terminal status; a partial
            // report leaves it `in_flight` for the next tick.
            const answeredAll = outcomes.length === items.length;
            if (answeredAll) {
              await recordReconcileOutcome(t, organizationId, {
                submissionId: batch.submissionId,
                nextStatus: plan.nextStatus,
                acceptedCount: plan.acceptedCount,
                rejectedCount: plan.rejectedCount,
                acceptanceReport: { iqiesBatchId: report.iqiesBatchId, items: report.items },
                at: now,
              });
              for (const event of plan.events) {
                await deps.outbox.publish(t, {
                  eventName: event.eventName,
                  payload: event.payload,
                  organizationId,
                  aggregateKind: "hope_submission",
                  aggregateId: batch.submissionId,
                });
              }
              reconciled.push(batch.submissionId);
            }
          },
        );
      } catch (cause) {
        logCronFailure(
          "iqies-reconcile-worker",
          `submission ${batch.submissionId} (org ${organizationId})`,
          cause,
        );
        failed.push(batch.submissionId);
        errors.push(cause);
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `m10 iqies-reconcile-worker: ${errors.length} batch(es) failed`,
    );
  }
  return { reconciled, failed };
}

// ── GAP-181 — `hope-retention-scan` (monthly) ─────────────────────────────────────────────────────────────
//
// `hope.retention` was a declared queue with no worker, so HOPE retention was documented but never evaluated.
// Per org, in ONE tx: fold each patient's HOPE assessments + iQIES outcomes into facts, layer the M4 legal-hold
// scope on (the hold's patients are compared with the assessments' in SQL, on canonical uuids; an org-wide hold here), evaluate the retention horizon (`./retention`: 10y from the last transmission for a submitted record,
// else 7y from the last effective date, lengthen-only override) and record the verdict in the M10-owned
// `hope_retention_review` ledger. A patient newly `eligible` publishes `m10.hope.retention_eligible` ONCE; a
// `blocked` patient (legal hold / open iQIES error / pending correction) is recorded with its blockers and never
// flagged. The reads are unlocked, so each ledger UPDATE is keyed on the status its verdict was judged from, and a new row
// is inserted `ON CONFLICT DO NOTHING` and only while the patient still has a HOPE assessment; a lost race of either kind
// writes and publishes nothing, and does not abort the org's other patients. THE SCAN NEVER DELETES a clinical row: destruction is a human-approved M4 destruction certificate
// invoking the registered `hope_record` eraser, which re-checks the CMS 10-year rule itself.
export async function runHopeRetentionCron(deps: M10WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const holds = deps.retentionHolds;
  if (!holds) {
    return unbound(
      "retentionHolds.activeLegalHoldScopeForOrg",
      "bind M4's activeLegalHoldScopeForOrg at the composition root — the retention scan must know about legal holds before it can flag anything",
    );
  }
  const errors: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      const holdScope = await readThroughPort("the M4 legal-hold read", () =>
        holds.activeLegalHoldScopeForOrg(organizationId),
      );
      const overridePort = deps.retentionOverride;
      const overrideYears = overridePort
        ? ((await readThroughPort("the retention-override read", () =>
            overridePort.overrideYearsForOrg(organizationId),
          )) ?? null)
        : null;
      await withOrgContext(
        deps.db,
        { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
        async (tx) => {
          const t = tx as unknown as DbClient;
          await boundCronLockWait(t);
          // The hold's patients are compared with the assessments' patients IN SQL (see `heldPatientSql`), not on the
          // spelling the hold's creator typed; only the org-wide flag is layered on here.
          const facts = await hopeRetentionFactsForOrg(t, organizationId, holdScope.patientIds);
          const reviews = new Map(
            (await retentionReviewsForOrg(t, organizationId)).map((r) => [r.patientId, r]),
          );
          for (const f of facts) {
            const decision = evaluateHopeRetention(
              { ...f, legalHold: holdScope.orgWide || f.legalHold },
              now,
              overrideYears,
            );
            const prior = reviews.get(f.patientId);
            // Not due and never flagged: no row (the ledger holds only patients that have reached their horizon).
            if (!prior && decision.status === "cleared") continue;
            const becameEligible = decision.status === "eligible" && prior?.status !== "eligible";
            // An already-flagged patient keeps its original flag instant: the column is left OUT of the update (an explicit
            // null would overwrite it). A status that leaves `eligible` clears it; a new flag stamps it.
            const flag: Pick<RetentionReviewWrite, "flaggedAt"> = becameEligible
              ? { flaggedAt: now }
              : decision.status === "eligible"
                ? {}
                : { flaggedAt: null };
            const write: RetentionReviewWrite = {
              basis: decision.basis,
              anchorAt: decision.anchorAt,
              retentionYears: decision.retentionYears,
              eligibleAt: decision.eligibleAt,
              status: decision.status,
              blockers: decision.blockers,
              evaluatedAt: now,
              ...flag,
            };
            let rowId: string;
            if (prior) {
              rowId = prior.id;
              const updated = await updateRetentionReview(t, prior.id, prior.status, write);
              if (!updated) {
                // The read above is unlocked: another scan moved this row, or a destruction deleted it, since. The verdict
                // was judged on a stale row, so neither the write nor its event happens; the next monthly scan re-judges.
                console.warn(
                  `m10: hope-retention-scan lost the race for review ${prior.id} in org ${organizationId}; it changed after it was read, so its verdict and event were skipped.`,
                );
                continue;
              }
            } else {
              const inserted = await insertRetentionReview(t, {
                ...write,
                organizationId,
                providerEntityId: f.providerEntityId,
                locationId: f.locationId,
                patientId: f.patientId,
              });
              if (inserted === null) {
                // Same unlocked read: another scan inserted this patient's row first, or a destruction removed the patient's
                // last HOPE assessment since the facts were read. Nothing is written or published; the org's other
                // patients are unaffected, and the next monthly scan re-judges.
                console.warn(
                  `m10: hope-retention-scan lost the race to insert a review for one patient in org ${organizationId}; another scan inserted it, or the patient's HOPE records were destroyed since they were read, so its verdict and event were skipped.`,
                );
                continue;
              }
              rowId = inserted;
            }
            if (becameEligible) {
              await deps.outbox.publish(t, {
                eventName: "m10.hope.retention_eligible",
                payload: {
                  patientId: f.patientId,
                  basis: decision.basis,
                  retentionYears: decision.retentionYears,
                  eligibleAt: decision.eligibleAt.toISOString(),
                },
                organizationId,
                aggregateKind: "hope_retention_review",
                aggregateId: rowId,
              });
            }
          }
        },
      );
    } catch (cause) {
      // One org failing (its hold read, override read or transaction) must not starve the orgs after it: the next run is a month away.
      // A port read that never answers is cut off after `M10_SEAM_READ_TIMEOUT_MS` and fails the org like a thrown one; the
      // log line names the read. NOT bounded: the pooled-connection checkout and a running statement (see ./watchdog-ticks.ts).
      logCronFailure("hope-retention-scan", `org ${organizationId}`, cause);
      errors.push(cause);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `m10 hope-retention-scan: ${errors.length} organization(s) failed`,
    );
  }
}
