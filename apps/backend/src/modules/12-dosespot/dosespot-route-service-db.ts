import { type DbClient, schema } from "@wardenx/db";
// apps/backend/src/modules/12-dosespot — PRODUCTION MedicationOrderRouteService + §4.7 ABAC resolver
// (M12L reads + writes over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (medication-order list + detail, active-medications, transmission status, the
// refill inbox, the prescriber roster) run as real Drizzle queries over the M12-owned tables inside
// `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged `wardenx_app` role.
// `medication_order` is PARTITION BY RANGE(created_at) — reads query the parent, inserts always land.
//
// Unlike M11, M12 has NO state-transition triggers (only the M4 audit triggers) — the service does every
// status transition itself via UPDATE, composing the PURE `@wardenx/dosespot` deciders: the §2.2 D2
// medication-order machine (`transitionMedicationOrder`), the §2.7 D9 refill machine (`transitionRefillRequest`),
// and `isEpcsRequired`. Route-driven writes stop at `signed` — the transmission chain (signed → queued →
// transmitted → ack → active) and the EPCS controlled-substance branch are SYSTEM-ACTOR only, so a controlled
// order fail-closes at requestSignature (`EPCS_NOT_CERTIFIED`, D18) and never reaches pending_signature.
// Every mutation emits its strict `m12.*` catalog payload on the bound transactional outbox (the publisher
// Value.Checks each and rolls back on mismatch), so the payloads here are the exact events-by-m12.ts shapes.
//
// Documented compromises (the M8–M11 convention; the interface threads no siting/discipline/seams into the
// DB backend): (1) `withOrgContext` runs with `userId:""` → the M4 write-audit trigger fires with a NULL
// actor (the acting membership is the passed `userId`, stored where a column exists); (2) provider/location
// siting is null (mig 0132); (3) medication_order has NO prescriber_discipline / signed_by / discontinuation_
// reason column, so requestSignature's eligibility reads the threaded `signerDiscipline` arg and the read view
// surfaces the stable defaults; (4) the M11 `OrderSignatureProvider` sign seam + the M22 medhx store are not
// threaded — signing UPDATEs the order status directly (no order_signature row) and reconcileHistory returns
// null, both mirroring the in-memory reference; (5) the refill-SLA / controlled-substance policies have no
// table in Phase 1 — the put* routes apply their tighten-only guards and return the computed view without
// persisting (the platform default is authoritative).
import {
  isEpcsRequired,
  transitionMedicationOrder,
  transitionRefillRequest,
  validateMedicationOrderData,
} from "@wardenx/dosespot";
import { withOrgContext } from "@wardenx/tenancy";
import type { DeaSchedule, MedClass } from "@wardenx/types";
import { NotFoundError, ValidationError } from "@wardenx/types";
import { type SQL, and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { prescriberEligible } from "./prescriber-eligibility";
import type {
  ControlledSubstancePolicyView,
  CreateMedicationOrderArgs,
  DoseSpotAbacActor,
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

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The disciplines eligible to SIGN a medication order (§4.6 — prescriber-only; RN drafts, never signs). */
const SIGNER_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
]);
const signerEligibleForMed = (discipline: string): boolean =>
  SIGNER_DISCIPLINES.has(discipline.toLowerCase());

/** The transactional-outbox port (§4.4): the bound publisher validates every emit against the boot catalog
 * and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests commit
 * without a dispatcher. Mirrors M7/M8/M9/M10/M11. */
export interface DoseSpotWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: DoseSpotWriteOutboxPort = { async publish() {} };

/** First row of a RETURNING/SELECT, or a 500 (unreachable after a successful write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new NotFoundError(msg);
  return r;
}

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
  data: r.data,
  rxnormRxcui: r.rxnormRxcui ?? null,
  ndc: r.ndc ?? null,
  version: Number(r.version),
  prescriberMembershipId: r.prescriberMembershipId,
  prescriberDiscipline: "", // no persisted column (request-time attribute) — read-safe default
  prescribingPhysicianMdmId: r.prescribingPhysicianMdmId,
  dispensingPharmacyMdmId: r.dispensingPharmacyMdmId ?? null,
  isControlledSubstance: r.isControlledSubstance,
  deaSchedule: r.deaSchedule ?? null,
  cosignRequired: r.cosignRequired,
  cosignStatus: (r.cosignStatus as "pending" | "attached" | null) ?? null,
  refillsRemaining: Number(r.refillsRemaining),
  refillsAuthorized: Number(r.refillsAuthorized),
  derivedFromRefillId: r.derivedFromRefillId ?? null,
  replacesMedicationOrderId: r.replacesMedicationOrderId ?? null,
  signedAt: iso(r.signedAt),
  signedBy: null, // no persisted signer-membership column (the M11 sign seam is not threaded here)
  transmittedAt: iso(r.transmittedAt),
  discontinuedAt: iso(r.discontinuedAt),
  discontinuationReason: null, // no persisted column
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
 * The §2.7 refill-inbox narrowing, AS A `WHERE` CLAUSE — "which refill rows belong to this actor's
 * inbox?" over the three axes {@link MedicationOrderRouteService.loadRefillScope} gates a detail with.
 * `null` means no axis can name a row for this actor (no caseload, no membership id): the caller must
 * return an empty inbox WITHOUT querying, because an empty `or()` folds to `undefined` in drizzle —
 * an unfiltered read, which is exactly the tenant-wide leak this narrowing exists to close.
 *
 * Exported because the SQL SHAPE is the security- and cost-relevant property, and it is the one thing
 * a behavioural test cannot see: a post-read `rows.filter(...)` returns the same rows as this does
 * (that is what GAP-026 first shipped) while still reading every refill in the tenant into app memory.
 * `refillInboxWhere(...).toSQL()` is what tells those two apart.
 *
 * `db` is used only to RENDER the correlated EXISTS sub-select; a subquery never executes on its own,
 * and the caller's `withOrgContext` transaction is what runs (and RLS-scopes) the finished statement.
 */
export function refillInboxWhere(
  db: DbClient,
  args: { caseloadPatientIds: readonly string[]; actor: DoseSpotAbacActor },
): SQL | null {
  const me = args.actor.membershipId;
  const axes: SQL[] = [];
  if (args.caseloadPatientIds.length > 0)
    axes.push(inArray(RR.patientId, [...args.caseloadPatientIds]));
  if (me !== null) {
    axes.push(eq(RR.approvedByMembershipId, me));
    axes.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(MO)
          .where(
            and(
              eq(MO.id, RR.sourceMedicationOrderId),
              eq(MO.organizationId, RR.organizationId),
              eq(MO.prescriberMembershipId, me),
            ),
          ),
      ),
    );
  }
  return axes.length === 0 ? null : (or(...axes) as SQL);
}

/**
 * The production, RLS-backed DoseSpot backend (service + §4.7 ABAC resolver in one object). Reads + the write
 * lifecycle are live over Drizzle+RLS; every mutation emits `m12.*` on the bound transactional `outbox`. Org
 * is bound from the request context by the caller — never the body.
 */
export function createDbDoseSpotBackend(
  db: DbClient,
  outbox: DoseSpotWriteOutboxPort = NOOP_OUTBOX,
): MedicationOrderRouteService {
  const withOrg = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));

  /**
   * The §2.7 caseload axis (GAP-026) — "is this refill's patient on the caller's caseload right now?",
   * through M5's published `CaseloadProvider` seam. This used to be the literal `patientInCaseload:
   * false` placeholder, so `refill_inbox_scope`'s second disjunct never fired and a covering clinician
   * could not open, approve or deny a refill for a patient they are actively caring for.
   *
   * `userId` here is the M2 USER id, not a membership id: the seam reads
   * `patient_assignment.clinician_user_id`, and passing the membership id would silently match
   * nothing — the same class of mistake this gap was.
   *
   * Called OUTSIDE `withOrg`: the M5 provider opens its own `withOrgContext`, and nesting one inside
   * another sets the GUC on an already-bound connection. Fail-CLOSED on a seam error (unregistered,
   * deny-stub, RLS-empty) — an authorization axis that cannot be evaluated does not grant.
   */
  /**
   * Every patient id on the caller's caseload right now — the list-side counterpart of
   * {@link patientInCaseload}, one seam call instead of one per row. Same fail-closed posture: an
   * unresolvable caseload narrows the inbox to the named-prescriber axis rather than widening it.
   */
  const caseloadPatientIds = async (
    organizationId: string,
    userId: string,
  ): Promise<readonly string[]> => {
    if (!userId) return [];
    try {
      return await getSeam("CaseloadProvider").caseloadPatientIds({ organizationId, userId });
    } catch {
      return [];
    }
  };

  const patientInCaseload = async (
    organizationId: string,
    userId: string,
    patientId: string,
  ): Promise<boolean> => {
    if (!userId) return false;
    try {
      return await getSeam("CaseloadProvider").isInCaseload({ organizationId, userId, patientId });
    } catch {
      return false;
    }
  };

  /** Emit one `m12.*` event on the caller's tx (validated + persisted by the bound publisher). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind,
      aggregateId,
    });
  }

  /** Load a medication_order row (RLS-scoped) or the non-leaking 404. */
  /**
   * GAP-024 — the §4.4 M22 render handshake for a signed medication order. Declared in the catalog as a
   * "mirror of `signed`" since M12-T04 and named in M22's consumer allowlist just as long, but emitted from
   * nowhere: the medication-order PDF was never requested. Shared by BOTH sign paths (the ordinary
   * `signOrder` and the EPCS `signControlledComplete`) so the controlled-substance route cannot quietly
   * skip the render the moment EPCS is enabled.
   *
   * `formTemplate` is M22's PUBLISHED template key (`medication_order`) — M22 refuses a key it cannot
   * resolve. `patientId` rides inside `renderPayload` (catalog schema `Type.Unknown()`, so no payload-schema
   * change) because the rendered `document` files against the patient's chart.
   */
  async function emitDocumentRequest(
    tx: DbClient,
    organizationId: string,
    order: MoRow,
    signedAt: Date,
  ): Promise<void> {
    await emit(
      tx,
      organizationId,
      "m12.medication_order.document_requested",
      "medication_order",
      order.id,
      {
        orderId: order.id,
        formTemplate: "medication_order",
        renderPayload: {
          patientId: order.patientId,
          admissionId: order.admissionId,
          signedAt: signedAt.toISOString(),
          isControlledSubstance: order.isControlledSubstance,
        },
      },
    );
  }

  async function loadOrder(tx: DbClient, id: string): Promise<MoRow> {
    const [r] = await tx.select().from(MO).where(eq(MO.id, id)).limit(1);
    if (!r) throw new NotFoundError(`medication order ${id} not found`);
    return r;
  }
  /** Re-read one order (post-write) as the wire view. */
  async function readOrder(tx: DbClient, id: string): Promise<MedicationOrderView> {
    return toOrderView(await loadOrder(tx, id));
  }

  /** Insert a `draft` medication_order (shared by createDraft / correctOrder / retransmit / refill mint).
   *
   * `acquisition_cost_cents` (mig 0158) is DELIBERATELY not written here and carries no route field: the
   * create/update bodies are prescriber clinical shapes and a prescriber does not know the drug's
   * acquisition cost — the future DoseSpot fill/NDC pricing feed populates it at dispense time (a plain
   * `update ... set acquisitionCostCents` when that webhook lands). Until then every line is honestly
   * NULL = "not priced", and the §2.10 cost-basis seam refuses to aggregate unpriced lines (never $0). */
  async function insertDraft(
    tx: DbClient,
    organizationId: string,
    userId: string,
    args: CreateMedicationOrderArgs,
  ): Promise<string> {
    const findings = validateMedicationOrderData(args.medClass, undefined, args.data, false);
    if (findings.length) throw new ValidationError("medication draft validation failed", findings);
    const controlled = isEpcsRequired(args.medClass, args.containsControlled ?? false);
    // The `medication_order_controlled_schedule_consistency` CHECK requires is_controlled = (dea_schedule
    // IS NOT NULL): pin a schedule for a controlled draft, and force null for a non-controlled one.
    const sched: DeaSchedule | null = controlled ? (args.deaSchedule ?? "II") : null;
    const row = firstOrThrow(
      await tx
        .insert(MO)
        .values({
          organizationId,
          patientId: args.patientId,
          admissionId: args.admissionId,
          medClass: args.medClass,
          isControlledSubstance: controlled,
          deaSchedule: sched,
          rxnormRxcui: args.rxnormRxcui ?? null,
          ndc: args.ndc ?? null,
          drugName: args.drugName,
          strength: args.strength,
          doseForm: args.doseForm,
          route: args.route,
          data: args.data ?? {},
          prescriberMembershipId: userId,
          prescribingPhysicianMdmId: args.prescribingPhysicianMdmId,
          dispensingPharmacyMdmId: args.dispensingPharmacyMdmId ?? null,
          refillsAuthorized: args.refillsAuthorized,
          refillsRemaining: args.refillsAuthorized,
          status: "draft",
          derivedFromRefillId: args.derivedFromRefillId ?? null,
          replacesMedicationOrderId: args.replacesMedicationOrderId ?? null,
        })
        .returning({ id: MO.id }),
      "medication_order insert returned no row",
    );
    await emit(
      tx,
      organizationId,
      "m12.medication_order.draft_created",
      "medication_order",
      row.id,
      {
        orderId: row.id,
        patientId: args.patientId,
        medClass: args.medClass,
        isControlledSubstance: controlled,
      },
    );
    return row.id;
  }

  return {
    // ── Medication-order reads ─────────────────────────────────────────────────────────────────────
    async listOrders(organizationId, filter) {
      return withOrg(organizationId, async (tx) => {
        const scopedPreds = [
          filter.patientId ? eq(MO.patientId, filter.patientId) : undefined,
          filter.prescriberId ? eq(MO.prescriberMembershipId, filter.prescriberId) : undefined,
          filter.medClass ? eq(MO.medClass, filter.medClass as MoRow["medClass"]) : undefined,
        ].filter((p): p is NonNullable<typeof p> => p !== undefined);
        const preds = [...scopedPreds, filter.status ? eq(MO.status, filter.status as MoRow["status"]) : undefined]
          .filter((p): p is NonNullable<typeof p> => p !== undefined);
        const [rows, counts] = await Promise.all([tx
          .select()
          .from(MO)
          .where(preds.length ? and(...preds) : undefined)
          .orderBy(desc(MO.createdAt), desc(MO.id)), tx
          .select({ status: MO.status, count: sql<number>`count(*)` })
          .from(MO)
          .where(scopedPreds.length ? and(...scopedPreds) : undefined)
          .groupBy(MO.status)]);
        return { orders: rows.map(toOrderView), statusCounts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])) };
      });
    },
    async getOrder(organizationId, id) {
      return withOrg(organizationId, async (tx) => readOrder(tx, id));
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
      // The external DoseSpot MedHx fetch is a write-side job; no local projection until the store is threaded.
      return { records: [] };
    },

    // ── Medication-order writes (§2.2 lifecycle; the service does the transitions, no DB triggers) ───
    async createDraft(organizationId, userId, args) {
      return withOrg(organizationId, async (tx) =>
        readOrder(tx, await insertDraft(tx, organizationId, userId, args)),
      );
    },
    async editDraft(organizationId, id, patch) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        if (r.status !== "draft")
          throw new NotFoundError(`medication order ${id} is not a draft and cannot be edited`);
        if (patch.data !== undefined) {
          const findings = validateMedicationOrderData(r.medClass, undefined, patch.data, false);
          if (findings.length) throw new ValidationError("medication draft validation failed", findings);
        }
        await tx
          .update(MO)
          .set({
            data: patch.data !== undefined ? patch.data : r.data,
            drugName: patch.drugName ?? r.drugName,
            strength: patch.strength ?? r.strength,
            refillsRemaining: patch.refillsAuthorized ?? r.refillsRemaining,
            refillsAuthorized: patch.refillsAuthorized ?? r.refillsAuthorized,
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(MO.id, id));
        return readOrder(tx, id);
      });
    },
    async requestSignature(organizationId, id, signerDiscipline) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        const findings = validateMedicationOrderData(r.medClass, undefined, r.data, true);
        if (findings.length) throw new ValidationError("medication order is not ready for signature", findings);
        // medication_order has no prescriber_discipline column — read the threaded discipline arg (§4.1).
        transitionMedicationOrder(r.status, {
          type: "requestSignature",
          medClass: r.medClass,
          containsControlled: r.isControlledSubstance,
          requiredDataComplete: true,
          prescriberEligible: prescriberEligible(signerDiscipline, r.medClass),
          allergyCheckPassed: true,
          sudConsentSatisfied: true, // M39 consent unbound in the DB backend → allowed (§7.13)
          tenantEpcsCertified: DEFAULT_CS_POLICY.epcsCertificationStatus === "certified", // false (D18)
        });
        await tx
          .update(MO)
          .set({ status: "pending_signature", version: r.version + 1, updatedAt: new Date() })
          .where(eq(MO.id, id));
        await emit(
          tx,
          organizationId,
          "m12.medication_order.signature_requested",
          "medication_order",
          id,
          {
            orderId: id,
            prescriberMembershipId: r.prescriberMembershipId,
            prescribingPhysicianMdmId: r.prescribingPhysicianMdmId,
          },
        );
        return readOrder(tx, id);
      });
    },
    async signOrder(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        const fromVerbal = r.status === "verbal_pending";
        transitionMedicationOrder(r.status, {
          type: "sign",
          medClass: r.medClass,
          containsControlled: r.isControlledSubstance,
          signerEligible: signerEligibleForMed(args.signerDiscipline),
          signerIsOrderingPhysician: args.signerIsOrderingPhysician ?? !fromVerbal,
        });
        const at = new Date();
        await tx
          .update(MO)
          .set({ status: "signed", signedAt: at, version: r.version + 1, updatedAt: at })
          .where(eq(MO.id, id));
        await emit(tx, organizationId, "m12.medication_order.signed", "medication_order", id, {
          orderId: id,
          signerMembershipId: userId,
          signedAt: at.toISOString(),
          viaVerbal: fromVerbal,
        });
        await emitDocumentRequest(tx, organizationId, r, at);
        return readOrder(tx, id);
      });
    },
    async signControlledInitiate(organizationId, _userId, id, _schedule) {
      // EPCS is OFF in Phase 1 (D18): the machine guard refuses unless the tenant is certified — it throws
      // here and this never returns a challenge. No DB write.
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        transitionMedicationOrder(r.status, {
          type: "signControlled",
          medClass: r.medClass,
          containsControlled: r.isControlledSubstance,
          deaScheduleAuthorized: true,
          prescriberIal2Verified: true,
          tenantEpcsCertified: DEFAULT_CS_POLICY.epcsCertificationStatus === "certified",
        });
        return { nonce: id, expiresAt: new Date().toISOString(), requiredFactor: "totp" as const };
      });
    },
    async signControlledComplete(organizationId, userId, id) {
      // Phase-1 deny path: completing requires epcs_identity_pending, only reachable when EPCS is certified
      // (OFF) — the machine refuses the transition otherwise. No DB write on the (unreachable) success path.
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        transitionMedicationOrder(r.status, {
          type: "completeSecondFactor",
          challengeCompletedInTime: true,
          secondFactorType: "totp",
        });
        const at = new Date();
        await tx
          .update(MO)
          .set({ status: "signed", signedAt: at, version: r.version + 1, updatedAt: at })
          .where(eq(MO.id, id));
        await emit(tx, organizationId, "m12.medication_order.signed", "medication_order", id, {
          orderId: id,
          signerMembershipId: userId,
          signedAt: at.toISOString(),
          viaEpcs: true,
          secondFactorType: "totp",
        });
        await emitDocumentRequest(tx, organizationId, r, at);
        return readOrder(tx, id);
      });
    },
    async recordVerbal(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        transitionMedicationOrder(r.status, {
          type: "recordVerbal",
          medClass: r.medClass,
          containsControlled: r.isControlledSubstance,
          recorderEligible: true,
          namedPrescriberPresent: args.namedPrescriberMdmId.length > 0,
          attestationRecorded: args.verbalAttestation.length >= 100,
        });
        await tx
          .update(MO)
          .set({
            status: "verbal_pending",
            prescribingPhysicianMdmId: args.namedPrescriberMdmId,
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(MO.id, id));
        await emit(
          tx,
          organizationId,
          "m12.medication_order.verbal_received",
          "medication_order",
          id,
          {
            orderId: id,
            recordingMembershipId: userId,
            namedPrescriberMdmId: args.namedPrescriberMdmId,
          },
        );
        return readOrder(tx, id);
      });
    },
    async cosignOrder(organizationId, userId, id, _args) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        if (r.prescriberMembershipId === userId)
          throw new NotFoundError(
            "a medication order may not be cosigned by its own drafter (§7.3)",
          );
        // The cosignature primitive is M11's `OrderSignatureProvider`; the DB backend records the attach
        // locally (no M12-owned cosign event, mirroring the in-mem slice).
        await tx
          .update(MO)
          .set({ cosignStatus: "attached", updatedAt: new Date() })
          .where(eq(MO.id, id));
        return readOrder(tx, id);
      });
    },
    async discontinueOrder(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        transitionMedicationOrder(r.status, { type: "discontinue", reason: args.reason });
        const at = new Date();
        await tx
          .update(MO)
          .set({
            status: "discontinued",
            discontinuedAt: at,
            version: r.version + 1,
            updatedAt: at,
          })
          .where(eq(MO.id, id));
        await emit(
          tx,
          organizationId,
          "m12.medication_order.discontinued",
          "medication_order",
          id,
          {
            orderId: id,
            reason: args.reason,
            actorMembershipId: userId,
            effectiveAt: new Date(args.effectiveAt).toISOString(),
          },
        );
        return readOrder(tx, id);
      });
    },
    async completeOrder(organizationId, _userId, id, reason) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        transitionMedicationOrder(r.status, { type: "complete", criterionMet: true });
        const at = new Date();
        await tx
          .update(MO)
          .set({ status: "completed", completedAt: at, version: r.version + 1, updatedAt: at })
          .where(eq(MO.id, id));
        await emit(tx, organizationId, "m12.medication_order.completed", "medication_order", id, {
          orderId: id,
          completedAt: at.toISOString(),
          ...(reason ? { reason } : {}),
        });
        return readOrder(tx, id);
      });
    },
    async correctOrder(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const original = await loadOrder(tx, id);
        const newId = await insertDraft(tx, organizationId, userId, {
          ...args,
          replacesMedicationOrderId: id,
        });
        await tx
          .update(MO)
          .set({ version: original.version + 1, updatedAt: new Date() })
          .where(eq(MO.id, id));
        return { newOrderId: newId };
      });
    },
    async retransmit(organizationId, userId, id) {
      return withOrg(organizationId, async (tx) => {
        const original = await loadOrder(tx, id);
        if (original.status !== "transmission_failed")
          throw new NotFoundError(
            `medication order ${id} is ${original.status}; only a transmission_failed order may be retransmitted`,
          );
        const newId = await insertDraft(tx, organizationId, userId, {
          patientId: original.patientId,
          admissionId: original.admissionId,
          medClass: original.medClass,
          rxnormRxcui: original.rxnormRxcui ?? null,
          ndc: original.ndc ?? null,
          drugName: original.drugName,
          strength: original.strength,
          doseForm: original.doseForm,
          route: original.route,
          data: original.data,
          prescriberDiscipline: "",
          prescribingPhysicianMdmId: original.prescribingPhysicianMdmId,
          dispensingPharmacyMdmId: original.dispensingPharmacyMdmId ?? undefined,
          deaSchedule: original.deaSchedule ?? undefined,
          containsControlled: original.isControlledSubstance,
          refillsAuthorized: original.refillsRemaining,
          replacesMedicationOrderId: id,
        });
        return { newOrderId: newId };
      });
    },
    async refreshHistory(_organizationId, patientId) {
      return { jobId: `dosespot.fetch_medhx:${patientId}` };
    },
    async reconcileHistory(_organizationId, _userId, _historyRecordId, _decision) {
      // MedHx reconciliation carry-forward needs the M22 intake-extraction history store, not threaded here
      // (§7.13). Returns null until that store lands (mirrors the read side's empty medicationHistory).
      return { resultingOrderId: null };
    },

    // ── Refill-inbox reads + writes (§2.7 D9) ────────────────────────────────────────────────────────
    async listRefills(organizationId, actor) {
      // GAP-026 — the inbox is NARROWED, not merely org-scoped. `refill_inbox_scope` resolves to
      // allow on a list (there is no per-row target to gate), so this service call is the only
      // control on the list side, and before GAP-026 it applied none: every clinician saw every
      // refill in the tenant. The narrowing is the §2.7 inbox model — the refills you are the named
      // prescriber of, plus those for patients on your caseload — the same two axes
      // `loadRefillScope` gates a detail with.
      //
      // THE NARROWING IS THE `WHERE` CLAUSE, not a post-read `.filter()`. GAP-026 first shipped it in
      // the service: read every refill row in the tenant, then drop the ones that are not yours. That
      // is correct and it is invisible from the outside, but it makes the cost of MY inbox scale with
      // EVERY OTHER clinician's refill volume, and it ships the whole tenant's refill PHI into app
      // memory to throw most of it away. Both are properties of the query, so both are fixed in the
      // query:
      //   · caseload  — `patient_id = ANY($ids)`, the ids M5 resolved for this actor;
      //   · approver  — `approved_by_membership_id = $me`, a column on the row itself;
      //   · prescriber— an EXISTS against `medication_order` (M12's OWN table, so this is a
      //                 within-module join, not a cross-boundary one) on the SOURCE order's
      //                 prescriber. Supported by `medication_order_prescriber_idx` (mig 0208) —
      //                 the pre-existing prescriber index is PARTIAL on the pending-signature
      //                 statuses, so a refill against an ACTIVE order could not use it.
      // The caseload ids still come from M5 across a boundary this module may not join over
      // (ADR-0005), so they arrive as a bound parameter — resolved OUTSIDE `withOrg`, because M5's
      // provider opens its own `withOrgContext`.
      //
      // Deliberately unpaged: the result is now bounded by one actor's own work rather than by the
      // tenant, and a silent `LIMIT` on an inbox would under-report work without saying so. Paging is
      // a route-contract change, for when a single prescriber's own volume warrants it.
      const caseload = await caseloadPatientIds(organizationId, actor.userId);
      const mine = refillInboxWhere(db, { caseloadPatientIds: caseload, actor });
      // No caseload AND no membership id = no axis can name a row for this actor.
      if (mine === null) return { refills: [] };
      return withOrg(organizationId, async (tx) => {
        const rows = await tx.select().from(RR).where(mine).orderBy(desc(RR.receivedAt));
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
    async approveRefill(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const [refill] = await tx.select().from(RR).where(eq(RR.id, id)).limit(1);
        if (!refill) throw new NotFoundError(`refill request ${id} not found`);
        const [source] = await tx
          .select()
          .from(MO)
          .where(eq(MO.id, refill.sourceMedicationOrderId))
          .limit(1);
        // Validates ILLEGAL_REFILL_TRANSITION / REFILL_SOURCE_ORDER_NOT_ACTIVE / schedule ceiling.
        transitionRefillRequest(refill.status, id, {
          type: "approve",
          actorInScope: true,
          sourceOrderActive: source?.status === "active",
          deaSchedule: source?.deaSchedule ?? null,
          refillsAuthorized: args.refillsAuthorized,
          tenantMaxOverride: DEFAULT_CS_POLICY.scheduleIiiToVMaxRefills,
          responseChannel: args.responseChannel ?? "electronic_via_dosespot",
        });
        // A refill is a NEW prescription (D9): mint a draft medication_order from the source.
        const newId = await insertDraft(tx, organizationId, userId, {
          patientId: refill.patientId,
          admissionId: source?.admissionId ?? refill.patientId,
          medClass: (source?.medClass ?? "standard") as MedClass,
          rxnormRxcui: source?.rxnormRxcui ?? null,
          ndc: source?.ndc ?? null,
          drugName: source?.drugName ?? "",
          strength: source?.strength ?? "",
          doseForm: source?.doseForm ?? "",
          route: source?.route ?? "",
          data: source?.data ?? {},
          prescriberDiscipline: "",
          prescribingPhysicianMdmId:
            source?.prescribingPhysicianMdmId ?? refill.sourceMedicationOrderId,
          dispensingPharmacyMdmId: source?.dispensingPharmacyMdmId ?? undefined,
          deaSchedule: source?.deaSchedule ?? undefined,
          containsControlled: source?.isControlledSubstance ?? false,
          refillsAuthorized: args.refillsAuthorized,
          derivedFromRefillId: id,
        });
        const at = new Date();
        await tx
          .update(RR)
          .set({
            status: "approved",
            approvedAt: at,
            approvedByMembershipId: userId,
            resultingMedicationOrderId: newId,
            responseChannel: args.responseChannel ?? "electronic_via_dosespot",
            updatedAt: at,
          })
          .where(eq(RR.id, id));
        await emit(tx, organizationId, "m12.refill_request_approved", "refill_request", id, {
          refillRequestId: id,
          resultingOrderId: newId,
          approvedByMembershipId: userId,
        });
        return { resultingOrderId: newId };
      });
    },
    async denyRefill(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const [refill] = await tx
          .select({ status: RR.status })
          .from(RR)
          .where(eq(RR.id, id))
          .limit(1);
        if (!refill) throw new NotFoundError(`refill request ${id} not found`);
        transitionRefillRequest(refill.status, id, {
          type: "deny",
          actorInScope: true,
          denialReasonPresent: args.denialReason.length >= 10,
          responseChannel: args.responseChannel ?? "electronic_via_dosespot",
        });
        const at = new Date();
        await tx
          .update(RR)
          .set({
            status: "denied",
            deniedAt: at,
            deniedByMembershipId: userId,
            denialReason: args.denialReason,
            responseChannel: args.responseChannel ?? "electronic_via_dosespot",
            updatedAt: at,
          })
          .where(eq(RR.id, id));
        await emit(tx, organizationId, "m12.refill_request_denied", "refill_request", id, {
          refillRequestId: id,
          deniedByMembershipId: userId,
          denialReason: args.denialReason,
        });
        return { status: "denied" as const };
      });
    },
    async rxBenefitLookup(_organizationId, _patientId, _rxnormRxcui) {
      return { covered: true, copayCents: null };
    },

    // ── Prescriber roster (§2.4) ─────────────────────────────────────────────────────────────────────
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
    async enrollPrescriber(organizationId, membershipId, deaAuthorizedSchedules) {
      return withOrg(organizationId, async (tx) => {
        const at = new Date();
        const row = firstOrThrow(
          await tx
            .insert(DP)
            .values({
              organizationId,
              membershipId,
              deaAuthorizedSchedules: deaAuthorizedSchedules as string[],
              enrolledAt: at,
            })
            .onConflictDoUpdate({
              target: [DP.organizationId, DP.membershipId],
              set: {
                deaAuthorizedSchedules: deaAuthorizedSchedules as string[],
                enrolledAt: at,
                revokedAt: null,
                revocationReason: null,
                updatedAt: at,
              },
            })
            .returning({ id: DP.id }),
          "dosespot_prescriber upsert returned no row",
        );
        await emit(
          tx,
          organizationId,
          "m12.prescriber_enrolled",
          "dosespot_prescriber",
          membershipId,
          {
            membershipId,
            dosespotPrescriberId: row.id,
          },
        );
        return { membershipId, enrolled: true, deaAuthorizedSchedules, ial2Status: "not_started" };
      });
    },
    async revokePrescriber(organizationId, membershipId, reason) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ id: DP.id })
          .from(DP)
          .where(eq(DP.membershipId, membershipId))
          .limit(1);
        if (!row) throw new NotFoundError(`prescriber roster entry for ${membershipId} not found`);
        await tx
          .update(DP)
          .set({
            revokedAt: new Date(),
            revocationReason: reason,
            epcsEnabled: false,
            updatedAt: new Date(),
          })
          .where(eq(DP.id, row.id));
        await emit(
          tx,
          organizationId,
          "m12.prescriber_revoked",
          "dosespot_prescriber",
          membershipId,
          {
            membershipId,
            reason,
          },
        );
        return { status: "revoked" as const };
      });
    },

    // ── Policies (no Phase-1 table — the put* routes apply the tighten-only guard, return the view) ──
    async getRefillInboxPolicy(_organizationId) {
      return DEFAULT_REFILL_POLICY;
    },
    async putRefillInboxPolicy(_organizationId, patch) {
      const warn = patch.slaWarnHours ?? DEFAULT_REFILL_POLICY.slaWarnHours;
      const critical = patch.slaCriticalHours ?? DEFAULT_REFILL_POLICY.slaCriticalHours;
      if (
        warn > DEFAULT_REFILL_POLICY.platformFloorWarnHours ||
        critical > DEFAULT_REFILL_POLICY.platformFloorCriticalHours
      )
        throw new NotFoundError(
          "refill SLA policy is tighten-only; cannot exceed the platform floor",
        );
      return { ...DEFAULT_REFILL_POLICY, slaWarnHours: warn, slaCriticalHours: critical };
    },
    async getControlledSubstancePolicy(_organizationId) {
      return DEFAULT_CS_POLICY;
    },
    async putControlledSubstancePolicy(organizationId, patch) {
      const max = patch.scheduleIiiToVMaxRefills ?? DEFAULT_CS_POLICY.scheduleIiiToVMaxRefills;
      if (max > 5)
        throw new NotFoundError(
          "controlled-substance refill policy is tighten-only (21 CFR 1306.22 ≤ 5)",
        );
      const next = { ...DEFAULT_CS_POLICY, scheduleIiiToVMaxRefills: max };
      await withOrg(organizationId, (tx) =>
        emit(
          tx,
          organizationId,
          "m12.controlled_substance_policy_changed",
          "controlled_substance_policy",
          organizationId,
          {
            before: DEFAULT_CS_POLICY.scheduleIiiToVMaxRefills,
            after: max,
          },
        ),
      );
      return next;
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
    async loadRefillScope(organizationId, refillId, actor) {
      const facts = await withOrg(organizationId, async (tx) => {
        const [r] = await tx
          .select({
            patientId: RR.patientId,
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
          patientId: r.patientId,
          // MEMBERSHIP ids on both sides (GAP-026). The ABAC layer used to hand this method
          // `context.userId` — a different id space — so this comparison was false for every real
          // caller and, with the caseload axis hardcoded false below, `refill_inbox_scope` denied
          // EVERYONE on a refill detail in production while the in-memory route suite stayed green.
          isNamedPrescriber:
            actor.membershipId !== null &&
            (r.approvedByMembershipId === actor.membershipId ||
              source?.prescriberMembershipId === actor.membershipId),
        };
      });
      if (!facts) return null; // absent / cross-tenant refill → fail closed
      return {
        isNamedPrescriber: facts.isNamedPrescriber,
        patientInCaseload: await patientInCaseload(organizationId, actor.userId, facts.patientId),
      };
    },

    // The prod outbox is the M1 transactional relay, not a drainable in-memory buffer.
    drainEvents: () => [],
  };
}
