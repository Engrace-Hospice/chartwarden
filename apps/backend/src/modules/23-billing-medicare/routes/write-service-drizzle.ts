// apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts — the Drizzle-backed
// M23WriteRouteService (§4.1 mutating surface: claim assemble / update-draft / delete-draft / validate /
// submit / replace / void, validation override, rule-config CRUD, NOE/NOTR submit + cancel, eligibility
// check, sequestration forward-date, MAC-credential upsert).
//
// Implements the {@link M23WriteRouteService} interface, but every method runs inside ONE
// `withOrgContext(db, {organizationId, userId}, …)` transaction on the PRIMARY so Postgres RLS scopes each
// statement to `app.org_id` (the M27 routes/write-service-drizzle precedent). Org/actor/owner binding is
// ALWAYS the server-assembled {@link M23WriteActor} (never the body). The lifecycle methods do NOT
// re-implement state logic — they drive the pure @chartwarden/billing machines (`claim` reducer + `noeMachine` /
// `notrMachine`) and persist the result with the §2.5 version check (`transitionToState` →
// VERSION_CONFLICT → 412). The §4.10 `m23.*` events are emitted through the injected {@link WriteOutboxPort}
// in the SAME unit of work as the mutation (transactional outbox, D2); the §4.8 worker jobs through the
// injected {@link JobEnqueuePort}. M23 carries NO PHI and NEVER the MBI digit (D13 / §3.6 / §8.7); money is
// INTEGER CENTS (D8).
//
// OUTBOX-ONLY MAC POSTURE (D2): `submitClaim` / `submitNoe` / `submitNotr` do NOT transition the record to
// SUBMITTED here — they append the `claim_submission` attempt, enqueue the worker, and emit the
// `*_requested` outbox row; the §4.8 worker performs the X12 generation + MAC-portal upload and emits the
// terminal `submitted`/`accepted`/`rejected` (the X12 client is called behind a fail-closed bind). Likewise
// `replaceClaim` / `voidClaim` assemble the NEW TOB-817/818 claim; the ORIGINAL transitions to
// REPLACED/VOIDED only when the 277CA acceptance arrives (the ack consumer/worker), never at this surface.
//
// IMPORT BOUNDARY (M23 dependsOn = [6,8,22,38,40], NOT M1): the `@chartwarden/db` ROOT barrel is forbidden; the
// universal `@chartwarden/db/schema` leaf supplies the `claim_line` / `claim` table objects the internal-write
// re-assembly delete needs, and `withOrgContext` comes from the always-importable `@chartwarden/tenancy`
// foundation. AI-BLOCK (D13): no `@chartwarden/ai-platform` import here; the per-route `actor_kind='ai_*'` reject
// is composed at the route (see ./actor `rejectAiActor`).
import { randomUUID } from "node:crypto";
import {
  type ClaimState,
  type ClaimTransitionEvent,
  canonicalRuleKey,
  reduce as claimReduce,
  deriveControlNumber,
  noeMachine,
  notrMachine,
  repositories,
} from "@chartwarden/billing";
import * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, ConflictError, DegradedError, NotFoundError } from "@chartwarden/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { M23_QUEUES } from "../jobs/queues";
import { buildNoticeCorrectionService } from "../services/notice-correction-service";
import {
  PriorElectionNotClosedError,
  priorElectionClosureTx,
} from "../services/prior-election-closure";
import type { M23WriteActor } from "./actor";
import { mapNoe, mapNotr } from "./notice-views";
import type {
  ClaimDetailView,
  ClaimSummaryView,
  MacCredentialView,
  NoeView,
  NotrView,
  RuleConfigView,
  ValidationOverrideView,
} from "./read-service";
import { claimDischargeCodesView, perDiemClassPricingView } from "./read-service";
import type {
  AssembleClaimArgs,
  AssembledClaimLineInput,
  AuditEventPort,
  CancelNoeArgs,
  CancelNotrArgs,
  CheckEligibilityArgs,
  ClaimSubmissionAcceptedView,
  CorrectNoticeArgs,
  CreateRuleConfigArgs,
  DeleteRuleConfigArgs,
  EligibilityCheckAcceptedView,
  JobEnqueuePort,
  M23WriteRouteService,
  M23WriteServicePorts,
  MacCredentialTestView,
  NoticeSubmissionAcceptedView,
  OverrideValidationResultArgs,
  ProviderCcnPort,
  ReplaceClaimArgs,
  SecretCipherPort,
  UpdateDraftClaimArgs,
  UpdateRuleConfigArgs,
  UpsertMacCredentialArgs,
  ValidationJobAcceptedView,
  VoidClaimArgs,
} from "./write-service";

type BillingDb = repositories.BillingDb;

const REASON_FLOOR = 40;

// ── projections (mirror the read-service mappers; kept local so write returns the same DTOs) ────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

function mapClaimSummary(row: repositories.ClaimRecord): ClaimSummaryView {
  return {
    claimId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    tob: row.tob,
    state: row.state,
    serviceFrom: row.serviceFrom,
    serviceTo: row.serviceTo,
    claimControlNumber: row.claimControlNumber,
    payerClaimControlNumber: row.payerClaimControlNumber ?? null,
    macJurisdiction: row.macJurisdiction,
    totalChargeCents: row.totalChargeCents,
    totalExpectedPaymentCents: row.totalExpectedPaymentCents,
    version: row.version,
  };
}

function mapOverride(row: schema.ValidationOverride): ValidationOverrideView {
  return {
    overrideId: row.id,
    resultId: row.resultId,
    overrideMembershipId: row.overrideMembershipId,
    overrideRoleApplied: row.overrideRoleApplied,
    reason: row.reason,
    appliedAt: isoReq(row.appliedAt),
  };
}

function mapRuleConfig(row: schema.ValidationRuleConfig): RuleConfigView {
  return {
    ruleConfigId: row.id,
    organizationId: row.organizationId,
    ruleKey: canonicalRuleKey(row.ruleKey),
    ruleVersion: row.ruleVersion,
    isCustom: row.isCustom,
    enabled: row.enabled,
    severity: row.severity,
    overrideRoleRequired: row.overrideRoleRequired,
    parameters: (row.parameters ?? {}) as Readonly<Record<string, unknown>>,
    regulatoryRequiredSnapshot: row.regulatoryRequiredSnapshot,
    predicateDsl: row.predicateDsl ?? null,
    setByMembershipId: row.setByMembershipId,
    setReason: row.setReason ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

function mapMacCredential(row: repositories.MacSubmitterCredentialSafeRecord): MacCredentialView {
  return {
    credentialId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    macJurisdiction: row.macJurisdiction,
    submitterId: row.submitterId,
    tradingPartnerId: row.tradingPartnerId,
    clientId: row.clientId,
    hasSecret: true,
    baaRecordRef: row.baaRecordRef ?? null,
    credentialExpiresAt: iso(row.credentialExpiresAt),
    lastSandboxTestAt: iso(row.lastSandboxTestAt),
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

/** Map the assembled-line args to the internal-write-only `claim_line` insert input (LOC stays domain-cased). */
function mapLines(
  lines: readonly AssembledClaimLineInput[],
  organizationId: string,
  claimId: string,
): repositories.NewClaimLineInput[] {
  return lines.map((l) => ({
    organizationId,
    claimId,
    lineNumber: l.lineNumber,
    revenueCode: l.revenueCode as schema.NewClaimLine["revenueCode"],
    qCode: l.qCode as schema.NewClaimLine["qCode"],
    levelOfCare: l.levelOfCare,
    hcpcsCode: l.hcpcsCode ?? null,
    serviceDateFrom: l.serviceDateFrom,
    serviceDateTo: l.serviceDateTo,
    unitCount: l.unitCount,
    unitRateCents: l.unitRateCents,
    lineChargeCents: l.lineChargeCents,
    levelOfCarePeriodId: l.levelOfCarePeriodId,
    modifiers: [...(l.modifiers ?? [])] as schema.NewClaimLine["modifiers"],
    icdPointerPositions: [
      ...(l.icdPointerPositions ?? []),
    ] as schema.NewClaimLine["icdPointerPositions"],
    backingEncounterIds: [
      ...(l.backingEncounterIds ?? []),
    ] as schema.NewClaimLine["backingEncounterIds"],
  }));
}

const sumCharges = (lines: readonly AssembledClaimLineInput[]): number =>
  lines.reduce((acc, l) => acc + l.lineChargeCents, 0);

/**
 * Delete a DRAFT claim and everything it owns, children first so each database delete guard (migration 1061) can still
 * resolve the owning claim: override -> result -> run -> state history -> SIA -> HIPPS -> lines -> claim. The database,
 * not this function, is what refuses a non-draft claim (`M23_CLAIM_NOT_DRAFT`); every statement is org-scoped here and by RLS.
 */
async function deleteDraftClaimSubtree(
  tx: BillingDb,
  organizationId: string,
  claimId: string,
): Promise<void> {
  const runIds = tx
    .select({ id: schema.validationRun.id })
    .from(schema.validationRun)
    .where(
      and(
        eq(schema.validationRun.claimId, claimId),
        eq(schema.validationRun.organizationId, organizationId),
      ),
    );
  const resultIds = tx
    .select({ id: schema.validationResult.id })
    .from(schema.validationResult)
    .where(
      and(
        inArray(schema.validationResult.validationRunId, runIds),
        eq(schema.validationResult.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.validationOverride)
    .where(
      and(
        inArray(schema.validationOverride.resultId, resultIds),
        eq(schema.validationOverride.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.validationResult)
    .where(
      and(
        inArray(schema.validationResult.validationRunId, runIds),
        eq(schema.validationResult.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.validationRun)
    .where(
      and(
        eq(schema.validationRun.claimId, claimId),
        eq(schema.validationRun.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.claimStateHistory)
    .where(
      and(
        eq(schema.claimStateHistory.claimId, claimId),
        eq(schema.claimStateHistory.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.siaCalculation)
    .where(
      and(
        eq(schema.siaCalculation.claimId, claimId),
        eq(schema.siaCalculation.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.perDiemRateCalculation)
    .where(
      and(
        eq(schema.perDiemRateCalculation.claimId, claimId),
        eq(schema.perDiemRateCalculation.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.claimLine)
    .where(
      and(
        eq(schema.claimLine.claimId, claimId),
        eq(schema.claimLine.organizationId, organizationId),
      ),
    );
  await tx
    .delete(schema.claim)
    .where(and(eq(schema.claim.id, claimId), eq(schema.claim.organizationId, organizationId)));
}

const PG_UNIQUE_VIOLATION = "23505";

/** True when `err` (or its driver cause) is a Postgres unique-index violation. */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;
  return (
    code(err) === PG_UNIQUE_VIOLATION ||
    code((err as { cause?: unknown } | null)?.cause) === PG_UNIQUE_VIOLATION
  );
}

/** Run `fn`; a lost first-create race (unique violation) becomes a typed 409, never a 500. */
const mapUniqueViolation =
  (message: string) =>
  async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(message);
      throw err;
    }
  };

// ── the factory ────────────────────────────────────────────────────────────────────────────────────

const denyCcn: ProviderCcnPort = {
  ccnForProviderEntity: async () => {
    throw new ChartWardenError(
      "SEAM_UNBOUND",
      "the provider-entity CCN resolver is not bound",
      503,
    );
  },
};
const denyCipher: SecretCipherPort = {
  encrypt: async () => {
    throw new ChartWardenError(
      "SEAM_UNBOUND",
      "the MAC credential secret cipher is not bound (set M24_CREDENTIAL_ENCRYPTION_KEY, 32 bytes base64)",
      503,
    );
  },
};
const denyAudit: AuditEventPort = {
  recordOverrideAudit: async () => {
    throw new ChartWardenError("SEAM_UNBOUND", "the override audit port is not bound", 503);
  },
};

/** Phase-0 containment: no M23 job may be accepted until its worker's external ports are live. */
export function buildRefusingM23JobEnqueue(): JobEnqueuePort {
  return {
    async enqueue(queueName) {
      throw new ChartWardenError(
        "SEAM_UNBOUND",
        `billing worker capability '${queueName}' is not available`,
        503,
      );
    },
  };
}

/**
 * Build the Drizzle-backed {@link M23WriteRouteService}. `db` is the PRIMARY (RLS-enforced) client; every
 * method opens the actor's own `withOrgContext` transaction so Postgres scopes to `app.org_id`.
 */
export function buildDrizzleM23WriteService(
  db: BillingDb,
  ports: M23WriteServicePorts = {},
): M23WriteRouteService {
  const now = ports.now ?? (() => new Date());
  const jobs: JobEnqueuePort = ports.jobs ?? buildRefusingM23JobEnqueue();
  const providerCcn = ports.providerCcn ?? denyCcn;
  const secretCipher = ports.secretCipher ?? denyCipher;
  const auditPort = ports.audit ?? denyAudit;

  const inOrgCtx = <T>(actor: M23WriteActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  /** Emit a §4.10 `m23.*` event on the CALLER'S tx (commits in the same unit of work as the mutation). */
  const emit = async (
    tx: BillingDb,
    input: {
      eventName: string;
      payload: Record<string, unknown>;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
    },
  ): Promise<void> => {
    if (ports.outbox) await ports.outbox.publish(tx, input);
  };

  // Corrected NOE / NOTR after a rejection — its own service (one transaction each, RLS-scoped).
  const corrections = buildNoticeCorrectionService(db, {
    outbox: ports.outbox,
    ccnFor: (tx, organizationId, providerEntityId) =>
      providerCcn.ccnForProviderEntity(tx, organizationId, providerEntityId),
    now,
  });

  /** The NOE's patient's latest earlier live-ended stay (`null` = none, an unknown NOE, or the port unbound). */
  const priorLiveEndedStayFor = async (
    actor: M23WriteActor,
    noeId: string,
  ): Promise<{ admissionId: string; patientId: string } | null> => {
    const port = ports.priorLiveEndedStay;
    if (!port) return null;
    const noe = await inOrgCtx(actor, (tx) => new repositories.NoeRepository(tx).findById(noeId));
    if (!noe || noe.organizationId !== actor.organizationId) return null;
    const prior = await port.latestPriorLiveEndedAdmission(actor.organizationId, {
      patientId: noe.patientId,
      currentAdmissionId: noe.admissionId,
    });
    return prior ? { admissionId: prior.admissionId, patientId: noe.patientId } : null;
  };

  /** §6 / §D14 server-side step-up gate (claim submit/replace/void · override · MAC-credential admin). */
  const requireStepUp = (actor: M23WriteActor): void => {
    if (!actor.stepUpRecent) {
      throw new ChartWardenError(
        "STEP_UP_REQUIRED",
        "this action requires a recent step-up re-authentication",
        403,
      );
    }
  };

  const requireReason = (reason: string): void => {
    if (reason.trim().length < REASON_FLOOR) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        `a reason of at least ${REASON_FLOOR} characters is required`,
        422,
      );
    }
  };

  const conflict412 = (currentVersion: number | null): ChartWardenError =>
    new ChartWardenError(
      "VERSION_CONFLICT",
      `the record was modified concurrently (current version ${currentVersion ?? "unknown"})`,
      412,
    );

  /** Map a pure-reducer rejection to the structured response envelope. */
  const reduceError = (error: string, event: string): ChartWardenError =>
    error === "GUARD_FAILED"
      ? new ChartWardenError("GUARD_FAILED", `the '${event}' transition guard failed`, 422)
      : new ConflictError(`cannot '${event}' a record in its current state`);

  /**
   * Take the claim row's write lock before reading its state, so a concurrent transition (e.g. DRAFT -> VALIDATING)
   * either finishes first (we then see the new state and refuse) or waits for us. The database guards re-check too.
   */
  const lockClaim = async (tx: BillingDb, actor: M23WriteActor, claimId: string): Promise<void> => {
    await tx.execute(
      sql`SELECT 1 FROM claim WHERE id = ${claimId} AND organization_id = ${actor.organizationId} FOR UPDATE`,
    );
  };

  const loadClaim = async (
    tx: BillingDb,
    actor: M23WriteActor,
    claimId: string,
  ): Promise<repositories.ClaimRecord> => {
    const row = await new repositories.ClaimRepository(tx).findById(claimId);
    if (!row || row.organizationId !== actor.organizationId) throw new NotFoundError("claim");
    return row;
  };

  /** The unresolved BLOCKING (error-severity, un-overridden) failures of the latest validation run (§2.3). */
  const unresolvedBlockingFailures = async (tx: BillingDb, claimId: string): Promise<number> => {
    const run = await new repositories.ValidationRunRepository(tx).findLatestForClaim(claimId);
    if (!run) return Number.POSITIVE_INFINITY; // never validated → cannot be READY-clean
    const failures = await new repositories.ValidationResultRepository(tx).listFailuresForRun(
      run.id,
    );
    if (failures.length === 0) return 0;
    const overrides = await new repositories.ValidationOverrideRepository(tx).listByResultIds(
      failures.map((f) => f.id),
    );
    const overridden = new Set(overrides.map((o) => o.resultId));
    return failures.filter((f) => f.severity === "error" && !overridden.has(f.id)).length;
  };

  /** Assemble the §4.1 claim detail view (summary + latest validation + HIPPS/SIA pricing). */
  const buildClaimDetail = async (
    tx: BillingDb,
    claim: repositories.ClaimRecord,
  ): Promise<ClaimDetailView> => {
    const latestRun = await new repositories.ValidationRunRepository(tx).findLatestForClaim(
      claim.id,
    );
    const perDiemClass = await new repositories.PerDiemRateCalculationRepository(tx).findByClaim(
      claim.id,
    );
    const sia = await new repositories.SiaCalculationRepository(tx).findByClaim(claim.id);
    return {
      ...mapClaimSummary(claim),
      electionPeriodIdFrom: claim.electionPeriodIdFrom,
      electionPeriodIdTo: claim.electionPeriodIdTo,
      patientPayerId: claim.patientPayerId,
      sequestrationAppliedPct: claim.sequestrationAppliedPct,
      sequestrationPolicyId: claim.sequestrationPolicyId,
      replacesClaimId: claim.replacesClaimId ?? null,
      replacedByClaimId: claim.replacedByClaimId ?? null,
      replacementReason: claim.replacementReason ?? null,
      latestValidationRunId: claim.latestValidationRunId ?? null,
      latestSubmissionId: claim.latestSubmissionId ?? null,
      acknowledgmentDocumentId: claim.acknowledgmentDocumentId ?? null,
      dischargeCodes: claimDischargeCodesView(claim),
      latestValidation: latestRun
        ? {
            validationRunId: latestRun.id,
            claimId: latestRun.claimId,
            trigger: latestRun.trigger,
            outcome: latestRun.outcome,
            rulesExecuted: latestRun.rulesExecuted,
            rulesPassed: latestRun.rulesPassed,
            rulesFailed: latestRun.rulesFailed,
            rulesWarn: latestRun.rulesWarn,
            rulesInfo: latestRun.rulesInfo,
            startedAt: isoReq(latestRun.startedAt),
            completedAt: isoReq(latestRun.completedAt),
            durationMs: latestRun.durationMs,
            initiatedByMembershipId: latestRun.initiatedByMembershipId ?? null,
          }
        : null,
      pricing: {
        perDiemClass: perDiemClass
          ? perDiemClassPricingView(perDiemClass, { admissionId: claim.admissionId })
          : null,
        sia: sia
          ? {
              windowStart: sia.windowStart,
              totalQualifyingMinutes: sia.totalQualifyingMinutes,
              siaAddOnCents: sia.siaAddOnCents,
              calculatedAt: isoReq(sia.calculatedAt),
            }
          : null,
      },
      createdAt: isoReq(claim.createdAt),
      updatedAt: isoReq(claim.updatedAt),
    };
  };

  /** Shared claim-assembly persistence (used by assemble / replace / void). Returns the created record. */
  const persistAssembledClaim = async (
    tx: BillingDb,
    actor: M23WriteActor,
    input: {
      providerEntityId: string;
      patientId: string;
      admissionId: string;
      electionPeriodIdFrom: string;
      electionPeriodIdTo: string;
      patientPayerId: string;
      tob: schema.NewClaim["tob"];
      serviceFrom: string;
      serviceTo: string;
      macJurisdiction: string;
      lines: readonly AssembledClaimLineInput[];
      totalChargeCents?: number;
      totalExpectedPaymentCents?: number;
      replacesClaimId?: string;
      replacementReason?: string;
    },
  ): Promise<repositories.ClaimRecord> => {
    const claimId = randomUUID();
    const ccn = await providerCcn.ccnForProviderEntity(
      tx,
      actor.organizationId,
      input.providerEntityId,
    );
    let claimControlNumber: string;
    try {
      claimControlNumber = deriveControlNumber({
        ccn,
        serviceFrom: input.serviceFrom,
        claimId,
        attemptIndex: 0,
      });
    } catch (e) {
      throw new ChartWardenError("VALIDATION_FAILED", (e as Error).message, 422);
    }
    const seq = await new repositories.SequestrationPolicyRepository(tx).findEffectiveOn(
      input.providerEntityId,
      input.serviceFrom,
    );
    if (!seq) {
      throw new ConflictError(
        "no sequestration policy is in effect for the claim service-from date",
      );
    }
    const totalCharge = input.totalChargeCents ?? sumCharges(input.lines);
    const claim = await new repositories.ClaimRepository(tx).create({
      id: claimId,
      organizationId: actor.organizationId,
      providerEntityId: input.providerEntityId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      electionPeriodIdFrom: input.electionPeriodIdFrom,
      electionPeriodIdTo: input.electionPeriodIdTo,
      patientPayerId: input.patientPayerId,
      tob: input.tob,
      serviceFrom: input.serviceFrom,
      serviceTo: input.serviceTo,
      macJurisdiction: input.macJurisdiction as schema.NewClaim["macJurisdiction"],
      claimControlNumber,
      totalChargeCents: totalCharge,
      totalExpectedPaymentCents: input.totalExpectedPaymentCents ?? totalCharge,
      sequestrationAppliedPct: seq.percentage,
      sequestrationPolicyId: seq.id,
      createdByMembershipId: actor.membershipId,
      ...(input.replacesClaimId ? { replacesClaimId: input.replacesClaimId } : {}),
      ...(input.replacementReason ? { replacementReason: input.replacementReason } : {}),
    });
    if (input.lines.length > 0) {
      await new repositories.ClaimLineRepository(tx).insertBatch(
        mapLines(input.lines, actor.organizationId, claim.id),
      );
    }
    await emit(tx, {
      eventName: "m23.claim.draft_created",
      organizationId: actor.organizationId,
      aggregateKind: "claim",
      aggregateId: claim.id,
      payload: {
        claimId: claim.id,
        providerEntityId: claim.providerEntityId,
        patientId: claim.patientId,
        admissionId: claim.admissionId,
        tob: claim.tob,
        serviceFrom: claim.serviceFrom,
        serviceTo: claim.serviceTo,
      },
    });
    return claim;
  };

  return {
    // ── claim assembly + lifecycle ──
    async assembleClaim(actor, args: AssembleClaimArgs): Promise<ClaimDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const claim = await persistAssembledClaim(tx, actor, { ...args });
        return buildClaimDetail(tx, claim);
      });
    },

    async updateDraftClaim(actor, claimId, args: UpdateDraftClaimArgs): Promise<ClaimDetailView> {
      return inOrgCtx(actor, async (tx) => {
        await lockClaim(tx, actor, claimId);
        const claim = await loadClaim(tx, actor, claimId);
        if (claim.state !== "draft") {
          throw new ConflictError("only a draft claim can be edited");
        }
        // Internal-write-only re-assembly: replace the line set wholesale (the assembly service owns the
        // delete; there is no external line-mutation route). RLS already scopes; the org clause is belt.
        await tx
          .delete(schema.claimLine)
          .where(
            and(
              eq(schema.claimLine.claimId, claimId),
              eq(schema.claimLine.organizationId, actor.organizationId),
            ),
          );
        if (args.lines.length > 0) {
          await new repositories.ClaimLineRepository(tx).insertBatch(
            mapLines(args.lines, actor.organizationId, claimId),
          );
        }
        const totalCharge = args.totalChargeCents ?? sumCharges(args.lines);
        // Same-state versioned patch of the claim aggregates (no lifecycle hop; §2.5 If-Match enforced).
        const res = await new repositories.ClaimRepository(tx).transitionToState(
          claim.id,
          args.expectedVersion,
          "draft",
          {
            totalChargeCents: totalCharge,
            totalExpectedPaymentCents: args.totalExpectedPaymentCents ?? totalCharge,
          },
        );
        if (!res.ok) throw conflict412(res.currentVersion);
        return buildClaimDetail(tx, res.row);
      });
    },

    async deleteDraftClaim(actor, claimId): Promise<void> {
      return inOrgCtx(actor, async (tx) => {
        await lockClaim(tx, actor, claimId);
        const claim = await loadClaim(tx, actor, claimId);
        if (claim.state !== "draft") {
          throw new ConflictError("only a draft claim can be deleted");
        }
        // L1: M23 never writes `replaced_by_claim_id` on the original (it moves to REPLACED only when the 277CA accepts the
        // replacement, in the ack consumer), so deleting a DRAFT replacement leaves no dangling pointer to clear.
        // Defence in depth with the database guard: a claim that was ever transmitted or acknowledged is never deletable.
        const transmitted = await tx
          .select({ id: schema.claimSubmission.id })
          .from(schema.claimSubmission)
          .where(eq(schema.claimSubmission.claimId, claimId))
          .limit(1);
        const acknowledged = await tx
          .select({ id: schema.claimAcknowledgment.id })
          .from(schema.claimAcknowledgment)
          .where(eq(schema.claimAcknowledgment.claimId, claimId))
          .limit(1);
        if (transmitted.length > 0 || acknowledged.length > 0) {
          throw new ConflictError(
            "a claim that has been transmitted or acknowledged cannot be deleted",
          );
        }
        await deleteDraftClaimSubtree(tx, actor.organizationId, claimId);
      });
    },

    async validateClaim(actor, claimId): Promise<ValidationJobAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId);
        let event: ClaimTransitionEvent;
        let trigger: schema.NewValidationRun["trigger"];
        if (claim.state === "draft") {
          event = "begin_validation";
          trigger = "initial_assembly";
        } else if (claim.state === "ready" || claim.state === "validating") {
          event = "revalidate";
          trigger = "manual_re_run";
        } else {
          throw new ConflictError(`cannot validate a claim in state '${claim.state}'`);
        }
        const stepped = claimReduce(claim.state, event);
        if (stepped.error) throw reduceError(stepped.error, event);
        const validationRunId = randomUUID();
        const res = await new repositories.ClaimRepository(tx).transitionToState(
          claim.id,
          claim.version,
          stepped.state,
          { latestValidationRunId: validationRunId },
        );
        if (!res.ok) throw conflict412(res.currentVersion);
        await new repositories.ClaimStateHistoryRepository(tx).append({
          organizationId: actor.organizationId,
          claimId: claim.id,
          fromState: claim.state,
          toState: stepped.state,
          actorKind: actor.actorKind,
          actorMembershipId: actor.membershipId,
          validationRunId,
        });
        const { jobId } = await jobs.enqueue(
          M23_QUEUES.validationRun,
          `${actor.organizationId}:${claim.id}:${validationRunId}`,
          { claimId: claim.id, validationRunId, trigger },
        );
        await emit(tx, {
          eventName: "m23.claim.validation_started",
          organizationId: actor.organizationId,
          aggregateKind: "claim",
          aggregateId: claim.id,
          payload: { claimId: claim.id, validationRunId, trigger },
        });
        return { claimId: claim.id, validationRunId, jobId };
      });
    },

    async submitClaim(actor, claimId): Promise<ClaimSubmissionAcceptedView> {
      requireStepUp(actor);
      return inOrgCtx(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId);
        if (claim.state !== "ready") {
          throw new ConflictError("only a READY claim can be submitted");
        }
        const blocking = await unresolvedBlockingFailures(tx, claim.id);
        if (blocking > 0) {
          throw new ChartWardenError(
            "GUARD_FAILED",
            "the claim has unresolved blocking validation failures",
            422,
          );
        }
        const ccn = await providerCcn.ccnForProviderEntity(
          tx,
          actor.organizationId,
          claim.providerEntityId,
        );
        const subRepo = new repositories.ClaimSubmissionRepository(tx);
        const latest = await subRepo.findLatestForClaim(claim.id);
        const attemptIndex = latest ? latest.attemptIndex + 1 : 0;
        let claimControlNumber: string;
        try {
          claimControlNumber = deriveControlNumber({
            ccn,
            serviceFrom: claim.serviceFrom,
            claimId: claim.id,
            attemptIndex,
          });
        } catch (e) {
          throw new ChartWardenError("VALIDATION_FAILED", (e as Error).message, 422);
        }
        const submission = await subRepo.append({
          organizationId: actor.organizationId,
          providerEntityId: claim.providerEntityId,
          kind: "claim_837i",
          claimId: claim.id,
          claimControlNumber,
          attemptIndex,
          outcome: "queued",
        });
        const { jobId } = await jobs.enqueue(
          "claim.submit",
          `${actor.organizationId}:${claim.id}:${attemptIndex}`,
          { claimId: claim.id, submissionId: submission.id, claimControlNumber, attemptIndex },
        );
        // D2 outbox-only: the worker performs the upload + the READY→SUBMITTED transition + `m23.claim.submitted`.
        await emit(tx, {
          eventName: "m23.claim.submit_requested",
          organizationId: actor.organizationId,
          aggregateKind: "claim",
          aggregateId: claim.id,
          payload: {
            claimId: claim.id,
            submissionId: submission.id,
            claimControlNumber,
            attemptIndex,
          },
        });
        return { submissionId: submission.id, jobId, attemptIndex, claimControlNumber };
      });
    },

    async replaceClaim(actor, claimId, args: ReplaceClaimArgs): Promise<ClaimDetailView> {
      requireStepUp(actor);
      requireReason(args.reason);
      return inOrgCtx(actor, async (tx) => {
        const original = await loadClaim(tx, actor, claimId);
        if (!REPLACEABLE_STATES.has(original.state)) {
          throw new ConflictError(`a claim in state '${original.state}' cannot be replaced`);
        }
        const replacement = await persistAssembledClaim(tx, actor, {
          providerEntityId: original.providerEntityId,
          patientId: original.patientId,
          admissionId: original.admissionId,
          electionPeriodIdFrom: original.electionPeriodIdFrom,
          electionPeriodIdTo: original.electionPeriodIdTo,
          patientPayerId: original.patientPayerId,
          tob: "817",
          serviceFrom: original.serviceFrom,
          serviceTo: original.serviceTo,
          macJurisdiction: original.macJurisdiction,
          lines: args.lines,
          totalChargeCents: args.totalChargeCents,
          totalExpectedPaymentCents: args.totalExpectedPaymentCents,
          replacesClaimId: original.id,
          replacementReason: args.reason,
        });
        // The ORIGINAL transitions to REPLACED only when the 277CA accepts the replacement (the ack consumer).
        return buildClaimDetail(tx, replacement);
      });
    },

    async voidClaim(actor, claimId, args: VoidClaimArgs): Promise<ClaimDetailView> {
      requireStepUp(actor);
      requireReason(args.reason);
      return inOrgCtx(actor, async (tx) => {
        const original = await loadClaim(tx, actor, claimId);
        if (!REPLACEABLE_STATES.has(original.state)) {
          throw new ConflictError(`a claim in state '${original.state}' cannot be voided`);
        }
        const voidClaim = await persistAssembledClaim(tx, actor, {
          providerEntityId: original.providerEntityId,
          patientId: original.patientId,
          admissionId: original.admissionId,
          electionPeriodIdFrom: original.electionPeriodIdFrom,
          electionPeriodIdTo: original.electionPeriodIdTo,
          patientPayerId: original.patientPayerId,
          tob: "818",
          serviceFrom: original.serviceFrom,
          serviceTo: original.serviceTo,
          macJurisdiction: original.macJurisdiction,
          lines: args.lines ?? [],
          replacesClaimId: original.id,
          replacementReason: args.reason,
        });
        return buildClaimDetail(tx, voidClaim);
      });
    },

    // ── validation override ──
    async overrideValidationResult(
      actor,
      claimId,
      args: OverrideValidationResultArgs,
    ): Promise<ValidationOverrideView> {
      requireStepUp(actor);
      requireReason(args.reason);
      return inOrgCtx(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId);
        const result = await new repositories.ValidationResultRepository(tx).findById(
          args.validationResultId,
        );
        if (!result || result.organizationId !== actor.organizationId) {
          throw new NotFoundError("validation result");
        }
        const run = await new repositories.ValidationRunRepository(tx).findById(
          result.validationRunId,
        );
        if (!run || run.claimId !== claim.id) throw new NotFoundError("validation result");
        if (result.outcome !== "fail") {
          throw new ConflictError("only a failing validation result can be overridden");
        }
        const overrideRepo = new repositories.ValidationOverrideRepository(tx);
        if (await overrideRepo.findByResult(result.id)) {
          throw new ConflictError("this validation result has already been overridden");
        }
        // One correlation id for this override: the explicit audit event below AND the row-level M4 write-audit trigger on
        // validation_override (which reads the transaction-local `app.correlation_id`) must carry the same id, so a
        // surveyor can join them (and the request's logs). Prefer the request's id; fall back to a fresh one.
        const correlationId = actor.request?.correlationId ?? randomUUID();
        await tx.execute(sql`SELECT set_config('app.correlation_id', ${correlationId}, true)`);
        // Record the §4.5 prominent M4 audit event in the same tx (the @chartwarden/audit helper is the only
        // sanctioned writer of `audit_event`); its id is stamped onto the NOT-NULL override back-ref.
        const { auditEventId } = await auditPort.recordOverrideAudit(tx, {
          organizationId: actor.organizationId,
          actorMembershipId: actor.membershipId,
          claimId: claim.id,
          validationRunId: run.id,
          resultId: result.id,
          ruleKey: canonicalRuleKey(result.ruleKey),
          overrideRole: args.overrideRole,
          actorUserId: actor.userId,
          correlationId,
          ...(actor.request?.requestId ? { requestId: actor.request.requestId } : {}),
          ...(actor.request?.sourceIp ? { sourceIp: actor.request.sourceIp } : {}),
          ...(actor.request?.userAgent ? { userAgent: actor.request.userAgent } : {}),
          reason: args.reason,
        });
        const override = await overrideRepo.append({
          organizationId: actor.organizationId,
          resultId: result.id,
          overrideMembershipId: actor.membershipId,
          overrideRoleApplied: args.overrideRole,
          reason: args.reason,
          m4AuditEventId: auditEventId,
        });
        await emit(tx, {
          eventName: "m23.claim.override_applied",
          organizationId: actor.organizationId,
          aggregateKind: "validation_override",
          aggregateId: override.id,
          payload: {
            claimId: claim.id,
            validationRunId: run.id,
            resultId: result.id,
            overrideId: override.id,
            ruleKey: canonicalRuleKey(result.ruleKey),
            overrideRoleApplied: args.overrideRole,
          },
        });
        return mapOverride(override);
      });
    },

    // ── rule-config CRUD ──
    async createRuleConfig(actor, args: CreateRuleConfigArgs): Promise<RuleConfigView> {
      // A legacy (pre-1069) spelling can never be created: it would be an inert row the read side aliases away.
      if (canonicalRuleKey(args.ruleKey) !== args.ruleKey) {
        throw new ChartWardenError(
          "VALIDATION_FAILED",
          `rule key '${args.ruleKey}' is a legacy spelling; use '${canonicalRuleKey(args.ruleKey)}'`,
          400,
        );
      }
      return inOrgCtx(actor, async (tx) => {
        const row = await new repositories.ValidationRuleConfigRepository(tx).create({
          organizationId: actor.organizationId,
          ruleKey: args.ruleKey,
          ruleVersion: args.ruleVersion ?? 1,
          isCustom: args.isCustom ?? false,
          enabled: args.enabled ?? true,
          severity: args.severity,
          // A tenant overlay can NEVER be regulatory-required (D5); pinned false (the repo also fails closed).
          regulatoryRequiredSnapshot: false,
          parameters: (args.parameters ?? {}) as schema.NewValidationRuleConfig["parameters"],
          setByMembershipId: actor.membershipId,
          ...(args.overrideRoleRequired ? { overrideRoleRequired: args.overrideRoleRequired } : {}),
          ...(args.predicateDsl !== undefined
            ? { predicateDsl: args.predicateDsl as schema.NewValidationRuleConfig["predicateDsl"] }
            : {}),
          ...(args.setReason !== undefined ? { setReason: args.setReason } : {}),
        });
        return mapRuleConfig(row);
      });
    },

    async updateRuleConfig(
      actor,
      ruleConfigId,
      args: UpdateRuleConfigArgs,
    ): Promise<RuleConfigView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new repositories.ValidationRuleConfigRepository(tx);
        const existing = await repo.findById(ruleConfigId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("rule config");
        }
        const res = await repo.updateWithVersion(ruleConfigId, args.expectedVersion, {
          setByMembershipId: actor.membershipId,
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.severity !== undefined ? { severity: args.severity } : {}),
          ...(args.overrideRoleRequired !== undefined
            ? { overrideRoleRequired: args.overrideRoleRequired }
            : {}),
          ...(args.parameters !== undefined
            ? { parameters: args.parameters as schema.NewValidationRuleConfig["parameters"] }
            : {}),
          ...(args.predicateDsl !== undefined
            ? { predicateDsl: args.predicateDsl as schema.NewValidationRuleConfig["predicateDsl"] }
            : {}),
          ...(args.setReason !== undefined ? { setReason: args.setReason } : {}),
        });
        if (!res.ok) throw conflict412(res.currentVersion);
        return mapRuleConfig(res.row);
      });
    },

    async deleteRuleConfig(actor, ruleConfigId, args: DeleteRuleConfigArgs): Promise<void> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new repositories.ValidationRuleConfigRepository(tx);
        const existing = await repo.findById(ruleConfigId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("rule config");
        }
        const res = await repo.deleteWithVersion(ruleConfigId, args.expectedVersion);
        if (!res.ok) throw conflict412(res.currentVersion);
      });
    },

    // ── NOE / NOTR fast path ──
    async submitNoe(actor, noeId): Promise<NoticeSubmissionAcceptedView> {
      // Readmission — the prior election must be closed out first (the M6 lookup opens its own org context, so it
      // runs before this method's transaction rather than holding two connections).
      const priorStay = await priorLiveEndedStayFor(actor, noeId);
      return inOrgCtx(actor, async (tx) => {
        if (priorStay) {
          const closure = await priorElectionClosureTx(tx, priorStay);
          if (!closure.notrFiled && !closure.finalClaimFiled) {
            throw new PriorElectionNotClosedError(priorStay.admissionId);
          }
        }
        const repo = new repositories.NoeRepository(tx);
        let noe = await repo.findById(noeId);
        if (!noe || noe.organizationId !== actor.organizationId) throw new NotFoundError("noe");
        if (noe.state === "draft") {
          const stepped = noeMachine.reduce(noe.state, "assemble");
          if (stepped.error) throw reduceError(stepped.error, "assemble");
          const res = await repo.transitionToState(noe.id, noe.version, stepped.state);
          if (!res.ok) throw conflict412(res.currentVersion);
          noe = res.row;
        }
        if (noe.state !== "ready") {
          throw new ConflictError(`a NOE in state '${noe.state}' cannot be submitted`);
        }
        const submission = await new repositories.ClaimSubmissionRepository(tx).append({
          organizationId: actor.organizationId,
          providerEntityId: noe.providerEntityId,
          kind: "noe",
          noeId: noe.id,
          claimControlNumber: noe.noeControlNumber,
          attemptIndex: 0,
          outcome: "queued",
        });
        const { jobId } = await jobs.enqueue("noe.submit", `${actor.organizationId}:${noe.id}`, {
          noeId: noe.id,
          submissionId: submission.id,
          noeControlNumber: noe.noeControlNumber,
        });
        await emit(tx, {
          eventName: "m23.noe.submit_requested",
          organizationId: actor.organizationId,
          aggregateKind: "noe_record",
          aggregateId: noe.id,
          payload: {
            noeId: noe.id,
            submissionId: submission.id,
            noeControlNumber: noe.noeControlNumber,
          },
        });
        return { submissionId: submission.id, jobId, kind: "noe" };
      });
    },

    async cancelNoe(actor, noeId, args: CancelNoeArgs): Promise<NoeView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new repositories.NoeRepository(tx);
        const noe = await repo.findById(noeId);
        if (!noe || noe.organizationId !== actor.organizationId) throw new NotFoundError("noe");
        const stepped = noeMachine.reduce(noe.state, "cancel", {
          electionReversed: args.electionReversed,
        });
        if (stepped.error) throw reduceError(stepped.error, "cancel");
        const res = await repo.transitionToState(noe.id, noe.version, stepped.state);
        if (!res.ok) throw conflict412(res.currentVersion);
        return mapNoe(res.row);
      });
    },

    async submitNotr(actor, notrId): Promise<NoticeSubmissionAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new repositories.NotrRepository(tx);
        let notr = await repo.findById(notrId);
        if (!notr || notr.organizationId !== actor.organizationId) throw new NotFoundError("notr");
        if (notr.state === "draft") {
          const stepped = notrMachine.reduce(notr.state, "assemble");
          if (stepped.error) throw reduceError(stepped.error, "assemble");
          const res = await repo.transitionToState(notr.id, notr.version, stepped.state);
          if (!res.ok) throw conflict412(res.currentVersion);
          notr = res.row;
        }
        if (notr.state !== "ready") {
          throw new ConflictError(`a NOTR in state '${notr.state}' cannot be submitted`);
        }
        const submission = await new repositories.ClaimSubmissionRepository(tx).append({
          organizationId: actor.organizationId,
          providerEntityId: notr.providerEntityId,
          kind: "notr",
          notrId: notr.id,
          claimControlNumber: notr.notrControlNumber,
          attemptIndex: 0,
          outcome: "queued",
        });
        const { jobId } = await jobs.enqueue("notr.submit", `${actor.organizationId}:${notr.id}`, {
          notrId: notr.id,
          submissionId: submission.id,
          notrControlNumber: notr.notrControlNumber,
        });
        await emit(tx, {
          eventName: "m23.notr.submit_requested",
          organizationId: actor.organizationId,
          aggregateKind: "notr_record",
          aggregateId: notr.id,
          payload: {
            notrId: notr.id,
            submissionId: submission.id,
            notrControlNumber: notr.notrControlNumber,
          },
        });
        return { submissionId: submission.id, jobId, kind: "notr" };
      });
    },

    async cancelNotr(actor, notrId, args: CancelNotrArgs): Promise<NotrView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new repositories.NotrRepository(tx);
        const notr = await repo.findById(notrId);
        if (!notr || notr.organizationId !== actor.organizationId) throw new NotFoundError("notr");
        const stepped = notrMachine.reduce(notr.state, "cancel", {
          terminatingEventReversed: args.terminatingEventReversed,
        });
        if (stepped.error) throw reduceError(stepped.error, "cancel");
        const res = await repo.transitionToState(notr.id, notr.version, stepped.state);
        if (!res.ok) throw conflict412(res.currentVersion);
        return mapNotr(res.row);
      });
    },

    async correctNoe(actor, noeId, args: CorrectNoticeArgs) {
      const res = await corrections.correctNoe(actor, noeId, args);
      return { created: res.created, notice: mapNoe(res.record) };
    },

    async correctNotr(actor, notrId, args: CorrectNoticeArgs) {
      const res = await corrections.correctNotr(actor, notrId, args);
      return { created: res.created, notice: mapNotr(res.record) };
    },

    // ── eligibility ──
    async checkEligibility(
      actor,
      args: CheckEligibilityArgs,
    ): Promise<EligibilityCheckAcceptedView> {
      return inOrgCtx(actor, async (tx) => {
        const { jobId } = await jobs.enqueue(
          "eligibility.refresh",
          `${actor.organizationId}:${args.patientId}:${args.asOfServiceDate}`,
          {
            patientId: args.patientId,
            providerEntityId: args.providerEntityId,
            asOfServiceDate: args.asOfServiceDate,
          },
        );
        // The worker runs HETS 270/271 and appends the eligibility_check row (MBI never persisted, §3.6).
        await emit(tx, {
          eventName: "m23.eligibility.refresh_requested",
          organizationId: actor.organizationId,
          aggregateKind: "patient",
          aggregateId: args.patientId,
          payload: {
            patientId: args.patientId,
            providerEntityId: args.providerEntityId,
            asOfServiceDate: args.asOfServiceDate,
          },
        });
        return { jobId, patientId: args.patientId, asOfServiceDate: args.asOfServiceDate };
      });
    },

    // ── MAC credentials (step-up; secret encrypted at the boundary) ──
    async upsertMacCredential(actor, args: UpsertMacCredentialArgs): Promise<MacCredentialView> {
      requireStepUp(actor);
      return mapUniqueViolation(
        "a MAC credential already exists for this provider entity; send its current version in If-Match to update it",
      )(() =>
        inOrgCtx(actor, async (tx) => {
          const repo = new repositories.MacSubmitterCredentialRepository(tx);
          const existing = await repo.findByProviderEntity(args.providerEntityId);
          if (existing && existing.organizationId !== actor.organizationId) {
            throw new NotFoundError("mac credential");
          }
          // A credential row is bound to one provider entity AND one MAC jurisdiction (both are in the cipher's AAD);
          // changing the jurisdiction is a new credential, not an update of this one.
          if (existing && existing.macJurisdiction !== args.macJurisdiction) {
            throw new ConflictError(
              "this provider entity's MAC credential is for a different MAC jurisdiction",
            );
          }
          const { cipher, dekVersion } = await secretCipher.encrypt(
            actor.organizationId,
            args.clientSecret,
            // The database stores uuids lowercase; bind the same spelling the worker will read back.
            {
              providerEntityId: args.providerEntityId.toLowerCase(),
              macJurisdiction: args.macJurisdiction,
            },
          );
          let row: repositories.MacSubmitterCredentialSafeRecord;
          if (existing) {
            if (existing.organizationId !== actor.organizationId) {
              throw new NotFoundError("mac credential");
            }
            if (args.expectedVersion === undefined) {
              throw new ChartWardenError(
                "IF_MATCH_REQUIRED",
                "an If-Match version is required to update an existing MAC credential",
                428,
              );
            }
            const res = await repo.updateWithVersion(existing.id, args.expectedVersion, {
              submitterId: args.submitterId,
              tradingPartnerId: args.tradingPartnerId,
              clientId: args.clientId,
              clientSecretCipher: cipher,
              clientSecretDekVersion: dekVersion,
              ...(args.baaRecordRef !== undefined ? { baaRecordRef: args.baaRecordRef } : {}),
              ...(args.credentialExpiresAt !== undefined
                ? { credentialExpiresAt: new Date(args.credentialExpiresAt) }
                : {}),
            });
            if (!res.ok) throw conflict412(res.currentVersion);
            row = res.row;
          } else {
            row = await repo.create({
              organizationId: actor.organizationId,
              providerEntityId: args.providerEntityId,
              macJurisdiction:
                args.macJurisdiction as schema.NewMacSubmitterCredential["macJurisdiction"],
              submitterId: args.submitterId,
              tradingPartnerId: args.tradingPartnerId,
              clientId: args.clientId,
              clientSecretCipher: cipher,
              clientSecretDekVersion: dekVersion,
              setByMembershipId: actor.membershipId,
              ...(args.baaRecordRef !== undefined ? { baaRecordRef: args.baaRecordRef } : {}),
              ...(args.credentialExpiresAt !== undefined
                ? { credentialExpiresAt: new Date(args.credentialExpiresAt) }
                : {}),
            });
          }
          await emit(tx, {
            eventName: "m23.mac_credential.updated",
            organizationId: actor.organizationId,
            aggregateKind: "mac_submitter_credential",
            aggregateId: row.id,
            payload: {
              providerEntityId: args.providerEntityId,
              macJurisdiction: args.macJurisdiction,
              version: row.version,
            },
          });
          return mapMacCredential(row);
        }),
      );
    },

    async testMacCredential(actor, providerEntityId): Promise<MacCredentialTestView> {
      requireStepUp(actor);
      const probe = ports.macSandbox;
      if (!probe) {
        throw new DegradedError(
          "mac-sandbox",
          "no MAC gateway is configured, so a credential cannot be tested from this deployment",
        );
      }
      const credential = await inOrgCtx(actor, async (tx) => {
        const existing = await new repositories.MacSubmitterCredentialRepository(
          tx,
        ).findByProviderEntity(providerEntityId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("mac credential");
        }
        return existing;
      });
      // The probe is network I/O: it runs OUTSIDE the DB transaction, then the stamp is its own short one.
      const outcome = await probe.probe({
        organizationId: actor.organizationId,
        providerEntityId,
        macJurisdiction: credential.macJurisdiction,
      });
      const checkedAt = now();
      if (!outcome.ok) {
        return {
          providerEntityId,
          macJurisdiction: credential.macJurisdiction,
          ok: false,
          method: "portal_health_probe",
          detail: outcome.detail,
          checkedAt: checkedAt.toISOString(),
          lastSandboxTestAt: null,
        };
      }
      await inOrgCtx(actor, async (tx) => {
        const repo = new repositories.MacSubmitterCredentialRepository(tx);
        const current = await repo.findByProviderEntity(providerEntityId);
        if (!current || current.organizationId !== actor.organizationId) {
          throw new NotFoundError("mac credential");
        }
        const res = await repo.updateWithVersion(current.id, current.version, {
          lastSandboxTestAt: checkedAt,
        });
        if (!res.ok) throw conflict412(res.currentVersion);
      });
      return {
        providerEntityId,
        macJurisdiction: credential.macJurisdiction,
        ok: true,
        method: "portal_health_probe",
        detail: outcome.detail,
        checkedAt: checkedAt.toISOString(),
        lastSandboxTestAt: checkedAt.toISOString(),
      };
    },
  };
}

/** The claim states from which a TOB-817 replacement / TOB-818 void may be authored (D14). */
const REPLACEABLE_STATES: ReadonlySet<ClaimState> = new Set<ClaimState>([
  "ack_accepted",
  "ack_partial",
  "paid",
]);
