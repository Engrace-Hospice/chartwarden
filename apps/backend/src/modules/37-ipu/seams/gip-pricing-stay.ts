// M37 owner projection for M24's nonposting local own-IPU GIP daily pricing profile.
// The projection contains identity/version facts only; it never returns GIP clinical note payloads.
import { type DbClient, schema } from "@chartwarden/db";
import { validateGipCriteriaPayload } from "@chartwarden/inpatient";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { buildFoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";

export interface GipPricingStayScope {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locPeriodId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly assessedAt: string;
}

export interface GipPricingDailyEvidence {
  readonly serviceDate: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly verifiedAt: Date;
  readonly stillMet: true;
}

export interface GipPricingStayFacts {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locPeriodId: string;
  readonly ipuAdmissionId: string;
  readonly ipuAdmissionVersion: number;
  readonly ipuAdmissionUpdatedAt: Date;
  readonly ipuAdmissionKind: string;
  readonly ipuAdmissionState: string;
  readonly activatedAt: Date;
  readonly closedAt: Date | null;
  readonly unitId: string;
  readonly unitVersion: number;
  readonly unitFacilityId: string;
  readonly bedId: string;
  readonly bedAssignmentId: string;
  readonly bedAssignmentVersion: number;
  readonly bedAssignedAt: Date;
  readonly bedEndedAt: Date | null;
  readonly facilityId: string;
  readonly facilityKind: "ipu";
  readonly locationId: string;
  readonly serviceTimeZone: string;
  readonly criteriaId: string;
  readonly criteriaVersion: number;
  readonly criteriaKind: string;
  readonly criteriaAttestedAt: Date;
  readonly dailyEvidence: readonly GipPricingDailyEvidence[];
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

/**
 * Read and lock the exact M37 own-unit GIP stay for one M6 LOC span. A bed-assignment row is an
 * accepted assignment: M37 creates it only in the owner transition that accepts assignBed. This
 * reader requires one historical assignment to cover the complete local-date interval and rejects
 * all admission transitions in the interval. It uses the actual M1 service-location timezone.
 */
export async function gipPricingStayInTransaction(
  transaction: unknown,
  scope: GipPricingStayScope,
): Promise<GipPricingStayFacts | null> {
  const tx = transaction as DbClient;
  await assertTxScopedToOrg(tx, scope.organizationId);
  const assessedAt = new Date(scope.assessedAt);
  if (!Number.isFinite(assessedAt.getTime()) || scope.serviceFrom > scope.serviceTo) return null;

  const I = schema.ipuAdmission;
  const U = schema.inpatientUnit;
  const BA = schema.ipuBedAssignment;
  const B = schema.ipuBed;
  const R = schema.ipuRoom;
  const SITES = buildFoundationSiteReader();
  const rows = await tx
    .select({
      organizationId: I.organizationId,
      providerEntityId: I.providerEntityId,
      patientId: I.patientId,
      admissionId: I.admissionId,
      locPeriodId: I.levelOfCarePeriodId,
      ipuAdmissionId: I.id,
      ipuAdmissionVersion: I.version,
      ipuAdmissionUpdatedAt: I.updatedAt,
      ipuAdmissionKind: I.kind,
      ipuAdmissionState: I.state,
      activatedAt: I.activatedAt,
      closedAt: I.closedAt,
      unitId: U.id,
      unitVersion: U.version,
      unitFacilityId: U.facilityId,
      unitActive: U.isActive,
      bedId: B.id,
      bedActive: B.isActive,
      roomActive: R.isActive,
      bedAssignmentId: BA.id,
      bedAssignmentVersion: BA.version,
      bedAssignedAt: BA.assignedAt,
      bedEndedAt: BA.endedAt,
      facilityId: U.facilityId,
      locationId: I.locationId,
    })
    .from(I)
    .innerJoin(U, and(eq(U.id, I.unitId), eq(U.organizationId, scope.organizationId)))
    .innerJoin(BA, and(eq(BA.ipuAdmissionId, I.id), eq(BA.organizationId, scope.organizationId)))
    .innerJoin(
      B,
      and(eq(B.id, BA.bedId), eq(B.unitId, U.id), eq(B.organizationId, scope.organizationId)),
    )
    .innerJoin(
      R,
      and(eq(R.id, B.roomId), eq(R.unitId, U.id), eq(R.organizationId, scope.organizationId)),
    )
    .where(
      and(
        eq(I.organizationId, scope.organizationId),
        eq(I.providerEntityId, scope.providerEntityId),
        eq(I.patientId, scope.patientId),
        eq(I.admissionId, scope.admissionId),
        eq(I.levelOfCarePeriodId, scope.locPeriodId),
        eq(I.kind, "gip"),
      ),
    )
    .orderBy(BA.assignedAt)
    .limit(3)
    .for("share");
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const site = row.locationId
    ? await SITES.locationSiteFacts(tx, scope.organizationId, row.locationId)
    : null;
  if (
    !row.locationId ||
    !site ||
    site.providerEntityId !== scope.providerEntityId ||
    site.status !== "active" ||
    site.state !== "OR" ||
    !row.activatedAt ||
    row.activatedAt > assessedAt ||
    !row.unitActive ||
    !row.bedActive ||
    !row.roomActive
  )
    return null;
  if (!["active", "discharged", "deceased", "closed"].includes(row.ipuAdmissionState)) return null;
  if (
    ["discharged", "deceased", "closed"].includes(row.ipuAdmissionState) !==
    (row.closedAt !== null)
  )
    return null;

  // PostgreSQL converts each local calendar boundary independently, including DST 23/25-hour days.
  const start = sql`(${scope.serviceFrom}::date::timestamp AT TIME ZONE ${site.timeZone})`;
  const end = sql`((${scope.serviceTo}::date + 1)::timestamp AT TIME ZONE ${site.timeZone})`;
  const stayCovers = await tx.execute(sql`
    SELECT
      ${row.activatedAt}::timestamptz <= ${start} AND
      (${row.closedAt}::timestamptz IS NULL OR ${row.closedAt}::timestamptz >= ${end}) AS covers
  `);
  const coverageRows = (stayCovers as { rows?: readonly { covers?: boolean }[] }).rows ?? [];
  if (coverageRows[0]?.covers !== true) return null;

  const assignmentRows = await tx
    .select({ id: BA.id })
    .from(BA)
    .where(
      and(
        eq(BA.organizationId, scope.organizationId),
        eq(BA.ipuAdmissionId, row.ipuAdmissionId),
        sql`${BA.assignedAt} < ${end}`,
        sql`(${BA.endedAt} IS NULL OR ${BA.endedAt} > ${start})`,
      ),
    )
    .limit(2)
    .for("share");
  if (assignmentRows.length !== 1 || assignmentRows[0]!.id !== row.bedAssignmentId) return null;
  const assignmentCoverage = await tx.execute(sql`
    SELECT ${row.bedAssignedAt}::timestamptz <= ${start} AND
      (${row.bedEndedAt}::timestamptz IS NULL OR ${row.bedEndedAt}::timestamptz >= ${end}) AS covers
  `);
  const assignmentCoverageRows =
    (assignmentCoverage as { rows?: readonly { covers?: boolean }[] }).rows ?? [];
  if (assignmentCoverageRows[0]?.covers !== true || row.bedAssignedAt > assessedAt) return null;

  const transitions = await tx
    .select({ id: schema.ipuAdmissionTransition.id })
    .from(schema.ipuAdmissionTransition)
    .where(
      and(
        eq(schema.ipuAdmissionTransition.organizationId, scope.organizationId),
        eq(schema.ipuAdmissionTransition.ipuAdmissionId, row.ipuAdmissionId),
        sql`${schema.ipuAdmissionTransition.initiatedAt} < ${end}`,
        sql`COALESCE(${schema.ipuAdmissionTransition.completedAt}, ${schema.ipuAdmissionTransition.initiatedAt}) >= ${start}`,
      ),
    )
    .limit(1)
    .for("share");
  if (transitions.length !== 0) return null;

  const C = schema.gipAdmissionCriteria;
  const criteriaRows = await tx
    .select({
      id: C.id,
      version: C.version,
      criterionKind: C.criterionKind,
      data: C.data,
      attestedAt: C.attestedAt,
      updatedAt: C.updatedAt,
    })
    .from(C)
    .where(
      and(eq(C.organizationId, scope.organizationId), eq(C.ipuAdmissionId, row.ipuAdmissionId)),
    )
    .limit(2)
    .for("share");
  if (
    criteriaRows.length !== 1 ||
    criteriaRows[0]!.attestedAt > assessedAt ||
    criteriaRows[0]!.updatedAt > assessedAt
  )
    return null;
  const criteria = criteriaRows[0]!;
  // M37 owns the discriminated clinical payload. Validate its persisted source form here, but
  // deliberately project only the criterion kind and source identity into M24.
  let criteriaPayload: ReturnType<typeof validateGipCriteriaPayload>;
  try {
    criteriaPayload = validateGipCriteriaPayload(criteria.data);
  } catch {
    return null;
  }
  if (criteriaPayload.criterion_kind !== criteria.criterionKind) return null;

  const reassessmentTable = schema.gipCriteriaReassessment;
  const reassessments = await tx
    .select({
      id: reassessmentTable.id,
      version: reassessmentTable.version,
      criterionStillMet: reassessmentTable.criterionStillMet,
      assessedAt: reassessmentTable.assessedAt,
      createdAt: reassessmentTable.createdAt,
    })
    .from(reassessmentTable)
    .where(
      and(
        eq(reassessmentTable.organizationId, scope.organizationId),
        eq(reassessmentTable.ipuAdmissionId, row.ipuAdmissionId),
        lte(reassessmentTable.assessedAt, assessedAt),
      ),
    )
    .orderBy(reassessmentTable.assessedAt)
    .for("share");
  if (
    reassessments.some(
      (row, index) =>
        row.createdAt > assessedAt ||
        (index > 0 && row.assessedAt.getTime() === reassessments[index - 1]!.assessedAt.getTime()),
    )
  ) {
    // Equal assessment instants have no authoritative ordering in the M37 record model.
    return null;
  }
  const dailyEvidence: GipPricingDailyEvidence[] = [];
  for (let date = scope.serviceFrom; date <= scope.serviceTo; date = nextDate(date)) {
    const bounds = await tx.execute(sql`
      SELECT (${date}::date::timestamp AT TIME ZONE ${site.timeZone}) AS day_start,
             ((${date}::date + 1)::timestamp AT TIME ZONE ${site.timeZone}) AS day_end
    `);
    const b = (
      bounds as unknown as {
        rows?: readonly { day_start: Date | string; day_end: Date | string }[];
      }
    ).rows?.[0];
    if (!b) return null;
    const dayStart = b.day_start instanceof Date ? b.day_start : new Date(b.day_start);
    const dayEnd = b.day_end instanceof Date ? b.day_end : new Date(b.day_end);
    if (!Number.isFinite(dayStart.getTime()) || !Number.isFinite(dayEnd.getTime())) return null;
    const due = reassessments.filter((entry) => entry.assessedAt < dayEnd);
    const latest = due.at(-1);
    const source = latest
      ? {
          id: latest.id,
          version: Number(latest.version),
          at: latest.assessedAt,
          stillMet: latest.criterionStillMet,
        }
      : {
          id: criteria.id,
          version: Number(criteria.version),
          at: criteria.attestedAt,
          stillMet: true,
        };
    if (source.at < dayStart || source.at >= dayEnd || !source.stillMet) {
      return null;
    }
    dailyEvidence.push({
      serviceDate: date,
      sourceId: source.id,
      sourceVersion: source.version,
      verifiedAt: source.at,
      stillMet: true,
    });
  }
  return {
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    locPeriodId: row.locPeriodId,
    ipuAdmissionId: row.ipuAdmissionId,
    ipuAdmissionVersion: Number(row.ipuAdmissionVersion),
    ipuAdmissionUpdatedAt: row.ipuAdmissionUpdatedAt,
    ipuAdmissionKind: row.ipuAdmissionKind,
    ipuAdmissionState: row.ipuAdmissionState,
    activatedAt: row.activatedAt,
    closedAt: row.closedAt,
    unitId: row.unitId,
    unitVersion: Number(row.unitVersion),
    unitFacilityId: row.unitFacilityId,
    bedId: row.bedId,
    bedAssignmentId: row.bedAssignmentId,
    bedAssignmentVersion: Number(row.bedAssignmentVersion),
    bedAssignedAt: row.bedAssignedAt,
    bedEndedAt: row.bedEndedAt,
    facilityId: row.facilityId,
    facilityKind: "ipu",
    locationId: row.locationId,
    serviceTimeZone: site.timeZone,
    criteriaId: criteria.id,
    criteriaVersion: Number(criteria.version),
    criteriaKind: criteria.criterionKind,
    criteriaAttestedAt: criteria.attestedAt,
    dailyEvidence,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
  };
}

function nextDate(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(at + 86_400_000).toISOString().slice(0, 10);
}
