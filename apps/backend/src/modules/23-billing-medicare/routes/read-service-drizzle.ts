import {
  type ArAgingDto,
  type MetricsBucket,
  claimStateCodec,
  repositories,
} from "@wardenx/billing";
// apps/backend/src/modules/23-billing-medicare/routes/read-service-drizzle.ts — the Drizzle-backed
// M23ReadRouteService (§4.1 GET surface: claim list/detail/lines/state-history/submissions/acks,
// validation runs, NOE/NOTR list/detail, eligibility, rule-config, sequestration policy, MAC credentials,
// AR/metrics).
//
// Implements the {@link M23ReadRouteService} the route plugins compose over, but every read opens ONE
// `withOrgContext(db, {organizationId, userId}, tx => …)` transaction (the M1 @wardenx/tenancy helper) so
// Postgres RLS scopes every statement to `app.org_id` — keeping tenant scoping in one home. Inside the tx
// it reads through the @wardenx/billing data-port REPOSITORIES (each takes the `tx` handle) and projects
// rows to the deliberately-narrowed read DTOs. Mirrors the M27 routes/read-service-drizzle.ts precedent (one
// `read(actor, fn)` helper, one builder returning the service, DTO mappers above it). M23 carries NO PHI and
// NEVER the MBI digit (D13 / §3.6 / §8.7); money is INTEGER CENTS (D8).
//
// IMPORT BOUNDARY (M23 dependsOn = [6,8,22,38,40], NOT M1): the `@wardenx/db` ROOT barrel is forbidden;
// the universal `@wardenx/db/schema` leaf (a FOUNDATION_HELPER) supplies the table objects the AR/metrics
// aggregations need, and `withOrgContext` comes from the always-importable `@wardenx/tenancy` foundation.
// `BillingDb` (the repo handle) is `NodePgDatabase<typeof schema>`, reconstructed in the package — a tx
// handle is assignable to it, so the repos + the local aggregation queries share the same `tx`.
import * as schema from "@wardenx/db/schema";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import type { M23ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";
import type {
  ClaimAcknowledgmentView,
  ClaimDetailView,
  ClaimLineView,
  ClaimListFilter,
  ClaimStateHistoryView,
  ClaimSubmissionView,
  ClaimSummaryView,
  EligibilityCheckView,
  M23ReadRouteService,
  MacCredentialView,
  MetricsFilter,
  NoeListFilter,
  NoeView,
  NotrListFilter,
  NotrView,
  RuleConfigListFilter,
  RuleConfigView,
  ValidationOverrideView,
  ValidationResultView,
  ValidationRunDetailView,
  ValidationRunView,
} from "./read-service";
import { claimDischargeCodesView } from "./read-service";

type BillingDb = repositories.BillingDb;

/**
 * Composition deps the Drizzle read backend binds at boot. Intentionally minimal — every read scopes itself
 * through `withOrgContext`. The clock defaults so the boot wiring can omit it in dev.
 */
export interface M23ReadServicePorts {
  readonly now?: () => Date;
}

// ── small projection helpers ───────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();
const json = (v: unknown): Readonly<Record<string, unknown>> =>
  (v && typeof v === "object" ? v : {}) as Readonly<Record<string, unknown>>;
const strArr = (v: unknown): readonly string[] => (Array.isArray(v) ? (v as string[]) : []);
const numArr = (v: unknown): readonly number[] => (Array.isArray(v) ? (v as number[]) : []);

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

function mapValidationRun(row: schema.ValidationRun): ValidationRunView {
  return {
    validationRunId: row.id,
    claimId: row.claimId,
    trigger: row.trigger,
    outcome: row.outcome,
    rulesExecuted: row.rulesExecuted,
    rulesPassed: row.rulesPassed,
    rulesFailed: row.rulesFailed,
    rulesWarn: row.rulesWarn,
    rulesInfo: row.rulesInfo,
    startedAt: isoReq(row.startedAt),
    completedAt: isoReq(row.completedAt),
    durationMs: row.durationMs,
    initiatedByMembershipId: row.initiatedByMembershipId ?? null,
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

function mapNoe(row: repositories.NoeRecord): NoeView {
  return {
    noeId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    electionPeriodId: row.electionPeriodId,
    state: row.state,
    electionEffectiveDate: row.electionEffectiveDate,
    windowTargetAt: row.windowTargetAt,
    windowBreachedAt: row.windowBreachedAt ?? null,
    noeControlNumber: row.noeControlNumber,
    payerNoeControlNumber: row.payerNoeControlNumber ?? null,
    latestSubmissionId: row.latestSubmissionId ?? null,
    latestAcknowledgmentId: row.latestAcknowledgmentId ?? null,
    confirmationDocumentId: row.confirmationDocumentId ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

function mapNotr(row: repositories.NotrRecord): NotrView {
  return {
    notrId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    triggerKind: row.triggerKind,
    revocationEventId: row.revocationEventId ?? null,
    transferEventId: row.transferEventId ?? null,
    dischargeEventId: row.dischargeEventId ?? null,
    effectiveEndDate: row.effectiveEndDate,
    windowTargetAt: row.windowTargetAt,
    windowBreachedAt: row.windowBreachedAt ?? null,
    state: row.state,
    notrControlNumber: row.notrControlNumber,
    payerNotrControlNumber: row.payerNotrControlNumber ?? null,
    latestSubmissionId: row.latestSubmissionId ?? null,
    latestAcknowledgmentId: row.latestAcknowledgmentId ?? null,
    confirmationDocumentId: row.confirmationDocumentId ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

function mapEligibility(row: repositories.EligibilityCheckRecord): EligibilityCheckView {
  return {
    checkId: row.id,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    asOfServiceDate: row.asOfServiceDate,
    outcome: row.outcome,
    parsedPayload: json(row.parsedPayload),
    checkedAt: isoReq(row.checkedAt),
    staleAt: isoReq(row.staleAt),
  };
}

function mapRuleConfig(row: schema.ValidationRuleConfig): RuleConfigView {
  return {
    ruleConfigId: row.id,
    organizationId: row.organizationId,
    ruleKey: row.ruleKey,
    ruleVersion: row.ruleVersion,
    isCustom: row.isCustom,
    enabled: row.enabled,
    severity: row.severity,
    overrideRoleRequired: row.overrideRoleRequired ?? null,
    parameters: json(row.parameters),
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
    // `client_secret_cipher` is NOT NULL on every persisted credential and is dropped by the safe
    // projection, so the secret-is-set flag is true without ever reading the cipher itself (§3.6).
    hasSecret: true,
    baaRecordRef: row.baaRecordRef ?? null,
    credentialExpiresAt: iso(row.credentialExpiresAt),
    lastSandboxTestAt: iso(row.lastSandboxTestAt),
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

function mapSubmission(row: schema.ClaimSubmission): ClaimSubmissionView {
  return {
    submissionId: row.id,
    providerEntityId: row.providerEntityId,
    kind: row.kind,
    claimId: row.claimId ?? null,
    noeId: row.noeId ?? null,
    notrId: row.notrId ?? null,
    claimControlNumber: row.claimControlNumber,
    attemptIndex: row.attemptIndex,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason ?? null,
    generatedFileUri: row.generatedFileUri ?? null,
    submittedAt: iso(row.submittedAt),
    createdAt: isoReq(row.createdAt),
  };
}

function mapAck(row: schema.ClaimAcknowledgment): ClaimAcknowledgmentView {
  return {
    acknowledgmentId: row.id,
    submissionId: row.submissionId,
    claimId: row.claimId ?? null,
    kind: row.kind,
    macJurisdiction: row.macJurisdiction,
    ackReceivedAt: isoReq(row.ackReceivedAt),
    parsedAt: isoReq(row.parsedAt),
    outcomeStatus: row.outcomeStatus,
    parsedPayload: json(row.parsedPayload),
    createdAt: isoReq(row.createdAt),
  };
}

function mapStateHistory(row: repositories.ClaimStateHistoryRecord): ClaimStateHistoryView {
  return {
    historyId: row.id,
    claimId: row.claimId,
    fromState: row.fromState,
    toState: row.toState,
    at: isoReq(row.at),
    actorMembershipId: row.actorMembershipId ?? null,
    actorKind: row.actorKind,
    reason: row.reason ?? null,
    validationRunId: row.validationRunId ?? null,
    submissionId: row.submissionId ?? null,
    acknowledgmentId: row.acknowledgmentId ?? null,
    remittanceAdviceId: row.remittanceAdviceId ?? null,
  };
}

function mapLine(row: repositories.ClaimLineRecord): ClaimLineView {
  return {
    claimLineId: row.id,
    claimId: row.claimId,
    lineNumber: row.lineNumber,
    revenueCode: row.revenueCode,
    qCode: row.qCode,
    levelOfCare: row.levelOfCare,
    hcpcsCode: row.hcpcsCode ?? null,
    serviceDateFrom: row.serviceDateFrom,
    serviceDateTo: row.serviceDateTo,
    unitCount: row.unitCount,
    unitRateCents: row.unitRateCents,
    lineChargeCents: row.lineChargeCents,
    levelOfCarePeriodId: row.levelOfCarePeriodId,
    modifiers: strArr(row.modifiers),
    icdPointerPositions: numArr(row.icdPointerPositions),
    backingEncounterIds: strArr(row.backingEncounterIds),
  };
}

// ── the builder ──────────────────────────────────────────────────────────────────────────────────────

/** The AR-aging states (a claim with an outstanding receivable: dispatched but not yet paid/closed). */
const AR_OPEN_DB_STATES = ["SUBMITTED", "ACK_PENDING", "ACK_ACCEPTED", "ACK_PARTIAL"] as const;

/**
 * Build the Drizzle-backed {@link M23ReadRouteService}. Every method opens one `withOrgContext` transaction
 * (RLS-scoped to the actor's org) and reads through the @wardenx/billing repositories on the tx handle. The
 * route plugins gate each method on the §4.6 permission + §4.7 ABAC predicate BEFORE the call reaches here.
 */
export function buildDrizzleM23ReadService(
  db: BillingDb,
  ports: M23ReadServicePorts = {},
): M23ReadRouteService {
  const now = ports.now ?? (() => new Date());
  const read = <T>(actor: M23ReadActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  /** Resolve a claim by id under RLS, enforcing the org match (404 otherwise). */
  const loadClaim = async (
    tx: BillingDb,
    actor: M23ReadActor,
    claimId: string,
  ): Promise<repositories.ClaimRecord> => {
    const row = await new repositories.ClaimRepository(tx).findById(claimId);
    if (!row || row.organizationId !== actor.organizationId) throw new NotFoundError("claim");
    return row;
  };

  return {
    async listClaims(actor, filter: ClaimListFilter, cursor, limit) {
      return read(actor, async (tx) => {
        const page = await new repositories.ClaimRepository(tx).listByOrgPage(
          actor.organizationId,
          {
            providerEntityId: filter.providerEntityId,
            patientId: filter.patientId,
            state: filter.state,
            providerEntityScope: filter.providerEntityScope,
          },
          cursor,
          limit,
        );
        return {
          items: page.items.map(mapClaimSummary),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        } satisfies CursorPage<ClaimSummaryView>;
      });
    },

    async getClaim(actor, claimId) {
      return read(actor, async (tx) => {
        const row = await loadClaim(tx, actor, claimId);
        const latestRun = await new repositories.ValidationRunRepository(tx).findLatestForClaim(
          claimId,
        );
        const hipps = await new repositories.HippsCalculationRepository(tx).findByClaim(claimId);
        const sia = await new repositories.SiaCalculationRepository(tx).findByClaim(claimId);
        return {
          ...mapClaimSummary(row),
          electionPeriodIdFrom: row.electionPeriodIdFrom,
          electionPeriodIdTo: row.electionPeriodIdTo,
          patientPayerId: row.patientPayerId,
          sequestrationAppliedPct: row.sequestrationAppliedPct,
          sequestrationPolicyId: row.sequestrationPolicyId,
          replacesClaimId: row.replacesClaimId ?? null,
          replacedByClaimId: row.replacedByClaimId ?? null,
          replacementReason: row.replacementReason ?? null,
          latestValidationRunId: row.latestValidationRunId ?? null,
          latestSubmissionId: row.latestSubmissionId ?? null,
          acknowledgmentDocumentId: row.acknowledgmentDocumentId ?? null,
          dischargeCodes: claimDischargeCodesView(row),
          latestValidation: latestRun ? mapValidationRun(latestRun) : null,
          pricing: {
            hipps: hipps
              ? {
                  hippsCode: hipps.hippsCode,
                  hippsRateCents: hipps.hippsRateCents,
                  wageIndexCcn: hipps.wageIndexCcn,
                  wageIndexFiscalYear: hipps.wageIndexFiscalYear,
                  wageIndexFactor: hipps.wageIndexFactor,
                  segments: hipps.segments,
                  calculatedAt: isoReq(hipps.calculatedAt),
                }
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
          createdAt: isoReq(row.createdAt),
          updatedAt: isoReq(row.updatedAt),
        } satisfies ClaimDetailView;
      });
    },

    async listClaimLines(actor, claimId) {
      return read(actor, async (tx) => {
        await loadClaim(tx, actor, claimId);
        const rows = await new repositories.ClaimLineRepository(tx).listForClaim(claimId);
        return rows.map(mapLine);
      });
    },

    async listClaimStateHistory(actor, claimId, cursor, limit) {
      return read(actor, async (tx) => {
        await loadClaim(tx, actor, claimId);
        const page = await new repositories.ClaimStateHistoryRepository(tx).listForClaimPage(
          claimId,
          cursor,
          limit,
        );
        return {
          items: page.items.map(mapStateHistory),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        } satisfies CursorPage<ClaimStateHistoryView>;
      });
    },

    async listClaimSubmissions(actor, claimId) {
      return read(actor, async (tx) => {
        await loadClaim(tx, actor, claimId);
        const rows = await new repositories.ClaimSubmissionRepository(tx).listForClaim(claimId);
        return rows.map(mapSubmission);
      });
    },

    async listClaimAcknowledgments(actor, claimId) {
      return read(actor, async (tx) => {
        await loadClaim(tx, actor, claimId);
        const rows = await new repositories.ClaimAcknowledgmentRepository(tx).listForClaim(claimId);
        return rows.map(mapAck);
      });
    },

    async listValidationRuns(actor, claimId) {
      return read(actor, async (tx) => {
        await loadClaim(tx, actor, claimId);
        const rows = await new repositories.ValidationRunRepository(tx).listForClaim(claimId);
        return rows.map(mapValidationRun);
      });
    },

    async getValidationRun(actor, claimId, validationRunId) {
      return read(actor, async (tx) => {
        await loadClaim(tx, actor, claimId);
        const run = await new repositories.ValidationRunRepository(tx).findById(validationRunId);
        if (!run || run.organizationId !== actor.organizationId || run.claimId !== claimId) {
          throw new NotFoundError("validation run");
        }
        const results = await new repositories.ValidationResultRepository(tx).listForRun(
          validationRunId,
        );
        const overrideRepo = new repositories.ValidationOverrideRepository(tx);
        const overrides = await overrideRepo.listByResultIds(results.map((r) => r.id));
        const overrideByResult = new Map(overrides.map((o) => [o.resultId, o]));
        const mappedResults: ValidationResultView[] = results.map((r) => {
          const override = overrideByResult.get(r.id) ?? null;
          return {
            resultId: r.id,
            validationRunId: r.validationRunId,
            ruleKey: r.ruleKey,
            ruleVersion: r.ruleVersion,
            severity: r.severity,
            outcome: r.outcome,
            remediation: json(r.remediation),
            overridden: override !== null,
            override: override ? mapOverride(override) : null,
            recordedAt: isoReq(r.recordedAt),
          };
        });
        return {
          ...mapValidationRun(run),
          results: mappedResults,
        } satisfies ValidationRunDetailView;
      });
    },

    async listNoes(actor, filter: NoeListFilter, cursor, limit) {
      return read(actor, async (tx) => {
        const page = await new repositories.NoeRepository(tx).listByOrgPage(
          actor.organizationId,
          filter,
          cursor,
          limit,
        );
        return {
          items: page.items.map(mapNoe),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        } satisfies CursorPage<NoeView>;
      });
    },

    async getNoe(actor, noeId) {
      return read(actor, async (tx) => {
        const row = await new repositories.NoeRepository(tx).findById(noeId);
        if (!row || row.organizationId !== actor.organizationId) throw new NotFoundError("noe");
        return mapNoe(row);
      });
    },

    async listNotrs(actor, filter: NotrListFilter, cursor, limit) {
      return read(actor, async (tx) => {
        const page = await new repositories.NotrRepository(tx).listByOrgPage(
          actor.organizationId,
          filter,
          cursor,
          limit,
        );
        return {
          items: page.items.map(mapNotr),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        } satisfies CursorPage<NotrView>;
      });
    },

    async getNotr(actor, notrId) {
      return read(actor, async (tx) => {
        const row = await new repositories.NotrRepository(tx).findById(notrId);
        if (!row || row.organizationId !== actor.organizationId) throw new NotFoundError("notr");
        return mapNotr(row);
      });
    },

    async listEligibilityChecks(actor, patientId) {
      return read(actor, async (tx) => {
        const rows = await new repositories.EligibilityCheckRepository(tx).listForPatient(
          actor.organizationId,
          patientId,
        );
        return rows.map(mapEligibility);
      });
    },

    async getLatestEligibility(actor, patientId) {
      return read(actor, async (tx) => {
        const row = await new repositories.EligibilityCheckRepository(tx).findLatestForPatient(
          actor.organizationId,
          patientId,
        );
        return row ? mapEligibility(row) : null;
      });
    },

    async listRuleConfigs(actor, filter: RuleConfigListFilter, cursor, limit) {
      return read(actor, async (tx) => {
        const page = await new repositories.ValidationRuleConfigRepository(tx).listByOrgPage(
          actor.organizationId,
          filter,
          cursor,
          limit,
        );
        return {
          items: page.items.map(mapRuleConfig),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        } satisfies CursorPage<RuleConfigView>;
      });
    },

    async getRuleConfig(actor, ruleConfigId) {
      return read(actor, async (tx) => {
        const row = await new repositories.ValidationRuleConfigRepository(tx).findById(
          ruleConfigId,
        );
        if (!row || row.organizationId !== actor.organizationId)
          throw new NotFoundError("rule config");
        return mapRuleConfig(row);
      });
    },

    async listMacCredentials(actor, cursor, limit) {
      return read(actor, async (tx) => {
        const page = await new repositories.MacSubmitterCredentialRepository(tx).listByOrgPage(
          actor.organizationId,
          cursor,
          limit,
        );
        return {
          items: page.items.map(mapMacCredential),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        } satisfies CursorPage<MacCredentialView>;
      });
    },

    async getMacCredential(actor, providerEntityId) {
      return read(actor, async (tx) => {
        const row = await new repositories.MacSubmitterCredentialRepository(
          tx,
        ).findByProviderEntity(providerEntityId);
        if (!row || row.organizationId !== actor.organizationId) return null;
        return mapMacCredential(row);
      });
    },

    async getClaimMetrics(actor, filter: MetricsFilter): Promise<readonly MetricsBucket[]> {
      return read(actor, (tx) => aggregateByState(tx, actor.organizationId, filter));
    },

    async getArAging(actor, filter: MetricsFilter): Promise<ArAgingDto> {
      return read(actor, async (tx) => {
        const C = schema.claim;
        const rows = await tx
          .select({
            createdAt: C.createdAt,
            amountCents: C.totalExpectedPaymentCents,
          })
          .from(C)
          .where(
            and(
              eq(C.organizationId, actor.organizationId),
              filter.providerEntityId ? eq(C.providerEntityId, filter.providerEntityId) : undefined,
              inArray(C.state, [...AR_OPEN_DB_STATES]),
            ),
          );
        const at = now().getTime();
        const buckets = { b0: 0, b31: 0, b61: 0, b90: 0 };
        for (const r of rows) {
          const ageDays = Math.floor((at - r.createdAt.getTime()) / 86_400_000);
          if (ageDays <= 30) buckets.b0 += r.amountCents;
          else if (ageDays <= 60) buckets.b31 += r.amountCents;
          else if (ageDays <= 90) buckets.b61 += r.amountCents;
          else buckets.b90 += r.amountCents;
        }
        return {
          bucket0to30Cents: buckets.b0,
          bucket31to60Cents: buckets.b31,
          bucket61to90Cents: buckets.b61,
          bucket90PlusCents: buckets.b90,
        } satisfies ArAgingDto;
      });
    },
  };
}

// ── aggregation helpers (kept below the builder; pure Drizzle over the tx handle) ──────────────────────

function buildMetricsWhere(organizationId: string, filter: MetricsFilter) {
  const C = schema.claim;
  return and(
    eq(C.organizationId, organizationId),
    filter.providerEntityId ? eq(C.providerEntityId, filter.providerEntityId) : undefined,
  );
}

async function aggregateByState(
  tx: repositories.BillingDb,
  organizationId: string,
  filter: MetricsFilter,
): Promise<readonly MetricsBucket[]> {
  const C = schema.claim;
  const rows = await tx
    .select({ state: C.state, totalChargeCents: C.totalChargeCents })
    .from(C)
    .where(buildMetricsWhere(organizationId, filter));
  const acc = new Map<string, { count: number; amountCents: number }>();
  for (const r of rows) {
    const key = claimStateCodec.fromDb(r.state);
    const cur = acc.get(key) ?? { count: 0, amountCents: 0 };
    cur.count += 1;
    cur.amountCents += r.totalChargeCents;
    acc.set(key, cur);
  }
  return [...acc.entries()].map(([key, v]) => ({
    key,
    count: v.count,
    amountCents: v.amountCents,
  }));
}
