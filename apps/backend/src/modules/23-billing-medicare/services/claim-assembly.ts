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
  type BillableEncounterSnapshot,
  type CapProjectionProvider,
  type Cents,
  type CertificationSnapshot,
  type ClaimAssembleRequest,
  type ClaimAssembleResponse,
  type ElectionPeriodSnapshot,
  type EvvBracketSnapshot,
  type FaceToFaceSnapshot,
  type HippsRateTable,
  type IsoDate,
  type LevelOfCare,
  type LevelOfCarePeriodSnapshot,
  type MdmResolution,
  type RuleResult,
  type SignedEncounterSnapshot,
  type TerminologyResolution,
  type ValidationContext,
  addDaysIso,
  applySequestrationPolicy,
  calculateHipps,
  calculateSia,
  deriveControlNumber,
  deriveTypeOfBill,
  isSkipped,
  isWithinInclusive,
  repositories,
  summarizeRuleRun,
} from "@wardenx/billing";
import type { BillingRuleRegistry } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";

// The org-context transaction handle every repo writes through (structurally a `BillingDb`). withOrgContext
// hands back this handle with `app.org_id` / `app.user_id` already set transaction-locally.
type BillingDb = repositories.BillingDb;

// Row-insert types are derived from the §3.3 repository append signatures (NOT imported from the central
// Drizzle schema barrel) so this file carries no cross-module schema-path import literal — the table-ownership
// scanner only flags a file that BOTH imports a `*schema*` path AND names another module's table const, and
// this service legitimately names M6/M8 concepts (election/level-of-care/encounter) in its seam vocabulary.
type NewSiaCalculationInput = Parameters<repositories.SiaCalculationRepository["append"]>[0];
type NewValidationResultInput = Parameters<repositories.ValidationResultRepository["append"]>[0];

/** The MAC jurisdiction alphabet (the frozen `m23_mac_jurisdiction` enum), derived — never re-listed. */
type MacJurisdiction = repositories.ClaimRecord["macJurisdiction"];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Injected ports — the SHAPE of seam injection. Each return value reuses a `@wardenx/billing` aggregate
// snapshot type so the service and the §11.A rule context speak one vocabulary. The composition root binds
// the live M5/M6/M8/M18/M38/M40 readers + the platform reference-data + the transactional-outbox ports.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** An inclusive ISO calendar-date window. */
export interface DateRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/** M5 — the patient-payer / coordination-of-benefits resolution for the Medicare-primary gate (D15). */
export interface MedicarePrimaryResolution {
  /** The `patient_payer` snapshot id stamped onto the claim (NEVER the MBI). */
  readonly patientPayerId: string;
  /** True iff Medicare FFS Part A is the PRIMARY payer across the window (D15 assembly gate). */
  readonly medicarePrimary: boolean;
}

export interface PatientPayerReader {
  medicarePrimaryForRange(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<MedicarePrimaryResolution | null>;
}

/** M6 — the admission anchor facts the assembly + the HIPPS day-of-stay bucket + the TOB derivation need. */
export interface AdmissionContext {
  readonly admissionId: string;
  /** The hospice election/admission date — anchors the RHC days-1-7 vs days-8+ bucket (D7). */
  readonly hospiceAdmissionDate: IsoDate;
  readonly dischargeDate: IsoDate | null;
  readonly dischargeReason: string | null;
  /** M5/M6 date of death (drives SIA + the PATIENT_DECEASED_BEFORE_FROM gate); `null` ⇒ alive. */
  readonly deceasedDate: IsoDate | null;
}

export interface AdmissionContextReader {
  resolveForRange(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<AdmissionContext | null>;
}

/** M6 — an election period covering the window, carrying its id (the claim's election-scope columns). */
export interface ResolvedElectionPeriod extends ElectionPeriodSnapshot {
  readonly electionPeriodId: string;
}

export interface ElectionPeriodReader {
  coveringRange(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<readonly ResolvedElectionPeriod[]>;
}

/** M6 — certification (CTI) facts per election period. */
export interface CertificationReader {
  forPatient(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<readonly CertificationSnapshot[]>;
}

/** M6 — face-to-face attestation facts (required for periods ≥ 3). */
export interface FaceToFaceReader {
  forPatient(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<readonly FaceToFaceSnapshot[]>;
}

/** M6 — a level-of-care period within the window, carrying its id (the claim_line's `level_of_care_period_id`). */
export interface ResolvedLevelOfCarePeriod extends LevelOfCarePeriodSnapshot {
  readonly levelOfCarePeriodId: string;
}

export interface LevelOfCareReader {
  periodsInRange(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<readonly ResolvedLevelOfCarePeriod[]>;
}

/** M8 — billable-encounter resolution (D10). `awaiting_cosignature` visits are surfaced but EXCLUDED from lines. */
export interface BillableEncounterReader {
  forRange(
    orgId: string,
    providerEntityId: string,
    patientId: string,
    range: DateRange,
  ): Promise<readonly BillableEncounterSnapshot[]>;
}

/** M8 — signed encounters in the last-7-days-of-life window (drives the SIA add-on). */
export interface SignedEncountersReader {
  inWindow(
    orgId: string,
    patientId: string,
    window: DateRange,
  ): Promise<readonly SignedEncounterSnapshot[]>;
}

/** M18 — EVV bracket state per backing encounter (D9). */
export interface EvvComplianceReader {
  bracketsForEncounters(
    orgId: string,
    encounterIds: readonly string[],
  ): Promise<readonly EvvBracketSnapshot[]>;
}

/** M40 — the provider-entity directory entry (CCN + MAC jurisdiction + CBSA) for the control-number + rates. */
export interface ProviderEntityDirectoryEntry {
  /** 6-char CMS Certification Number — the deterministic control-number anchor (D4). */
  readonly ccn: string;
  readonly macJurisdiction: MacJurisdiction;
  readonly cbsaCode: string | null;
}

/** M40 — master-data resolution: the provider-entity directory + the clinical participants (physicians/POS). */
export interface MdmEntityProvider {
  resolveProviderEntity(
    orgId: string,
    providerEntityId: string,
  ): Promise<ProviderEntityDirectoryEntry | null>;
  resolveClinicalParticipants(
    orgId: string,
    patientId: string,
    asOf: IsoDate,
  ): Promise<MdmResolution>;
}

/** M38 — terminology resolution (value-set membership + ICD billability) as-of `claim.service_from`. */
export interface TerminologyProvider {
  resolveForClaim(orgId: string, asOfDate: IsoDate): Promise<TerminologyResolution>;
}

/** Platform reference-data resolution (the CMS rate file, wage index, sequestration schedule). */
export interface WageIndexResolution {
  /** The wage-index factor as a decimal STRING (e.g. `"0.9234"`) — never a float (D12). */
  readonly factorDecimal: string;
  readonly cbsaCode: string | null;
}

export interface SequestrationPolicyResolution {
  /** The `sequestration_policy` row id snapshotted onto the claim. */
  readonly sequestrationPolicyId: string;
  /** Decimal STRING (e.g. `"2.00"`) — never a float (D11). */
  readonly percentage: string;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
}

export interface BillingReferenceDataReader {
  /** The CMS per-diem base rate table for the claim's MAC jurisdiction + hospice fiscal year (PRE-wage-index). */
  hippsRateTable(
    macJurisdiction: MacJurisdiction,
    fiscalYearStarting: number,
  ): Promise<HippsRateTable>;
  /** The wage-index-ADJUSTED CHC hourly rate (whole cents) the SIA add-on is priced at. */
  chcHourlyRateCents(fiscalYearStarting: number, wageIndexFactorDecimal: string): Promise<Cents>;
  wageIndexForCcn(ccn: string, fiscalYearStarting: number): Promise<WageIndexResolution | null>;
  activeSequestrationPolicy(
    orgId: string,
    providerEntityId: string,
    serviceFrom: IsoDate,
  ): Promise<SequestrationPolicyResolution | null>;
}

/** §4.10 transactional outbox — the emit commits in the SAME transaction as the assembly mutation (D2). */
export interface AssemblyOutboxPort {
  publish(
    tx: BillingDb,
    event: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The full injected seam bundle the assembly service depends on. */
export interface ClaimAssemblySeams {
  readonly patientPayer: PatientPayerReader; // M5
  readonly admission: AdmissionContextReader; // M6
  readonly electionPeriods: ElectionPeriodReader; // M6
  readonly certifications: CertificationReader; // M6
  readonly faceToFace: FaceToFaceReader; // M6
  readonly levelOfCare: LevelOfCareReader; // M6
  readonly billableEncounters: BillableEncounterReader; // M8
  readonly signedEncounters: SignedEncountersReader; // M8
  readonly evvCompliance: EvvComplianceReader; // M18
  readonly mdm: MdmEntityProvider; // M40
  readonly terminology: TerminologyProvider; // M38
  readonly capProjection: CapProjectionProvider; // M26 — §11.A pre-submission cap rules (degrades, D8)
  readonly referenceData: BillingReferenceDataReader; // platform reference data (M23/M1-owned)
  /** The §11.A rule registry — built + FROZEN at composition (platform-default + MAC + tenant overlays). */
  readonly ruleRegistry: BillingRuleRegistry;
  readonly outbox: AssemblyOutboxPort; // §4.10
  /** Injected clock (deterministic timestamps in tests). */
  readonly now?: () => Date;
}

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

/** Map the resolved place of service to its CMS hospice Q-code; unknown ⇒ Q5006 (unspecified). */
function qCodeForPlaceOfService(
  pos: string | null,
): "Q5001" | "Q5002" | "Q5003" | "Q5005" | "Q5007" | "Q5008" | "Q5006" {
  switch ((pos ?? "").toLowerCase()) {
    case "home":
      return "Q5001";
    case "assisted_living":
    case "alf":
      return "Q5002";
    case "snf":
    case "nf":
      return "Q5003";
    case "ipu":
    case "inpatient_unit":
      return "Q5005";
    case "hospice_facility":
      return "Q5007";
    case "hospital":
      return "Q5008";
    default:
      return "Q5006";
  }
}

/** The CMS hospice fiscal year STARTING year for a service date (the rate year flips each Oct 1). */
function hospiceFiscalYearStarting(serviceFrom: IsoDate): number {
  const year = Number(serviceFrom.slice(0, 4));
  const month = Number(serviceFrom.slice(5, 7));
  return month >= 10 ? year : year - 1;
}

/** Map a per-rule `RuleResult` to the `validation_result.outcome` enum value. */
function resultOutcome(r: RuleResult): "pass" | "fail" | "warn" | "info" {
  if (isSkipped(r)) return "info";
  if (r.passed) return "pass";
  if (r.severity === "error") return "fail";
  if (r.severity === "warn") return "warn";
  return "info";
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

      const admission = await seams.admission.resolveForRange(orgId, patientId, range);
      if (!admission) {
        throw new WardenXError(
          "PATIENT_NOT_ELECTED",
          "no hospice admission covers the service window",
          409,
        );
      }
      if (admission.deceasedDate !== null && admission.deceasedDate < serviceFrom) {
        throw new WardenXError(
          "PATIENT_DECEASED_BEFORE_FROM",
          "the patient died before the claim's service_from",
          409,
        );
      }

      const resolvedPeriods = [
        ...(await seams.electionPeriods.coveringRange(orgId, patientId, range)),
      ].sort((a, b) =>
        a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
      );
      if (resolvedPeriods.length === 0) {
        throw new WardenXError(
          "PATIENT_NOT_ELECTED",
          "no active election covers the service window",
          409,
        );
      }
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

      const certifications = await seams.certifications.forPatient(orgId, patientId, range);
      const faceToFace = await seams.faceToFace.forPatient(orgId, patientId, range);
      const resolvedLoc = await seams.levelOfCare.periodsInRange(orgId, patientId, range);

      const pe = await seams.mdm.resolveProviderEntity(orgId, providerEntityId);
      if (!pe) {
        throw new WardenXError(
          "PROVIDER_ENTITY_UNRESOLVED",
          "the provider entity could not be resolved (M40)",
          422,
        );
      }
      const fiscalYearStarting = hospiceFiscalYearStarting(serviceFrom);
      const wageIndex = await seams.referenceData.wageIndexForCcn(pe.ccn, fiscalYearStarting);
      if (!wageIndex) {
        throw new WardenXError(
          "WAGE_INDEX_UNAVAILABLE",
          `no wage-index factor is loaded for CCN ${pe.ccn} FY${fiscalYearStarting} (D12)`,
          422,
        );
      }
      const rateTable = await seams.referenceData.hippsRateTable(
        pe.macJurisdiction,
        fiscalYearStarting,
      );
      const seqPolicy = await seams.referenceData.activeSequestrationPolicy(
        orgId,
        providerEntityId,
        serviceFrom,
      );
      if (!seqPolicy) {
        throw new WardenXError(
          "SEQUESTRATION_POLICY_UNAVAILABLE",
          "no active sequestration policy resolved for the service period (D11)",
          422,
        );
      }

      const billableEncounters = await seams.billableEncounters.forRange(
        orgId,
        providerEntityId,
        patientId,
        range,
      );
      const billableIds = billableEncounters
        .filter((e) => e.billability === "billable") // D10: awaiting_cosignature excluded entirely
        .map((e) => e.encounterId);
      const evvBrackets = await seams.evvCompliance.bracketsForEncounters(orgId, billableIds);
      const mdmResolution = await seams.mdm.resolveClinicalParticipants(
        orgId,
        patientId,
        serviceFrom,
      );
      const terminology = await seams.terminology.resolveForClaim(orgId, serviceFrom);
      // M26 §11.A cap projection (D8). Cap year is the federal FY (Oct–Sep): a service date in Oct–Dec
      // belongs to the NEXT FY. The provider degrades to status:"unavailable" when M26 is unbound or has no
      // projection — the cap rules then warn-skip; a bound projection makes them live (warn-or-block, D8).
      const capServiceYear = Number(serviceFrom.slice(0, 4));
      const capServiceMonth = Number(serviceFrom.slice(5, 7));
      const capYear = capServiceMonth >= 10 ? capServiceYear + 1 : capServiceYear;
      const [capOrg, capPatient] = await Promise.all([
        seams.capProjection.projectionForOrg(orgId, providerEntityId, capYear),
        seams.capProjection.projectionForPatient(orgId, patientId, capYear),
      ]);
      const capProjectionBound = capOrg.status === "ok" && capPatient.status === "ok";
      const capProjectionCtx = capProjectionBound
        ? {
            patientWithinCap: capPatient.withinCap ?? true,
            orgPctOfCap: capOrg.pctOfCap ?? 0,
            ipuWithinCap: capOrg.ipuWithinCap ?? true,
          }
        : null;

      // SIA only when deceased; gather the last-7-days-of-life signed visits.
      let signedEncounters: readonly SignedEncounterSnapshot[] = [];
      if (admission.deceasedDate !== null) {
        const window: DateRange = {
          from: addDaysIso(admission.deceasedDate, -6),
          to: admission.deceasedDate,
        };
        signedEncounters = await seams.signedEncounters.inWindow(orgId, patientId, window);
      }

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
        const patientDischarged =
          admission.dischargeDate !== null && admission.dischargeDate <= serviceTo;
        const tob = deriveTypeOfBill({
          hasPriorClaimForAdmission,
          patientDischarged,
          adjustment: "none",
        });

        // ── 3. HIPPS per-diem math (D7) — lines are derived, never client-supplied ───────────────────
        const hipps = calculateHipps({
          claimServiceFrom: serviceFrom,
          claimServiceTo: serviceTo,
          hospiceAdmissionDate: admission.hospiceAdmissionDate,
          levelOfCarePeriods: resolvedLoc.map((p) => ({
            levelOfCare: p.levelOfCare,
            from: p.from,
            to: p.to,
          })),
          rateTable,
          wageIndexCcn: pe.ccn,
          wageIndexFiscalYear: fiscalYearStarting,
          wageIndexFactorDecimal: wageIndex.factorDecimal,
        });

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
            icdPointerPositions: [],
            modifiers: [],
          };
        });

        // ── 4. SIA add-on math (D6) — purely encounter-derived ───────────────────────────────────────
        let siaCents: Cents = 0;
        let siaQualifyingVisitCount = 0;
        let siaRow: NewSiaCalculationInput | null = null;
        if (admission.deceasedDate !== null) {
          const chcHourlyRateCents = await seams.referenceData.chcHourlyRateCents(
            fiscalYearStarting,
            wageIndex.factorDecimal,
          );
          const sia = calculateSia({
            deceasedDate: admission.deceasedDate,
            chcHourlyRateCents,
            signedEncounters: signedEncounters.map((e) => ({
              encounterId: e.encounterId,
              serviceDate: e.serviceDate,
              discipline: e.discipline,
              durationMinutes: e.durationMinutes,
              signed: e.signed,
            })),
          });
          if (sia.present) {
            siaCents = sia.siaAddOnCents;
            siaQualifyingVisitCount = sia.qualifyingVisits.length;
            siaRow = {
              organizationId: orgId,
              claimId: "", // filled below
              patientDeceasedDate: sia.patientDeceasedDate as IsoDate,
              windowStart: sia.windowStart as IsoDate,
              qualifyingVisits: sia.qualifyingVisits.map((v) => ({
                encounterId: v.encounterId,
                visitDate: v.visitDate,
                discipline: v.discipline,
                durationMinutes: v.durationMinutes,
              })),
              totalQualifyingMinutes: sia.totalQualifyingMinutes,
              siaAddOnCents: sia.siaAddOnCents,
            };
          }
        }

        // ── 5. Sequestration (D11) over the gross HIPPS + SIA payable ────────────────────────────────
        const grossCents: Cents = hipps.totalCents + siaCents;
        const sequestration = applySequestrationPolicy(grossCents, {
          percentage: seqPolicy.percentage,
        });

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
          totalChargeCents: grossCents,
          totalExpectedPaymentCents: sequestration.netCents,
          sequestrationAppliedPct: sequestration.percentApplied,
          sequestrationPolicyId: seqPolicy.sequestrationPolicyId,
          latestValidationRunId: validationRunId, // logical pointer; the run row is appended below
          createdByMembershipId: actor.membershipId,
        });

        const insertedLines = await new repositories.ClaimLineRepository(tx).insertBatch(
          lineInputs.map((l) => ({ ...l, claimId })),
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
        });

        if (siaRow) {
          await new repositories.SiaCalculationRepository(tx).append({ ...siaRow, claimId });
        }

        // ── 7. Initial §11.A validation pass — recorded as a COMPLETE validation_run (trigger initial_assembly) ─
        const ctx: ValidationContext = {
          orgId,
          asOfDate: serviceFrom,
          macJurisdiction: pe.macJurisdiction,
          claim: {
            claimId,
            providerEntityId,
            patientId,
            admissionId: admission.admissionId,
            tob,
            serviceFrom,
            serviceTo,
            replacesClaimId: null,
            icd10Sequence: [],
            totalChargeCents: grossCents,
            priorClaimTob: priorClaim?.tob ?? null,
            priorClaimServiceTo: priorClaim?.serviceTo ?? null,
            dischargeDate: admission.dischargeDate,
            dischargeReason: admission.dischargeReason,
          },
          lines: insertedLines.map((row) => ({
            claimLineId: row.id,
            serviceDate: row.serviceDateFrom,
            revenueCode: row.revenueCode,
            qCode: row.qCode,
            levelOfCare: row.levelOfCare,
            hcpcs: row.hcpcsCode,
            modifiers: row.modifiers,
            unitCount: row.unitCount,
            unitRateCents: row.unitRateCents,
            lineChargeCents: row.lineChargeCents,
            icdPointerPositions: row.icdPointerPositions,
            backingEncounterIds: row.backingEncounterIds,
          })),
          electionPeriods: resolvedPeriods.map(({ electionPeriodId: _id, ...rest }) => rest),
          certifications,
          faceToFace,
          levelOfCarePeriods: resolvedLoc.map(({ levelOfCarePeriodId: _id, ...rest }) => rest),
          billableEncounters,
          signedEncounters,
          evvBrackets,
          terminology,
          mdm: mdmResolution,
          hipps: {
            hippsCode: hipps.hippsCode,
            perDiemRateCents: hipps.perDiemRateCents,
            wageIndexFactorApplied: wageIndex.factorDecimal,
            segments: hipps.segments.map((s) => ({
              levelOfCare: s.levelOfCare,
              dateFrom: s.dateFrom,
              dateTo: s.dateTo,
              ratePerDiemCents: s.ratePerDiemCents,
              rhcDayBucket: s.rhcDayBucket,
            })),
          },
          sia:
            siaQualifyingVisitCount > 0
              ? {
                  present: true,
                  qualifyingVisitCount: siaQualifyingVisitCount,
                  amountCents: siaCents,
                  doubleCounted: false,
                }
              : null,
          capProjection: capProjectionCtx, // M26 §11.A live projection (or null → cap rules warn-skip, D8)
          eligibility: null, // resolved by the HETS refresh worker, not at assembly — the rule skips
          noe: null,
          sequestration: {
            percentage: seqPolicy.percentage,
            effectiveFrom: seqPolicy.effectiveFrom,
            effectiveTo: seqPolicy.effectiveTo,
          },
          wageIndex: {
            ccn: pe.ccn,
            fiscalYearStarting,
            factorDecimal: wageIndex.factorDecimal,
            cbsaCode: wageIndex.cbsaCode,
          },
          seams: {
            capProjectionBound,
            mdmResolverBound: true,
            terminologyBound: true,
            eligibilityBound: false,
          },
        };

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
              totalChargeCents: grossCents,
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
              remediation: (r.annotations?.remediation ??
                {}) as NewValidationResultInput["remediation"],
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
          totalChargeCents: grossCents,
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
