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
// `routes/write-service-drizzle.ts`'s `validateClaim` already performs for a manual click. Its mandatory
// payer-responsibility input is re-resolved from M5 inside this worker transaction; unavailable or changing
// coverage is a blocking rule result, never a skip that could move a claim to READY.
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
  evaluateMedicaidPayerResponsibility,
  medicaidClaimMachine,
  runMedicaidRules,
} from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientAddressReader, PatientCoverageReader } from "@chartwarden/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import {
  type CurrentLocPeriodForClaim,
  hospiceClaimLineSnapshotIssue,
} from "../claim-hospice-line-snapshot";
import {
  type AdmissionStayForClaim,
  admissionServiceRangeIssue,
  inclusiveLocEndDateForAdmission,
  patientLifecycleServiceRangeIssue,
} from "../claim-range-guards";
import {
  lockMedicaidRatePolicyScopes,
  readInSavepoint,
  verifyStoredRhcPricingSnapshots,
} from "../pricing/rhc-pricing-snapshot";
import type { CanonicalPayerIdentityReader } from "../routes/write-service-drizzle";
import { readMedicaidRatePolicyLineage } from "../routes/write-service-drizzle";
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
  /** M5's transaction-bound resolver. Missing or failed reads block READY. */
  readonly coverages?: Pick<PatientCoverageReader, "coverageSnapshotForRangeInTransaction">;
  /** M6 transaction-bound admission identity/stay-end snapshot; absent means READY is blocked. */
  readonly admissions?: {
    cadenceSnapshotInTransaction(
      transaction: unknown,
      organizationId: string,
      admissionId: string,
    ): Promise<
      | (AdmissionStayForClaim & {
          readonly patientId: string;
          readonly providerEntityId: string | null;
          readonly version?: number;
        })
      | null
    >;
    periodsForAdmissionInTransaction?(
      transaction: unknown,
      organizationId: string,
      admissionId: string,
    ): Promise<ReadonlyArray<CurrentLocPeriodForClaim>>;
  };
  /** M40 canonical payer and dated program-classification reader. */
  readonly canonicalPayerReader?: CanonicalPayerIdentityReader;
  /** M5 PHI-minimal, transaction-bound residence history for local RHC snapshot revalidation. */
  readonly patientAddresses?: Pick<PatientAddressReader, "residencesBetweenInTransaction">;
  now?: () => Date;
  readonly outbox: RevalidateWorkerOutboxPort;
}

async function resolvePayerContext(
  tx: Tx,
  deps: RevalidateWorkerDeps,
  claim: typeof schema.medicaidClaim.$inferSelect,
): Promise<{
  payerResponsibility: MedicaidValidationContext["payerResponsibility"];
  hasConcurrentMedicareAndMedicaidCoverage: boolean;
  primaryPayerCoverageId: string | null;
  /** Set only from the transaction-bound M6 snapshot for a matching death discharge. */
  inclusiveEndDate?: string | null;
  admissionVersion?: number;
}> {
  if (!deps.coverages) {
    return {
      payerResponsibility: { status: "unresolved", reasonCode: "coverage_reader_unbound" },
      hasConcurrentMedicareAndMedicaidCoverage: false,
      primaryPayerCoverageId: null,
    };
  }

  // Each in-transaction read runs in a savepoint: a database error rolls back only that read, never the
  // patient's whole job, and the claim fails closed with a reason instead of poisoning its siblings.
  const coverages = deps.coverages;
  const snapshotRead = await readInSavepoint(
    tx,
    "m24.claim_revalidate.coverage_snapshot_unavailable",
    (savepoint) =>
      coverages.coverageSnapshotForRangeInTransaction(savepoint, {
        organizationId: claim.organizationId,
        patientId: claim.patientId,
        from: day(claim.serviceFrom),
        to: day(claim.serviceTo),
        coverageKind: "medicaid",
      }),
  );
  if (!snapshotRead.ok) {
    return {
      payerResponsibility: { status: "unresolved", reasonCode: "coverage_snapshot_unavailable" },
      hasConcurrentMedicareAndMedicaidCoverage: false,
      primaryPayerCoverageId: null,
    };
  }
  const snapshot = snapshotRead.value;

  const patientLifecycleIssue = patientLifecycleServiceRangeIssue(
    snapshot.patientLifecycle,
    day(claim.serviceTo),
  );
  if (patientLifecycleIssue) {
    return {
      payerResponsibility: {
        status: "blocked",
        reasonCode: patientLifecycleIssue.code,
      },
      hasConcurrentMedicareAndMedicaidCoverage: false,
      primaryPayerCoverageId: null,
    };
  }

  const medicaid = snapshot.resolution;
  const primary = snapshot.primaryResolution;
  if (medicaid.status !== "uniform" || primary.status !== "uniform") {
    return {
      payerResponsibility: { status: "unresolved", reasonCode: "coverage_not_uniform" },
      hasConcurrentMedicareAndMedicaidCoverage: false,
      primaryPayerCoverageId: null,
    };
  }

  const hasConcurrentMedicareAndMedicaidCoverage =
    medicaid.coverage.coverageKind === "medicaid" &&
    medicaid.coverage.rank === 2 &&
    primary.coverage.coverageKind === "medicare_ffs" &&
    primary.coverage.rank === 1;
  if (medicaid.coverage.id !== claim.patientPayerId) {
    return {
      payerResponsibility: { status: "blocked", reasonCode: "selected_medicaid_coverage_changed" },
      hasConcurrentMedicareAndMedicaidCoverage,
      primaryPayerCoverageId: primary.coverage.id,
    };
  }

  if (!deps.admissions) {
    return {
      payerResponsibility: { status: "unresolved", reasonCode: "admission_reader_unbound" },
      hasConcurrentMedicareAndMedicaidCoverage,
      primaryPayerCoverageId: primary.coverage.id,
    };
  }
  const admissions = deps.admissions;
  const admissionRead = await readInSavepoint(
    tx,
    "m24.claim_revalidate.admission_snapshot_unavailable",
    (savepoint) =>
      admissions.cadenceSnapshotInTransaction(savepoint, claim.organizationId, claim.admissionId),
  );
  if (!admissionRead.ok) {
    return {
      payerResponsibility: { status: "unresolved", reasonCode: "admission_snapshot_unavailable" },
      hasConcurrentMedicareAndMedicaidCoverage,
      primaryPayerCoverageId: primary.coverage.id,
    };
  }
  const admission = admissionRead.value;
  if (
    !admission ||
    admission.patientId !== claim.patientId ||
    admission.providerEntityId !== claim.providerEntityId
  ) {
    return {
      payerResponsibility: { status: "blocked", reasonCode: "admission_identity_unverified" },
      hasConcurrentMedicareAndMedicaidCoverage,
      primaryPayerCoverageId: primary.coverage.id,
    };
  }
  const admissionIssue = admissionServiceRangeIssue(admission, day(claim.serviceTo));
  if (admissionIssue) {
    return {
      payerResponsibility: { status: "blocked", reasonCode: admissionIssue.code },
      hasConcurrentMedicareAndMedicaidCoverage,
      primaryPayerCoverageId: primary.coverage.id,
    };
  }

  const decision = evaluateMedicaidPayerResponsibility({
    claimKind: claim.kind,
    medicaidCoverageId: medicaid.coverage.id,
    medicaidRank: medicaid.coverage.rank,
    primaryCoverageId: primary.coverage.id,
    primaryCoverageKind: primary.coverage.coverageKind,
    primaryRank: primary.coverage.rank,
  });
  return {
    payerResponsibility: decision.allowed
      ? { status: "permitted", reasonCode: null }
      : { status: "blocked", reasonCode: decision.reason },
    hasConcurrentMedicareAndMedicaidCoverage,
    primaryPayerCoverageId: primary.coverage.id,
    inclusiveEndDate: inclusiveLocEndDateForAdmission(admission),
    admissionVersion: admission.version,
  };
}

async function verifyHospiceClaimSnapshot(
  tx: Tx,
  deps: RevalidateWorkerDeps,
  claim: typeof schema.medicaidClaim.$inferSelect,
  lines: readonly (typeof schema.medicaidClaimLine.$inferSelect)[],
  inclusiveEndDate: string | null,
): Promise<{ readonly verified: boolean; readonly periods: readonly CurrentLocPeriodForClaim[] }> {
  if (claim.kind === "rb_only") return { verified: true, periods: [] };
  const readPeriods = deps.admissions?.periodsForAdmissionInTransaction;
  if (!readPeriods) return { verified: false, periods: [] };
  const periodsRead = await readInSavepoint(
    tx,
    "m24.claim_revalidate.loc_periods_unavailable",
    (savepoint) => readPeriods(savepoint, claim.organizationId, claim.admissionId),
  );
  if (!periodsRead.ok) return { verified: false, periods: [] };
  const periods = periodsRead.value;
  return {
    verified:
      hospiceClaimLineSnapshotIssue({
        lines,
        periods,
        organizationId: claim.organizationId,
        providerEntityId: claim.providerEntityId,
        claimId: claim.id,
        serviceFrom: day(claim.serviceFrom),
        serviceTo: day(claim.serviceTo),
        inclusiveEndDate,
      }) === null,
    periods,
  };
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

  // The pricing verification below takes a rate-policy lock per claim and holds it to the end of this
  // transaction. Take all of them first, in one fixed order, so two workers whose claims touch the same payers
  // in opposite order cannot deadlock (the evidence locks are per patient, so they cannot cross workers).
  if (deps.canonicalPayerReader?.medicaidProgramClassifications) {
    await lockMedicaidRatePolicyScopes(
      tx,
      claims.flatMap((claim) =>
        claim.kind !== "rb_only" &&
        claim.canonicalPayerId &&
        claim.medicaidProgramKind === "managed_care"
          ? [
              {
                organizationId: claim.organizationId,
                providerEntityId: claim.providerEntityId,
                canonicalPayerId: claim.canonicalPayerId,
                serviceState: claim.serviceState,
              },
            ]
          : [],
      ),
    );
  }

  for (const claim of claims) {
    const lineRows = await tx
      .select()
      .from(L)
      .where(eq(L.medicaidClaimId, claim.id))
      .orderBy(L.lineNumber);

    // Other optional readers remain unbound in this worker, but payer responsibility is mandatory and
    // comes from the same transaction-bound M5 interval snapshot used by claim assembly.
    const resolvedPayer = await resolvePayerContext(tx, deps, claim);
    const hospiceSnapshot = await verifyHospiceClaimSnapshot(
      tx,
      deps,
      claim,
      lineRows,
      resolvedPayer.inclusiveEndDate ?? null,
    );
    let hospicePricingSnapshotVerified = claim.kind === "rb_only";
    let hospiceInstitutionalFormatQualified = claim.kind === "rb_only";
    if (
      claim.kind !== "rb_only" &&
      claim.canonicalPayerId &&
      claim.medicaidProgramKind === "managed_care" &&
      deps.canonicalPayerReader?.medicaidProgramClassifications
    ) {
      const { resolvePayer, medicaidProgramClassifications } = deps.canonicalPayerReader;
      const canonicalPayerId = claim.canonicalPayerId;
      // One claim's pricing verification runs in a savepoint: a refusal or a deterministic defect in this
      // claim marks only this claim unverified (it then fails the snapshot rule and is visible to the operator),
      // instead of rolling back every claim of the patient and parking the job after its retries. A connection
      // or deadlock error is rethrown, so the job retries.
      const pricing = await readInSavepoint(
        tx,
        "m24.claim_revalidate.pricing_snapshot_unverified",
        async (savepoint) => {
          const assessedAt = now.toISOString();
          const rateRows = await readMedicaidRatePolicyLineage(savepoint, {
            organizationId: claim.organizationId,
            providerEntityId: claim.providerEntityId,
            canonicalPayerId,
            programKind: "managed_care",
            serviceState: claim.serviceState,
            serviceTo: day(claim.serviceTo),
            assessedAt,
          });
          return verifyStoredRhcPricingSnapshots({
            tx: savepoint,
            claim,
            lines: lineRows,
            locPeriods: hospiceSnapshot.periods,
            admissionVersion: resolvedPayer.admissionVersion,
            inclusiveEndDate: resolvedPayer.inclusiveEndDate ?? null,
            rateRows,
            payerReader: { resolvePayer, medicaidProgramClassifications },
            residenceReader:
              deps.patientAddresses?.residencesBetweenInTransaction !== undefined
                ? {
                    residencesBetweenInTransaction: (...args) =>
                      deps.patientAddresses!.residencesBetweenInTransaction!(...args),
                  }
                : undefined,
            assessedAt,
          });
        },
      );
      hospicePricingSnapshotVerified = pricing.ok && pricing.value.pricingSnapshotVerified;
      hospiceInstitutionalFormatQualified =
        pricing.ok && pricing.value.institutionalFormatQualified;
    }
    const ctx: MedicaidValidationContext = {
      orgId: job.organizationId,
      asOfDate: day(claim.serviceFrom),
      serviceState: claim.serviceState,
      claim: {
        claimId: claim.id,
        providerEntityId: claim.providerEntityId,
        patientId: claim.patientId,
        admissionId: claim.admissionId,
        serviceState: claim.serviceState,
        kind: claim.kind,
        tob: claim.tob as MedicaidValidationContext["claim"]["tob"],
        serviceFrom: day(claim.serviceFrom),
        serviceTo: day(claim.serviceTo),
        replacesClaimId: claim.replacesClaimId ?? null,
        medicareClaimId: claim.medicareClaimId ?? null,
        primaryPayerCoverageId: resolvedPayer.primaryPayerCoverageId,
        rbArrangementId: claim.rbArrangementId ?? null,
        hasConcurrentMedicareAndMedicaidCoverage:
          resolvedPayer.hasConcurrentMedicareAndMedicaidCoverage,
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
      // The asynchronous revalidation worker does not load billed R&B day ownership and current M6 LOC facts.
      // The platform-required rule therefore keeps R&B claims out of READY until an authorized validation route
      // performs those transaction-bound checks.
      rbClaimSnapshotVerified: false,
      hospiceClaimSnapshotVerified: hospiceSnapshot.verified,
      hospicePricingSnapshotVerified,
      hospiceInstitutionalFormatQualified,
      rateLookups: [],
      payerResponsibility: resolvedPayer.payerResponsibility,
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
