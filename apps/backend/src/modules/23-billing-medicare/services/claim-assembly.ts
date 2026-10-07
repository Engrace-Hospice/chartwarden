// apps/backend/src/modules/23-billing-medicare/services/claim-assembly.ts — the §10 task-30 CLAIM
// ASSEMBLY service (D10): the heart of M23. Given (org, providerEntity, patient, service window, TOB) it
// SERVER-AUTHORITATIVELY assembles a DRAFT `claim` from clinical artifacts — never trusting any client
// line. It walks the §4.4 CONSUMED reader seams ONCE to materialize an aggregate, PHI-free snapshot,
// derives the Type of Bill, runs the pure HIPPS + SIA + sequestration calculators, persists the
// `claim` + `claim_line[]` + `hipps_calculation` + (0..1) `sia_calculation` rows, runs the initial
// §11.A validation pass, and emits the §4.10 `m23.claim.draft_created` outbox event — ALL in ONE
// `withOrgContext` transaction so Postgres RLS scopes every statement to `app.org_id` (the M27
// write-service-drizzle precedent).
//
// SEAM INJECTION (the architecture posture): every cross-module edge is an INJECTED port — this service
// depends on the seam INTERFACES (shaped below over the `@wardenx/billing` aggregate snapshot types),
// never on another module's package. The composition root binds the live providers at boot (M5/M6/M8/
// M18/M38/M40 readers are LIVE; the platform reference-data + outbox ports are M1/M23-owned). The pure
// calculators + rule registry are imported from `@wardenx/billing` (no I/O); all I/O lives here at the
// service boundary.
//
// HARD INVARIANTS carried from the M27 lessons:
//   * withOrgContext on the single write transaction (RLS).
//   * D2 transactional-outbox: the `m23.claim.draft_created` emit commits in the SAME unit of work.
//   * Enum case never leaks: the repos map UPPER↔lower at the DB boundary; this service speaks the
//     lowercase domain alphabet (`ClaimState`/`LevelOfCare`) throughout.
//   * Append-only: hipps/sia/validation_run/validation_result/claim_state_history are written once.
//   * claim_line is INTERNAL-WRITE-ONLY: only this service writes lines, as a batch under the parent.
//   * AI-BLOCK (D13): an `actor_kind='ai_*'` caller is rejected fail-closed before any work.
//   * NO PHI / NO MBI ever crosses a seam or lands on a row (D13 / §3.6 / §8.7).
import { createHash, randomUUID } from "node:crypto";
import {
  type Cents,
  type ClaimAssembleRequest,
  type ClaimAssembleResponse,
  G0679_HCPCS,
  G0679_REVENUE_CODE,
  G0679_UNITS_PER_ENCOUNTER,
  G0679_UNIT_CHARGE_CENTS,
  type IsoDate,
  type LevelOfCare,
  POS_BY_QCODE,
  POS_LABEL_ALIASES,
  type RuleResult,
  applySequestrationPolicy,
  deriveControlNumber,
  deriveTypeOfBill,
  isSkipped,
  isWithinInclusive,
  repositories,
  summarizeRuleRun,
  telehealthF2fDatesRequiringG0679,
} from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import {
  computeClaimHipps,
  computeClaimSia,
  hospiceFiscalYearStarting,
  readAssemblyFacts,
} from "./claim-assembly-facts";
import { claimDischargeCodeColumns, claimDischargeCodes } from "./claim-discharge";
import { persistedRemediation } from "./persisted-remediation";
import { readClaimRhcCarryOver, rhcCarryOverSnapshot } from "./rhc-carry-over";
import { assembleValidationContext } from "./validation-context";

// The org-context transaction handle every repo writes through (structurally a `BillingDb`). withOrgContext
// hands back this handle with `app.org_id` / `app.user_id` already set transaction-locally.
type BillingDb = repositories.BillingDb;

// Row-insert types are derived from the §3.3 repository append signatures (NOT imported from the central
// Drizzle schema barrel) so this file carries no cross-module schema-path import literal — the table-ownership
// scanner only flags a file that BOTH imports a `*schema*` path AND names another module's table const, and
// this service legitimately names M6/M8 concepts (election/level-of-care/encounter) in its seam vocabulary.
type NewSiaCalculationInput = Parameters<repositories.SiaCalculationRepository["append"]>[0];
type NewValidationResultInput = Parameters<repositories.ValidationResultRepository["append"]>[0];

export type * from "./claim-assembly-types";
import type { ClaimAssemblySeams, DateRange } from "./claim-assembly-types";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The actor + the public service contract.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The server-assembled actor (NEVER the request body) — org/user/membership + the kind for the AI gate. */
export interface ClaimAssemblyActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  /** `'user'|'system'|'consumer'|'worker'` — `ai_*` is rejected fail-closed (D13). */
  readonly actorKind: string;
}

export interface ClaimAssemblyService {
  assemble(actor: ClaimAssemblyActor, input: ClaimAssembleRequest): Promise<ClaimAssembleResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Pure helpers.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** UB-04 revenue code per level of care (RHC=0651, CHC=0652, IRC=0655, GIP=0656). */
const REVENUE_BY_LOC: Record<LevelOfCare, "0651" | "0652" | "0655" | "0656"> = {
  routine_home_care: "0651",
  continuous_home_care: "0652",
  inpatient_respite_care: "0655",
  general_inpatient_care: "0656",
};

/**
 * `POS_BY_QCODE` inverted (F-125, #251) — the single authoritative CMS Q-code table now lives in
 * `@wardenx/billing`'s `place_of_service_consistency` rule; deriving from it rather than carrying a
 * second, independently-authored mapping is what makes it impossible for this function and that rule to
 * disagree about which Q-code a given place resolves to again (they used to, on three of nine places).
 */
const QCODE_BY_POS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(POS_BY_QCODE).map(([qcode, pos]) => [pos, qcode]),
);

/**
 * Map the resolved place of service to its CMS hospice Q-code. An unrecognized or absent place resolves
 * to Q5009 — CMS's own "place N.O.S." catch-all — never a specific site: the prior version defaulted to
 * Q5006 ("inpatient hospice facility") under a doc comment that called it "unspecified", which asserted a
 * real, specific place of care for a patient whose location was never actually assessed (F-125).
 */
function qCodeForPlaceOfService(pos: string | null): repositories.NewClaimLineInput["qCode"] {
  const label = (pos ?? "").toLowerCase();
  const canonical = POS_LABEL_ALIASES[label] ?? label;
  return (QCODE_BY_POS[canonical] ?? "Q5009") as repositories.NewClaimLineInput["qCode"];
}

/** Map a per-rule `RuleResult` to the `validation_result.outcome` enum value. */
function resultOutcome(r: RuleResult): "pass" | "fail" | "warn" | "info" {
  if (isSkipped(r)) return "info";
  if (r.passed) return "pass";
  if (r.severity === "error") return "fail";
  if (r.severity === "warn") return "warn";
  return "info";
}

/**
 * FY2027 — CR 14495 (Pub 100-04 ch. 11 § 30.3): one separately dated G0679 line on revenue code 0657 per
 * telehealth recertification face-to-face whose encounter date falls in the claim span (dates of service
 * from 2027-01-01). In-person encounters are never reported. The line rides the LOC period covering the
 * encounter date (the `claim_line` model requires one) and the claim's site Q-code; the 837I builder emits
 * the G0679 HCPCS for it, not the Q-code. Units / charge are the UNCONFIRMED constants in
 * `@wardenx/billing` (`G0679_UNITS_PER_ENCOUNTER`, `G0679_UNIT_CHARGE_CENTS`).
 */
export function buildG0679LineInputs(args: {
  readonly orgId: string;
  readonly faceToFace: Parameters<typeof telehealthF2fDatesRequiringG0679>[0];
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly resolvedLoc: readonly {
    readonly levelOfCarePeriodId: string;
    readonly levelOfCare: LevelOfCare;
    readonly from: string;
    readonly to: string;
  }[];
  readonly qCode: repositories.NewClaimLineInput["qCode"];
  readonly icdPointerPositions: readonly number[];
  readonly firstLineNumber: number;
}): repositories.NewClaimLineInput[] {
  const dates = telehealthF2fDatesRequiringG0679(args.faceToFace, {
    serviceFrom: args.serviceFrom,
    serviceTo: args.serviceTo,
  });
  return dates.map((date, idx) => {
    const owningPeriod = args.resolvedLoc.find((p) => isWithinInclusive(date, p.from, p.to));
    if (!owningPeriod) {
      throw new WardenXError(
        "ASSEMBLY_VALIDATION_FAILED",
        `no level-of-care period backs the telehealth face-to-face G0679 line on ${date}`,
        422,
      );
    }
    return {
      organizationId: args.orgId,
      claimId: "",
      lineNumber: args.firstLineNumber + idx,
      revenueCode: G0679_REVENUE_CODE,
      qCode: args.qCode,
      levelOfCare: owningPeriod.levelOfCare,
      hcpcsCode: G0679_HCPCS,
      serviceDateFrom: date,
      serviceDateTo: date,
      unitCount: G0679_UNITS_PER_ENCOUNTER,
      unitRateCents: G0679_UNIT_CHARGE_CENTS,
      lineChargeCents: G0679_UNITS_PER_ENCOUNTER * G0679_UNIT_CHARGE_CENTS,
      levelOfCarePeriodId: owningPeriod.levelOfCarePeriodId,
      backingEncounterIds: [],
      icdPointerPositions: [...args.icdPointerPositions],
      modifiers: [],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The factory.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the claim-assembly service over the RLS-enforced primary `db` + the injected seam bundle. The
 * single `assemble` entry runs the whole pipeline inside one `withOrgContext` transaction.
 */
export function buildClaimAssemblyService(
  db: BillingDb,
  seams: ClaimAssemblySeams,
): ClaimAssemblyService {
  const now = seams.now ?? (() => new Date());

  const inOrgCtx = <T>(actor: ClaimAssemblyActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  return {
    async assemble(actor, input): Promise<ClaimAssembleResponse> {
      // AI-BLOCK (D13): no AI actor may create an M23 row — reject before any read.
      if (actor.actorKind.startsWith("ai_")) {
        throw new WardenXError(
          "AI_ACTOR_FORBIDDEN",
          "AI actors may not assemble claims (D13)",
          403,
        );
      }

      const orgId = actor.organizationId;
      const { providerEntityId, patientId, serviceFrom, serviceTo } = input;
      if (serviceTo < serviceFrom) {
        throw new WardenXError("VALIDATION_FAILED", "serviceTo precedes serviceFrom", 422);
      }
      const range: DateRange = { from: serviceFrom, to: serviceTo };

      // ── 1. Walk the consumed reader seams ONCE (no client data trusted) ────────────────────────────
      // D15 Medicare-primary gate.
      const payer = await seams.patientPayer.medicarePrimaryForRange(orgId, patientId, range);
      if (!payer || !payer.medicarePrimary) {
        throw new WardenXError(
          "NON_MEDICARE_PRIMARY_PAYER",
          "Medicare FFS Part A is not the primary payer for this service window (D15)",
          409,
        );
      }

      const facts = await readAssemblyFacts(seams, orgId, {
        providerEntityId,
        patientId,
        serviceFrom,
        serviceTo,
      });
      const {
        admission,
        resolvedPeriods,
        certifications,
        faceToFace,
        resolvedLoc,
        pe,
        fiscalYearStarting,
        wageIndex,
        rateScope,
        rateTable,
        seqPolicy,
        billableEncounters,
        evvBrackets,
        mdmResolution,
        diagnosisRead,
        icd10Sequence,
        terminology,
        icdPointerPositions,
        capProjectionBound,
        capProjectionCtx,
        signedEncounters,
      } = facts;
      const firstPeriod = resolvedPeriods[0];
      const lastPeriod = resolvedPeriods[resolvedPeriods.length - 1];
      if (!firstPeriod || !lastPeriod) {
        throw new WardenXError(
          "PATIENT_NOT_ELECTED",
          "no active election covers the service window",
          409,
        );
      }
      const electionPeriodIdFrom =
        input.electionPeriodScope?.electionPeriodIdFrom ?? firstPeriod.electionPeriodId;
      const electionPeriodIdTo =
        input.electionPeriodScope?.electionPeriodIdTo ?? lastPeriod.electionPeriodId;

      // ── 2. Server-authoritative TOB + the run inside the write transaction ─────────────────────────
      return inOrgCtx(actor, async (tx) => {
        const claimRepo = new repositories.ClaimRepository(tx);

        // Prior-claim continuity for this admission (drives the TOB cadence + the duplicate/overlap guard).
        const patientClaims = await claimRepo.listByOrgPage(
          orgId,
          { providerEntityId, patientId },
          undefined,
          repositories.MAX_PAGE_SIZE,
        );
        const NON_SUPERSEDED = new Set(["voided", "replaced", "ack_rejected"]);
        const interimTobs = new Set(["811", "812", "813", "814"]);
        const admissionClaims = patientClaims.items.filter(
          (c) => c.admissionId === admission.admissionId && !NON_SUPERSEDED.has(c.state),
        );
        // OVERLAPPING_ACTIVE_CLAIM: any live interim claim whose range intersects this window (the DB
        // partial-unique index `claim_active_by_range_uq` is the hard exact-range backstop).
        const overlap = admissionClaims.find(
          (c) => interimTobs.has(c.tob) && c.serviceFrom <= serviceTo && c.serviceTo >= serviceFrom,
        );
        if (overlap) {
          throw new WardenXError(
            "OVERLAPPING_ACTIVE_CLAIM",
            "a non-superseded claim already covers part of this service window",
            409,
          );
        }
        const priorClaim = [...admissionClaims]
          .filter((c) => interimTobs.has(c.tob))
          .sort((a, b) => (a.serviceTo < b.serviceTo ? 1 : a.serviceTo > b.serviceTo ? -1 : 0))[0];
        const hasPriorClaimForAdmission = priorClaim !== undefined;
        // The stay ends on a completed discharge_event, a transfer-out or a revocation (claim-discharge.ts) —
        // the latter two have no discharge_event row, so reading only `dischargeDate` mis-typed their final
        // bill as an interim one (812/813 instead of 811/814).
        const { discharge, codes: dischargeCodes } = claimDischargeCodes(
          admission,
          resolvedPeriods,
          serviceTo,
        );
        const patientDischarged = discharge !== null && discharge.effectiveDate <= serviceTo;
        const tob = deriveTypeOfBill({
          hasPriorClaimForAdmission,
          patientDischarged,
          adjustment: "none",
        });

        // ── 3. HIPPS per-diem math (D7) — lines are derived, never client-supplied ───────────────────
        // Two-tier RHC: the prior hospice days this stay continues — our stays merged with the HETS history.
        const rhcCarryOver = await readClaimRhcCarryOver(tx, orgId, patientId, admission, now());
        const hipps = computeClaimHipps(facts, { serviceFrom, serviceTo }, rhcCarryOver.priorDays);

        const placeOfService = qCodeForPlaceOfService(mdmResolution.placeOfService);
        const lineInputs: repositories.NewClaimLineInput[] = hipps.segments.map((seg, idx) => {
          const owningPeriod = resolvedLoc.find((p) =>
            isWithinInclusive(seg.dateFrom, p.from, p.to),
          );
          if (!owningPeriod) {
            throw new WardenXError(
              "ASSEMBLY_VALIDATION_FAILED",
              `no level-of-care period backs the assembled segment starting ${seg.dateFrom}`,
              422,
            );
          }
          const backingEncounterIds = billableEncounters
            .filter(
              (e) =>
                e.billability === "billable" &&
                isWithinInclusive(e.serviceDate, seg.dateFrom, seg.dateTo),
            )
            .map((e) => e.encounterId);
          return {
            organizationId: orgId,
            claimId: "", // filled below once the claim id is minted
            lineNumber: idx + 1,
            revenueCode: REVENUE_BY_LOC[seg.levelOfCare],
            qCode: placeOfService,
            levelOfCare: seg.levelOfCare,
            hcpcsCode: null,
            serviceDateFrom: seg.dateFrom,
            serviceDateTo: seg.dateTo,
            unitCount: seg.days,
            unitRateCents: seg.ratePerDiemCents,
            // CHECK (line_charge_cents = unit_count * unit_rate_cents): compute the product directly.
            lineChargeCents: seg.ratePerDiemCents * seg.days,
            levelOfCarePeriodId: owningPeriod.levelOfCarePeriodId,
            backingEncounterIds,
            icdPointerPositions: [...icdPointerPositions],
            modifiers: [],
          };
        });

        // ── 3b. FY2027 CR 14495 — the separately dated G0679 telehealth-F2F lines (rev 0657) ──────────
        const g0679Lines = buildG0679LineInputs({
          orgId,
          faceToFace,
          serviceFrom,
          serviceTo,
          resolvedLoc,
          qCode: placeOfService,
          icdPointerPositions,
          firstLineNumber: lineInputs.length + 1,
        });
        const allLineInputs = [...lineInputs, ...g0679Lines];
        const g0679ChargeCents: Cents = g0679Lines.reduce((sum, l) => sum + l.lineChargeCents, 0);

        // ── 4. SIA add-on math (D6) — purely encounter-derived ───────────────────────────────────────
        const siaResult = await computeClaimSia(seams, facts);
        const siaCents: Cents = siaResult?.siaAddOnCents ?? 0;
        const siaQualifyingVisitCount = siaResult?.qualifyingVisits.length ?? 0;
        const siaRow: NewSiaCalculationInput | null = siaResult
          ? {
              organizationId: orgId,
              claimId: "", // filled below
              patientDeceasedDate: siaResult.patientDeceasedDate as IsoDate,
              windowStart: siaResult.windowStart as IsoDate,
              qualifyingVisits: siaResult.qualifyingVisits.map((v) => ({
                encounterId: v.encounterId,
                visitDate: v.visitDate,
                discipline: v.discipline,
                durationMinutes: v.durationMinutes,
              })),
              totalQualifyingMinutes: siaResult.totalQualifyingMinutes,
              siaAddOnCents: siaResult.siaAddOnCents,
            }
          : null;

        // ── 5. Sequestration (D11) over the gross HIPPS + SIA payable ────────────────────────────────
        const grossCents: Cents = hipps.totalCents + siaCents;
        const sequestration = applySequestrationPolicy(grossCents, {
          percentage: seqPolicy.percentage,
        });
        // The billed total includes the G0679 line charge (an administrative expense: never paid, so it
        // stays out of the sequestered expected payment).
        const totalChargeCents: Cents = grossCents + g0679ChargeCents;

        // ── 6. Mint ids + the deterministic control number, then persist the claim DRAFT ─────────────
        const claimId = randomUUID();
        const validationRunId = randomUUID();
        const claimControlNumber = deriveControlNumber({
          ccn: pe.ccn,
          serviceFrom,
          claimId,
          attemptIndex: 0,
        });

        await claimRepo.create({
          id: claimId,
          organizationId: orgId,
          providerEntityId,
          patientId,
          admissionId: admission.admissionId,
          electionPeriodIdFrom,
          electionPeriodIdTo,
          patientPayerId: payer.patientPayerId,
          tob,
          serviceFrom,
          serviceTo,
          // state defaults to DRAFT at the DB; this service never advances the lifecycle (spec response = DRAFT).
          claimControlNumber,
          macJurisdiction: pe.macJurisdiction,
          totalChargeCents,
          totalExpectedPaymentCents: sequestration.netCents,
          sequestrationAppliedPct: sequestration.percentApplied,
          sequestrationPolicyId: seqPolicy.sequestrationPolicyId,
          latestValidationRunId: validationRunId, // logical pointer; the run row is appended below
          createdByMembershipId: actor.membershipId,
          // CMS Pub. 100-04 Ch. 11 §30.3 discharge codes (refreshed on every re-validation).
          ...claimDischargeCodeColumns(dischargeCodes),
        });

        const insertedLines = await new repositories.ClaimLineRepository(tx).insertBatch(
          allLineInputs.map((l) => ({ ...l, claimId })),
        );

        await new repositories.HippsCalculationRepository(tx).append({
          organizationId: orgId,
          claimId,
          hippsCode: hipps.hippsCode,
          hippsRateCents: hipps.perDiemRateCents,
          wageIndexCcn: pe.ccn,
          wageIndexFiscalYear: fiscalYearStarting,
          wageIndexFactor: wageIndex.factorDecimal,
          segments: hipps.segments.map((s) => ({
            levelOfCare: s.levelOfCareCode,
            dateFrom: s.dateFrom,
            dateTo: s.dateTo,
            ratePerDiemCents: s.ratePerDiemCents,
            hippsCharPosition: s.hippsCharPosition,
          })),
          rhcDays1to60: hipps.rhcDays1to60,
          rhcDays61Plus: hipps.rhcDays61Plus,
          rhcCarryOver,
        });

        if (siaRow) {
          await new repositories.SiaCalculationRepository(tx).append({ ...siaRow, claimId });
        }

        // ── 7. Initial §11.A validation pass — recorded as a COMPLETE validation_run (trigger initial_assembly) ─
        const ctx = assembleValidationContext({
          orgId,
          facts,
          claim: {
            claimId,
            providerEntityId,
            patientId,
            tob,
            serviceFrom,
            serviceTo,
            replacesClaimId: null,
            totalChargeCents,
            priorClaimTob: priorClaim?.tob ?? null,
            priorClaimServiceTo: priorClaim?.serviceTo ?? null,
          },
          lines: insertedLines,
          hipps,
          siaQualifyingVisitCount,
          siaCents,
          eligibility: null, // resolved by the HETS refresh worker, not at assembly — the rule skips
          noe: null,
          eligibilityBound: false,
          rhcCarryOver: rhcCarryOverSnapshot(rhcCarryOver),
        });

        const startedAt = now();
        const results = seams.ruleRegistry.runRules(ctx);
        const summary = summarizeRuleRun(
          results,
          new Set(seams.ruleRegistry.regulatoryRequiredKeys()),
        );
        const completedAt = now();
        const rulesInfo = results.filter(
          (r) => !isSkipped(r) && !r.passed && r.severity === "info",
        ).length;
        const outcome: "all_pass" | "failures_present" =
          summary.failedCount > 0 ? "failures_present" : "all_pass";
        const runInputHash = createHash("sha256")
          .update(
            JSON.stringify({
              claimId,
              version: 0,
              serviceFrom,
              serviceTo,
              tob,
              hippsCode: hipps.hippsCode,
              totalChargeCents,
              lineCount: insertedLines.length,
            }),
          )
          .digest("hex");

        await new repositories.ValidationRunRepository(tx).append({
          id: validationRunId,
          organizationId: orgId,
          claimId,
          trigger: "initial_assembly",
          outcome,
          runInputHash,
          rulesExecuted: results.length,
          rulesPassed: summary.passedCount,
          rulesFailed: summary.failedCount,
          rulesWarn: summary.warningCount,
          rulesInfo,
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          initiatedByMembershipId: actor.membershipId,
        });

        if (results.length > 0) {
          await new repositories.ValidationResultRepository(tx).appendBatch(
            results.map((r) => ({
              organizationId: orgId,
              validationRunId,
              ruleKey: r.ruleKey,
              ruleVersion: seams.ruleRegistry.getRule(r.ruleKey)?.version ?? 1,
              severity: r.severity,
              outcome: resultOutcome(r),
              remediation: persistedRemediation(r) as NewValidationResultInput["remediation"],
            })),
          );
        }

        // ── 8. The creation history row (fromState NULL → draft) + the §4.10 outbox emit (same tx) ───
        await new repositories.ClaimStateHistoryRepository(tx).append({
          organizationId: orgId,
          claimId,
          fromState: null,
          toState: "draft",
          actorKind: actor.actorKind,
          actorMembershipId: actor.membershipId,
          validationRunId,
        });

        await seams.outbox.publish(tx, {
          eventName: "m23.claim.draft_created",
          organizationId: orgId,
          aggregateKind: "claim",
          aggregateId: claimId,
          payload: {
            claimId,
            providerEntityId,
            patientId,
            admissionId: admission.admissionId,
            tob,
            serviceFrom,
            serviceTo,
          },
        });

        return {
          claimId,
          state: "DRAFT",
          totalChargeCents,
          hippsCode: hipps.hippsCode,
          hippsRateCents: hipps.perDiemRateCents,
          lineCount: insertedLines.length,
          initialValidationRunId: validationRunId,
          initialValidationOutcome: outcome,
        };
      });
    },
  };
}
