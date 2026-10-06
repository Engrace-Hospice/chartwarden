// apps/backend/src/modules/23-billing-medicare/services/claim-assembly-types.ts
//
// The injected reader-port SHAPES of the claim assembly (M5/M6/M7/M8/M18/M26/M38/M40 + platform reference data).
// Split out of `claim-assembly.ts` so `claim-assembly-facts.ts` (which reads through them) and the assembly
// itself can both depend on the types without importing each other. `claim-assembly.ts` re-exports every name,
// so existing importers are unchanged.
import type {
  BillableEncounterSnapshot,
  BillingRuleRegistry,
  CapProjectionProvider,
  Cents,
  CertificationSnapshot,
  ElectionPeriodSnapshot,
  EvvBracketSnapshot,
  FaceToFaceSnapshot,
  HippsRateTable,
  Icd10Pointer,
  IsoDate,
  LevelOfCare,
  LevelOfCarePeriodSnapshot,
  MdmResolution,
  SignedEncounterSnapshot,
  TerminologyResolution,
} from "@wardenx/billing";
import type { repositories } from "@wardenx/billing";

type BillingDb = repositories.BillingDb;

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
  /** The hospice election/admission date — day 1 of THIS stay in the ADR-0001 RHC day-60 tier count (D7). */
  readonly hospiceAdmissionDate: IsoDate;
  /** Earlier stays' hospice days carried into the RHC day count (readmission within 60 days); absent = 0. */
  readonly rhcPriorHospiceDays?: number;
  /** M6's earlier stays with us (the facts behind `rhcPriorHospiceDays`), merged with the HETS cross-hospice
   *  history by `computeRhcCarryOver`. Absent (older readers / fakes) ⇒ `rhcPriorHospiceDays` is used as is. */
  readonly rhcPriorStays?: readonly {
    readonly admissionId: string;
    readonly startedOn: IsoDate | null;
    readonly endedOn: IsoDate | null;
  }[];
  /** The COMPLETED `discharge_event` only (a voided or pending-cosign row is not a discharge). */
  readonly dischargeDate: IsoDate | null;
  readonly dischargeReason: string | null;
  /** M5/M6 date of death (drives SIA + the PATIENT_DECEASED_BEFORE_FROM gate); `null` ⇒ alive. */
  readonly deceasedDate: IsoDate | null;
  /** M6 `discharge_event.place_of_death` (`home` / `facility` / `unknown`); claim patient status 40/41/42. */
  readonly placeOfDeath: string | null;
  /** The completed `discharge_event.id` (addresses the record a blocked claim needs completed). Optional so
   *  older fakes/fixtures stay valid; absent ⇒ unknown. */
  readonly dischargeEventId?: string | null;
  /** M6 transfer-OUT (no `discharge_event` row); `receivingCareSetting` drives claim patient status 50/51. */
  readonly transferOut: {
    readonly transferEventId?: string;
    readonly effectiveDate: IsoDate;
    readonly receivingCareSetting: string | null;
  } | null;
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
    /** F-213 — the claim's whole service range, so `placeOfService` can be resolved over the range
     *  rather than at `asOf` alone (a range can span a move). Absent = `[asOf, asOf]`. */
    range?: DateRange,
  ): Promise<MdmResolution>;
}

/**
 * M7 — the claim's ICD-10 diagnosis sequence over the service window (F-209, #251): position 1..12, code,
 * relationship. Code + relationship only (no free-text description). Empty when the patient has no active,
 * coded problem in the window — the `icd10_sequencing` rule then fails honestly ("no ICD-10 diagnosis sequence").
 *
 * F-214 (#251) — the owning module (M7) has ALREADY applied the 42 CFR Part 2 consent gate: a `sud_related`
 * diagnosis with no valid release on file is absent from `sequence` (positions re-ranked contiguously) and
 * reported only as a NON-PHI summary — a count + whether the principal was among them, never a code.
 */
export interface DiagnosisSequenceResult {
  readonly sequence: readonly Icd10Pointer[];
  readonly withheldForConsentCount: number;
  readonly terminalWithheldForConsent: boolean;
}
export interface DiagnosisSequenceReader {
  forRange(orgId: string, patientId: string, range: DateRange): Promise<DiagnosisSequenceResult>;
}

/**
 * M38 — terminology resolution (value-set membership + ICD billability) as-of `claim.service_from`.
 * `icd10Codes` (F-209) are the claim's diagnosis codes; `icd10Billable` is resolved for exactly these.
 */
export interface TerminologyProvider {
  resolveForClaim(
    orgId: string,
    asOfDate: IsoDate,
    icd10Codes?: readonly string[],
  ): Promise<TerminologyResolution>;
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

/**
 * F-210 — who/when the TENANT-ENTERED rate table is read for: the rate table is org + provider-entity scoped and
 * effective-dated, so the reader needs more than the (MAC, fiscal year) the CMS-file design assumed.
 */
export interface RateLookupScope {
  readonly orgId: string;
  readonly providerEntityId: string;
  /** The claim's service-from date; the rate version whose effective window covers it is the one priced from. */
  readonly serviceFrom: IsoDate;
}

export interface BillingReferenceDataReader {
  /**
   * The per-diem base rate table (PRE-wage-index) in effect on `scope.serviceFrom`, TENANT-ENTERED (F-210). Throws the
   * typed `RATE_TABLE_MISSING` (422) when no table covers the date — never a guess and never `SEAM_UNBOUND`.
   */
  hippsRateTable(
    macJurisdiction: MacJurisdiction,
    fiscalYearStarting: number,
    scope: RateLookupScope,
  ): Promise<HippsRateTable>;
  /** The wage-index-ADJUSTED CHC hourly rate (whole cents) the SIA add-on is priced at (same `RATE_TABLE_MISSING`). */
  chcHourlyRateCents(
    fiscalYearStarting: number,
    wageIndexFactorDecimal: string,
    scope: RateLookupScope,
  ): Promise<Cents>;
  /**
   * The CMS hospice wage index for a CCN + fiscal year, or `null` (the caller fails closed `WAGE_INDEX_UNAVAILABLE`).
   * F-211: `orgId` lets the reader prefer the TENANT-ENTERED value (`tenant_wage_index`) over a platform AUTHORITATIVE
   * `wage_index_factor` row; a non-authoritative placeholder row never qualifies.
   */
  wageIndexForCcn(
    ccn: string,
    fiscalYearStarting: number,
    orgId: string,
  ): Promise<WageIndexResolution | null>;
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
  readonly diagnoses: DiagnosisSequenceReader; // M7 (F-209)
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
