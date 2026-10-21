// apps/backend/src/modules/37-ipu/seams.ts — M37 §4.11 the eight PUBLISHED reader seams, backed by M37's
// Drizzle tables under RLS. The composition root registers these over the Phase-0 deny-stubs (registerSeam)
// before validateSeams(); consumers (M23/M26/M27/M13/M30/M31/M34) resolve them via getSeam. Every seam
// scopes its read to the passed organizationId via withOrgContext (RLS backstop); the returned shapes are
// PHI-lean (ids + counts + policy flags), never a raw PHI row (D17/§8.5).
import { type DbClient, schema } from "@chartwarden/db";
import { evaluateVisitorCheckIn } from "@chartwarden/inpatient";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  AdmissionId,
  IpuAdmissionReader,
  IpuBedAssignmentProvider,
  IpuCensusProvider,
  IpuIvSafetyOverlayProvider,
  IpuQualityReader,
  IpuShiftCoverageReader,
  IpuTenantPostureReader,
  IpuVisitorReader,
  IpuVisitorRelationship,
  PatientPrivacyFlagReader,
  SeamContracts,
  SeamName,
} from "@chartwarden/types";
import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import type {
  AdmissionDischargeReader,
  BodyReleaseDocumentReader,
  MdmDirectoryReader,
  RestraintOrderReader,
  VisitorConsentGate,
} from "./routes/ipu-trust-gates";
import { buildIpuIvSafetyOverlayProvider } from "./seams/iv-overlay-provider";

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
      async activeBedAssignmentForLevelOfCarePeriod(organizationId, levelOfCarePeriodId) {
        return withOrg(organizationId, async (tx) => {
          const [adm] = await tx
            .select({ id: schema.ipuAdmission.id })
            .from(schema.ipuAdmission)
            .where(eq(schema.ipuAdmission.levelOfCarePeriodId, levelOfCarePeriodId))
            .limit(1);
          if (!adm) return null;
          const [ba] = await tx
            .select({ id: schema.ipuBedAssignment.id, bedId: schema.ipuBedAssignment.bedId })
            .from(schema.ipuBedAssignment)
            .where(
              and(
                eq(schema.ipuBedAssignment.ipuAdmissionId, adm.id),
                isNull(schema.ipuBedAssignment.endedAt),
              ),
            )
            .limit(1);
          if (!ba) return null;
          return { ipuAdmissionId: adm.id, bedAssignmentId: ba.id, bedId: ba.bedId };
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

    // GAP-107 — the §2.6 overlay reader + M13's pre-administration gate (`./seams/iv-overlay-provider`).
    IpuIvSafetyOverlayProvider: buildIpuIvSafetyOverlayProvider(db),

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

// ── §4.4 cross-module seams M37 CONSUMES (not owned) ─────────────────────────────────────────────────

/**
 * GAP-061 — M5's §3.5 `PatientPrivacyFlagReader`, the sex-class + privacy-flag read the §2.2 shared-room
 * occupancy gate consults before `assignBed`. Leaf-typed in @chartwarden/types, so this resolves through the
 * M1 registry with NO import edge into M5's code (ADR-0005 D1) — the M12 `getDoseSpotMdmValidator`
 * precedent. The route service takes it as a lazy thunk so the seam is read after `wireModuleSeams()`.
 */
export function getIpuRoomingFactsReader(): PatientPrivacyFlagReader {
  return getSeam("PatientPrivacyFlagReader");
}

/**
 * GAP-062 — M39's `ConsentEvaluator`, narrowed to the one method §2.7's visitor gate calls. The seam is
 * held OPAQUELY by the M1 registry (its rich interface lives in @chartwarden/consent, which M37 does not
 * import), so this narrows with a cast — to `evaluate`, a method the real evaluator actually implements.
 */
export function getIpuVisitorConsentGate(): VisitorConsentGate {
  return getSeam("ConsentEvaluator") as VisitorConsentGate;
}

/**
 * F-069 — M11's `OrderProvider`, narrowed to the one method §2.10's restraint gate calls.
 *
 * `validateRestraintApply` takes `hasOrderingOrder: boolean` and refuses without it, quoting CoP
 * 418.110 ("even in emergency"). The service used to answer that question with
 * `body.orderingOrderId.length > 0` — whether the caller typed anything into the field — so the one
 * control the regulation is explicit about was satisfied by any non-empty string, and the physician
 * order the row claims to rest on was never looked for. M37 already `dependsOn` 11 and this seam has
 * been registered the whole time.
 */
export function getIpuOrderReader(): RestraintOrderReader {
  return getSeam("OrderProvider") as unknown as RestraintOrderReader;
}

/**
 * F-070 — M6's `AdmissionStatusReader`, narrowed to the one method §2.2's discharge gate calls.
 *
 * `transitionAdmission`'s `discharge` case refuses unless the M6 admission has itself been discharged.
 * The service used to read that boolean off the request body, so the guard has never refused anything.
 * M37 already `dependsOn` 6 and M6 registers this seam for real (`06-admission/seams/index.ts`).
 */
export function getIpuAdmissionStatusReader(): AdmissionDischargeReader {
  const reader = getSeam("AdmissionStatusReader");
  return {
    async getAdmissionSummary(organizationId, admissionId) {
      const summary = await reader.getAdmissionSummary(organizationId, admissionId as AdmissionId);
      return { status: summary.status, dischargedAt: summary.dischargedAt };
    },
  };
}

/**
 * GAP-106 — M22's `DocumentReader`, narrowed to `documentMetadata`, the one read the §2.11 release gate
 * makes (is this document an ACTIVE `body_release_authorization` for THIS release and patient?). The
 * published seam already exists, so no new contract is added; resolved per call so the deny-stub (which
 * throws) stands until M22 registers — and the gate reads a throw as "not proven", refusing the release.
 */
export function getIpuBodyReleaseDocumentReader(): BodyReleaseDocumentReader {
  const reader = getSeam("DocumentReader");
  return {
    documentMetadata: (args) => reader.documentMetadata(args),
  };
}

/**
 * GAP-106 — M40's `MdmEntityProvider` (held opaquely by the M1 registry), narrowed to the two resolves the
 * §2.11 funeral-home gate and the §2.4 attester gate make. Both are merge-aware and org-scoped inside M40.
 */
export function getIpuMdmDirectoryReader(): MdmDirectoryReader {
  return getSeam("MdmEntityProvider") as MdmDirectoryReader;
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
