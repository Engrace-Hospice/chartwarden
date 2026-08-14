// apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts — the Drizzle-backed M24 WRITE
// service. Each command runs under withOrgContext (RLS), validates the §2.2 transition via the pure
// @wardenx/medicaid-adapters reducers, stamps the acting membership, writes an append-only
// medicaid_claim_state_history row, and emits the §4.11 outbox event on the caller's tx (transactional
// outbox). A bad transition → INVALID_TRANSITION (409); a stale If-Match → VERSION_CONFLICT (409); a missing
// row → NOT_FOUND. Money is INTEGER cents; no MBI/Recipient ID enters an outbox payload (D12 / D13 / §3.6).
//
// DEFERRAL (the M25/M26 posture): commands that need an unbound consumed reader DEGRADE to a structured typed
// error / queued no-op rather than crashing — assembleClaim (M5/M6/M40 readers), refreshEligibility (M5
// unlock + the per-state 270/271 adapter), testCredential + submitClaim adapter wire I/O (the state adapter),
// loadRateSchedule (M40), registerPlatformRule (rules are the frozen code registry). Each is noted at its site.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_MEDICAID_RULES,
  DEFAULT_MEDICAID_RULE_SET_VERSION,
  type MedicaidValidationContext,
  type PlaceOfServiceFacilityKind,
  type PlaceOfServiceResidenceKind,
  buildHospiceLines,
  deriveMedicaidControlNumber,
  medicaidClaimMachine,
  parseMedicaidControlNumber,
  rbArrangementMachine,
  replacementTob,
  runMedicaidRules,
  voidTob,
} from "@wardenx/medicaid-adapters";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { CredentialCipherPort } from "../credential-crypto";
import type { M24WriteActor } from "./actor";
import type { ClaimView, RbArrangementView } from "./read-service";
import type {
  ApplyOverrideInput,
  AssembleClaimInput,
  CreateCustomRuleInput,
  CreateRbArrangementInput,
  EditRbArrangementInput,
  EditRuleConfigInput,
  LoadRateScheduleInput,
  M24WriteService,
  OverrideRbDayInput,
  RefreshEligibilityInput,
  RegisterPlatformRuleInput,
  ReplaceClaimInput,
  SubmitClaimInput,
  TerminateRbArrangementInput,
  UpdateDraftClaimInput,
  UpsertCredentialInput,
  VoidClaimInput,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

class ConflictError extends WardenXError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "ConflictError";
  }
}
class DegradedError extends WardenXError {
  constructor(code: string, message: string) {
    super(code, message, 503);
    this.name = "DegradedError";
  }
}

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const day = (d: Date | string | null): string => iso(d).slice(0, 10);
const dayN = (d: Date | string | null): string | null => (d === null ? null : day(d));

/**
 * Refuse to store a secret when no cipher port is bound, rather than dropping it. The pre-crypto placeholder
 * accepted the secret and wrote a sentinel — the caller believed it was saved. Failing loudly is the only
 * honest option when the KEK is absent.
 */
const UNBOUND_CIPHER: CredentialCipherPort = {
  seal() {
    throw new DegradedError(
      "CREDENTIAL_CRYPTO_UNBOUND",
      "credential secrets cannot be stored — M24_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  },
  open() {
    throw new DegradedError(
      "CREDENTIAL_CRYPTO_UNBOUND",
      "credential secrets cannot be read — M24_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  },
};

/**
 * How the write path resolves a patient's Medicaid coverage. Bound at the composition root to M5's §3.4
 * `PatientCoverageReader` seam (via getSeam); left undefined in a slice/test, where the paths that need it
 * degrade with a precise message instead of a blanket "readers unbound".
 */
export interface CoverageResolverPort {
  activeMedicaidCoverage(input: {
    organizationId: string;
    patientId: string;
    onDate: string;
  }): Promise<{ id: string; payerId: string; subscriberId: string } | null>;
}

/**
 * How the write path resolves a provider entity's CMS Certification Number (the control-number namespace,
 * D4). `provider_entity` is M1-owned — the table-ownership gate forbids this module's own Drizzle schema
 * from touching it, so the read lives at the composition root (outside every module's codePaths) and is
 * injected here, mirroring `CoverageResolverPort`'s "degrade with a precise message" posture when absent.
 */
export interface ProviderEntityCcnReader {
  ccnForProviderEntity(organizationId: string, providerEntityId: string): Promise<string | null>;
}

/** M6's `level_of_care_period` raw list (per-line assembly follow-up). `level_of_care_period` is M6-owned —
 * same "composition-root escape valve" posture as `ProviderEntityCcnReader` (the read lives outside every
 * module's codePaths in apps/backend/src/index.ts, injected here as a narrow port). `facilityId`/
 * `ipuBedAssignmentId` (place-of-service follow-up) are the same two pre-existing M6 columns, just now
 * also selected — M6's own write path does not populate them for IRC/GIP yet (a separate, pre-existing
 * M6-T04 gap — `changeLoc` hardcodes `facilityId: null`), so they read null in practice until that lands;
 * reading them regardless costs nothing and needs no further M24 change once M6 starts writing them. */
export interface LevelOfCarePeriodReaderPort {
  periodsForAdmission(
    organizationId: string,
    admissionId: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      levelOfCare:
        | "routine_home_care"
        | "continuous_home_care"
        | "inpatient_respite_care"
        | "general_inpatient_care";
      effectiveAt: Date;
      endedAt: Date | null;
      facilityId: string | null;
      ipuBedAssignmentId: string | null;
    }>
  >;
}

/** `facility.kind` (M40) for a batch of facility ids (place-of-service follow-up). `facility` is
 * NON_ORG_SCOPED/M40-owned — same composition-root escape-valve posture as `LevelOfCarePeriodReaderPort`.
 * Batched (not per-id) so resolving a claim's LOC periods + residence never issues more than one query. */
export interface FacilityKindReaderPort {
  kindsFor(
    facilityIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlaceOfServiceFacilityKind>>;
}

/**
 * M40's LIVE `MdmEntityProvider` seam, narrowed to the one question an R&B arrangement asks it
 * (GAP-040): what is this nursing facility's canonical display name, right now, at contract time?
 *
 * `rb_arrangement.nf_facility_name_snapshot` is a SNAPSHOT — the name as it stood when the contract was
 * signed, deliberately frozen against later MDM renames, and surfaced verbatim through the read API. It
 * was written as the literal string "[unresolved — M40 facility resolver deferred]" on every create,
 * even though M40's provider has been registered over a Drizzle store at boot since M40 landed.
 *
 * Resolved through the SEAM rather than a direct `facility` read (the `FacilityKindReaderPort`
 * escape-valve above) because the seam chases `merged_into_id` (§7.2): a facility canonical that was
 * merged after the tenant picked it must snapshot the SURVIVOR's name, not a dead row's.
 */
export interface FacilityNameResolverPort {
  resolveFacility(
    orgId: string,
    id: string,
  ): Promise<{ readonly canonical: { readonly displayName: string } } | null>;
}

/** M5's LIVE `PatientAddressReader` seam (place-of-service follow-up) — the patient's residence kind/
 * facility as of a given date, for RHC/CHC's home-vs-facility Q-code disambiguation. Optional: an absent
 * binding degrades to the LOC-based Q-code default (via `resolvePlaceOfServiceQCode`'s own fallback), not
 * a hard failure — residence is a refinement, not a required input to assembling the claim. */
export interface ResidenceReaderPort {
  residenceAt(
    organizationId: string,
    patientId: string,
    asOfDate: string,
  ): Promise<{ kind: PlaceOfServiceResidenceKind; facilityId: string | null } | null>;
}

/** M8's LIVE `SignedEncountersReader` seam, narrowed to what claim assembly needs (backing-encounter
 * evidence for a line, not the full digest). Bound at the composition root via `getSeam`. Optional: an
 * absent binding degrades to zero linked encounters rather than blocking assembly — the LOC period is the
 * authoritative billing basis; encounter linkage is supplementary audit evidence, not a NOT-NULL input. */
export interface SignedEncounterWindowReaderPort {
  encountersInWindow(
    organizationId: string,
    patientId: string,
    from: string,
    to: string,
  ): Promise<ReadonlyArray<{ encounterId: string; serviceDate: string }>>;
}

const LOC_BY_M6_ENUM: Record<
  | "routine_home_care"
  | "continuous_home_care"
  | "inpatient_respite_care"
  | "general_inpatient_care",
  "RHC" | "CHC" | "IRC" | "GIP"
> = {
  routine_home_care: "RHC",
  continuous_home_care: "CHC",
  inpatient_respite_care: "IRC",
  general_inpatient_care: "GIP",
};

export function buildDrizzleM24WriteService(
  db: DbClient,
  outbox: WriteOutboxPort = NOOP_OUTBOX,
  cipher: CredentialCipherPort = UNBOUND_CIPHER,
  coverage?: CoverageResolverPort,
  ccnReader?: ProviderEntityCcnReader,
  locPeriodReader?: LevelOfCarePeriodReaderPort,
  signedEncounters?: SignedEncounterWindowReaderPort,
  facilityKindReader?: FacilityKindReaderPort,
  residenceReader?: ResidenceReaderPort,
  facilityNames?: FacilityNameResolverPort,
): M24WriteService {
  const C = schema.medicaidClaim;
  const SUB = schema.medicaidSubmission;
  const VR = schema.medicaidValidationRun;
  const VRES = schema.medicaidValidationResult;
  const VOV = schema.medicaidValidationOverride;
  const RC = schema.medicaidValidationRuleConfig;
  const A = schema.rbArrangement;
  const RD = schema.rbDay;
  const TP = schema.stateMedicaidTradingPartnerCredential;
  const SH = schema.medicaidClaimStateHistory;
  const SPC = schema.medicaidStatePlanCode;
  const SRS = schema.medicaidStateRateSchedule;
  const L = schema.medicaidClaimLine;
  const LE = schema.medicaidClaimLineEncounter;
  const RULES_BY_KEY = new Map(DEFAULT_MEDICAID_RULES.map((r) => [r.key, r]));

  async function loadClaim(tx: Tx, claimId: string) {
    const rows = await tx.select().from(C).where(eq(C.id, claimId)).limit(1);
    if (!rows[0]) throw new NotFoundError("medicaid claim not found");
    return rows[0];
  }

  /**
   * GAP-040 — resolve the NF's canonical display name for the contract snapshot. FAILS the write when
   * the resolver is unbound or the id resolves to nothing: an R&B arrangement names a real nursing
   * facility the agency has a pass-through contract with, and a snapshot that says anything other than
   * that facility's name is worse than no arrangement at all — it is surfaced verbatim on the
   * arrangement view and read as the contracted party. A placeholder is not a degraded answer here, it
   * is a wrong one.
   */
  async function resolveNfFacilityName(orgId: string, facilityMdmId: string): Promise<string> {
    if (!facilityNames) {
      throw new DegradedError(
        "MDM_FACILITY_RESOLVER_UNBOUND",
        "the NF facility name cannot be snapshotted — M40's MdmEntityProvider is not bound",
      );
    }
    const resolved = await facilityNames.resolveFacility(orgId, facilityMdmId);
    if (!resolved) {
      throw new WardenXError(
        "NF_FACILITY_NOT_FOUND",
        `no M40 facility resolves for '${facilityMdmId}' — pick the facility from the master-data list`,
        422,
      );
    }
    return resolved.canonical.displayName;
  }
  function assertVersion(row: { version: number }, expected: number | null): void {
    if (expected !== null && row.version !== expected) {
      throw new ConflictError(
        "VERSION_CONFLICT",
        "the If-Match version is stale; reload and retry",
      );
    }
  }
  async function recordHistory(
    tx: Tx,
    orgId: string,
    claimId: string,
    fromState: (typeof C.state.enumValues)[number] | null,
    toState: (typeof C.state.enumValues)[number],
    actorMembershipId: string,
    reason: string | null,
  ): Promise<void> {
    await tx.insert(SH).values({
      organizationId: orgId,
      medicaidClaimId: claimId,
      fromState,
      toState,
      reason,
      triggerSource: "user",
      actorMembershipId,
    });
  }

  function toClaimView(r: typeof C.$inferSelect): ClaimView {
    return {
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
    };
  }
  function toArrangementView(r: typeof A.$inferSelect): RbArrangementView {
    return {
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
    };
  }

  return {
    // ── route 1 — assemble. The claim row needs three externally-owned values: `patient_payer_id` (M5),
    // `service_state` (the state whose Medicaid program is billed) and `state_plan_code_id` (WX-PR-011:
    // resolved from the M24-owned `medicaid_state_plan_code` platform catalog — see the schema file's
    // deviation note on why this is self-owned rather than routed through M40's entity-merge engine).
    // M5's §3.4 PatientCoverageReader gives the coverage; the service state is read from the provider
    // entity's own active trading-partner credential (an M24-owned row: you cannot bill a state you hold
    // no credential for, which makes it the authoritative source, not a guess).
    //
    // PER-LINE ASSEMBLY (WX-PR-011 follow-up, closed): walks M6 LOC periods into hospice-LOC lines
    // (RHC/CHC/IRC/GIP, one line per contiguous same-LOC segment clipped to the claim window, rate from
    // the M24-owned `medicaid_state_rate_schedule` platform catalog) and M24's own `rb_day` sweep output
    // into R&B lines (NF_RB, one line per billable day, rate = the facility's own contracted per-diem —
    // never the state schedule, per audit finding M24-F02). `kind` gates which family runs
    // (`hospice_only`/`rb_only` skip the other). Backing M8 encounter evidence links via
    // `medicaid_claim_line_encounter` when the signed-encounters reader is bound (optional — supplementary
    // audit evidence, not a structural input).
    async assembleClaim(actor: M24WriteActor, input: AssembleClaimInput): Promise<ClaimView> {
      if (!coverage) {
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "claim assembly requires M5's PatientCoverageReader seam (not bound in this environment)",
        );
      }
      const resolved = await coverage.activeMedicaidCoverage({
        organizationId: actor.organizationId,
        patientId: input.patientId,
        onDate: input.serviceFrom,
      });
      if (!resolved) {
        throw new ConflictError(
          "MEDICAID_COVERAGE_NOT_IN_FORCE",
          "this patient holds no Medicaid coverage in force on the claim's first service date",
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const creds = await tx
          .select({ serviceState: TP.serviceState, activeTo: TP.activeTo })
          .from(TP)
          .where(
            and(
              eq(TP.organizationId, actor.organizationId),
              eq(TP.providerEntityId, input.providerEntityId),
            ),
          );
        const from = new Date(input.serviceFrom);
        const serviceState =
          creds.find((c) => c.activeTo === null || c.activeTo >= from)?.serviceState ?? null;
        if (!serviceState) {
          throw new ConflictError(
            "MEDICAID_NO_ACTIVE_TRADING_PARTNER",
            "this provider entity has no active state trading-partner credential — configure one before assembling a Medicaid claim",
          );
        }
        const planRows = await tx
          .select({ id: SPC.id, planCode: SPC.planCode })
          .from(SPC)
          .where(
            and(
              eq(SPC.stateCode, serviceState),
              eq(SPC.isStateDefault, true),
              lte(SPC.effectiveFrom, from),
              or(isNull(SPC.effectiveTo), gte(SPC.effectiveTo, from)),
            ),
          )
          .orderBy(desc(SPC.effectiveFrom))
          .limit(1);
        const plan = planRows[0];
        if (!plan) {
          throw new DegradedError(
            "MEDICAID_STATE_PLAN_CODE_CATALOG_MISSING",
            `no active medicaid_state_plan_code default row is loaded for state ${serviceState} as of ${day(input.serviceFrom)} — load the platform catalog before assembling a ${serviceState} claim`,
          );
        }
        if (!ccnReader) {
          throw new DegradedError(
            "MEDICAID_CCN_READER_UNBOUND",
            "claim assembly requires the provider-entity CCN reader (not bound in this environment)",
          );
        }
        const ccn = await ccnReader.ccnForProviderEntity(
          actor.organizationId,
          input.providerEntityId,
        );
        if (!ccn) {
          throw new ConflictError(
            "MEDICAID_PROVIDER_ENTITY_NOT_FOUND",
            "the provider entity on this claim does not exist or carries no CCN",
          );
        }
        const claimId = randomUUID();
        const controlNumber = deriveMedicaidControlNumber({
          ccn,
          serviceState,
          serviceFrom: day(input.serviceFrom),
          claimId,
          attemptIndex: 0,
        });
        const inserted = await tx
          .insert(C)
          .values({
            id: claimId,
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            patientId: input.patientId,
            patientPayerId: resolved.id,
            admissionId: input.admissionId,
            serviceState,
            kind: input.kind,
            tob: "811", // the original-claim TOB (D13 §2.5) — replace/void derive 817/818 from this
            serviceFrom: new Date(input.serviceFrom),
            serviceTo: new Date(input.serviceTo),
            statePlanCodeId: plan.id,
            statePlanCodeSnapshot: plan.planCode,
            rbArrangementId: input.rbArrangementId ?? null,
            medicareClaimId: input.medicareClaimId ?? null,
            medicaidClaimControlNumber: controlNumber,
            state: "DRAFT",
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          })
          .returning();

        // ── per-line assembly (WX-PR-011 follow-up): walk M6 LOC periods into hospice-LOC lines
        // (RHC/CHC/IRC/GIP) and M24's own `rb_day` sweep output into R&B lines (NF_RB). Header-only
        // assembly (zero lines) was the prior scope cut; this closes it for real for both line families.
        let nextLineNumber = 1;
        if (input.kind !== "rb_only") {
          if (!locPeriodReader) {
            throw new DegradedError(
              "MEDICAID_LOC_PERIOD_READER_UNBOUND",
              "claim assembly requires the M6 level-of-care period reader (not bound in this environment)",
            );
          }
          const rawPeriods = await locPeriodReader.periodsForAdmission(
            actor.organizationId,
            input.admissionId,
          );
          // place-of-service (WX-PR-011 follow-up #2): resolve the real facts per period BEFORE calling
          // the pure buildHospiceLines — one residence lookup + one batched facility-kind lookup, anchored
          // to each period's own start date (not the claim's), so a mid-claim LOC change resolves against
          // the address/facility that was actually current when that period began.
          const facilityIdsToResolve = new Set<string>();
          for (const p of rawPeriods) if (p.facilityId) facilityIdsToResolve.add(p.facilityId);
          const residenceByPeriod = new Map<
            string,
            { kind: PlaceOfServiceResidenceKind; facilityId: string | null } | null
          >();
          if (residenceReader) {
            for (const p of rawPeriods) {
              const residence = await residenceReader.residenceAt(
                actor.organizationId,
                input.patientId,
                day(p.effectiveAt),
              );
              residenceByPeriod.set(p.id, residence);
              if (residence?.facilityId) facilityIdsToResolve.add(residence.facilityId);
            }
          }
          const facilityKinds = facilityKindReader
            ? await facilityKindReader.kindsFor([...facilityIdsToResolve])
            : new Map<string, PlaceOfServiceFacilityKind>();
          const locPeriods = rawPeriods.map((p) => {
            const residence = residenceByPeriod.get(p.id) ?? null;
            return {
              levelOfCarePeriodId: p.id,
              levelOfCare: LOC_BY_M6_ENUM[p.levelOfCare],
              from: day(p.effectiveAt),
              to: p.endedAt ? day(p.endedAt) : null,
              placeOfService: {
                ownIpuBed: p.ipuBedAssignmentId !== null,
                locPeriodFacilityKind: p.facilityId
                  ? (facilityKinds.get(p.facilityId) ?? null)
                  : null,
                residenceKind: residence?.kind ?? null,
                residenceFacilityKind: residence?.facilityId
                  ? (facilityKinds.get(residence.facilityId) ?? null)
                  : null,
              },
            };
          });
          const encounters = signedEncounters
            ? await signedEncounters.encountersInWindow(
                actor.organizationId,
                input.patientId,
                input.serviceFrom,
                input.serviceTo,
              )
            : [];
          const rateRows = await tx
            .select({
              id: SRS.id,
              levelOfCare: SRS.levelOfCare,
              rateCents: SRS.rateCents,
              effectiveFrom: SRS.effectiveFrom,
            })
            .from(SRS)
            .where(
              and(
                eq(SRS.stateCode, serviceState),
                isNull(SRS.countyCode),
                lte(SRS.effectiveFrom, from),
                or(isNull(SRS.effectiveTo), gte(SRS.effectiveTo, from)),
              ),
            )
            .orderBy(desc(SRS.effectiveFrom));
          const rateByLoc = new Map<string, { rateCents: number; scheduleId: string }>();
          for (const r of rateRows) {
            if (!rateByLoc.has(r.levelOfCare)) {
              rateByLoc.set(r.levelOfCare, { rateCents: r.rateCents, scheduleId: r.id });
            }
          }
          const { lines: hospiceLines, missingRateSegments } = buildHospiceLines({
            serviceFrom: day(input.serviceFrom),
            serviceTo: day(input.serviceTo),
            locPeriods,
            rateFor: (loc) => rateByLoc.get(loc) ?? null,
            encounters,
            startingLineNumber: nextLineNumber,
          });
          if (missingRateSegments.length > 0) {
            throw new DegradedError(
              "MEDICAID_STATE_RATE_SCHEDULE_MISSING",
              `no active medicaid_state_rate_schedule row for ${missingRateSegments
                .map((s) => `${s.levelOfCare} ${s.from}..${s.to}`)
                .join(", ")} — load the platform rate schedule before assembling this claim`,
            );
          }
          if (hospiceLines.length === 0) {
            throw new ConflictError(
              "MEDICAID_NO_BILLABLE_LOC_DAYS",
              "no M6 level-of-care period overlaps this claim's service window — nothing to bill",
            );
          }
          for (const ln of hospiceLines) {
            const insertedLine = await tx
              .insert(L)
              .values({
                organizationId: actor.organizationId,
                providerEntityId: input.providerEntityId,
                medicaidClaimId: claimId,
                lineNumber: ln.lineNumber,
                serviceDate: new Date(ln.serviceDate),
                revenueCode: ln.revenueCode,
                qCode: ln.qCode,
                levelOfCare: ln.levelOfCare,
                locPeriodId: ln.locPeriodId,
                units: ln.units,
                rateAtAssemblyCents: ln.rateCents,
                stateRateScheduleIdSnapshot: ln.stateRateScheduleId,
                chargesCents: ln.chargesCents,
                isRb: false,
              })
              .returning({ id: L.id });
            for (const encounterId of ln.backingEncounterIds) {
              await tx.insert(LE).values({
                medicaidClaimLineId: insertedLine[0]!.id,
                encounterId,
                organizationId: actor.organizationId,
              });
            }
          }
          nextLineNumber += hospiceLines.length;
        }
        if (input.kind !== "hospice_only" && input.rbArrangementId) {
          const rbDays = await tx
            .select()
            .from(RD)
            .where(
              and(
                eq(RD.organizationId, actor.organizationId),
                eq(RD.rbArrangementId, input.rbArrangementId),
                eq(RD.status, "billable"),
                gte(RD.serviceDate, from),
                lte(RD.serviceDate, new Date(input.serviceTo)),
              ),
            )
            .orderBy(RD.serviceDate);
          for (const rbd of rbDays) {
            const insertedLine = await tx
              .insert(L)
              .values({
                organizationId: actor.organizationId,
                providerEntityId: input.providerEntityId,
                medicaidClaimId: claimId,
                lineNumber: nextLineNumber++,
                serviceDate: rbd.serviceDate,
                revenueCode: "0658",
                qCode: "Q5003",
                levelOfCare: "NF_RB",
                locPeriodId: rbd.locPeriodIdSnapshot,
                units: 1,
                rateAtAssemblyCents: rbd.perDiemCentsSnapshot,
                stateRateScheduleIdSnapshot: null,
                chargesCents: rbd.perDiemCentsSnapshot,
                isRb: true,
                rbDayId: rbd.id,
              })
              .returning({ id: L.id });
            await tx
              .update(RD)
              .set({
                status: "billed",
                medicaidClaimLineId: insertedLine[0]!.id,
                updatedAt: new Date(),
              })
              .where(eq(RD.id, rbd.id));
          }
        }

        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          null,
          "DRAFT",
          actor.userId,
          "assemble",
        );
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.draft_created",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            providerEntityId: input.providerEntityId,
            patientId: input.patientId,
            admissionId: input.admissionId,
            state: "DRAFT",
            kind: input.kind,
            tob: "811",
            serviceFrom: new Date(input.serviceFrom).toISOString(),
            serviceTo: new Date(input.serviceTo).toISOString(),
          },
        });
        return toClaimView(inserted[0]!);
      });
    },

    async updateDraftClaim(actor, claimId, input: UpdateDraftClaimInput) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        if (claim.state !== "DRAFT")
          throw new ConflictError("CLAIM_NOT_DRAFT", "only a DRAFT claim is editable");
        assertVersion(claim, input.expectedVersion);
        const updated = await tx
          .update(C)
          .set({
            mcoId: input.mcoId === undefined ? claim.mcoId : input.mcoId,
            version: claim.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        return toClaimView(updated[0]!);
      });
    },

    async deleteDraftClaim(actor, claimId, expectedVersion) {
      await withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        if (claim.state !== "DRAFT")
          throw new ConflictError("CLAIM_NOT_DRAFT", "only a DRAFT claim is deletable");
        assertVersion(claim, expectedVersion);
        await tx.delete(C).where(eq(C.id, claimId));
      });
    },

    async validateClaim(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        const lineRows = await tx
          .select()
          .from(schema.medicaidClaimLine)
          .where(eq(schema.medicaidClaimLine.medicaidClaimId, claimId))
          .orderBy(schema.medicaidClaimLine.lineNumber);

        // Build the minimal, PHI-free aggregate context. Every reader seam is UNBOUND (deferred), so the
        // seam-gated rules SKIP `seam_not_bound` (non-blocking). The run is honest about its degraded inputs.
        const ctx: MedicaidValidationContext = {
          orgId: actor.organizationId,
          asOfDate: day(claim.serviceFrom),
          serviceState: claim.serviceState,
          claim: {
            claimId: claim.id,
            providerEntityId: claim.providerEntityId,
            patientId: claim.patientId,
            serviceState: claim.serviceState,
            kind: claim.kind,
            tob: claim.tob as MedicaidValidationContext["claim"]["tob"],
            serviceFrom: day(claim.serviceFrom),
            serviceTo: day(claim.serviceTo),
            replacesClaimId: claim.replacesClaimId ?? null,
            medicareClaimId: claim.medicareClaimId ?? null,
            rbArrangementId: claim.rbArrangementId ?? null,
            isDualEligible: claim.medicareClaimId != null,
          },
          lines: lineRows.map((l) => ({
            claimLineId: l.id,
            serviceDate: day(l.serviceDate),
            levelOfCare: l.levelOfCare,
            revenueCode: l.revenueCode,
            qCode: l.qCode,
            modifiers: [
              l.hcpcsModifier1,
              l.hcpcsModifier2,
              l.hcpcsModifier3,
              l.hcpcsModifier4,
            ].filter((m): m is string => typeof m === "string" && m.length > 0),
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
          rateLookups: [],
          medicareSecondary: null,
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
            medicareClaimBound: false,
            capProjectionBound: false,
            mdmBound: false,
            adapterBound: false,
          },
        };

        const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, ctx);
        const runId = randomUUID();
        const now = new Date();
        await tx.insert(VR).values({
          id: runId,
          organizationId: actor.organizationId,
          medicaidClaimId: claimId,
          ruleRegistryVersion: DEFAULT_MEDICAID_RULE_SET_VERSION,
          triggeredBy: "manual",
          claimStateAtTrigger: claim.state,
          idempotencyKey: `${claimId}:${now.getTime()}`,
          actorMembershipId: actor.userId,
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
            organizationId: actor.organizationId,
            medicaidValidationRunId: runId,
            ruleKey: r.ruleKey,
            ruleVersion: RULES_BY_KEY.get(r.ruleKey)?.version ?? 1,
            outcome,
            remediationSummary: r.message.length > 0 ? r.message : null,
          });
        }

        const nextState = summary.blockingFailures === 0 ? "READY" : "FAILED_VALIDATION";
        await tx
          .update(C)
          .set({
            state: nextState,
            validationRunIdLatest: runId,
            updatedAt: now,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId));
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "VALIDATING",
          actor.userId,
          "validate",
        );
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          "VALIDATING",
          nextState,
          actor.userId,
          null,
        );

        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.validation_started",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            validationRunId: runId,
            trigger: "manual",
          },
        });
        await outbox.publish(
          tx,
          nextState === "READY"
            ? {
                eventName: "m24.medicaid_claim.ready_for_submission",
                organizationId: actor.organizationId,
                aggregateKind: "medicaid_claim",
                aggregateId: claimId,
                payload: { organizationId: actor.organizationId, claimId, validationRunId: runId },
              }
            : {
                eventName: "m24.medicaid_claim.validation_failed",
                organizationId: actor.organizationId,
                aggregateKind: "medicaid_claim",
                aggregateId: claimId,
                payload: {
                  organizationId: actor.organizationId,
                  claimId,
                  validationRunId: runId,
                  failedRuleKeys,
                },
              },
        );
        return { validationRunId: runId };
      });
    },

    async submitClaim(actor, claimId, input: SubmitClaimInput) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        assertVersion(claim, input.expectedVersion);
        const reduced = medicaidClaimMachine.reduce(claim.state, "submit", {
          unresolvedBlockingFailures: 0,
        });
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot submit from ${claim.state}`);
        const submissionId = randomUUID();
        const submittedAt = new Date();
        const channel = input.channelHint ?? "direct_mmis";
        // Adapter wire I/O is DEFERRED — the submission row is created in `pending` and the per-state submit
        // worker drives the real envelope when the adapter binds (§4.5/§4.9). The state advances to SUBMITTED.
        await tx.insert(SUB).values({
          id: submissionId,
          organizationId: actor.organizationId,
          medicaidClaimId: claimId,
          providerEntityId: claim.providerEntityId,
          serviceState: claim.serviceState,
          channel,
          mcoIdSnapshot: claim.mcoId ?? null,
          medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
          attemptIndex: 0,
          adapterVendor: "deferred",
          adapterVersion: "0",
          result: "pending",
          createdByMembershipId: actor.userId,
        });
        const updated = await tx
          .update(C)
          .set({
            state: "SUBMITTED",
            version: claim.version + 1,
            updatedAt: submittedAt,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "SUBMITTED",
          actor.userId,
          "submit",
        );
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.submit_requested",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            submissionId,
            medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
            attemptIndex: 0,
            channel,
            mcoId: claim.mcoId ?? null,
          },
        });
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.submitted",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            submissionId,
            medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
            state: "SUBMITTED",
            channel,
            mcoId: claim.mcoId ?? null,
            submittedAt: submittedAt.toISOString(),
          },
        });
        return toClaimView(updated[0]!);
      });
    },

    async replaceClaim(actor, claimId, input: ReplaceClaimInput) {
      return buildSuccessorClaim(actor, claimId, input.expectedVersion, "817", input.reason);
    },
    async voidClaim(actor, claimId, input: VoidClaimInput) {
      return buildSuccessorClaim(actor, claimId, input.expectedVersion, "818", input.reason);
    },

    async abandonClaim(actor, claimId, expectedVersion) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        assertVersion(claim, expectedVersion);
        const reduced = medicaidClaimMachine.reduce(claim.state, "abandon");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot abandon from ${claim.state}`);
        const updated = await tx
          .update(C)
          .set({
            state: "ABANDONED",
            version: claim.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "ABANDONED",
          actor.userId,
          "abandon",
        );
        return toClaimView(updated[0]!);
      });
    },

    async applyOverride(actor, resultId, input: ApplyOverrideInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(VRES).where(eq(VRES.id, resultId)).limit(1);
        const result = rows[0];
        if (!result) throw new NotFoundError("validation result not found");
        const runRows = await tx
          .select({ claimId: VR.medicaidClaimId })
          .from(VR)
          .where(eq(VR.id, result.medicaidValidationRunId))
          .limit(1);
        const claimId = runRows[0]?.claimId ?? "";
        const overrideId = randomUUID();
        await tx.insert(VOV).values({
          id: overrideId,
          organizationId: actor.organizationId,
          medicaidValidationResultId: resultId,
          medicaidClaimId: claimId,
          ruleKey: result.ruleKey,
          overrideRoleApplied: input.overrideRoleClaimed,
          reason: input.reason,
          stepUpAuthTokenAt: new Date(),
          actorMembershipId: actor.userId,
        });
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.override_applied",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            validationRunId: result.medicaidValidationRunId,
            resultId,
            overrideId,
            ruleKey: result.ruleKey,
            overrideRoleApplied: input.overrideRoleClaimed,
          },
        });
        return { overrideId };
      });
    },

    async editRuleConfig(actor, ruleKey, input: EditRuleConfigInput) {
      await withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(RC)
          .where(and(eq(RC.ruleKey, ruleKey), eq(RC.organizationId, actor.organizationId)))
          .limit(1);
        const regReq = RULES_BY_KEY.get(ruleKey)?.regulatoryRequired ?? false;
        if (existing[0]) {
          assertVersion(existing[0], input.expectedVersion);
          await tx
            .update(RC)
            .set({
              enabled: input.enabled ?? existing[0].enabled,
              parametersOverlay: input.parametersOverlay ?? existing[0].parametersOverlay,
              version: existing[0].version + 1,
              updatedAt: new Date(),
              updatedByMembershipId: actor.userId,
            })
            .where(eq(RC.id, existing[0].id));
        } else {
          await tx.insert(RC).values({
            organizationId: actor.organizationId,
            ruleKey,
            enabled: input.enabled ?? true,
            parametersOverlay: input.parametersOverlay ?? null,
            isCustom: false,
            regulatoryRequiredSnapshot: regReq,
            updatedByMembershipId: actor.userId,
          });
        }
      });
    },

    async createCustomRule(actor, input: CreateCustomRuleInput) {
      await withOrgContext(db, actor, async (tx) => {
        await tx.insert(RC).values({
          organizationId: actor.organizationId,
          ruleKey: input.ruleKey,
          enabled: true,
          isCustom: true,
          customPredicateDsl: input.customPredicateDsl,
          customSeverity: input.customSeverity,
          customOverrideRole: input.customOverrideRole ?? null,
          regulatoryRequiredSnapshot: false,
          updatedByMembershipId: actor.userId,
        });
      });
      return { ruleKey: input.ruleKey };
    },

    async deleteCustomRule(actor, ruleKey, expectedVersion) {
      await withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(RC)
          .where(
            and(
              eq(RC.ruleKey, ruleKey),
              eq(RC.organizationId, actor.organizationId),
              eq(RC.isCustom, true),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new NotFoundError("custom rule not found");
        assertVersion(existing[0], expectedVersion);
        await tx.delete(RC).where(eq(RC.id, existing[0].id));
      });
    },

    // ── route 22 — refresh eligibility (DEFERRED: the M5 MedicaidIdUnlockReader + the per-state 270/271
    // adapter are unbound; the row's service_state comes from M5. Degrades to a typed 503; the route exists). ──
    // The per-state 270/271 adapter is still unbound (no live MMIS to ask), but that is no reason to
    // refuse to record a check. M5's §3.4 coverage read supplies the payer + the masked recipient-id tail,
    // so the row is written with outcome `unknown` — an honest "we could not confirm", which the §11
    // freshness rule then treats as a finding. Previously this 503'd and no row existed at all, so the
    // eligibility history and MCO timeline could never populate.
    async refreshEligibility(actor, input: RefreshEligibilityInput) {
      if (!coverage) {
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "eligibility refresh requires M5's PatientCoverageReader seam (not bound in this environment)",
        );
      }
      const resolved = await coverage.activeMedicaidCoverage({
        organizationId: actor.organizationId,
        patientId: input.patientId,
        onDate: input.asOfServiceDate,
      });
      if (!resolved) {
        throw new ConflictError(
          "MEDICAID_COVERAGE_NOT_IN_FORCE",
          "this patient holds no Medicaid coverage in force on the requested service date",
        );
      }
      const serviceState = await withOrgContext(db, actor, async (tx) => {
        const creds = await tx
          .select({ serviceState: TP.serviceState })
          .from(TP)
          .where(eq(TP.organizationId, actor.organizationId))
          .limit(1);
        return creds[0]?.serviceState ?? null;
      });
      if (!serviceState) {
        throw new ConflictError(
          "MEDICAID_NO_ACTIVE_TRADING_PARTNER",
          "no state trading-partner credential is configured — the service state cannot be determined",
        );
      }
      // Only the last 4 of the member id is ever persisted (D12 / §3.6) — the full recipient id is read
      // from the seam, used to derive the tail, and dropped on this line.
      const maskedTail = resolved.subscriberId.slice(-4);
      const checkedAt = new Date();
      const staleAt = new Date(checkedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      const checkId = randomUUID();
      await withOrgContext(db, actor, async (tx) => {
        await tx.insert(schema.medicaidEligibilityCheck).values({
          id: checkId,
          organizationId: actor.organizationId,
          patientId: input.patientId,
          patientPayerId: resolved.id,
          serviceState,
          asOfServiceDate: new Date(input.asOfServiceDate),
          outcome: "unknown",
          recipientIdMaskedAtCheck: maskedTail,
          checkedAt,
          staleAt,
          errorMessage:
            "no state eligibility adapter is wired for this service state — coverage was resolved from the record, not confirmed with the state",
        });
        // The payload must match the REGISTERED §4.11 payloadSchema exactly — the catalog-validating
        // publisher throws on a mismatch and rolls this insert back with it.
        await outbox.publish(tx, {
          eventName: "m24.medicaid_eligibility.checked",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_eligibility_check",
          aggregateId: checkId,
          payload: {
            organizationId: actor.organizationId,
            checkId,
            patientId: input.patientId,
            asOfServiceDate: new Date(input.asOfServiceDate).toISOString(),
            outcome: "unknown",
            mcoId: null,
            checkedAt: checkedAt.toISOString(),
            staleAt: staleAt.toISOString(),
          },
        });
      });
      return { checkId, outcome: "unknown" };
    },

    async createRbArrangement(actor, input: CreateRbArrangementInput) {
      // GAP-040 — snapshot the NF's canonical name from M40 BEFORE the transaction opens: the seam runs
      // its own org-scoped read, and holding a write tx across it would pin a pooled connection for the
      // duration of someone else's query.
      const nfFacilityNameSnapshot = await resolveNfFacilityName(
        actor.organizationId,
        input.nfFacilityMdmId,
      );
      return withOrgContext(db, actor, async (tx) => {
        const inserted = await tx
          .insert(A)
          .values({
            organizationId: actor.organizationId,
            patientId: input.patientId,
            providerEntityId: input.providerEntityId,
            nfFacilityMdmId: input.nfFacilityMdmId,
            nfFacilityNameSnapshot,
            effectiveFrom: new Date(input.effectiveFrom),
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            nfPerDiemRoutineCents: input.nfPerDiemRoutineCents,
            nfPerDiemRespCents: input.nfPerDiemRespCents,
            nfPerDiemGipCents: input.nfPerDiemGipCents,
            passThroughPct: input.passThroughPct,
            retentionPct: input.retentionPct,
            contractDocumentId: input.contractDocumentId ?? null,
            state: "DRAFT",
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          })
          .returning();
        return toArrangementView(inserted[0]!);
      });
    },

    async editRbArrangement(actor, arrangementId, input: EditRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        if (arr.state !== "DRAFT")
          throw new ConflictError("ARRANGEMENT_NOT_DRAFT", "only a DRAFT arrangement is editable");
        assertVersion(arr, input.expectedVersion);
        const updated = await tx
          .update(A)
          .set({
            effectiveTo:
              input.effectiveTo === undefined ? arr.effectiveTo : new Date(input.effectiveTo),
            nfPerDiemRoutineCents: input.nfPerDiemRoutineCents ?? arr.nfPerDiemRoutineCents,
            nfPerDiemRespCents: input.nfPerDiemRespCents ?? arr.nfPerDiemRespCents,
            nfPerDiemGipCents: input.nfPerDiemGipCents ?? arr.nfPerDiemGipCents,
            version: arr.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        return toArrangementView(updated[0]!);
      });
    },

    async activateRbArrangement(actor, arrangementId, expectedVersion) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        assertVersion(arr, expectedVersion);
        const reduced = rbArrangementMachine.reduce(arr.state, "activate");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot activate from ${arr.state}`);
        const updated = await tx
          .update(A)
          .set({
            state: "ACTIVE",
            contractStartedAt: new Date(),
            version: arr.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m24.rb_arrangement.activated",
          organizationId: actor.organizationId,
          aggregateKind: "rb_arrangement",
          aggregateId: row.id,
          payload: {
            organizationId: actor.organizationId,
            rbArrangementId: row.id,
            patientId: row.patientId,
            nfFacilityMdmId: row.nfFacilityMdmId,
            effectiveFrom: day(row.effectiveFrom),
            effectiveTo: dayN(row.effectiveTo),
          },
        });
        return toArrangementView(row);
      });
    },

    async terminateRbArrangement(actor, arrangementId, input: TerminateRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        assertVersion(arr, input.expectedVersion);
        const reduced = rbArrangementMachine.reduce(arr.state, "terminate");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot terminate from ${arr.state}`);
        const terminatedAt = new Date();
        const updated = await tx
          .update(A)
          .set({
            state: "TERMINATED",
            contractTerminatedAt: terminatedAt,
            terminationReason: input.reason,
            version: arr.version + 1,
            updatedAt: terminatedAt,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m24.rb_arrangement.ended",
          organizationId: actor.organizationId,
          aggregateKind: "rb_arrangement",
          aggregateId: row.id,
          payload: {
            organizationId: actor.organizationId,
            rbArrangementId: row.id,
            endedState: "TERMINATED",
            endedAt: terminatedAt.toISOString(),
            reason: input.reason,
          },
        });
        return toArrangementView(row);
      });
    },

    async overrideRbDay(actor, rbDayId, input: OverrideRbDayInput) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(RD).where(eq(RD.id, rbDayId)).limit(1);
        const rbDay = rows[0];
        if (!rbDay) throw new NotFoundError("R&B day not found");
        assertVersion(rbDay, input.expectedVersion);
        const updated = await tx
          .update(RD)
          .set({
            status: input.status,
            exclusionReason: input.exclusionReason ?? rbDay.exclusionReason,
            version: rbDay.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(RD.id, rbDayId))
          .returning({ id: RD.id });
        if (!updated[0]) throw new NotFoundError("R&B day not found");
      });
    },

    async upsertCredential(actor, input: UpsertCredentialInput) {
      return withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(TP)
          .where(
            and(
              eq(TP.organizationId, actor.organizationId),
              eq(TP.providerEntityId, input.providerEntityId),
              eq(TP.serviceState, input.serviceState),
              eq(TP.channel, input.channel),
            ),
          )
          .limit(1);
        // §8.7 envelope encryption under the per-tenant HKDF DEK. A submitted secret is SEALED (never
        // stored plaintext, never returned by any read); an omitted secret leaves the existing cipher
        // untouched, so a PATCH-shaped upsert cannot silently blank a credential. With no KEK bound the
        // seal THROWS — storing a sentinel and reporting success is what the placeholder did wrong.
        const clientSecretCipher =
          input.clientSecret != null
            ? cipher.seal(actor.organizationId, input.clientSecret)
            : (existing[0]?.clientSecretCipher ?? null);
        const sftpKeyCipher =
          input.sftpKey != null
            ? cipher.seal(actor.organizationId, input.sftpKey)
            : (existing[0]?.sftpKeyCipher ?? null);
        let id: string;
        let version: number;
        if (existing[0]) {
          id = existing[0].id;
          version = existing[0].version + 1;
          await tx
            .update(TP)
            .set({
              mcoId: input.mcoId ?? null,
              tradingPartnerId: input.tradingPartnerId,
              clientId: input.clientId ?? null,
              clientSecretCipher,
              sftpHost: input.sftpHost ?? null,
              sftpUser: input.sftpUser ?? null,
              sftpKeyCipher,
              portalUrl: input.portalUrl ?? null,
              activeFrom: new Date(input.activeFrom),
              activeTo: input.activeTo ? new Date(input.activeTo) : null,
              version,
              updatedAt: new Date(),
              updatedByMembershipId: actor.userId,
            })
            .where(eq(TP.id, id));
        } else {
          id = randomUUID();
          version = 1;
          await tx.insert(TP).values({
            id,
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            serviceState: input.serviceState,
            channel: input.channel,
            mcoId: input.mcoId ?? null,
            tradingPartnerId: input.tradingPartnerId,
            clientId: input.clientId ?? null,
            clientSecretCipher,
            sftpHost: input.sftpHost ?? null,
            sftpUser: input.sftpUser ?? null,
            sftpKeyCipher,
            portalUrl: input.portalUrl ?? null,
            activeFrom: new Date(input.activeFrom),
            activeTo: input.activeTo ? new Date(input.activeTo) : null,
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          });
        }
        await outbox.publish(tx, {
          eventName: "m24.medicaid_trading_partner.updated",
          organizationId: actor.organizationId,
          aggregateKind: "state_medicaid_trading_partner_credential",
          aggregateId: id,
          payload: {
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            state: input.serviceState,
            channel: input.channel,
            mcoId: input.mcoId ?? null,
            version,
          },
        });
        return { id };
      });
    },

    // ── route 34 — test credential (DEFERRED: the per-state sandbox adapter is unbound; records the attempt
    // result as deferred, never throws). ──
    async testCredential(actor, credentialId) {
      return withOrgContext(db, actor, async (tx) => {
        const updated = await tx
          .update(TP)
          .set({
            lastSandboxTestAt: new Date(),
            lastSandboxTestResult: "deferred",
            lastSandboxTestError: "state sandbox adapter not wired (deferred, §4.5)",
          })
          .where(eq(TP.id, credentialId))
          .returning({ id: TP.id });
        if (!updated[0]) throw new NotFoundError("credential not found");
        return { ok: false, errorMessage: "state sandbox adapter not wired (deferred)" };
      });
    },

    // ── route 37 — register platform rule (the §4.6 rule registry is the FROZEN code-defined
    // DEFAULT_MEDICAID_RULES; there is no platform-rule table. Accepted as a no-op until a dynamic
    // platform-rule store lands — the M26 platform-constant posture). ──
    async registerPlatformRule(_actor, _input: RegisterPlatformRuleInput) {
      return;
    },

    // ── route 38 — load rate schedule (platform-only; delegates to the M40 loader, which is unbound.
    // Accepted as a queued no-op — the M40 delegation binds later). ──
    async loadRateSchedule(_actor, _input: LoadRateScheduleInput) {
      return { queued: true };
    },
  };

  /** Build a TOB 817 replacement / 818 void successor DRAFT claim by copying the original (D13 §2.5). */
  async function buildSuccessorClaim(
    actor: M24WriteActor,
    originalClaimId: string,
    expectedVersion: number | null,
    tob: "817" | "818",
    reason: string,
  ): Promise<ClaimView> {
    return withOrgContext(db, actor, async (tx) => {
      const original = await loadClaim(tx, originalClaimId);
      assertVersion(original, expectedVersion);
      if (!["ACK_ACCEPTED", "ACK_PARTIAL", "PAID"].includes(original.state)) {
        throw new ConflictError(
          "CLAIM_NOT_REPLACEABLE",
          `cannot build a ${tob} from state ${original.state}`,
        );
      }
      const newId = randomUUID();
      const parsed = parseMedicaidControlNumber(original.medicaidClaimControlNumber);
      const ccn = parsed?.ccn ?? "000000";
      const controlNumber = deriveMedicaidControlNumber({
        ccn,
        serviceState: original.serviceState,
        serviceFrom: day(original.serviceFrom),
        claimId: newId,
        attemptIndex: 0,
      });
      const successorTob = tob === "817" ? replacementTob(original.tob) : voidTob(original.tob);
      const inserted = await tx
        .insert(C)
        .values({
          id: newId,
          organizationId: actor.organizationId,
          providerEntityId: original.providerEntityId,
          locationId: original.locationId ?? null,
          patientId: original.patientId,
          patientPayerId: original.patientPayerId,
          admissionId: original.admissionId,
          serviceState: original.serviceState,
          kind: original.kind,
          tob: successorTob,
          serviceFrom: original.serviceFrom,
          serviceTo: original.serviceTo,
          statePlanCodeId: original.statePlanCodeId,
          statePlanCodeSnapshot: original.statePlanCodeSnapshot,
          mcoId: original.mcoId ?? null,
          mcoSnapshot: original.mcoSnapshot ?? null,
          medicareClaimId: original.medicareClaimId ?? null,
          medicareSecondaryContextSnapshot: original.medicareSecondaryContextSnapshot ?? null,
          rbArrangementId: original.rbArrangementId ?? null,
          medicaidClaimControlNumber: controlNumber,
          state: "DRAFT",
          replacesClaimId: original.id,
          createdByMembershipId: actor.userId,
          updatedByMembershipId: actor.userId,
        })
        .returning();
      await tx
        .update(C)
        .set({ replacedByClaimId: newId, updatedAt: new Date() })
        .where(eq(C.id, originalClaimId));
      await recordHistory(
        tx,
        actor.organizationId,
        newId,
        null,
        "DRAFT",
        actor.userId,
        `${tob}:${reason}`,
      );
      return toClaimView(inserted[0]!);
    });
  }
}
