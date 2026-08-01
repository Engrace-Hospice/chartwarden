// apps/backend/src/modules/13-emar — PRODUCTION EmarRouteService, READ-first (M13L-T01, mirrors M6L-T01).
//
// The screen-driving READS (administration record + census, IV-continuous session, scheduled/missed doses,
// reconciliation worksheets + decisions, comfort-kit deployments, administration policy) run as real Drizzle
// queries over the M13-owned `emar/*` tables inside `withOrgContext`, so RLS scopes every row by `app.org_id`
// as the unprivileged `wardenx_app` role. `administration_record` is PARTITIONED BY RANGE(administered_at);
// reads query the parent. The full WRITE lifecycle (record/correct/void administration, witness token mint,
// caregiver-attested capture, missed-dose ack, reconciliation decisions/finalize, comfort-kit return, policy
// put) is the M13L-T02+ follow-up; every write here fail-closes 501 (`NOT_IMPLEMENTED`). The in-memory
// `createInMemoryEmarBackend` (`routes/service.ts`) stays the behavioral reference for those writes.
//
// The backend is ALSO the {@link EmarAbacResolver} (the M12-T08 precedent): the §4.7 predicate facts resolve
// over the same dataset. `loadWorksheetTriggerKind` reads the M13-owned worksheet; the witness/caregiver
// facts depend on M2 membership / M5 caseload data outside M13's tables and fail closed until wired (they gate
// write routes that already 501).
import { type DbClient, schema } from "@wardenx/db";
import type { BarcodeMatchResult } from "@wardenx/emar";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type {
  CaregiverReviewAbacFacts,
  WitnessAbacFacts,
} from "./abac-predicates";
import type {
  AdministrationPolicyView,
  AdministrationView,
  DeploymentView,
  EmarRouteService,
  IvSessionView,
  MissedDoseView,
  ReconciliationDecisionView,
  ScheduledDoseView,
  WorksheetView,
} from "./routes/service";

const ADM = schema.administrationRecords;
const SD = schema.scheduledDoses;
const MD = schema.missedDoses;
const WS = schema.medicationReconciliationWorksheets;
const RD = schema.medicationReconciliationDecisions;
const CKD = schema.comfortKitDeployments;
const POL = schema.administrationPolicy;
const BSE = schema.barcodeScanEvents;

/** The in-memory slice's default policy (returned when the org has no `administration_policy` row). */
const DEFAULT_POLICY: AdministrationPolicyView = {
  graceWindowMinutes: 30,
  prnMinimumIntervalMinutes: 60,
  emarPdfOnCommit: false,
};

/** A never-returning stub for the write lifecycle still owed by M13L-T02+. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "eMAR writes arrive in M13L-T02+ (the Drizzle write lifecycle)",
    501,
  );
};

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** Map an `administration_record` row (+ its captured barcode match) to the read projection. */
type AdminRow = typeof ADM.$inferSelect;
const toAdminView = (r: AdminRow, match: BarcodeMatchResult | null): AdministrationView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  medicationOrderId: r.medicationOrderId,
  mode: r.mode,
  status: r.status,
  actorKind: r.actorKind,
  administeredAt: iso(r.administeredAt)!,
  recordedAt: iso(r.recordedAt)!,
  lateEntryTier: r.lateEntryTier,
  administeringClinicianMembershipId: r.administeringClinicianMembershipId ?? null,
  witnessMembershipId: r.witnessMembershipId ?? null,
  encounterId: r.encounterId ?? null,
  scheduledDoseId: r.scheduledDoseId ?? null,
  comfortKitDeploymentId: r.comfortKitDeploymentId ?? null,
  ivSessionId: r.ivSessionId ?? null,
  isControlledSubstance: r.isControlledSubstance,
  isComfortKitDrawdown: r.isComfortKitDrawdown,
  requiresRnReview: r.requiresRnReview,
  // No forward "superseded_by" pointer exists on the row (only `corrects_administration_id`, the inverse).
  supersededById: null,
  barcodeMatchResult: match,
});

const toWorksheetView = (
  w: typeof WS.$inferSelect,
  decisions: readonly ReconciliationDecisionView[],
): WorksheetView => ({
  id: w.id,
  patientId: w.patientId,
  admissionId: w.admissionId,
  triggerKind: w.triggerKind,
  status: w.status,
  lineCount: decisions.length,
  decisions,
});

const toDecisionView = (d: typeof RD.$inferSelect): ReconciliationDecisionView => ({
  lineId: d.id,
  lineKind: d.lineKind,
  sourceId: d.m12MedicationOrderId ?? d.m12MedicationHistoryRecordId ?? d.id,
  decision: d.decisionKind,
});

/**
 * The production, RLS-backed EmarRouteService + EmarAbacResolver. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `orgId` — never the body.
 */
export function createDbEmarBackend(db: DbClient): EmarRouteService {
  const withOrg = <T>(orgId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: orgId, userId: "" }, fn as never) as Promise<T>;

  /** Batch-load the captured barcode `match_result` for a set of administration ids. */
  async function matchResults(
    tx: DbClient,
    ids: readonly string[],
  ): Promise<Map<string, BarcodeMatchResult>> {
    const out = new Map<string, BarcodeMatchResult>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ adminId: BSE.administrationRecordId, match: BSE.matchResult })
      .from(BSE)
      .where(inArray(BSE.administrationRecordId, ids as string[]));
    for (const row of rows) {
      if (row.adminId && !out.has(row.adminId)) out.set(row.adminId, row.match as BarcodeMatchResult);
    }
    return out;
  }

  return {
    // ── EmarAbacResolver (§4.7 predicate facts) ────────────────────────────────────────────────────────
    async loadWitnessFacts(_orgId: string, _witnessUserId: string): Promise<WitnessAbacFacts | null> {
      // TODO(M13L-T02): witness discipline/membership facts live in M2 (organization_membership), outside
      // M13's tables. Fail closed (deny) until the membership read is wired; gates the controlled-substance
      // witness write path (501 today).
      return null;
    },
    async loadCaregiverReviewFacts(
      orgId,
      administrationId,
      _actorUserId,
    ): Promise<CaregiverReviewAbacFacts | null> {
      return withOrg(orgId, async (tx) => {
        const [r] = await tx
          .select({ requiresRnReview: ADM.requiresRnReview })
          .from(ADM)
          .where(eq(ADM.id, administrationId))
          .limit(1);
        if (!r) return null;
        // TODO(M13L-T02): `actorIsRnCaseManager` needs the M5 CaseloadProvider (patient → RN case manager),
        // outside M13's tables → fail closed until wired.
        return { requiresRnReview: r.requiresRnReview, actorIsRnCaseManager: false };
      });
    },
    async loadWorksheetTriggerKind(orgId, worksheetId) {
      return withOrg(orgId, async (tx) => {
        const [w] = await tx
          .select({ triggerKind: WS.triggerKind })
          .from(WS)
          .where(eq(WS.id, worksheetId))
          .limit(1);
        return w ? w.triggerKind : null;
      });
    },

    // ── administration reads ─────────────────────────────────────────────────────────────────────────
    async getAdministration(orgId, id): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        const [r] = await tx.select().from(ADM).where(eq(ADM.id, id)).limit(1);
        if (!r) throw new NotFoundError("administration not found");
        const m = await matchResults(tx, [r.id]);
        return toAdminView(r, m.get(r.id) ?? null);
      });
    },
    async listAdministrations(orgId, q): Promise<AdministrationView[]> {
      return withOrg(orgId, async (tx) => {
        const conds = [eq(ADM.patientId, q.patient)];
        if (q.since) conds.push(gte(ADM.administeredAt, new Date(q.since)));
        if (q.until) conds.push(lte(ADM.administeredAt, new Date(q.until)));
        const rows = await tx.select().from(ADM).where(and(...conds));
        const m = await matchResults(tx, rows.map((r) => r.id));
        return rows.map((r) => toAdminView(r, m.get(r.id) ?? null));
      });
    },
    async getIvSession(orgId, sessionId): Promise<IvSessionView> {
      return withOrg(orgId, async (tx) => {
        const segs = await tx.select().from(ADM).where(eq(ADM.ivSessionId, sessionId));
        if (segs.length === 0) throw new NotFoundError("iv session not found");
        return {
          sessionId,
          medicationOrderId: segs[0]!.medicationOrderId,
          segments: segs.map((r) => ({ kind: r.mode, recordedAt: iso(r.recordedAt)! })),
        };
      });
    },

    // ── scheduled / missed dose reads ──────────────────────────────────────────────────────────────────
    async listScheduledDoses(orgId, q): Promise<ScheduledDoseView[]> {
      return withOrg(orgId, async (tx) => {
        const conds = [eq(SD.patientId, q.patient)];
        if (q.from) conds.push(gte(SD.dueAt, new Date(q.from)));
        if (q.to) conds.push(lte(SD.dueAt, new Date(q.to)));
        const rows = await tx
          .select({
            id: SD.id,
            patientId: SD.patientId,
            medicationOrderId: SD.medicationOrderId,
            dueAt: SD.dueAt,
            status: SD.status,
          })
          .from(SD)
          .where(and(...conds));
        return rows.map((s) => ({
          id: s.id,
          patientId: s.patientId,
          medicationOrderId: s.medicationOrderId,
          dueAt: iso(s.dueAt)!,
          status: s.status,
        }));
      });
    },
    async listMissedDoses(orgId, q): Promise<MissedDoseView[]> {
      return withOrg(orgId, async (tx) => {
        // `missed_dose` carries no due_at — it is the scheduled dose's; join to source it (and filter `since`).
        const conds = [eq(MD.patientId, q.patient)];
        if (q.since) conds.push(gte(SD.dueAt, new Date(q.since)));
        const rows = await tx
          .select({
            id: MD.id,
            patientId: MD.patientId,
            scheduledDoseId: MD.scheduledDoseId,
            medicationOrderId: MD.medicationOrderId,
            dueAt: SD.dueAt,
            acknowledgedAt: MD.acknowledgedAt,
          })
          .from(MD)
          .innerJoin(SD, eq(MD.scheduledDoseId, SD.id))
          .where(and(...conds));
        return rows.map((m) => ({
          id: m.id,
          patientId: m.patientId,
          scheduledDoseId: m.scheduledDoseId,
          medicationOrderId: m.medicationOrderId,
          dueAt: iso(m.dueAt)!,
          acknowledgedAt: iso(m.acknowledgedAt),
        }));
      });
    },

    // ── reconciliation worksheet reads (worksheet + its decision lines) ──────────────────────────────────
    async listWorksheets(orgId, patient): Promise<WorksheetView[]> {
      return withOrg(orgId, async (tx) => {
        const sheets = await tx.select().from(WS).where(eq(WS.patientId, patient));
        if (sheets.length === 0) return [];
        const decisions = await tx
          .select()
          .from(RD)
          .where(inArray(RD.worksheetId, sheets.map((w) => w.id)));
        const byWorksheet = new Map<string, ReconciliationDecisionView[]>();
        for (const d of decisions) {
          const list = byWorksheet.get(d.worksheetId) ?? [];
          list.push(toDecisionView(d));
          byWorksheet.set(d.worksheetId, list);
        }
        return sheets.map((w) => toWorksheetView(w, byWorksheet.get(w.id) ?? []));
      });
    },
    async getWorksheet(orgId, id): Promise<WorksheetView> {
      return withOrg(orgId, async (tx) => {
        const [w] = await tx.select().from(WS).where(eq(WS.id, id)).limit(1);
        if (!w) throw new NotFoundError("reconciliation worksheet not found");
        const decisions = await tx.select().from(RD).where(eq(RD.worksheetId, id));
        return toWorksheetView(w, decisions.map(toDecisionView));
      });
    },

    // ── comfort-kit deployment reads ─────────────────────────────────────────────────────────────────
    async listDeployments(orgId, patient): Promise<DeploymentView[]> {
      return withOrg(orgId, async (tx) => {
        const rows = await tx
          .select({
            id: CKD.id,
            patientId: CKD.patientId,
            admissionId: CKD.admissionId,
            disposalStatus: CKD.disposalStatus,
          })
          .from(CKD)
          .where(eq(CKD.patientId, patient));
        return rows.map((d) => ({
          id: d.id,
          patientId: d.patientId,
          admissionId: d.admissionId,
          disposalStatus: d.disposalStatus,
        }));
      });
    },
    async getDeployment(orgId, id): Promise<DeploymentView> {
      return withOrg(orgId, async (tx) => {
        const [d] = await tx
          .select({
            id: CKD.id,
            patientId: CKD.patientId,
            admissionId: CKD.admissionId,
            disposalStatus: CKD.disposalStatus,
          })
          .from(CKD)
          .where(eq(CKD.id, id))
          .limit(1);
        if (!d) throw new NotFoundError("comfort-kit deployment not found");
        return { id: d.id, patientId: d.patientId, admissionId: d.admissionId, disposalStatus: d.disposalStatus };
      });
    },

    // ── administration policy read (org singleton; slice defaults when unset) ────────────────────────────
    async getPolicy(orgId): Promise<AdministrationPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [p] = await tx
          .select({
            grace: POL.defaultGraceWindowMinutes,
            prn: POL.defaultPrnReassessmentWindowMinutes,
            pdf: POL.emarPerAdministrationPdfEnabled,
          })
          .from(POL)
          .limit(1);
        return p
          ? { graceWindowMinutes: p.grace, prnMinimumIntervalMinutes: p.prn, emarPdfOnCommit: p.pdf }
          : { ...DEFAULT_POLICY };
      });
    },

    // ── writes — the M13L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ────────────────────────────
    recordAdministration: async () => notImpl(),
    mintWitnessToken: async () => notImpl(),
    recordCaregiverAttested: async () => notImpl(),
    acknowledgeCaregiver: async () => notImpl(),
    disputeCaregiver: async () => notImpl(),
    correctAdministration: async () => notImpl(),
    voidAdministration: async () => notImpl(),
    recordRefusal: async () => notImpl(),
    offlineSync: async () => notImpl(),
    intentionalHold: async () => notImpl(),
    acknowledgeMissed: async () => notImpl(),
    recordDecision: async () => notImpl(),
    updateDecision: async () => notImpl(),
    addCaregiverReportedLine: async () => notImpl(),
    finalizeReconciliation: async () => notImpl(),
    voidWorksheet: async () => notImpl(),
    acknowledgeReturn: async () => notImpl(),
    putPolicy: async () => notImpl(),
    // No outbox events are emitted on the read path.
    drainEvents: () => [],
  };
}
