// apps/backend/src/modules/12-dosespot — PRODUCTION MedicationOrderRouteService, READ-first (M12L-T01).
//
// The screen-driving READS (medication-order list + detail, active-medications, transmission status, the
// refill inbox, the prescriber roster) run as real Drizzle queries over the M12-owned tables inside
// `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged `wardenx_app` role.
// `medication_order` is partitioned — reads query the parent. The full WRITE lifecycle (draft → sign →
// EPCS controlled-substance sign → verbal → cosign → discontinue/complete, refill approve/deny, prescriber
// enrollment, policy tighten, med-history reconcile) plus the `m12.*` outbox is the M12L-T02+ follow-up;
// every write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface is satisfied and the mount is real.
// The in-memory `createInMemoryDoseSpotBackend` (`routes/service.ts`) stays the behavioral reference for
// those writes. EPCS stays OFF (D18) — the controlled-substance write branch is 501 regardless.
//
// The returned object is BOTH the route service AND the §4.7 ABAC resolver (one object, like the in-mem
// slice: `MedicationOrderRouteService extends DoseSpotAbacResolver`).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DeaSchedule } from "@wardenx/types";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type {
  ControlledSubstancePolicyView,
  MedicationOrderRouteService,
  MedicationOrderView,
  PrescriberRosterView,
  RefillInboxPolicyView,
  RefillRequestView,
} from "./routes/service";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;
const RR = schema.refillRequests;
const DP = schema.dosespotPrescribers;

/** A never-returning stub for the write lifecycle still owed by M12L-T02+. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "DoseSpot writes arrive in M12L-T02+ (the Drizzle write lifecycle; EPCS stays OFF, D18)",
    501,
  );
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Project a medication_order row to the wire view. `prescriberDiscipline`/`signedBy`/`discontinuationReason`
 * have no persisted column yet (the write lifecycle populates them) → read-safe defaults. */
type MoRow = typeof MO.$inferSelect;
const toOrderView = (r: MoRow): MedicationOrderView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  medClass: r.medClass,
  status: r.status,
  drugName: r.drugName,
  strength: r.strength,
  doseForm: r.doseForm,
  route: r.route,
  rxnormRxcui: r.rxnormRxcui ?? null,
  ndc: r.ndc ?? null,
  version: Number(r.version),
  prescriberMembershipId: r.prescriberMembershipId,
  prescriberDiscipline: "", // no persisted column (write lifecycle owns it) — M12L-T02+
  prescribingPhysicianMdmId: r.prescribingPhysicianMdmId,
  dispensingPharmacyMdmId: r.dispensingPharmacyMdmId ?? null,
  isControlledSubstance: r.isControlledSubstance,
  deaSchedule: r.deaSchedule ?? null,
  cosignRequired: r.cosignRequired,
  cosignStatus: (r.cosignStatus as "pending" | "attached" | null) ?? null,
  refillsRemaining: Number(r.refillsRemaining),
  derivedFromRefillId: r.derivedFromRefillId ?? null,
  replacesMedicationOrderId: r.replacesMedicationOrderId ?? null,
  signedAt: iso(r.signedAt),
  signedBy: null, // no persisted signer-membership column — M12L-T02+
  transmittedAt: iso(r.transmittedAt),
  discontinuedAt: iso(r.discontinuedAt),
  discontinuationReason: null, // no persisted column — M12L-T02+
  createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
});

type RrRow = typeof RR.$inferSelect;
const toRefillView = (r: RrRow): RefillRequestView => ({
  id: r.id,
  patientId: r.patientId,
  sourceMedicationOrderId: r.sourceMedicationOrderId,
  status: r.status,
  requestedAt: iso(r.receivedAt) ?? new Date(0).toISOString(),
  prescriberMembershipId: r.approvedByMembershipId ?? null,
  resultingMedicationOrderId: r.resultingMedicationOrderId ?? null,
});

const DEFAULT_REFILL_POLICY: RefillInboxPolicyView = {
  slaWarnHours: 48,
  slaCriticalHours: 72,
  platformFloorWarnHours: 48,
  platformFloorCriticalHours: 72,
};
const DEFAULT_CS_POLICY: ControlledSubstancePolicyView = {
  scheduleIiMaxRefills: 0,
  scheduleIiiToVMaxRefills: 5,
  epcsCertificationStatus: "not_certified",
};

/**
 * The production, RLS-backed DoseSpot backend (service + §4.7 ABAC resolver in one object). Reads are real;
 * writes fail-closed 501. Org is bound from the request context by the caller — never the body.
 */
export function createDbDoseSpotBackend(db: DbClient): MedicationOrderRouteService {
  const withOrg = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));

  return {
    // ── Medication-order reads ─────────────────────────────────────────────────────────────────────
    async listOrders(organizationId, filter) {
      return withOrg(organizationId, async (tx) => {
        const preds = [
          filter.patientId ? eq(MO.patientId, filter.patientId) : undefined,
          filter.prescriberId ? eq(MO.prescriberMembershipId, filter.prescriberId) : undefined,
          filter.medClass ? eq(MO.medClass, filter.medClass as MoRow["medClass"]) : undefined,
          filter.status ? eq(MO.status, filter.status as MoRow["status"]) : undefined,
        ].filter((p): p is NonNullable<typeof p> => p !== undefined);
        const rows = await tx
          .select()
          .from(MO)
          .where(preds.length ? and(...preds) : undefined)
          .orderBy(desc(MO.createdAt), desc(MO.id));
        return { orders: rows.map(toOrderView) };
      });
    },
    async getOrder(organizationId, id) {
      return withOrg(organizationId, async (tx) => {
        const [r] = await tx.select().from(MO).where(eq(MO.id, id)).limit(1);
        if (!r) throw new NotFoundError(`medication order ${id} not found`);
        return toOrderView(r);
      });
    },
    async getTransmission(organizationId, id) {
      return withOrg(organizationId, async (tx) => {
        const [order] = await tx.select({ id: MO.id }).from(MO).where(eq(MO.id, id)).limit(1);
        if (!order) throw new NotFoundError(`medication order ${id} not found`);
        const [t] = await tx
          .select()
          .from(MOT)
          .where(eq(MOT.medicationOrderId, id))
          .orderBy(desc(MOT.queuedAt))
          .limit(1);
        const status = !t
          ? "not_transmitted"
          : t.transmissionSucceededAt
            ? "transmitted"
            : t.transmissionFailedAt
              ? "transmission_failed"
              : t.transmissionStartedAt
                ? "in_flight"
                : "queued";
        const retryHistory =
          t && t.retryCount > 0
            ? [
                {
                  attempt: Number(t.retryCount),
                  at: iso(t.transmissionFailedAt ?? t.transmissionStartedAt ?? t.queuedAt) ?? "",
                  errorClass: t.lastErrorClass ?? null,
                },
              ]
            : [];
        return { orderId: id, status, retryHistory };
      });
    },
    async activeMedications(organizationId, patientId) {
      return withOrg(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(MO)
          .where(and(eq(MO.patientId, patientId), eq(MO.status, "active")))
          .orderBy(desc(MO.createdAt));
        return { orders: rows.map(toOrderView) };
      });
    },
    async medicationHistory(_organizationId, _patientId) {
      // The external DoseSpot MedHx fetch is a write-side job (refreshHistory → 501); no local projection.
      return { records: [] };
    },

    // ── Refill-inbox reads ─────────────────────────────────────────────────────────────────────────
    async listRefills(organizationId, _userId) {
      // RLS scopes to the org. The finer named-prescriber ∨ caseload narrowing (the in-mem filter) needs
      // the M5 caseload seam — deferred to M12L-T02+; the per-item `refill_inbox_scope` ABAC guards detail.
      return withOrg(organizationId, async (tx) => {
        const rows = await tx.select().from(RR).orderBy(desc(RR.receivedAt));
        return { refills: rows.map(toRefillView) };
      });
    },
    async getRefill(organizationId, id) {
      return withOrg(organizationId, async (tx) => {
        const [r] = await tx.select().from(RR).where(eq(RR.id, id)).limit(1);
        if (!r) throw new NotFoundError(`refill request ${id} not found`);
        return toRefillView(r);
      });
    },

    // ── Prescriber-roster read ─────────────────────────────────────────────────────────────────────
    async listPrescribers(organizationId) {
      return withOrg(organizationId, async (tx) => {
        const rows = await tx.select().from(DP);
        const prescribers: PrescriberRosterView[] = rows.map((p) => ({
          membershipId: p.membershipId,
          enrolled: !!p.enrolledAt && !p.revokedAt,
          deaAuthorizedSchedules: (p.deaAuthorizedSchedules ?? []) as readonly DeaSchedule[],
          ial2Status: p.ial2VerifiedAt ? "verified" : "not_started",
        }));
        return { prescribers };
      });
    },

    // ── Policy reads (platform defaults; per-tenant overrides land with the write lifecycle) ─────────
    async getRefillInboxPolicy(_organizationId) {
      return DEFAULT_REFILL_POLICY;
    },
    async getControlledSubstancePolicy(_organizationId) {
      return DEFAULT_CS_POLICY;
    },

    // ── §4.7 ABAC resolver reads ───────────────────────────────────────────────────────────────────
    async loadAuthorizedSchedules(organizationId, userId) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ schedules: DP.deaAuthorizedSchedules })
          .from(DP)
          .where(eq(DP.membershipId, userId))
          .limit(1);
        return row ? ((row.schedules ?? []) as readonly string[]) : null;
      });
    },
    async loadRefillScope(organizationId, refillId, userId) {
      return withOrg(organizationId, async (tx) => {
        const [r] = await tx
          .select({
            sourceMedicationOrderId: RR.sourceMedicationOrderId,
            approvedByMembershipId: RR.approvedByMembershipId,
          })
          .from(RR)
          .where(eq(RR.id, refillId))
          .limit(1);
        if (!r) return null;
        const [source] = await tx
          .select({ prescriberMembershipId: MO.prescriberMembershipId })
          .from(MO)
          .where(eq(MO.id, r.sourceMedicationOrderId))
          .limit(1);
        return {
          isNamedPrescriber:
            r.approvedByMembershipId === userId || source?.prescriberMembershipId === userId,
          // caseload axis needs the M5 caseload seam (M12L-T02+); fail closed until bound.
          patientInCaseload: false,
        };
      });
    },

    // ── Writes — the M12L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ────────────────────────
    createDraft: async () => notImpl(),
    editDraft: async () => notImpl(),
    requestSignature: async () => notImpl(),
    signOrder: async () => notImpl(),
    signControlledInitiate: async () => notImpl(),
    signControlledComplete: async () => notImpl(),
    recordVerbal: async () => notImpl(),
    cosignOrder: async () => notImpl(),
    discontinueOrder: async () => notImpl(),
    completeOrder: async () => notImpl(),
    correctOrder: async () => notImpl(),
    retransmit: async () => notImpl(),
    refreshHistory: async () => notImpl(),
    reconcileHistory: async () => notImpl(),
    approveRefill: async () => notImpl(),
    denyRefill: async () => notImpl(),
    rxBenefitLookup: async () => notImpl(),
    enrollPrescriber: async () => notImpl(),
    revokePrescriber: async () => notImpl(),
    putRefillInboxPolicy: async () => notImpl(),
    putControlledSubstancePolicy: async () => notImpl(),

    // The prod outbox is the M1 transactional relay, not a drainable in-memory buffer.
    drainEvents: () => [],
  };
}
