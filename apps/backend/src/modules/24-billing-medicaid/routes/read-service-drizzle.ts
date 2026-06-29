// apps/backend/src/modules/24-billing-medicaid/routes/read-service-drizzle.ts — the Drizzle-backed M24 READ
// service. Every method opens `withOrgContext(db, {organizationId, userId}, tx => …)` so Postgres RLS scopes
// each statement to the acting org. Claim list paging is keyset over (created_at DESC, id DESC). The
// rule-config read overlays the per-tenant config rows onto the §4.6 platform-default registry. Secrets and
// the Recipient ID are NEVER returned (presence flags + masked last-4 only; D12 / §3.6).
import { DEFAULT_MEDICAID_RULES } from "@wardenx/medicaid-adapters";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { type CursorPage, decodeCursor, toPage } from "./concurrency";
import type {
  AcknowledgmentView,
  ArDashboardView,
  ArMetricsView,
  ClaimFilters,
  ClaimLineView,
  ClaimView,
  EligibilityCheckView,
  EligibilityFilters,
  M24ReadService,
  RbArrangementFilters,
  RbArrangementView,
  RbDayFilters,
  RbDayView,
  RuleConfigView,
  SubmissionView,
  TradingPartnerCredentialView,
  ValidationOverrideView,
  ValidationResultView,
  ValidationRunView,
} from "./read-service";

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const day = (d: Date | string | null): string => iso(d).slice(0, 10);
const dayN = (d: Date | string | null): string | null => (d === null ? null : day(d));

const RULES_BY_KEY = new Map(DEFAULT_MEDICAID_RULES.map((r) => [r.key, r]));

export function buildDrizzleM24ReadService(db: DbClient): M24ReadService {
  const C = schema.medicaidClaim;
  const CL = schema.medicaidClaimLine;
  const SUB = schema.medicaidSubmission;
  const ACK = schema.medicaidAcknowledgment;
  const VR = schema.medicaidValidationRun;
  const VRES = schema.medicaidValidationResult;
  const VOV = schema.medicaidValidationOverride;
  const RC = schema.medicaidValidationRuleConfig;
  const EC = schema.medicaidEligibilityCheck;
  const A = schema.rbArrangement;
  const RD = schema.rbDay;
  const TP = schema.stateMedicaidTradingPartnerCredential;

  const toClaim = (r: typeof C.$inferSelect): ClaimView => ({
    id: r.id,
    providerEntityId: r.providerEntityId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    serviceState: r.serviceState,
    kind: r.kind,
    tob: r.tob,
    serviceFrom: day(r.serviceFrom),
    serviceTo: day(r.serviceTo),
    mcoId: r.mcoId ?? null,
    medicareClaimId: r.medicareClaimId ?? null,
    rbArrangementId: r.rbArrangementId ?? null,
    medicaidClaimControlNumber: r.medicaidClaimControlNumber,
    state: r.state,
    version: r.version,
    validationRunIdLatest: r.validationRunIdLatest ?? null,
    eligibilityOutcomeSnapshot: r.eligibilityOutcomeSnapshot ?? null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  });

  const toResult = (r: typeof VRES.$inferSelect): ValidationResultView => ({
    id: r.id,
    medicaidValidationRunId: r.medicaidValidationRunId,
    ruleKey: r.ruleKey,
    ruleVersion: r.ruleVersion,
    outcome: r.outcome,
    remediationSummary: r.remediationSummary ?? null,
    remediationFixAction: r.remediationFixAction ?? null,
    at: iso(r.at),
  });

  const toRun = (r: typeof VR.$inferSelect): ValidationRunView => ({
    id: r.id,
    medicaidClaimId: r.medicaidClaimId,
    ruleRegistryVersion: r.ruleRegistryVersion,
    triggeredBy: r.triggeredBy,
    claimStateAtTrigger: r.claimStateAtTrigger,
    at: iso(r.at),
    completedAt: isoN(r.completedAt),
    totalResults: r.totalResults,
    failedResults: r.failedResults,
    warnedResults: r.warnedResults,
  });

  const toArrangement = (r: typeof A.$inferSelect): RbArrangementView => ({
    id: r.id,
    patientId: r.patientId,
    providerEntityId: r.providerEntityId,
    nfFacilityMdmId: r.nfFacilityMdmId,
    nfFacilityNameSnapshot: r.nfFacilityNameSnapshot,
    effectiveFrom: day(r.effectiveFrom),
    effectiveTo: dayN(r.effectiveTo),
    nfPerDiemRoutineCents: r.nfPerDiemRoutineCents,
    nfPerDiemRespCents: r.nfPerDiemRespCents,
    nfPerDiemGipCents: r.nfPerDiemGipCents,
    passThroughPct: r.passThroughPct,
    retentionPct: r.retentionPct,
    state: r.state,
    version: r.version,
    createdAt: iso(r.createdAt),
  });

  const toRbDay = (r: typeof RD.$inferSelect): RbDayView => ({
    id: r.id,
    rbArrangementId: r.rbArrangementId,
    patientId: r.patientId,
    serviceDate: day(r.serviceDate),
    locOfDay: r.locOfDay,
    perDiemCentsSnapshot: r.perDiemCentsSnapshot,
    status: r.status,
    exclusionReason: r.exclusionReason ?? null,
    medicaidClaimLineId: r.medicaidClaimLineId ?? null,
    version: r.version,
  });

  return {
    async listClaims(actor, filters, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          filters.state ? eq(C.state, filters.state as typeof C.state.enumValues[number]) : undefined,
          filters.kind ? eq(C.kind, filters.kind as typeof C.kind.enumValues[number]) : undefined,
          filters.mcoId ? eq(C.mcoId, filters.mcoId) : undefined,
          filters.serviceState ? eq(C.serviceState, filters.serviceState) : undefined,
          filters.patientId ? eq(C.patientId, filters.patientId) : undefined,
          filters.providerEntityId ? eq(C.providerEntityId, filters.providerEntityId) : undefined,
          c ? sql`(${C.createdAt}, ${C.id}) < (${new Date(c.ts)}, ${c.id})` : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(C)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(C.createdAt), desc(C.id))
          .limit(limit + 1);
        return toPage<typeof rows[number], ClaimView>(
          rows,
          limit,
          (r) => ({ ts: iso(r.createdAt), id: r.id }),
          toClaim,
        ) satisfies CursorPage<ClaimView>;
      });
    },

    async getClaim(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(C).where(eq(C.id, claimId)).limit(1);
        return rows[0] ? toClaim(rows[0]) : null;
      });
    },

    async listClaimLines(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(CL)
          .where(eq(CL.medicaidClaimId, claimId))
          .orderBy(CL.lineNumber);
        return rows.map(
          (r): ClaimLineView => ({
            id: r.id,
            medicaidClaimId: r.medicaidClaimId,
            lineNumber: r.lineNumber,
            serviceDate: day(r.serviceDate),
            revenueCode: r.revenueCode,
            qCode: r.qCode,
            levelOfCare: r.levelOfCare,
            units: r.units,
            rateAtAssemblyCents: r.rateAtAssemblyCents,
            chargesCents: r.chargesCents,
            cobPaidCents: r.cobPaidCents ?? null,
            isRb: r.isRb,
            rbDayId: r.rbDayId ?? null,
          }),
        );
      });
    },

    async listSubmissions(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(SUB)
          .where(eq(SUB.medicaidClaimId, claimId))
          .orderBy(desc(SUB.createdAt));
        return rows.map(
          (r): SubmissionView => ({
            id: r.id,
            medicaidClaimId: r.medicaidClaimId,
            serviceState: r.serviceState,
            channel: r.channel,
            medicaidClaimControlNumber: r.medicaidClaimControlNumber,
            attemptIndex: r.attemptIndex,
            adapterVendor: r.adapterVendor,
            adapterVersion: r.adapterVersion,
            result: r.result,
            errorCode: r.errorCode ?? null,
            nextPollAt: isoN(r.nextPollAt),
            submittedAt: isoN(r.submittedAt),
            createdAt: iso(r.createdAt),
          }),
        );
      });
    },

    async listAcknowledgments(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(ACK)
          .where(eq(ACK.medicaidClaimId, claimId))
          .orderBy(desc(ACK.receivedAt));
        return rows.map(
          (r): AcknowledgmentView => ({
            id: r.id,
            medicaidClaimId: r.medicaidClaimId,
            medicaidSubmissionId: r.medicaidSubmissionId,
            kind: r.kind,
            outcome: r.outcome,
            payerClaimControlNumber: r.payerClaimControlNumber ?? null,
            acceptedLineNumbers: r.acceptedLineNumbers ?? null,
            rejectedLineNumbers: r.rejectedLineNumbers ?? null,
            errorCodes: r.errorCodes ?? null,
            receivedAt: iso(r.receivedAt),
          }),
        );
      });
    },

    async getValidationRun(actor, runId) {
      return withOrgContext(db, actor, async (tx) => {
        const runs = await tx.select().from(VR).where(eq(VR.id, runId)).limit(1);
        if (!runs[0]) return null;
        const results = await tx
          .select()
          .from(VRES)
          .where(eq(VRES.medicaidValidationRunId, runId))
          .orderBy(VRES.at);
        return { ...toRun(runs[0]), results: results.map(toResult) };
      });
    },

    async listValidationRuns(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(VR)
          .where(eq(VR.medicaidClaimId, claimId))
          .orderBy(desc(VR.at));
        return rows.map(toRun);
      });
    },

    async listOverrides(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(VOV).orderBy(desc(VOV.at)).limit(500);
        return rows.map(
          (r): ValidationOverrideView => ({
            id: r.id,
            medicaidValidationResultId: r.medicaidValidationResultId,
            medicaidClaimId: r.medicaidClaimId,
            ruleKey: r.ruleKey,
            overrideRoleApplied: r.overrideRoleApplied,
            reason: r.reason,
            actorMembershipId: r.actorMembershipId,
            at: iso(r.at),
          }),
        );
      });
    },

    async listRuleConfig(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const overlays = await tx.select().from(RC);
        const byKey = new Map(overlays.map((o) => [o.ruleKey, o]));
        const out: RuleConfigView[] = [];
        // platform-floor rules + their per-tenant overlay (if any)
        for (const rule of DEFAULT_MEDICAID_RULES) {
          const o = byKey.get(rule.key);
          out.push({
            ruleKey: rule.key,
            enabled: o?.enabled ?? true,
            isCustom: false,
            customSeverity: o?.customSeverity ?? null,
            customOverrideRole: o?.customOverrideRole ?? null,
            regulatoryRequired: rule.regulatoryRequired,
            parametersOverlay: o?.parametersOverlay ?? null,
            version: o?.version ?? null,
            platformDefault: {
              title: rule.title,
              category: rule.category,
              severity: rule.severity,
              regulatoryRequired: rule.regulatoryRequired,
              applicableStates: rule.applicableStates,
            },
          });
        }
        // tenant custom rules (not in the platform floor)
        for (const o of overlays) {
          if (o.isCustom) {
            out.push({
              ruleKey: o.ruleKey,
              enabled: o.enabled,
              isCustom: true,
              customSeverity: o.customSeverity ?? null,
              customOverrideRole: o.customOverrideRole ?? null,
              regulatoryRequired: o.regulatoryRequiredSnapshot,
              parametersOverlay: o.parametersOverlay ?? null,
              version: o.version,
            });
          }
        }
        return out;
      });
    },

    async listEligibilityChecks(actor, filters) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [filters.patientId ? eq(EC.patientId, filters.patientId) : undefined].filter(Boolean);
        const rows = await tx
          .select()
          .from(EC)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(EC.checkedAt))
          .limit(200);
        return rows.map(
          (r): EligibilityCheckView => ({
            id: r.id,
            patientId: r.patientId,
            patientPayerId: r.patientPayerId,
            serviceState: r.serviceState,
            asOfServiceDate: day(r.asOfServiceDate),
            outcome: r.outcome,
            mcoId: r.mcoId ?? null,
            recipientIdMaskedAtCheck: r.recipientIdMaskedAtCheck ?? null,
            checkedAt: iso(r.checkedAt),
            staleAt: iso(r.staleAt),
            errorMessage: r.errorMessage ?? null,
          }),
        );
      });
    },

    async listRbArrangements(actor, filters) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          filters.patientId ? eq(A.patientId, filters.patientId) : undefined,
          filters.nfFacilityMdmId ? eq(A.nfFacilityMdmId, filters.nfFacilityMdmId) : undefined,
          filters.state ? eq(A.state, filters.state as typeof A.state.enumValues[number]) : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(A)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(A.createdAt))
          .limit(200);
        return rows.map(toArrangement);
      });
    },

    async getRbArrangement(actor, arrangementId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        if (!rows[0]) return null;
        const days = await tx
          .select()
          .from(RD)
          .where(eq(RD.rbArrangementId, arrangementId))
          .orderBy(RD.serviceDate)
          .limit(500);
        return { ...toArrangement(rows[0]), days: days.map(toRbDay) };
      });
    },

    async listRbDays(actor, filters) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          filters.patientId ? eq(RD.patientId, filters.patientId) : undefined,
          filters.rbArrangementId ? eq(RD.rbArrangementId, filters.rbArrangementId) : undefined,
          filters.status ? eq(RD.status, filters.status as typeof RD.status.enumValues[number]) : undefined,
          filters.from ? gte(RD.serviceDate, new Date(filters.from)) : undefined,
          filters.to ? lte(RD.serviceDate, new Date(filters.to)) : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(RD)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(RD.serviceDate))
          .limit(500);
        return rows.map(toRbDay);
      });
    },

    async listTradingPartnerCredentials(actor, providerEntityId) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [providerEntityId ? eq(TP.providerEntityId, providerEntityId) : undefined].filter(Boolean);
        const rows = await tx
          .select()
          .from(TP)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(TP.createdAt));
        return rows.map(
          (r): TradingPartnerCredentialView => ({
            id: r.id,
            providerEntityId: r.providerEntityId,
            serviceState: r.serviceState,
            channel: r.channel,
            mcoId: r.mcoId ?? null,
            tradingPartnerId: r.tradingPartnerId,
            clientId: r.clientId ?? null,
            sftpHost: r.sftpHost ?? null,
            portalUrl: r.portalUrl ?? null,
            activeFrom: day(r.activeFrom),
            activeTo: dayN(r.activeTo),
            lastSandboxTestAt: isoN(r.lastSandboxTestAt),
            lastSandboxTestResult: r.lastSandboxTestResult ?? null,
            version: r.version,
            hasClientSecret: r.clientSecretCipher !== null,
            hasSftpKey: r.sftpKeyCipher !== null,
          }),
        );
      });
    },

    async arDashboard(actor, providerEntityId) {
      return withOrgContext(db, actor, async (tx): Promise<ArDashboardView> => {
        const conds = [providerEntityId ? eq(C.providerEntityId, providerEntityId) : undefined].filter(Boolean);
        const byState = await tx
          .select({
            state: C.serviceState,
            count: sql<number>`count(*)::int`,
          })
          .from(C)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .groupBy(C.serviceState);
        const total = byState.reduce((a, b) => a + b.count, 0);
        return {
          totalOpen: total,
          buckets: [],
          byState: byState.map((b) => ({ state: b.state, count: b.count, chargesCents: 0 })),
        };
      });
    },

    async arMetrics(actor, providerEntityId) {
      return withOrgContext(db, actor, async (tx): Promise<ArMetricsView> => {
        const conds = [providerEntityId ? eq(C.providerEntityId, providerEntityId) : undefined].filter(Boolean);
        const counts = await tx
          .select({ state: C.state, n: sql<number>`count(*)::int` })
          .from(C)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .groupBy(C.state);
        const open = counts.reduce((a, b) => a + b.n, 0);
        const denied = counts.find((c) => c.state === "DENIED")?.n ?? 0;
        const byMco = await tx
          .select({ mcoId: C.mcoId, count: sql<number>`count(*)::int` })
          .from(C)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .groupBy(C.mcoId);
        return {
          denialRate: open > 0 ? denied / open : 0,
          openCount: open,
          byMco: byMco.map((m) => ({ mcoId: m.mcoId ?? null, count: m.count })),
          aging: [],
        };
      });
    },
  };
}

// re-export so `import { RULES_BY_KEY }` consumers (none yet) resolve; keeps the registry single-sourced.
export { RULES_BY_KEY };
