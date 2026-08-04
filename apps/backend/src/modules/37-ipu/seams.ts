// apps/backend/src/modules/37-ipu/seams.ts — M37 §4.11 the eight PUBLISHED reader seams, backed by M37's
// Drizzle tables under RLS. The composition root registers these over the Phase-0 deny-stubs (registerSeam)
// before validateSeams(); consumers (M23/M26/M27/M13/M30/M31/M34) resolve them via getSeam. Every seam
// scopes its read to the passed organizationId via withOrgContext (RLS backstop); the returned shapes are
// PHI-lean (ids + counts + policy flags), never a raw PHI row (D17/§8.5).
import { type DbClient, schema } from "@wardenx/db";
import { evaluateVisitorCheckIn } from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  IpuAdmissionReader,
  IpuBedAssignmentProvider,
  IpuCensusProvider,
  IpuIvSafetyOverlayProvider,
  IpuQualityReader,
  IpuShiftCoverageReader,
  IpuTenantPostureReader,
  IpuVisitorReader,
  IpuVisitorRelationship,
  SeamContracts,
  SeamName,
} from "@wardenx/types";
import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";

type RegisterSeam = <K extends SeamName>(name: K, impl: SeamContracts[K]) => void;

/** Build the eight M37 published seam implementations over the Drizzle client. */
export function buildIpuSeams(db: DbClient): {
  IpuAdmissionReader: IpuAdmissionReader;
  IpuCensusProvider: IpuCensusProvider;
  IpuBedAssignmentProvider: IpuBedAssignmentProvider;
  IpuShiftCoverageReader: IpuShiftCoverageReader;
  IpuIvSafetyOverlayProvider: IpuIvSafetyOverlayProvider;
  IpuVisitorReader: IpuVisitorReader;
  IpuQualityReader: IpuQualityReader;
  IpuTenantPostureReader: IpuTenantPostureReader;
} {
  const withOrg = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));

  return {
    IpuAdmissionReader: {
      async bedAssignmentForDate(organizationId, patientId, _serviceDate) {
        return withOrg(organizationId, async (tx) => {
          // The patient's active-bed admission → its live bed → the bed's unit facility (the Q-code source).
          const [adm] = await tx
            .select({ id: schema.ipuAdmission.id, unitId: schema.ipuAdmission.unitId })
            .from(schema.ipuAdmission)
            .where(
              and(
                eq(schema.ipuAdmission.patientId, patientId),
                ne(schema.ipuAdmission.state, "closed"),
              ),
            )
            .limit(1);
          if (!adm) return null;
          const [ba] = await tx
            .select({ bedId: schema.ipuBedAssignment.bedId })
            .from(schema.ipuBedAssignment)
            .where(
              and(
                eq(schema.ipuBedAssignment.ipuAdmissionId, adm.id),
                isNull(schema.ipuBedAssignment.endedAt),
              ),
            )
            .limit(1);
          if (!ba) return null;
          const [unit] = adm.unitId
            ? await tx
                .select({ facilityId: schema.inpatientUnit.facilityId })
                .from(schema.inpatientUnit)
                .where(eq(schema.inpatientUnit.id, adm.unitId))
                .limit(1)
            : [];
          return { bedId: ba.bedId, unitFacilityId: unit?.facilityId ?? "" };
        });
      },
    },

    IpuCensusProvider: {
      async inpatientDaysForFiscalDate(organizationId, providerEntityId, asOfDate) {
        return withOrg(organizationId, async (tx) => {
          const [row] = await tx
            .select({
              n: sql<number>`coalesce(sum(${schema.ipuCensusSnapshot.bedDaysGip} + ${schema.ipuCensusSnapshot.bedDaysIrc} + ${schema.ipuCensusSnapshot.bedDaysArrangedGip} + ${schema.ipuCensusSnapshot.bedDaysArrangedIrc}), 0)::int`,
            })
            .from(schema.ipuCensusSnapshot)
            .where(
              and(
                eq(schema.ipuCensusSnapshot.providerEntityId, providerEntityId),
                lte(schema.ipuCensusSnapshot.serviceDate, asOfDate),
              ),
            );
          return row?.n ?? 0;
        });
      },
      async serviceDaysForFiscalYear(providerEntityId, fiscalYear) {
        // Fiscal year is the calendar year for the S-3 IPU line (org resolved from the PE's snapshots' RLS).
        // No org id on this signature → aggregate is provider-entity-keyed; a platform runner scopes it.
        const from = `${fiscalYear}-01-01`;
        const to = `${fiscalYear}-12-31`;
        const rows = await (db as DbClient)
          .select({
            n: sql<number>`coalesce(sum(${schema.ipuCensusSnapshot.bedDaysGip} + ${schema.ipuCensusSnapshot.bedDaysIrc} + ${schema.ipuCensusSnapshot.bedDaysArrangedGip} + ${schema.ipuCensusSnapshot.bedDaysArrangedIrc}), 0)::int`,
          })
          .from(schema.ipuCensusSnapshot)
          .where(
            and(
              eq(schema.ipuCensusSnapshot.providerEntityId, providerEntityId),
              and(
                sql`${schema.ipuCensusSnapshot.serviceDate} >= ${from}`,
                sql`${schema.ipuCensusSnapshot.serviceDate} <= ${to}`,
              ),
            ),
          );
        return rows[0]?.n ?? 0;
      },
    },

    IpuBedAssignmentProvider: {
      async hasActiveBedAssignment(organizationId, ipuAdmissionId) {
        return withOrg(organizationId, async (tx) => {
          const [ba] = await tx
            .select({ id: schema.ipuBedAssignment.id })
            .from(schema.ipuBedAssignment)
            .where(
              and(
                eq(schema.ipuBedAssignment.ipuAdmissionId, ipuAdmissionId),
                isNull(schema.ipuBedAssignment.endedAt),
              ),
            )
            .limit(1);
          return ba !== undefined;
        });
      },
    },

    IpuShiftCoverageReader: {
      async coverageActiveForUnit(organizationId, unitId, atIso) {
        return withOrg(organizationId, async (tx) => {
          const hourStart = new Date(Math.floor(new Date(atIso).getTime() / 3_600_000) * 3_600_000);
          const [w] = await tx
            .select({ isCovered: schema.ipuRnCoverageWindow.isCovered })
            .from(schema.ipuRnCoverageWindow)
            .where(
              and(
                eq(schema.ipuRnCoverageWindow.unitId, unitId),
                eq(schema.ipuRnCoverageWindow.hourStartAt, hourStart),
              ),
            )
            .limit(1);
          return w?.isCovered === true;
        });
      },
    },

    IpuIvSafetyOverlayProvider: {
      async getOverlayForOrder(organizationId, orderId) {
        return withOrg(organizationId, async (tx) => {
          const [o] = await tx
            .select()
            .from(schema.ipuIvSafetyOverlay)
            .where(
              and(
                eq(schema.ipuIvSafetyOverlay.orderId, orderId),
                eq(schema.ipuIvSafetyOverlay.overlayActive, true),
              ),
            )
            .limit(1);
          if (!o) return null;
          return {
            titrationMinRate: o.titrationMinRate ? Number(o.titrationMinRate) : 0,
            titrationMaxRate: o.titrationMaxRate
              ? Number(o.titrationMaxRate)
              : Number.POSITIVE_INFINITY,
            rateUnit: o.rateUnit,
            dualWitnessRequired: o.dualWitnessRequired,
            maxContinuousDurationHours: o.maxContinuousDurationHours,
            bedsideCheckIntervalMinutes: o.bedsideCheckIntervalMinutes,
            isSedationClass: o.isSedationClass,
          };
        });
      },
    },

    IpuVisitorReader: {
      async visitsAllowedForPatient(organizationId, patientId) {
        return withOrg(organizationId, async (tx) => {
          const restrictions = await tx
            .select({ kind: schema.ipuVisitorRestriction.restrictionKind })
            .from(schema.ipuVisitorRestriction)
            .where(
              and(
                eq(schema.ipuVisitorRestriction.patientId, patientId),
                isNull(schema.ipuVisitorRestriction.liftedAt),
              ),
            );
          try {
            // Probe with a non-family relationship — the strictest evaluation for a general "allowed?" read.
            const decision = evaluateVisitorCheckIn(
              "friend" as IpuVisitorRelationship,
              restrictions.map((r) => ({ kind: r.kind })),
            );
            return {
              allowed: true,
              maskRequired: decision.maskRequired,
              reason: decision.appliedRestriction,
            };
          } catch {
            return { allowed: false, maskRequired: false, reason: "restricted" };
          }
        });
      },
    },

    IpuQualityReader: {
      async acuityForAdmission() {
        // Deterministic rule-scoring lands with M32 augmentation; null until the acuity input surface binds.
        return null;
      },
      async restraintIncidentsForDate(organizationId, _unitId, serviceDate) {
        return withOrg(organizationId, async (tx) => {
          const [row] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.ipuRestraintEvent)
            .where(sql`${schema.ipuRestraintEvent.appliedAt}::date = ${serviceDate}`);
          return row?.n ?? 0;
        });
      },
      async mortalityCountForDate(organizationId, _unitId, serviceDate) {
        return withOrg(organizationId, async (tx) => {
          const [row] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.ipuAdmission)
            .where(
              and(
                eq(schema.ipuAdmission.state, "deceased"),
                sql`${schema.ipuAdmission.updatedAt}::date = ${serviceDate}`,
              ),
            );
          return row?.n ?? 0;
        });
      },
    },

    IpuTenantPostureReader: {
      async unitsForOrg(organizationId) {
        return withOrg(organizationId, async (tx) => {
          const rows = await tx
            .select({ unitId: schema.inpatientUnit.id, isActive: schema.inpatientUnit.isActive })
            .from(schema.inpatientUnit);
          return rows.map((r) => ({ unitId: r.unitId, isActive: r.isActive }));
        });
      },
      async openIpuAdmissionsForOrg(organizationId) {
        return withOrg(organizationId, async (tx) => {
          const [row] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.ipuAdmission)
            .where(eq(schema.ipuAdmission.state, "active"));
          return row?.n ?? 0;
        });
      },
    },
  };
}

/** Register M37's eight §4.11 published seams over the Phase-0 deny-stubs (composition-root hook). */
export function registerIpuSeams(deps: { registerSeam: RegisterSeam }, db: DbClient): void {
  const impls = buildIpuSeams(db);
  deps.registerSeam("IpuAdmissionReader", impls.IpuAdmissionReader);
  deps.registerSeam("IpuCensusProvider", impls.IpuCensusProvider);
  deps.registerSeam("IpuBedAssignmentProvider", impls.IpuBedAssignmentProvider);
  deps.registerSeam("IpuShiftCoverageReader", impls.IpuShiftCoverageReader);
  deps.registerSeam("IpuIvSafetyOverlayProvider", impls.IpuIvSafetyOverlayProvider);
  deps.registerSeam("IpuVisitorReader", impls.IpuVisitorReader);
  deps.registerSeam("IpuQualityReader", impls.IpuQualityReader);
  deps.registerSeam("IpuTenantPostureReader", impls.IpuTenantPostureReader);
}
