// apps/backend/src/modules/06-admission/seams/drizzle-store.ts — the Drizzle-backed
// {@link AdmissionReaderStore} (TASK-002). M6's §4.7 reader seams previously ran on the in-memory
// slice store (seeded empty in prod), so every downstream consumer — M23 claim/period binding, the
// recert CTI/F2F gates, M26 cap LOC-days, M14 queues, M30 census — read nothing.
//
// TENANCY. The id-keyed reads (periods / summary / LOC / CTI / F2F) open `withOrgContextFromRequest`:
// `app.org_id` is pinned from the CONSUMER'S ambient request context and RLS scopes the statement —
// the store never selects by a caller-passed org id, and called outside a request scope it THROWS
// rather than reading unscoped (the M21 store-drizzle precedent). The one org-explicit read,
// `activeAdmissions`, takes the census scope's `orgId` (worker-callable) and self-scopes via
// `withOrgContext` with the explicit `organization_id` predicate as the second wall (M7 precedent).
//
// PROJECTION GAPS — never fabricated. Three M6 facts the seam DTOs require non-null are nullable at
// draft in §3.3 (migration 0123): `admission.admission_at` / `provider_entity_id`, and a period's
// `effective_at` / `scheduled_end_at`. The rules here, in fail direction order:
//   · an UNDATED election period (no effective_at or scheduled_end_at) is EXCLUDED — it is not yet on
//     the benefit calendar, so no date-containment or window question about it has an answer;
//   · `admissionAt` coalesces to `activated_at` (the route service's own fallback idiom — activation
//     is the admission moment; the activate transition sets only `activated_at`);
//   · anything still missing THROWS {@link AdmissionSeamDataGapError} naming the gap. Silently
//     omitting an active patient from a census, or defaulting a level of care, would be a clinical lie.
//
// LEVEL OF CARE ON A PERIOD. `ElectionPeriodRecord.levelOfCare` has no per-period column — the LOC
// ledger hangs off the ADMISSION. It resolves as the admission's current LOC (the open
// `level_of_care_period`, else the most recent by `effective_at` — the same rule
// `LevelOfCareReader.getCurrentLevelOfCare` applies). Sound for the one consumer of the field
// (`toActiveElectionPeriod`, which M23 only reads for the period containing "now"); an admission with
// NO LOC row cannot answer it and throws the gap error rather than defaulting to routine home care.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  AdmissionSummary,
  CertificationSummary,
  FaceToFaceSummary,
  LevelOfCare,
  LevelOfCarePeriodSummary,
} from "@wardenx/types";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AdmissionReaderStore, ElectionPeriodRecord } from "./store";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;
const LOC = schema.levelOfCarePeriods;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The actor id the org-explicit census read's withOrgContext envelope carries — an aggregate read has
 *  no acting user (the M4 audit trigger maps the empty-string sentinel to a NULL actor). */
const ADMISSION_READER_SYSTEM_USER_ID = "";

/**
 * Thrown when a row the seam must project is missing a fact its DTO requires non-null (a draft-shaped
 * `admission`, an LOC-less admission behind a dated period, an attested F2F with no encounter date).
 * The store REFUSES to fabricate — loud beats silently wrong for census/billing/recert consumers.
 */
export class AdmissionSeamDataGapError extends Error {
  constructor(
    readonly entity: string,
    readonly entityId: string,
    readonly missing: readonly string[],
  ) {
    super(
      `M6 seam projection gap: ${entity} '${entityId}' is missing required fact(s): ` +
        `${missing.join(", ")} — refusing to fabricate a value`,
    );
    this.name = "AdmissionSeamDataGapError";
  }
}

const localDate = (d: Date | string): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : d.slice(0, 10);
const localDateN = (d: Date | string | null): string | null => (d === null ? null : localDate(d));

/** The joined election-period row shape both period reads project from. */
interface PeriodRow {
  id: string;
  admissionId: string;
  patientId: string;
  sequenceNumber: number;
  periodKind: ElectionPeriodRecord["periodKind"];
  status: ElectionPeriodRecord["status"];
  effectiveAt: string | null;
  scheduledEndAt: string | null;
  actualEndAt: string | null;
}

const periodCols = {
  id: EP.id,
  admissionId: EP.admissionId,
  patientId: ADM.patientId,
  sequenceNumber: EP.sequenceNumber,
  periodKind: EP.periodKind,
  status: EP.status,
  effectiveAt: EP.effectiveAt,
  scheduledEndAt: EP.scheduledEndAt,
  actualEndAt: EP.actualEndAt,
} as const;

/** Build the production Drizzle-backed {@link AdmissionReaderStore}. */
export function createDrizzleAdmissionReaderStore(db: DbClient): AdmissionReaderStore {
  /** Current LOC per admission for a batch (ONE query, never N+1): the open period, else the most
   *  recent by `effective_at` — the `getCurrentLevelOfCare` rule. Admissions absent from the map have
   *  no LOC ledger row at all. */
  async function currentLocByAdmission(
    tx: Tx,
    admissionIds: readonly string[],
  ): Promise<Map<string, LevelOfCare>> {
    const current = new Map<string, LevelOfCare>();
    if (admissionIds.length === 0) return current;
    const rows = await tx
      .select({
        admissionId: LOC.admissionId,
        levelOfCare: LOC.levelOfCare,
        endedAt: LOC.endedAt,
      })
      .from(LOC)
      .where(inArray(LOC.admissionId, admissionIds as string[]))
      .orderBy(asc(LOC.effectiveAt));
    const open = new Map<string, LevelOfCare>();
    for (const r of rows) {
      current.set(r.admissionId, r.levelOfCare); // ascending order ⇒ ends holding the latest
      if (r.endedAt === null) open.set(r.admissionId, r.levelOfCare);
    }
    for (const [admissionId, loc] of open) current.set(admissionId, loc); // open wins over latest
    return current;
  }

  /** Project joined period rows to {@link ElectionPeriodRecord}s (undated rows already excluded in
   *  SQL; the runtime guard is belt-and-braces for the type system). */
  async function periodRecordsOf(
    tx: Tx,
    rows: readonly PeriodRow[],
  ): Promise<ElectionPeriodRecord[]> {
    const locBy = await currentLocByAdmission(tx, [...new Set(rows.map((r) => r.admissionId))]);
    const records: ElectionPeriodRecord[] = [];
    for (const r of rows) {
      if (r.effectiveAt === null || r.scheduledEndAt === null) continue;
      const levelOfCare = locBy.get(r.admissionId);
      if (levelOfCare === undefined) {
        throw new AdmissionSeamDataGapError("admission", r.admissionId, [
          "level_of_care_period (no LOC ledger row; cannot resolve the period's level of care)",
        ]);
      }
      records.push({
        periodId: r.id,
        admissionId: r.admissionId,
        patientId: r.patientId,
        sequence: Number(r.sequenceNumber),
        periodKind: r.periodKind,
        status: r.status,
        levelOfCare,
        startDate: localDate(r.effectiveAt),
        endDate: localDate(r.scheduledEndAt),
        actualEndDate: localDateN(r.actualEndAt),
      } as ElectionPeriodRecord);
    }
    return records;
  }

  /** Project one admission row (+ pre-resolved current period/LOC) to the §4.7 summary DTO. */
  function summaryOf(
    row: {
      id: string;
      patientId: string;
      organizationId: string;
      providerEntityId: string | null;
      status: AdmissionSummary["status"];
      admissionAt: Date | null;
      activatedAt: Date | null;
      dischargedAt: Date | null;
    },
    currentElectionPeriodId: string | null,
    currentLevelOfCare: LevelOfCare | null,
  ): AdmissionSummary {
    const admissionAt = row.admissionAt ?? row.activatedAt;
    const missing: string[] = [];
    if (admissionAt === null) missing.push("admission_at (and no activated_at fallback)");
    if (row.providerEntityId === null) missing.push("provider_entity_id");
    if (missing.length > 0) throw new AdmissionSeamDataGapError("admission", row.id, missing);
    return {
      admissionId: row.id,
      patientId: row.patientId,
      organizationId: row.organizationId,
      providerEntityId: row.providerEntityId,
      status: row.status,
      admissionAt: localDate(admissionAt as Date),
      activatedAt: localDateN(row.activatedAt),
      dischargedAt: localDateN(row.dischargedAt),
      currentElectionPeriodId,
      currentLevelOfCare,
    } as AdmissionSummary;
  }

  const admissionCols = {
    id: ADM.id,
    patientId: ADM.patientId,
    organizationId: ADM.organizationId,
    providerEntityId: ADM.providerEntityId,
    status: ADM.status,
    admissionAt: ADM.admissionAt,
    activatedAt: ADM.activatedAt,
    dischargedAt: ADM.dischargedAt,
  } as const;

  /** Active election-period id per admission for a batch (ONE query). */
  async function activePeriodByAdmission(
    tx: Tx,
    admissionIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (admissionIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: EP.id, admissionId: EP.admissionId })
      .from(EP)
      .where(and(inArray(EP.admissionId, admissionIds as string[]), eq(EP.status, "active")))
      .orderBy(asc(EP.sequenceNumber));
    // ≤1 active period per admission by the §2.3.2 machine; ascending order makes a violation stable.
    return new Map(rows.map((r) => [r.admissionId, r.id] as const));
  }

  return {
    async electionPeriodsForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select(periodCols)
          .from(EP)
          .innerJoin(ADM, eq(EP.admissionId, ADM.id))
          .where(
            and(
              eq(EP.admissionId, admissionId),
              isNotNull(EP.effectiveAt),
              isNotNull(EP.scheduledEndAt),
            ),
          )
          .orderBy(asc(EP.sequenceNumber));
        return periodRecordsOf(tx, rows as PeriodRow[]);
      });
    },

    async electionPeriodsForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select(periodCols)
          .from(EP)
          .innerJoin(ADM, eq(EP.admissionId, ADM.id))
          .where(
            and(
              eq(ADM.patientId, patientId),
              isNotNull(EP.effectiveAt),
              isNotNull(EP.scheduledEndAt),
            ),
          )
          .orderBy(asc(EP.sequenceNumber));
        return periodRecordsOf(tx, rows as PeriodRow[]);
      });
    },

    async admissionSummary(admissionId) {
      return withOrgContextFromRequest(db, async (tx): Promise<AdmissionSummary | null> => {
        const [row] = await tx
          .select(admissionCols)
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!row) return null; // unknown id / not visible under RLS — the contract's null
        const [periodBy, locBy] = [
          await activePeriodByAdmission(tx, [row.id]),
          await currentLocByAdmission(tx, [row.id]),
        ];
        return summaryOf(row, periodBy.get(row.id) ?? null, locBy.get(row.id) ?? null);
      });
    },

    async levelOfCarePeriods(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            id: LOC.id,
            admissionId: LOC.admissionId,
            levelOfCare: LOC.levelOfCare,
            effectiveAt: LOC.effectiveAt,
            endedAt: LOC.endedAt,
          })
          .from(LOC)
          .where(eq(LOC.admissionId, admissionId))
          .orderBy(asc(LOC.effectiveAt)); // the in-memory reference sorts ascending by effectiveAt
        return rows.map(
          (r) =>
            ({
              levelOfCarePeriodId: r.id,
              admissionId: r.admissionId,
              levelOfCare: r.levelOfCare,
              effectiveAt: localDate(r.effectiveAt),
              endedAt: localDateN(r.endedAt),
            }) as LevelOfCarePeriodSummary,
        );
      });
    },

    async activeCertification(electionPeriodId) {
      return withOrgContextFromRequest(db, async (tx): Promise<CertificationSummary | null> => {
        // The partial unique `cti_period_active_idx` guarantees ≤1 non-voided CTI per period. The
        // in-memory reference prefers a non-terminal CTI and falls back to the latest row; here
        // "latest" is newest by created_at (rows come back ascending, `.at(-1)` is the newest).
        const rows = await tx
          .select({
            id: CTI.id,
            electionPeriodId: CTI.electionPeriodId,
            status: CTI.status,
            hospiceMdSignedAt: CTI.hospiceMdSignedAt,
            signedLate: CTI.signedLate,
            sequenceNumber: EP.sequenceNumber,
          })
          .from(CTI)
          .innerJoin(EP, eq(CTI.electionPeriodId, EP.id))
          .where(eq(CTI.electionPeriodId, electionPeriodId))
          .orderBy(asc(CTI.createdAt));
        const pick =
          rows.find((r) => r.status !== "voided" && r.status !== "superseded") ?? rows.at(-1);
        if (!pick) return null;
        return {
          certificationId: pick.id,
          electionPeriodId: pick.electionPeriodId,
          status: pick.status,
          hospiceMdSignedAt: localDateN(pick.hospiceMdSignedAt),
          signedLate: pick.signedLate,
          // No stored is_recert column — derived from the CMS definition: the first benefit period is
          // the initial certification, every subsequent sequence is a recertification (§2.2).
          isRecert: Number(pick.sequenceNumber) > 1,
        } as CertificationSummary;
      });
    },

    async attestedF2f(electionPeriodId) {
      return withOrgContextFromRequest(db, async (tx): Promise<FaceToFaceSummary | null> => {
        // The partial unique `f2f_period_attested_idx` guarantees ≤1 attested F2F per period. The
        // in-memory reference prefers the attested row and falls back to any row for the period
        // (the reader's `?.status === "attested"` check is the actual gate).
        const rows = await tx
          .select({
            id: F2F.id,
            electionPeriodId: F2F.electionPeriodId,
            status: F2F.status,
            performerRole: F2F.performerRole,
            encounterDate: F2F.encounterDate,
            attestationSignedAt: F2F.attestationSignedAt,
            windowOverride: F2F.windowOverride,
          })
          .from(F2F)
          .where(eq(F2F.electionPeriodId, electionPeriodId))
          .orderBy(asc(F2F.createdAt));
        const pick = rows.find((r) => r.status === "attested") ?? rows[0];
        if (!pick) return null;
        if (pick.encounterDate === null) {
          throw new AdmissionSeamDataGapError("face_to_face_encounter", pick.id, [
            "encounter_date",
          ]);
        }
        return {
          faceToFaceEncounterId: pick.id,
          electionPeriodId: pick.electionPeriodId,
          status: pick.status,
          performerRole: pick.performerRole,
          encounterDate: localDate(pick.encounterDate),
          attestedAt: localDateN(pick.attestationSignedAt),
          windowOverride: pick.windowOverride,
        } as FaceToFaceSummary;
      });
    },

    async activeAdmissions(scope) {
      // Org-explicit (census scope; worker-callable): self-scoped withOrgContext envelope, with the
      // explicit organization_id predicate as the second wall (the M7 drizzle-store precedent).
      return withOrgContext(
        db,
        { organizationId: scope.orgId, userId: ADMISSION_READER_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await tx
            .select(admissionCols)
            .from(ADM)
            .where(
              and(
                eq(ADM.organizationId, scope.orgId),
                eq(ADM.status, "active"),
                scope.providerEntityId === undefined
                  ? undefined
                  : eq(ADM.providerEntityId, scope.providerEntityId),
              ),
            )
            .orderBy(asc(ADM.admissionAt), asc(ADM.createdAt));
          const ids = rows.map((r) => r.id);
          const periodBy = await activePeriodByAdmission(tx, ids);
          const locBy = await currentLocByAdmission(tx, ids);
          // summaryOf THROWS on an unprojectable active row rather than silently dropping a patient
          // from the census (an invisible active patient is the worse failure for M30 dashboards).
          return rows.map((r) => summaryOf(r, periodBy.get(r.id) ?? null, locBy.get(r.id) ?? null));
        },
      );
    },
  };
}
