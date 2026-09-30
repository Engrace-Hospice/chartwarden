// apps/backend/src/modules/06-admission/seams/drizzle-store.ts — the Drizzle-backed
// {@link AdmissionReaderStore} (TASK-002). M6's §4.7 reader seams previously ran on the in-memory
// slice store (seeded empty in prod), so every downstream consumer — M23 claim/period binding, the
// recert CTI/F2F gates, M26 cap LOC-days, M14 queues, M30 census — read nothing.
//
// TENANCY. Most id-keyed reads (periods / LOC / CTI / F2F) open `withOrgContextFromRequest`:
// `app.org_id` is pinned from the CONSUMER'S ambient request context and RLS scopes the statement. The
// worker-callable reads (`admissionSummary`, `activeAdmissions`) take an explicit org id and self-scope
// via `withOrgContext`, with RLS as the wall rather than an ambient HTTP request context.
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
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { AdmissionReaderStore, ElectionPeriodRecord } from "./store";

const ADM = schema.admissions;
const REF = schema.referrals;
const EP = schema.electionPeriods;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;
const LOC = schema.levelOfCarePeriods;
const DE = schema.dischargeEvents;
const ES = schema.electionStatements;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The actor id the org-explicit census read's withOrgContext envelope carries — an aggregate read has
 *  no acting user (the M4 audit trigger maps the empty-string sentinel to a NULL actor). */
const ADMISSION_READER_SYSTEM_USER_ID = "";

/** Worker-safe, explicitly tenant-scoped active-service probe for event consumers. */
export function admissionIsActiveForOrg(
  db: DbClient,
  organizationId: string,
  admissionId: string,
): Promise<boolean> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({ status: ADM.status })
        .from(ADM)
        .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
        .limit(1);
      return row?.status === "active";
    },
  );
}

/**
 * The siting + anchor facts a BACKGROUND consumer needs about one admission (#48).
 *
 * Shaped like the §4.7 `AdmissionSummary` but org-EXPLICIT, because the seam's id-keyed reads open
 * `withOrgContextFromRequest` and a relay tick is not a request: an outbox consumer calling the seam
 * gets `no ambient request context (call inside runWithRequestContext)` and the row dead-letters. The
 * org-explicit shape is the established answer for exactly this — `activeAdmissionDraftContextForPatient`
 * (M11/M12 IDG consumers) and `admissionIsActiveForOrg` (the M8 visit-published consumer) are the same
 * pattern. Fabricating a request scope inside the relay instead would put the tenant pin somewhere no
 * reviewer looks for it.
 *
 * Nothing here throws on a missing fact: the caller decides what an unsited admission means to it, so
 * the refusal message stays where the reason lives.
 */
export interface AdmissionSchedulingContext {
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  /** Org-local `yyyy-mm-dd`, coalescing `admission_at` the way the seam's own projection does. */
  readonly admissionAt: string | null;
  readonly activatedAt: string | null;
  readonly dischargedAt: string | null;
}

/** One admission's siting + anchors, org-explicit and worker-callable. `null` when the id is unknown in
 * `organizationId` — indistinguishable from another tenant's, which is the point. */
export function admissionSchedulingContextForOrg(
  db: DbClient,
  organizationId: string,
  admissionId: string,
): Promise<AdmissionSchedulingContext | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({
          id: ADM.id,
          patientId: ADM.patientId,
          providerEntityId: ADM.providerEntityId,
          locationId: ADM.locationId,
          admissionAt: ADM.admissionAt,
          activatedAt: ADM.activatedAt,
          dischargedAt: ADM.dischargedAt,
        })
        .from(ADM)
        // The explicit organization_id predicate is the second wall behind RLS (the `activeAdmissions`
        // precedent above), so a misconfigured GUC cannot widen this read.
        .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
        .limit(1);
      if (!row) return null;
      return {
        admissionId: row.id,
        patientId: row.patientId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        admissionAt: localDateN(row.admissionAt ?? row.activatedAt),
        activatedAt: localDateN(row.activatedAt),
        dischargedAt: localDateN(row.dischargedAt),
      };
    },
  );
}

/**
 * The facts a BACKGROUND consumer needs about one ELECTION PERIOD, org-explicit (F-106).
 *
 * The `AdmissionSchedulingContext` sibling, and needed for the same reason: the §4.7 seam's id-keyed reads
 * open `withOrgContextFromRequest` and a relay tick is not a request. It joins through to the admission
 * because `election_period` carries neither the patient nor the provider entity, and a consumer creating a
 * federally-filed notice needs both.
 *
 * `effectiveAt` is nullable and the caller must treat it as load-bearing, not decorative: it is written by
 * the `setActive` transition at admission activation and by NOTHING else, so it is NULL for every period
 * that has not started. That is precisely why M23's NOE draft cannot be created from `m6.election.signed`
 * — see `23-billing-medicare/outbox-consumers/m6-election-period-started.ts`.
 */
export interface ElectionPeriodContext {
  readonly electionPeriodId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly sequenceNumber: number;
  readonly status: string;
  /** Org-local `yyyy-mm-dd`. NULL until the period is activated — see the interface note. */
  readonly effectiveAt: string | null;
  readonly scheduledEndAt: string | null;
}

/** One election period's identity + window, org-explicit and worker-callable. `null` when the id is
 *  unknown in `organizationId` — indistinguishable from another tenant's, which is the point. */
export function electionPeriodContextForOrg(
  db: DbClient,
  organizationId: string,
  electionPeriodId: string,
): Promise<ElectionPeriodContext | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({
          id: EP.id,
          admissionId: EP.admissionId,
          sequenceNumber: EP.sequenceNumber,
          status: EP.status,
          effectiveAt: EP.effectiveAt,
          scheduledEndAt: EP.scheduledEndAt,
          patientId: ADM.patientId,
          providerEntityId: ADM.providerEntityId,
          locationId: ADM.locationId,
        })
        .from(EP)
        .innerJoin(ADM, eq(ADM.id, EP.admissionId))
        // The explicit organization_id predicate is the second wall behind RLS (the
        // `admissionSchedulingContextForOrg` precedent), so a misconfigured GUC cannot widen this read.
        .where(and(eq(EP.organizationId, organizationId), eq(EP.id, electionPeriodId)))
        .limit(1);
      if (!row) return null;
      return {
        electionPeriodId: row.id,
        admissionId: row.admissionId,
        patientId: row.patientId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        sequenceNumber: Number(row.sequenceNumber),
        status: String(row.status),
        effectiveAt: localDateN(row.effectiveAt),
        scheduledEndAt: localDateN(row.scheduledEndAt),
      };
    },
  );
}

/**
 * F-121 (#251) — M23's claim-assembly §4.4 range-shaped M6 reads, org-explicit for the same reason as
 * {@link admissionSchedulingContextForOrg} / {@link electionPeriodContextForOrg}: `buildM23BootAssemblyService`
 * is built ONCE at boot over the bare pooled `db` (no per-request handle reaches it), so every read below
 * opens its own `withOrgContext` rather than assuming an ambient request scope. This is the ONE new
 * read-surface M23's five still-unbound M6 seams (`admission`/`electionPeriods`/`certifications`/
 * `faceToFace`/`levelOfCare`) all needed — none of M6's published §4.7 readers answers "every
 * period/CTI/F2F/LOC-period for this PATIENT overlapping this DATE RANGE", only single-id or single-date
 * lookups (`boot-assembly.ts`'s header has the full per-seam accounting).
 */
export interface ClaimRangeAdmission {
  readonly admissionId: string;
  /** `admission_at` coalesced to `activated_at` — the CURRENT election's admission date the HIPPS day
   *  counter anchors on (`packages/billing/src/hipps/calculator.ts`'s own doc: it does not (yet) count
   *  cumulative days across sequential elections, so this admission's own start is the right anchor). */
  readonly hospiceAdmissionDate: string;
  /** `discharge_event.effective_at` — NOT `admission.discharged_at`, which the F-107 finding established
   *  is the FILING timestamp, not the CMS-relevant effective date. */
  readonly dischargeDate: string | null;
  readonly dischargeReason: string | null;
  /** `discharge_event.death_at`, read as a plain UTC calendar date (F-105: M6 models no time of death —
   *  every value in that column is midnight UTC of a typed `LocalDate`, never a real instant). */
  readonly deceasedDate: string | null;
  /** `admission.hospice_physician_id` — the M40 physician who certifies the CTI (F-127, #251). `null`
   *  when not yet on file. */
  readonly hospicePhysicianId: string | null;
}

export interface ClaimRangeElectionPeriod {
  readonly electionPeriodId: string;
  readonly sequence: number;
  readonly effectiveFrom: string;
  /** `actual_end_at` — null while the period is still open (matches `ElectionPeriodSnapshot`'s own
   *  "`effectiveTo === null` ⇒ open period" contract; NOT `scheduled_end_at`, which is a forecast). */
  readonly effectiveTo: string | null;
  readonly revoked: boolean;
  readonly revocationDate: string | null;
  /** `election_statement.attending_physician_id` (M40) — only from a `signed` statement; a `drafted`
   *  attending is not yet a legal election and `voided` carries no live claim (F-127, #251). `null` when
   *  no signed statement names one. */
  readonly attendingPhysicianId: string | null;
}

export interface ClaimRangeCertification {
  readonly electionPeriodSequence: number;
  readonly ctiSigned: boolean;
  readonly ctiSignedDate: string | null;
  /** Derived from the CTI row itself (`attending_md_id` set), not `admission.attending_physician_id` —
   *  the CTI is the place a period-1 attending cosign requirement is actually tracked (§2.3.3). */
  readonly attendingCosignRequired: boolean;
  readonly attendingCosigned: boolean;
}

export interface ClaimRangeFaceToFace {
  readonly electionPeriodSequence: number;
  readonly attested: boolean;
  readonly encounterDate: string | null;
}

export interface ClaimRangeLevelOfCarePeriod {
  readonly levelOfCarePeriodId: string;
  readonly levelOfCare: LevelOfCare;
  readonly from: string;
  /** `ended_at`, clamped to the caller's `range.to` while the period is still open — the period's real
   *  end is unknown, but every day the HIPPS bucketer asks about is already `<= range.to` by construction. */
  readonly to: string;
  /** ALWAYS `null` — a real, stated gap, not a placeholder: no table anywhere in this platform (M6's
   *  `level_of_care_period` included) tracks continuous-home-care documented hours per day. The §4.5
   *  `level_of_care_coherence` rule already treats `null` as "not satisfied" (CMS-correct: silence is not
   *  compliance evidence), so this is honest rather than blocking. */
  readonly chcDocumentedHours: number | null;
  /** ALWAYS `null` for the same reason as {@link ClaimRangeLevelOfCarePeriod.chcDocumentedHours} — no GIP
   *  admission-criteria documentation flag exists anywhere in the schema yet. */
  readonly gipAdmissionCriteriaDocumented: boolean | null;
}

export interface ClaimAssemblyRangeContext {
  readonly admission: ClaimRangeAdmission;
  readonly electionPeriods: readonly ClaimRangeElectionPeriod[];
  readonly certifications: readonly ClaimRangeCertification[];
  readonly faceToFace: readonly ClaimRangeFaceToFace[];
  readonly levelOfCarePeriods: readonly ClaimRangeLevelOfCarePeriod[];
}

/**
 * Resolve the ONE admission for `patientId` whose episode overlaps `range`, plus every election period /
 * CTI / F2F / LOC period on it that overlaps the same range. `null` when no admission matches — the
 * caller (`claim-assembly.ts`) turns that into `PATIENT_NOT_ELECTED` (409).
 *
 * KNOWN LIMIT (stated, not silent): if more than one admission for this patient overlaps `range` — a data
 * anomaly, since the platform enforces at most one OPEN admission per patient at a time — the most
 * recently started one wins. A correctly-run tenant never exercises this branch.
 */
export async function claimAssemblyRangeContextForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  range: { readonly from: string; readonly to: string },
): Promise<ClaimAssemblyRangeContext | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const admRows = await tx
        .select({
          id: ADM.id,
          admissionAt: ADM.admissionAt,
          activatedAt: ADM.activatedAt,
          dischargedAt: ADM.dischargedAt,
          hospicePhysicianId: ADM.hospicePhysicianId,
        })
        .from(ADM)
        .where(and(eq(ADM.organizationId, organizationId), eq(ADM.patientId, patientId)))
        .orderBy(desc(ADM.admissionAt), desc(ADM.activatedAt));

      const candidate = admRows
        .map((r) => ({
          id: r.id,
          start: r.admissionAt ?? r.activatedAt,
          end: r.dischargedAt,
          hospicePhysicianId: r.hospicePhysicianId,
        }))
        .filter(
          (
            r,
          ): r is {
            id: string;
            start: Date;
            end: Date | null;
            hospicePhysicianId: string | null;
          } => r.start !== null,
        )
        .find((r) => {
          const start = localDate(r.start);
          const end = r.end ? localDate(r.end) : null;
          return start <= range.to && (end === null || end >= range.from);
        });
      if (!candidate) return null;
      const admissionId = candidate.id;

      const [dischargeRow] = await tx
        .select({
          effectiveAt: DE.effectiveAt,
          dischargeType: DE.dischargeType,
          deathAt: DE.deathAt,
        })
        .from(DE)
        .where(eq(DE.admissionId, admissionId))
        .limit(1);

      const admission: ClaimRangeAdmission = {
        admissionId,
        hospiceAdmissionDate: localDate(candidate.start),
        dischargeDate: dischargeRow ? localDate(dischargeRow.effectiveAt) : null,
        dischargeReason: dischargeRow ? String(dischargeRow.dischargeType) : null,
        deceasedDate: dischargeRow ? localDateN(dischargeRow.deathAt) : null,
        hospicePhysicianId: candidate.hospicePhysicianId,
      };

      const periodRows = await tx
        .select({
          id: EP.id,
          sequenceNumber: EP.sequenceNumber,
          effectiveAt: EP.effectiveAt,
          scheduledEndAt: EP.scheduledEndAt,
          actualEndAt: EP.actualEndAt,
          completedByCause: EP.completedByCause,
        })
        .from(EP)
        .where(and(eq(EP.admissionId, admissionId), isNotNull(EP.effectiveAt)))
        .orderBy(asc(EP.sequenceNumber));

      const overlapping = periodRows.filter((p) => {
        const end = p.actualEndAt ?? p.scheduledEndAt;
        return p.effectiveAt! <= range.to && (end === null || end >= range.from);
      });

      const overlappingIds = overlapping.map((p) => p.id);

      // Attending physician (F-127, #251) — only a SIGNED statement's `attending_physician_id` is a real
      // election, not a drafted one (`election_statement_period_idx` is unique per period, so at most one
      // row per id).
      const attendingByPeriod = new Map<string, string | null>();
      if (overlappingIds.length > 0) {
        const statementRows = await tx
          .select({
            electionPeriodId: ES.electionPeriodId,
            attendingPhysicianId: ES.attendingPhysicianId,
          })
          .from(ES)
          .where(and(inArray(ES.electionPeriodId, overlappingIds), eq(ES.status, "signed")));
        for (const row of statementRows) {
          attendingByPeriod.set(row.electionPeriodId, row.attendingPhysicianId);
        }
      }

      const electionPeriods: ClaimRangeElectionPeriod[] = overlapping.map((p) => ({
        electionPeriodId: p.id,
        sequence: Number(p.sequenceNumber),
        effectiveFrom: localDate(p.effectiveAt!),
        effectiveTo: localDateN(p.actualEndAt),
        revoked: p.completedByCause === "revocation",
        revocationDate: p.completedByCause === "revocation" ? localDateN(p.actualEndAt) : null,
        attendingPhysicianId: attendingByPeriod.get(p.id) ?? null,
      }));
      const bySequence = new Map(overlapping.map((p) => [p.id, Number(p.sequenceNumber)]));

      const certifications: ClaimRangeCertification[] = [];
      const faceToFace: ClaimRangeFaceToFace[] = [];
      if (overlappingIds.length > 0) {
        const ctiRows = await tx
          .select({
            electionPeriodId: CTI.electionPeriodId,
            status: CTI.status,
            hospiceMdSignedAt: CTI.hospiceMdSignedAt,
            attendingMdId: CTI.attendingMdId,
            attendingMdSignedAt: CTI.attendingMdSignedAt,
            createdAt: CTI.createdAt,
          })
          .from(CTI)
          .where(inArray(CTI.electionPeriodId, overlappingIds))
          .orderBy(asc(CTI.createdAt));
        for (const periodId of overlappingIds) {
          const rows = ctiRows.filter((r) => r.electionPeriodId === periodId);
          const pick =
            rows.find((r) => r.status !== "voided" && r.status !== "superseded") ?? rows.at(-1);
          if (!pick) continue;
          certifications.push({
            electionPeriodSequence: bySequence.get(periodId)!,
            ctiSigned: pick.status === "signed",
            ctiSignedDate: localDateN(pick.hospiceMdSignedAt),
            attendingCosignRequired: pick.attendingMdId !== null,
            attendingCosigned: pick.attendingMdSignedAt !== null,
          });
        }

        const f2fRows = await tx
          .select({
            electionPeriodId: F2F.electionPeriodId,
            status: F2F.status,
            encounterDate: F2F.encounterDate,
            createdAt: F2F.createdAt,
          })
          .from(F2F)
          .where(inArray(F2F.electionPeriodId, overlappingIds))
          .orderBy(asc(F2F.createdAt));
        for (const periodId of overlappingIds) {
          const rows = f2fRows.filter((r) => r.electionPeriodId === periodId);
          const pick = rows.find((r) => r.status === "attested") ?? rows[0];
          if (!pick) continue;
          faceToFace.push({
            electionPeriodSequence: bySequence.get(periodId)!,
            attested: pick.status === "attested",
            encounterDate: localDateN(pick.encounterDate),
          });
        }
      }

      const locRows = await tx
        .select({
          id: LOC.id,
          levelOfCare: LOC.levelOfCare,
          effectiveAt: LOC.effectiveAt,
          endedAt: LOC.endedAt,
        })
        .from(LOC)
        .where(and(eq(LOC.admissionId, admissionId), ne(LOC.status, "assigning")))
        .orderBy(asc(LOC.effectiveAt));

      const levelOfCarePeriods: ClaimRangeLevelOfCarePeriod[] = locRows
        .filter((p) => {
          const from = localDate(p.effectiveAt);
          const to = localDateN(p.endedAt);
          return from <= range.to && (to === null || to >= range.from);
        })
        .map((p) => ({
          levelOfCarePeriodId: p.id,
          levelOfCare: p.levelOfCare,
          from: localDate(p.effectiveAt),
          to: localDateN(p.endedAt) ?? range.to,
          chcDocumentedHours: null,
          gipAdmissionCriteriaDocumented: null,
        }));

      return { admission, electionPeriods, certifications, faceToFace, levelOfCarePeriods };
    },
  );
}

/** Minimal M6-owned context required when an event consumer creates an admission-scoped draft. */
export interface ActiveAdmissionDraftContext {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly orderingPhysicianMdmId: string;
}

/**
 * Resolve the patient's active admission without exposing M6's table to downstream consumers.
 * Missing siting/physician data is a hard projection gap: creating an unsited or unattributed
 * clinical order would make the event look handled while leaving an unusable draft behind.
 */
export function activeAdmissionDraftContextForPatient(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<ActiveAdmissionDraftContext | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({
          admissionId: ADM.id,
          providerEntityId: ADM.providerEntityId,
          locationId: ADM.locationId,
          attendingPhysicianId: ADM.attendingPhysicianId,
          admittedByPhysicianId: ADM.admittedByPhysicianId,
        })
        .from(ADM)
        .where(
          and(
            eq(ADM.organizationId, organizationId),
            eq(ADM.patientId, patientId),
            eq(ADM.status, "active"),
          ),
        )
        .limit(1);
      if (!row) return null;
      const providerEntityId = row.providerEntityId;
      const locationId = row.locationId;
      const orderingPhysicianMdmId = row.attendingPhysicianId ?? row.admittedByPhysicianId;
      const missing = [
        providerEntityId === null ? "provider_entity_id" : null,
        locationId === null ? "location_id" : null,
        orderingPhysicianMdmId === null ? "attending_physician_id|admitted_by_physician_id" : null,
      ].filter((value): value is string => value !== null);
      if (missing.length > 0) {
        throw new AdmissionSeamDataGapError("admission", row.admissionId, missing);
      }
      if (providerEntityId === null || locationId === null || orderingPhysicianMdmId === null) {
        throw new Error("unreachable admission draft context narrowing failure");
      }
      return {
        admissionId: row.admissionId,
        providerEntityId,
        locationId,
        orderingPhysicianMdmId,
      };
    },
  );
}

/** M6-owned siting-only facts for a patient's active admission — the {@link activeAdmissionDraftContextForPatient}
 *  sibling, deliberately WITHOUT its physician requirement (F-166, #248). That function throws
 *  {@link AdmissionSeamDataGapError} when no attending/admitting physician is on file, correct for its one
 *  caller (an M11/M12 clinical-order draft, which needs an ordering physician to be legally valid) but
 *  wrong for a scheduling consumer that needs only WHERE the visit belongs, not WHO orders it — reusing the
 *  physician-requiring function here would make a triage-driven visit proposal fail on a fact it never
 *  reads. Returns `null` (never throws) when there is no active admission OR the active admission is
 *  genuinely unsited — the caller decides what an unsited admission means to it, the
 *  `admissionSchedulingContextForOrg` convention. */
export interface ActiveAdmissionSitingContext {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
}

export function activeAdmissionSitingForPatientForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<ActiveAdmissionSitingContext | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({
          admissionId: ADM.id,
          providerEntityId: ADM.providerEntityId,
          locationId: ADM.locationId,
        })
        .from(ADM)
        .where(
          and(
            eq(ADM.organizationId, organizationId),
            eq(ADM.patientId, patientId),
            eq(ADM.status, "active"),
          ),
        )
        .limit(1);
      if (!row || row.providerEntityId === null || row.locationId === null) return null;
      return {
        admissionId: row.admissionId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
      };
    },
  );
}

/** M6-owned, RLS-backed referral visibility probe for referral-bound document artifacts. */
export function createReferralReader(db: DbClient): import("@wardenx/types").ReferralReader {
  return {
    async canAccessReferral({ organizationId, userId, referralId }) {
      return withOrgContext(db, { organizationId, userId }, async (tx) => {
        const [row] = await tx
          .select({ id: REF.id })
          .from(REF)
          .where(and(eq(REF.organizationId, organizationId), eq(REF.id, referralId)))
          .limit(1);
        return !!row;
      });
    },
  };
}

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
   *  no LOC ledger row at all. `assigning` (IRC/GIP awaiting M37 bed confirmation, confirm-handshake
   *  fix) is excluded entirely — it is not yet a real period of care, so it must never surface as
   *  "current" even though it is still open (`ended_at IS NULL`). */
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
      .where(and(inArray(LOC.admissionId, admissionIds as string[]), ne(LOC.status, "assigning")))
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
      locationId: string | null;
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
      // task-11 — the M9 capture-siting source; honestly null until activation sites the admission.
      locationId: row.locationId,
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
    locationId: ADM.locationId,
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

    async admissionSummary(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
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

    async admissionSiting(organizationId, admissionId) {
      return withOrgContext(
        db,
        { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              admissionId: ADM.id,
              organizationId: ADM.organizationId,
              providerEntityId: ADM.providerEntityId,
              locationId: ADM.locationId,
              admissionAt: ADM.admissionAt,
              activatedAt: ADM.activatedAt,
            })
            .from(ADM)
            .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
            .limit(1);
          if (!row) return null; // unknown id / not visible under RLS
          return {
            admissionId: row.admissionId,
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            admissionAt: row.admissionAt?.toISOString() ?? null,
            activatedAt: row.activatedAt?.toISOString() ?? null,
          };
        },
      );
    },

    async levelOfCarePeriods(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            id: LOC.id,
            admissionId: LOC.admissionId,
            levelOfCare: LOC.levelOfCare,
            status: LOC.status,
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
              status: r.status,
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
        {
          organizationId: scope.orgId,
          userId: ADMISSION_READER_SYSTEM_USER_ID,
        },
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

// ── M14 §2.3 D9 packet-inclusion read (F-171, #248) ─────────────────────────────────────────────────────
//
// M14's T-24h packet-build worker needs "the active caseload of LOCATION L at the meeting's SCHEDULED
// START, plus a 7-day post-discharge wrap-up" (§2.3 D9) — a fact no published seam answers. D9's own prose
// says "read via M5's CaseloadProvider", but that seam (packages/types/src/seams.ts) is clinician-keyed
// (`isInCaseload`/`caseloadPatientIds`, both taking a `userId`) with no location or as-of-date parameter —
// confirmed by direct read, not assumed from the prose (F-101). `AdmissionCensusReader.listActiveAdmissions`
// is the closer candidate but is org/providerEntity-scoped only, no location column on its DTO. Neither
// reading of D9 (a location-keyed CaseloadProvider union, or a per-location active-admission census) exists
// anywhere in this codebase, so this is genuine new infrastructure on the OWNING module (M6, which holds
// `admission.location_id` + `.status` + `.discharged_at`), the `claimAssemblyRangeContextForOrg` /
// `admissionSchedulingContextForOrg` precedent, not an M14-side wrapper over a mismatched seam.
//
// "Active AT S" is read literally off D9's own formula rather than reconstructed from admission history:
// `admission` is a single mutable row (never event-sourced per instant), so the only fact this platform can
// answer is CURRENT status — honest given the T-24h cron's own build-to-meeting gap is at most ~24h (and an
// on-demand rebuild only narrows that further), so "active now" and "active at S" agree for every practical
// case. `on_hold` is deliberately EXCLUDED — D9 says "active", not "active or on_hold", and a held admission
// is not receiving active hospice care for the IDG to review. The wrap-up window is evaluated on
// `discharged_at` directly (not the current `status`), because a discharge that has since progressed to
// `bereavement`/`closed` is still "discharged within the window" — a status-based filter would silently
// under-include a patient the CoP wrap-up flag exists to protect.
export interface IdgPacketInclusionCandidate {
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  /** ISO instant — the D5/§1.1 `first_idg` cursor fallback when the patient has no prior IDG. */
  readonly activatedAtIso: string;
  readonly inclusionReason: "active" | "post_discharge_wrap_up";
}

/**
 * Resolve the §2.3 D9 packet-inclusion set for one location as of `asOfIso` (the meeting's
 * `scheduled_start`): every admission at `locationId` with `status='active'`, plus every admission at
 * `locationId` whose `discharged_at` falls in `[asOfIso - wrapUpDays, asOfIso]`. Org-explicit and
 * worker-callable (the `admissionSchedulingContextForOrg` shape) — a T-24h cron tick is not a request, so
 * an id/request-scoped seam read is not an option here. Skips a matching row that is genuinely unsited
 * (`provider_entity_id`/`location_id` null) rather than fabricating a siting fact — an unsited admission
 * cannot legally have been scheduled at this location's IDG in the first place.
 */
export function idgPacketInclusionForOrg(
  db: DbClient,
  organizationId: string,
  locationId: string,
  asOfIso: string,
  wrapUpDays: number,
): Promise<readonly IdgPacketInclusionCandidate[]> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const asOf = new Date(asOfIso);
      const wrapUpStart = new Date(asOf.getTime() - wrapUpDays * 86_400_000);
      const rows = await tx
        .select({
          id: ADM.id,
          patientId: ADM.patientId,
          providerEntityId: ADM.providerEntityId,
          locationId: ADM.locationId,
          status: ADM.status,
          activatedAt: ADM.activatedAt,
          admissionAt: ADM.admissionAt,
          dischargedAt: ADM.dischargedAt,
        })
        .from(ADM)
        .where(and(eq(ADM.organizationId, organizationId), eq(ADM.locationId, locationId)));

      const out: IdgPacketInclusionCandidate[] = [];
      for (const r of rows) {
        if (r.providerEntityId === null || r.locationId === null) continue;
        const activatedAtIso = (r.activatedAt ?? r.admissionAt)?.toISOString() ?? null;
        if (activatedAtIso === null) continue; // never activated — cannot be on a caseload
        if (r.status === "active") {
          out.push({
            admissionId: r.id,
            patientId: r.patientId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            activatedAtIso,
            inclusionReason: "active",
          });
          continue;
        }
        if (r.dischargedAt !== null && r.dischargedAt >= wrapUpStart && r.dischargedAt <= asOf) {
          out.push({
            admissionId: r.id,
            patientId: r.patientId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            activatedAtIso,
            inclusionReason: "post_discharge_wrap_up",
          });
        }
      }
      return out;
    },
  );
}

/**
 * Resolve the current level-of-care (§2.4 patient-cover `levelOfCare`) for one admission as of `asOfIso`,
 * org-explicit. Reuses the SAME `level_of_care_period` read `claimAssemblyRangeContextForOrg` already
 * performs (`ne(status, 'assigning')`, ordered by `effective_at`) rather than a second implementation of
 * the identical query — the period whose `[effective_at, ended_at)` covers `asOfIso`, or the most recent
 * one if none is open exactly at that instant (mirrors `LevelOfCareReader.getCurrentLevelOfCare`'s own
 * "open, else most recent" rule). `null` when the admission has no LOC period at all — the caller decides
 * what an LOC-less admission means to it (this seam never fabricates a level of care).
 */
export function idgCurrentLevelOfCareForOrg(
  db: DbClient,
  organizationId: string,
  admissionId: string,
  asOfIso: string,
): Promise<LevelOfCare | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({ levelOfCare: LOC.levelOfCare, effectiveAt: LOC.effectiveAt, endedAt: LOC.endedAt })
        .from(LOC)
        .where(and(eq(LOC.admissionId, admissionId), ne(LOC.status, "assigning")))
        .orderBy(desc(LOC.effectiveAt));
      if (rows.length === 0) return null;
      const asOf = new Date(asOfIso);
      const open = rows.find((r) => r.effectiveAt <= asOf && (r.endedAt === null || r.endedAt > asOf));
      return (open ?? rows[0])!.levelOfCare;
    },
  );
}
