// apps/backend/src/modules/06-admission — PRODUCTION AdmissionRouteService, READ-first (M6L-T01).
//
// The screen-driving READS (referral inbox, admission census + detail, election periods, compliance
// windows) run as real Drizzle queries over the M6-owned tables inside `withOrgContext`, so RLS scopes
// every row by `app.org_id` as the unprivileged `wardenx_app` role. The full WRITE lifecycle (referral →
// admission → election + CTI + F2F → LOC → discharge, with optimistic concurrency + the `m6.*` outbox)
// is the M6L-T02..T05 follow-up; every write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface
// is satisfied and the mount is real. The in-memory `createInMemoryAdmissionBackend` (`routes/service.ts`)
// stays the behavioral reference for those writes.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { type AnyColumn, and, desc, eq } from "drizzle-orm";
import { computeActivationGate } from "./intake";
import type {
  AdmissionAbacResolver,
  AdmissionDetail,
  AdmissionRouteService,
  Page,
  SummaryRow,
} from "./routes/service";

const REF = schema.referrals;
const ADM = schema.admissions;
const EP = schema.electionPeriods;
const ES = schema.electionStatements;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;
const LOC = schema.levelOfCarePeriods;
const NOR = schema.noticeOfRightsAcknowledgments;
const CW = schema.complianceWindows;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const clampLimit = (n?: number): number =>
  n === undefined ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
/** The in-memory slice cursors on an integer offset (`String(offset)`); mirror it exactly. */
const parseOffset = (cursor?: string): number => {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const toSummary = (r: { id: string; state: string; version: number }): SummaryRow => ({
  id: r.id,
  state: r.state,
  version: Number(r.version),
});

/** A never-returning stub for the write lifecycle still owed by M6L-T02+. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "admission writes arrive in M6L-T02+ (the Drizzle write lifecycle)",
    501,
  );
};

/**
 * The production, RLS-backed AdmissionRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbAdmissionRouteService(db: DbClient): AdmissionRouteService {
  /** Page a status-bearing table on the integer-offset cursor, newest-first. */
  async function pageByStatus(
    organizationId: string,
    table: typeof REF | typeof ADM | typeof CW,
    orderCol: AnyColumn,
    query: { state?: string; cursor?: string; limit?: number },
  ): Promise<Page<SummaryRow>> {
    const limit = clampLimit(query.limit);
    const offset = parseOffset(query.cursor);
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const where = query.state
        ? eq(table.status as never, query.state as never)
        : undefined;
      const rows = (await tx
        .select({ id: table.id, state: table.status, version: table.version })
        .from(table)
        .where(where)
        .orderBy(desc(orderCol as never), desc(table.id))
        .limit(limit + 1)
        .offset(offset)) as { id: string; state: string; version: number }[];
      const items = rows.slice(0, limit).map(toSummary);
      const nextCursor = rows.length > limit ? String(offset + limit) : null;
      return { items, nextCursor };
    });
  }

  /** Does an admission exist for this org? (RLS-scoped) — reads return `null` → 404 when it does not. */
  async function admissionExists(tx: DbClient, id: string): Promise<boolean> {
    const [row] = await tx.select({ id: ADM.id }).from(ADM).where(eq(ADM.id, id)).limit(1);
    return !!row;
  }

  return {
    // ── Referral reads ───────────────────────────────────────────────────────────────────────────
    async listReferrals(organizationId, query) {
      return pageByStatus(organizationId, REF, REF.receivedAt, query);
    },
    async getReferral(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: REF.id, state: REF.status, version: REF.version })
          .from(REF)
          .where(eq(REF.id, id))
          .limit(1);
        return r ? toSummary(r) : null;
      });
    },

    // ── Admission reads ──────────────────────────────────────────────────────────────────────────
    async listAdmissions(organizationId, query) {
      return pageByStatus(organizationId, ADM, ADM.admissionAt, query);
    },
    async getAdmission(organizationId, id): Promise<AdmissionDetail | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ id: ADM.id, status: ADM.status, version: ADM.version })
          .from(ADM)
          .where(eq(ADM.id, id))
          .limit(1);
        if (!adm) return null;
        // R-AC-01 activation gate — computed from the period-1 bundle (§5.2.5). Loaded org-scoped.
        const [period] = await tx
          .select({ id: EP.id, sequenceNumber: EP.sequenceNumber })
          .from(EP)
          .where(and(eq(EP.admissionId, id), eq(EP.sequenceNumber, 1)))
          .limit(1);
        let electionSigned = false;
        let ctiHospiceMdSigned = false;
        let ctiAttendingSigned = false;
        if (period) {
          const [es] = await tx
            .select({ id: ES.id })
            .from(ES)
            .where(eq(ES.electionPeriodId, period.id))
            .limit(1);
          electionSigned = !!es;
          const [cti] = await tx
            .select({ h: CTI.hospiceMdSignedAt, a: CTI.attendingMdSignedAt })
            .from(CTI)
            .where(eq(CTI.electionPeriodId, period.id))
            .limit(1);
          ctiHospiceMdSigned = !!cti?.h;
          ctiAttendingSigned = !!cti?.a;
        }
        const [nor] = await tx
          .select({ id: NOR.id })
          .from(NOR)
          .where(eq(NOR.admissionId, id))
          .limit(1);
        const activationGate = computeActivationGate({
          periodSequence: period?.sequenceNumber ?? 1,
          electionSigned,
          norAcknowledged: !!nor,
          ctiHospiceMdSigned,
          ctiAttendingSigned,
        });
        return { id: adm.id, state: adm.status, version: Number(adm.version), activationGate };
      });
    },

    // ── Election reads ───────────────────────────────────────────────────────────────────────────
    async getElectionStatement(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // election_statement has no status column; a persisted row is a signed statement (signed_at NOT NULL).
        const [r] = await tx.select({ id: ES.id, version: ES.version }).from(ES).where(eq(ES.id, id)).limit(1);
        return r ? { id: r.id, state: "signed", version: Number(r.version) } : null;
      });
    },
    async listElectionPeriods(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: EP.id, state: EP.status, version: EP.version })
          .from(EP)
          .where(eq(EP.admissionId, admissionId))
          .orderBy(EP.sequenceNumber);
        return rows.map(toSummary);
      });
    },

    // ── CTI / F2F reads ──────────────────────────────────────────────────────────────────────────
    async getCti(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: CTI.id, state: CTI.status, version: CTI.version })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        return r ? toSummary(r) : null;
      });
    },
    async getF2f(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: F2F.id, state: F2F.status, version: F2F.version })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        return r ? toSummary(r) : null;
      });
    },

    // ── LOC / NOR reads (derived state — neither table carries a status column) ────────────────────
    async listLoc(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: LOC.id, endedAt: LOC.endedAt, version: LOC.version })
          .from(LOC)
          .where(eq(LOC.admissionId, admissionId))
          .orderBy(desc(LOC.effectiveAt));
        return rows.map((r) => ({
          id: r.id,
          state: r.endedAt ? "ended" : "active",
          version: Number(r.version),
        }));
      });
    },
    async getNor(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: NOR.id, version: NOR.version })
          .from(NOR)
          .where(eq(NOR.admissionId, admissionId))
          .limit(1);
        return r ? { id: r.id, state: "acknowledged", version: Number(r.version) } : null;
      });
    },

    // ── Compliance-window reads ────────────────────────────────────────────────────────────────────
    async listComplianceWindowsForAdmission(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: CW.id, state: CW.status, version: CW.version })
          .from(CW)
          .where(eq(CW.admissionId, admissionId))
          .orderBy(desc(CW.mustCompleteBy));
        return rows.map(toSummary);
      });
    },
    async listComplianceWindows(organizationId, query) {
      return pageByStatus(organizationId, CW, CW.mustCompleteBy, query);
    },

    // ── Writes — the M6L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ───────────────────────
    createReferral: async () => notImpl(),
    updateReferral: async () => notImpl(),
    triageReferral: async () => notImpl(),
    acceptReferral: async () => notImpl(),
    declineReferral: async () => notImpl(),
    createAdmission: async () => notImpl(),
    updateAdmission: async () => notImpl(),
    holdAdmission: async () => notImpl(),
    resumeAdmission: async () => notImpl(),
    activateAdmission: async () => notImpl(),
    draftElectionStatement: async () => notImpl(),
    signElection: async () => notImpl(),
    voidElection: async () => notImpl(),
    createElectionPeriod: async () => notImpl(),
    patchElectionPeriod: async () => notImpl(),
    draftCti: async () => notImpl(),
    signCtiHospiceMd: async () => notImpl(),
    signCtiAttending: async () => notImpl(),
    voidCti: async () => notImpl(),
    markCtiLate: async () => notImpl(),
    scheduleF2f: async () => notImpl(),
    completeF2f: async () => notImpl(),
    attestF2f: async () => notImpl(),
    overrideF2fWindow: async () => notImpl(),
    changeLoc: async () => notImpl(),
    patchLoc: async () => notImpl(),
    createRevocation: async () => notImpl(),
    transferOut: async () => notImpl(),
    transferIn: async () => notImpl(),
    discharge: async () => notImpl(),
    cosignDischarge: async () => notImpl(),
    acknowledgeNor: async () => notImpl(),
    closeComplianceWindow: async () => notImpl(),
    overrideComplianceWindow: async () => notImpl(),
  };
}

/**
 * The production, RLS-backed AdmissionAbacResolver — the §4.6 signer-identity write predicates
 * (F2F attest, discharge medical-director cosign, compliance override) load a resource's owner facts
 * through it. Every load is a single org-scoped read under `withOrgContext` (RLS backstops), returning
 * `null` when the row is absent/cross-tenant so the predicate fails closed.
 */
export function createDbAdmissionAbacResolver(db: DbClient): AdmissionAbacResolver {
  return {
    async loadReferral(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ locationId: REF.locationId, providerEntityId: REF.providerEntityId })
          .from(REF)
          .where(eq(REF.id, id))
          .limit(1);
        return r ? { locationId: r.locationId ?? null, providerEntityId: r.providerEntityId ?? null } : null;
      });
    },
    async loadAdmission(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ patientId: ADM.patientId, providerEntityId: ADM.providerEntityId })
          .from(ADM)
          .where(eq(ADM.id, id))
          .limit(1);
        return r ? { patientId: r.patientId, providerEntityId: r.providerEntityId ?? null } : null;
      });
    },
    async loadCti(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ hospiceMdId: CTI.hospiceMdId, attendingMdId: CTI.attendingMdId })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        return r
          ? { hospiceMedicalDirectorId: r.hospiceMdId, attendingPhysicianId: r.attendingMdId ?? null }
          : null;
      });
    },
    async loadF2f(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // The DB stores the performer as `performed_by_user_id`; the §4.6 predicate reads it as the
        // scheduled clinician (the person whose identity the attest gate matches).
        const [r] = await tx
          .select({ performedByUserId: F2F.performedByUserId })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        return r ? { scheduledClinicianId: r.performedByUserId } : null;
      });
    },
    async loadComplianceWindow(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // compliance_window carries no patient/provider — join the admission it belongs to.
        const [r] = await tx
          .select({
            admissionId: CW.admissionId,
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
          })
          .from(CW)
          .innerJoin(ADM, eq(CW.admissionId, ADM.id))
          .where(eq(CW.id, id))
          .limit(1);
        return r
          ? { admissionId: r.admissionId, patientId: r.patientId, providerEntityId: r.providerEntityId ?? null }
          : null;
      });
    },
  };
}
