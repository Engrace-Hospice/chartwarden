import { randomUUID } from "node:crypto";

import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/12-dosespot — PRODUCTION MedicationOrderRouteService + §4.7 ABAC resolver
// (M12L reads + writes over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (medication-order list + detail, active-medications, transmission status, the
// refill inbox, the prescriber roster) run as real Drizzle queries over the M12-owned tables inside
// `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged `chartwarden_app` role.
// `medication_order` is PARTITION BY RANGE(created_at) — reads query the parent, inserts always land.
//
// Unlike M11, M12 has NO state-transition triggers (only the M4 audit triggers) — the service does every
// status transition itself via UPDATE, composing the PURE `@chartwarden/dosespot` deciders: the §2.2 D2
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
// surfaces the stable defaults; (4) [CLOSED, GAP-018] the M11 `OrderSignatureProvider` seam is threaded for the
// standard and EPCS sign as well as cosign (GAP-034) and verbal: every signed prescription has an `order_signature` row; the medication-history read + reconcile are
// real since F-238 (`medication_history_record`, DoseSpot + DocLens rows) but reconcile NEVER mints an order
// (`resultingOrderId` is always null — D12 for DocLens rows, the D10 carry-forward draft is unbuilt); (5) the refill-SLA / controlled-substance policies have no
// table in Phase 1 — the put* routes apply their tighten-only guards and return the computed view without
// persisting (the platform default is authoritative).
import {
  ALLERGY_OVERRIDE_DATA_KEY,
  advisoryDeaSchedule,
  isEpcsRequired,
  transitionMedicationOrder,
  transitionRefillRequest,
  validateMedicationOrderData,
} from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DeaSchedule, MedClass, PatientAllergyReader } from "@chartwarden/types";
import {
  ChartWardenError,
  NotFoundError,
  StepUpRequiredError,
  ValidationError,
  assertCoverageDetermination,
} from "@chartwarden/types";
import {
  type SQL,
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import {
  buildRenderPayloadOrOmit,
  createRenderBuildCtx,
  logRenderPayload,
} from "../../bootstrap/render-payload-sources";
import { getOrderSignatureProvider } from "../11-orders";
import {
  type ConsentGatePort,
  allergyGateError,
  evaluateAllergyGate,
  isSudTreatmentDrug,
  resolveAllergyOverride,
  sudConsentSatisfied,
} from "./medication-order-safety-gates";
import {
  assertCosignSatisfied,
  assertCosignStanding,
  assertDisciplineHeld,
  assertRetransmitStanding,
  cosignDraftingDiscipline,
  cosignRequiredFor,
  isVerbalRecorderDiscipline,
  mayRetransmit,
  mdmIdAlreadyEnrolled,
  namedPrescriberNotEnrolled,
  prescriberEligible,
  signerStanding,
} from "./prescriber-eligibility";
import { buildMedicationOrderRenderPayload } from "./render-payloads";
import type {
  ControlledSubstancePolicyView,
  CreateMedicationOrderArgs,
  DoseSpotAbacActor,
  MedicationOrderDetailView,
  MedicationOrderRouteService,
  MedicationOrderView,
  NamedPrescriberView,
  PrescriberRosterView,
  RefillInboxPolicyView,
  RefillRequestView,
} from "./routes/service";
import { MEDICATION_ORDER_LIST_LIMIT, RX_BENEFIT_UNKNOWN } from "./routes/service";
import { enqueueTransmissionIfBound } from "./transmission-enqueue";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;
const RR = schema.refillRequests;
const DP = schema.dosespotPrescribers;
const MHR = schema.medicationHistoryRecords;
const RXB = schema.rxBenefitCache;

/** ACTIVE roster rows that carry an MDM id (the valid verbal-order named prescribers). RLS scopes the org. */
async function activeNamedPrescribers(tx: DbClient): Promise<NamedPrescriberView[]> {
  const rows = await tx
    .select({ membershipId: DP.membershipId, mdmId: DP.externalPhysicianMdmId })
    .from(DP)
    .where(
      and(isNull(DP.revokedAt), isNotNull(DP.enrolledAt), isNotNull(DP.externalPhysicianMdmId)),
    );
  return rows.flatMap((r) =>
    r.mdmId ? [{ membershipId: r.membershipId, externalPhysicianMdmId: r.mdmId }] : [],
  );
}

/** The partial unique index (mig 0326) that keeps one ACTIVE roster row per MDM id per tenant. */
const ACTIVE_MDM_UNIQUE_INDEX = "dosespot_prescriber_active_mdm_unique";
const PG_UNIQUE_VIOLATION = "23505";

/** True when `err` (or its `cause`, as drizzle wraps driver errors) is the active-MDM unique violation. */
function isActiveMdmViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 3; depth++) {
    const o = e as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      o.code === PG_UNIQUE_VIOLATION &&
      (o.constraint_name === ACTIVE_MDM_UNIQUE_INDEX || o.constraint === ACTIVE_MDM_UNIQUE_INDEX)
    )
      return true;
    e = o.cause;
  }
  return false;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

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
  advisoryDeaSchedule: advisoryDeaSchedule(r.drugName),
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
  hospiceCoverage: r.hospiceCoverage,
  coverageReason: r.coverageReason ?? null,
  coverageDeterminedAt: iso(r.coverageDeterminedAt),
  coverageDeterminedBy: r.coverageDeterminedByMembershipId ?? null,
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
/** Return `data` with the server-recorded allergy acknowledgement replaced (or removed when `null`). */
function withAllergyOverride(data: unknown, override: Record<string, unknown> | null): unknown {
  const base =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const { [ALLERGY_OVERRIDE_DATA_KEY]: _previous, ...rest } = base;
  return override === null ? rest : { ...rest, [ALLERGY_OVERRIDE_DATA_KEY]: override };
}

/** GAP-036 — test seam for the two `requestSignature` safety gates; production leaves both on the M39 / M5 seams. */
export interface DoseSpotSafetyGateDeps {
  readonly resolveConsentEvaluator?: () => ConsentGatePort;
  readonly resolveAllergyReader?: () => PatientAllergyReader;
  /**
   * GAP-037 — does this tenant have a bound DoseSpot adapter (complete per-tenant credentials)? When true, a
   * signed order that CAN be e-prescribed (has an RxCUI + a structured sig) is queued for transmission
   * instead of being activated locally. Absent / false ⇒ the F-058 behaviour is unchanged (`not_required`).
   */
  readonly transmissionEnabledFor?: (organizationId: string) => boolean;
}

export function createDbDoseSpotBackend(
  db: DbClient,
  outbox: DoseSpotWriteOutboxPort = NOOP_OUTBOX,
  gates: DoseSpotSafetyGateDeps = {},
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
  /**
   * F-058 — a signed order that is not being e-prescribed is ready to give, and nothing else is going to
   * happen to it first.
   *
   * `medication_order.dosespot_send_state` has carried `not_required` as its DEFAULT since M12-T02, and
   * with no transmission worker and no webhook handler in this build that is the state of every order
   * the platform has ever produced. The §2.2 graph nevertheless gave `signed` exactly one exit
   * (`enqueueTransmission`), so those orders stopped there forever: never `active`, and — because
   * `complete`, `discontinue` and `cascadeDiscontinue` are all legal only from `active` — never
   * completable, never discontinuable, and untouched by the discharge cascade. They were also invisible
   * to `GET /patients/:id/medications/active` (which filters `status = 'active'`) and refused by M13's
   * §2.9 D6 administrability gate. `signed` was a terminal state wearing an in-flight state's name.
   *
   * Run in the SAME transaction as the signature rather than behind a second button: a nurse pressing
   * "yes, really" for a drug already in the patient's home is a step with no decision in it, and
   * forgetting it is precisely the failure being fixed. An order that DOES owe a transmission is
   * untouched — the machine refuses the arm, and this never reaches it.
   */
  /**
   * GAP-018 -- every signed prescription has a signature record. M11 owns the signature ledger (M12 never
   * writes it directly), so the standard / EPCS sign records the signer, discipline and server-stamped time
   * through the published OrderSignatureProvider seam, exactly as cosign and verbal do. The discipline is the
   * SESSION's (never the body's). One primary signature per target is enforced by the ledger's unique index,
   * so a replayed sign cannot mint a second record.
   *
   * Called LAST in the sign transaction: the seam commits in its own request-scoped transaction (it cannot
   * join this one), so doing it after every other write keeps the window in which a later failure could
   * strand a ledger row down to the commit itself. A seam failure (including the unique index) rolls the
   * whole sign back -- a prescription is never `signed` without its signature record.
   */
  async function recordSignature(
    organizationId: string,
    signerMembershipId: string,
    orderId: string,
    signerDisciplines: readonly string[],
    signedAtClient?: string,
  ): Promise<void> {
    const signerDiscipline = signerDisciplines.find((d) => d.trim().length > 0);
    if (!signerDiscipline)
      throw new ChartWardenError(
        "DISCIPLINE_NOT_HELD",
        "The caller holds no prescriber discipline to sign under.",
        422,
      );
    await getOrderSignatureProvider().signOrderTarget({
      organizationId,
      targetKind: "medication_order",
      targetId: orderId,
      signerMembershipId,
      signerDiscipline,
      signedAtClient: signedAtClient ?? new Date().toISOString(),
      signatureKind: "signature",
    });
  }

  async function activateIfNotTransmitting(
    tx: DbClient,
    organizationId: string,
    row: MoRow,
    at: Date,
  ): Promise<void> {
    if (
      gates.transmissionEnabledFor?.(organizationId) &&
      (await enqueueTransmissionIfBound(tx, outbox, organizationId, row, at))
    ) {
      return;
    }
    if (row.dosespotSendState !== "not_required") return;
    transitionMedicationOrder("signed", {
      type: "activate",
      isSystemActor: false,
      transmissionRequired: false,
    });
    await tx
      .update(MO)
      .set({ status: "active", activatedAt: at, version: row.version + 2, updatedAt: at })
      .where(eq(MO.id, row.id));
    await emit(tx, organizationId, "m12.medication_order.active", "medication_order", row.id, {
      orderId: row.id,
      fullDto: null,
    });
  }

  /**
   * GAP-033 - the typed `renderPayload` of a signed medication order, built on the signing transaction's own `tx`.
   * When a SOURCE did not resolve (patient, signer name, malformed `data`) the event is published id-only and M22
   * refuses it loudly (retry -> DLQ) instead of drawing a blank prescription; ids are logged, never PHI.
   * A SUD-treatment drug is stamped `isSudClass` so M22's 42 CFR Part 2 consent gate applies to the render.
   */
  async function emitDocumentRequest(
    tx: DbClient,
    organizationId: string,
    order: MoRow,
    signedAt: Date,
    signing: { readonly signerMembershipId: string; readonly viaVerbal: boolean },
  ): Promise<void> {
    const typed = await buildRenderPayloadOrOmit(
      "m12",
      logRenderPayload,
      { organizationId, orderId: order.id },
      () =>
        buildMedicationOrderRenderPayload(createRenderBuildCtx(tx, organizationId), order, {
          ...signing,
          signedAt,
        }),
    );
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
          ...(order.isSudTreatment ? { isSudClass: true } : {}),
          ...(typed ?? {}),
        },
      },
    );
  }

  async function loadOrder(tx: DbClient, id: string): Promise<MoRow> {
    const [r] = await tx.select().from(MO).where(eq(MO.id, id)).limit(1);
    if (!r) throw new NotFoundError(`medication order ${id} not found`);
    return r;
  }
  /** Load an order taking a row lock (`FOR UPDATE`) until the surrounding tx ends — serialises writers per order. */
  async function lockOrder(tx: DbClient, id: string): Promise<MoRow> {
    const [r] = await tx.select().from(MO).where(eq(MO.id, id)).limit(1).for("update");
    if (!r) throw new NotFoundError(`medication order ${id} not found`);
    return r;
  }
  /** GAP-035 — the `external_physician_mdm_id` of the membership's ACTIVE roster row (null = none). */
  async function activeRosterMdmId(tx: DbClient, membershipId: string): Promise<string | null> {
    const [roster] = await tx
      .select({ mdmId: DP.externalPhysicianMdmId })
      .from(DP)
      .where(and(eq(DP.membershipId, membershipId), isNull(DP.revokedAt)))
      .limit(1);
    return roster?.mdmId ?? null;
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
  /**
   * COP27 (42 CFR 418.24(c)) — the coverage block a new draft starts with. A correction (`replaces…`) or a
   * refill mint (`derivedFromRefill…` → the refill's source order) is the SAME drug for the SAME patient, so it
   * inherits the predecessor's determination; otherwise a silently-reset `covered_related` would drop a
   * not-covered drug off the patient's election addendum. Everything else takes the column default.
   */
  async function inheritedCoverage(
    tx: DbClient,
    args: CreateMedicationOrderArgs,
  ): Promise<Partial<typeof MO.$inferInsert>> {
    let predecessorId = args.replacesMedicationOrderId ?? null;
    if (!predecessorId && args.derivedFromRefillId) {
      const [rr] = await tx
        .select({ src: RR.sourceMedicationOrderId })
        .from(RR)
        .where(eq(RR.id, args.derivedFromRefillId))
        .limit(1);
      predecessorId = rr?.src ?? null;
    }
    if (!predecessorId) return {};
    const [p] = await tx
      .select({
        hospiceCoverage: MO.hospiceCoverage,
        coverageReason: MO.coverageReason,
        coverageDeterminedAt: MO.coverageDeterminedAt,
        coverageDeterminedByMembershipId: MO.coverageDeterminedByMembershipId,
      })
      .from(MO)
      .where(eq(MO.id, predecessorId))
      .limit(1);
    return p ?? {};
  }

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
          isSudTreatment: isSudTreatmentDrug(args.drugName),
          strength: args.strength,
          doseForm: args.doseForm,
          route: args.route,
          data: args.data ?? {},
          prescriberMembershipId: userId,
          // GAP-034 follow-up — the drafting discipline, held-checked against the SESSION by the route
          // (never trusted from the body alone); read back by requestSignature for the cosign axis.
          draftedByDiscipline: args.prescriberDiscipline.trim() || null,
          prescribingPhysicianMdmId: args.prescribingPhysicianMdmId,
          dispensingPharmacyMdmId: args.dispensingPharmacyMdmId ?? null,
          refillsAuthorized: args.refillsAuthorized,
          refillsRemaining: args.refillsAuthorized,
          status: "draft",
          derivedFromRefillId: args.derivedFromRefillId ?? null,
          replacesMedicationOrderId: args.replacesMedicationOrderId ?? null,
          ...(await inheritedCoverage(tx, args)),
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
      // GAP-033 — caseload narrowing is the WHERE clause (not a post-read filter). Resolved OUTSIDE
      // `withOrg`: M5's CaseloadProvider opens its own `withOrgContext`. No caseload ⇒ empty, never an
      // empty `inArray` (which folds to an unfiltered read).
      const { scope } = filter;
      let scopePred: SQL | undefined;
      if (!scope.orgWide) {
        const ids = new Set(await caseloadPatientIds(organizationId, scope.userId));
        if (scope.sessionPatientId) ids.add(scope.sessionPatientId);
        if (ids.size === 0) return { orders: [], statusCounts: {} };
        scopePred = inArray(MO.patientId, [...ids]);
      }
      return withOrg(organizationId, async (tx) => {
        const scopedPreds = [
          scopePred,
          filter.patientId ? eq(MO.patientId, filter.patientId) : undefined,
          filter.prescriberId ? eq(MO.prescriberMembershipId, filter.prescriberId) : undefined,
          filter.medClass ? eq(MO.medClass, filter.medClass as MoRow["medClass"]) : undefined,
        ].filter((p): p is NonNullable<typeof p> => p !== undefined);
        const preds = [
          ...scopedPreds,
          filter.status ? eq(MO.status, filter.status as MoRow["status"]) : undefined,
        ].filter((p): p is NonNullable<typeof p> => p !== undefined);
        const [rows, counts] = await Promise.all([
          tx
            .select()
            .from(MO)
            .where(preds.length ? and(...preds) : undefined)
            .orderBy(desc(MO.createdAt), desc(MO.id))
            .limit(MEDICATION_ORDER_LIST_LIMIT),
          tx
            .select({ status: MO.status, count: sql<number>`count(*)` })
            .from(MO)
            .where(scopedPreds.length ? and(...scopedPreds) : undefined)
            .groupBy(MO.status),
        ]);
        return {
          orders: rows.map(toOrderView),
          statusCounts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
        };
      });
    },
    async getOrder(organizationId, id, viewer): Promise<MedicationOrderDetailView> {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        if (!viewer) return toOrderView(r);
        // The roster lookup only matters for a failed order — every other status is `false` without it.
        const signerMdmId =
          r.status === "transmission_failed"
            ? await activeRosterMdmId(tx, viewer.membershipId)
            : null;
        return {
          ...toOrderView(r),
          viewerMayRetransmit: mayRetransmit(r.status, {
            disciplines: viewer.disciplines,
            signerMembershipId: viewer.membershipId,
            signerMdmId,
            orderPrescriberMembershipId: r.prescriberMembershipId,
            orderPrescribingPhysicianMdmId: r.prescribingPhysicianMdmId,
          }),
        };
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
    async medicationHistory(organizationId, patientId) {
      // §2.8 D10 — the reconciliation worksheet's rows: DoseSpot MedHx entries and (F-238) DocLens referral
      // lines (`source = 'doclens_intake'`, the reviewer-attested text verbatim, with its attestation and
      // provenance) — every source, labelled, newest first. Never joined to a medication_order.
      return withOrg(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(MHR)
          .where(eq(MHR.patientId, patientId))
          .orderBy(desc(MHR.createdAt), desc(MHR.id));
        return {
          records: rows.map((r) => ({
            id: r.id,
            drugName: r.drugName,
            source: r.source,
            strength: r.strength,
            sigText: r.sigText,
            lastFillDate: r.lastFillDate,
            sourceDocumentId: r.sourceDocumentId,
            sourcePage: r.sourcePage,
            attestedByMembershipId: r.attestedByMembershipId,
            attestedAt: r.attestedAt ? r.attestedAt.toISOString() : null,
            reconciliationDecision: r.reconciliationDecision ?? null,
            reconciledAt: r.reconciledAt ? r.reconciledAt.toISOString() : null,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      });
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
          if (findings.length)
            throw new ValidationError("medication draft validation failed", findings);
        }
        await tx
          .update(MO)
          .set({
            // A prior acknowledgement belongs to the previous signature request: never carry it into a new draft cycle.
            data: withAllergyOverride(patch.data !== undefined ? patch.data : r.data, null),
            drugName: patch.drugName ?? r.drugName,
            isSudTreatment: isSudTreatmentDrug(patch.drugName ?? r.drugName),
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
    async requestSignature(
      organizationId,
      id,
      signerDiscipline,
      heldDisciplines,
      actorMembershipIdArg,
      allergyOverrideInput,
    ) {
      const actorMembershipId = actorMembershipIdArg ?? null;
      assertDisciplineHeld(heldDisciplines, signerDiscipline);
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        const findings = validateMedicationOrderData(r.medClass, undefined, r.data, true);
        if (findings.length)
          throw new ValidationError("medication order is not ready for signature", findings);
        // GAP-036 — both safety gates are decided from the stored order + the SESSION actor and fail closed
        // (a seam throw or unreadable data denies). `is_sud_treatment` is re-derived from the drug name so a
        // row written before the column was populated cannot dodge the Part 2 gate.
        const sudTreatment = r.isSudTreatment || isSudTreatmentDrug(r.drugName);
        const [allergyGate, sudOk] = await Promise.all([
          evaluateAllergyGate({
            organizationId,
            patientId: r.patientId,
            drugName: r.drugName,
            resolveReader: gates.resolveAllergyReader,
          }),
          sudConsentSatisfied({
            isSudTreatment: sudTreatment,
            organizationId,
            patientId: r.patientId,
            actorMembershipId,
            resolveEvaluator: gates.resolveConsentEvaluator,
          }),
        ]);
        // Allergy acknowledgement: a conflict proceeds only with a written reason + a fresh step-up; an
        // unreadable list never does. The machine below still refuses an ineligible prescriber FIRST (its
        // guard order), so an override can never be recorded for an actor who may not prescribe.
        const allergyDecision = resolveAllergyOverride(allergyGate, allergyOverrideInput);
        // medication_order has no prescriber_discipline column — read the threaded discipline arg (§4.1).
        try {
          transitionMedicationOrder(r.status, {
            type: "requestSignature",
            medClass: r.medClass,
            containsControlled: r.isControlledSubstance,
            requiredDataComplete: true,
            prescriberEligible: prescriberEligible(signerDiscipline, r.medClass),
            // A reason without a fresh step-up passes the machine (so eligibility is still judged first) and is
            // refused 403 STEP_UP_REQUIRED right after it, instead of masquerading as an unacknowledged conflict.
            allergyCheckPassed:
              allergyDecision.outcome === "proceed" ||
              allergyDecision.outcome === "step_up_required",
            sudConsentSatisfied: sudOk,
            tenantEpcsCertified: DEFAULT_CS_POLICY.epcsCertificationStatus === "certified", // false (D18)
          });
        } catch (err) {
          // Re-raise the generic machine refusal as the richer 422 (class wording + how to acknowledge).
          if (
            err instanceof ChartWardenError &&
            err.code === "ALLERGY_CHECK_NOT_PASSED" &&
            allergyGate.status !== "clear"
          )
            throw allergyGateError(allergyGate);
          throw err;
        }
        if (allergyDecision.outcome === "step_up_required") throw new StepUpRequiredError();
        const allergyOverride =
          allergyDecision.outcome === "proceed" && allergyDecision.override !== null
            ? {
                reason: allergyDecision.override.reason,
                acknowledgedByMembershipId: actorMembershipId ?? "",
                acknowledgedAt: new Date().toISOString(),
                matchedClasses: [
                  ...new Set(
                    allergyDecision.override.matches.map((m) => m.label ?? "ordered drug"),
                  ),
                ],
              }
            : null;
        // GAP-034 — the cosign axis from the drafting/requesting session discipline (held, asserted above),
        // never a body field: an RN-tier drafter's order owes a supervising cosign before it can be signed.
        const cosignRequired = cosignRequiredFor(
          cosignDraftingDiscipline(r.draftedByDiscipline, signerDiscipline),
        );
        await tx
          .update(MO)
          .set({
            status: "pending_signature",
            data: withAllergyOverride(r.data, allergyOverride),
            isSudTreatment: sudTreatment,
            cosignRequired,
            cosignStatus: cosignRequired ? "pending" : null,
            version: r.version + 1,
            updatedAt: new Date(),
          })
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
            // GAP-036 — the override is never silent: who acknowledged and which class, NEVER the reason text.
            ...(allergyOverride
              ? {
                  allergyOverride: {
                    acknowledgedByMembershipId: allergyOverride.acknowledgedByMembershipId,
                    matchedClasses: allergyOverride.matchedClasses,
                    reasonLength: allergyOverride.reason.length,
                  },
                }
              : {}),
          },
        );
        return readOrder(tx, id);
      });
    },
    async signOrder(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        assertCosignSatisfied(r);
        const fromVerbal = r.status === "verbal_pending";
        // GAP-035 — decided from the session actor + the stored order, never from the request body.
        const signerMdmId = await activeRosterMdmId(tx, userId);
        transitionMedicationOrder(r.status, {
          type: "sign",
          medClass: r.medClass,
          containsControlled: r.isControlledSubstance,
          ...signerStanding({
            disciplines: args.signerDisciplines,
            signerMembershipId: userId,
            signerMdmId,
            orderStatus: r.status,
            orderPrescriberMembershipId: r.prescriberMembershipId,
            orderPrescribingPhysicianMdmId: r.prescribingPhysicianMdmId,
          }),
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
        await emitDocumentRequest(tx, organizationId, r, at, {
          signerMembershipId: userId,
          viaVerbal: fromVerbal,
        });
        await activateIfNotTransmitting(tx, organizationId, r, at);
        await recordSignature(
          organizationId,
          userId,
          id,
          args.signerDisciplines,
          args.signedAtClient,
        );
        return readOrder(tx, id);
      });
    },
    async signControlledInitiate(organizationId, _userId, id, _schedule, args) {
      assertDisciplineHeld(args.signerDisciplines, args.signerDiscipline);
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
    async signControlledComplete(organizationId, userId, id, args) {
      // Phase-1 deny path: completing requires epcs_identity_pending, only reachable when EPCS is certified
      // (OFF) — the machine refuses the transition otherwise. No DB write on the (unreachable) success path.
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        assertCosignSatisfied(r); // an owed cosign gates EPCS completion exactly as it gates signOrder.
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
        await emitDocumentRequest(tx, organizationId, r, at, {
          signerMembershipId: userId,
          viaVerbal: false,
        });
        await activateIfNotTransmitting(tx, organizationId, r, at);
        await recordSignature(organizationId, userId, id, args?.signerDisciplines ?? []);
        return readOrder(tx, id);
      });
    },
    async recordVerbal(organizationId, userId, id, args) {
      assertDisciplineHeld(args.recorderDisciplines, args.recorderDiscipline);
      // Pre-check (read-only) so a request against an order that cannot legally record a verbal order
      // (wrong status / med class / short attestation) never writes M11's polymorphic `verbal_order` row
      // at all — the real refusal still happens again under the write tx below (a concurrent transition in
      // the gap raises the same typed error rather than silently racing).
      const pre = await withOrg(organizationId, (tx) => loadOrder(tx, id));
      transitionMedicationOrder(pre.status, {
        type: "recordVerbal",
        medClass: pre.medClass,
        containsControlled: pre.isControlledSubstance,
        recorderEligible: isVerbalRecorderDiscipline(args.recorderDiscipline),
        namedPrescriberPresent: args.namedPrescriberMdmId.length > 0,
        attestationRecorded: args.verbalAttestation.length >= 100,
      });
      // Refuse early when nobody could ever sign: no ACTIVE roster row maps to the named MDM id. Checked
      // BEFORE the M11 seam write so no verbal_order row / deadline timer is created for an unsignable order.
      const named = await withOrg(organizationId, activeNamedPrescribers);
      if (!named.some((p) => p.externalPhysicianMdmId === args.namedPrescriberMdmId))
        throw namedPrescriberNotEnrolled();

      // M11 owns `verbal_order` (§2.8 D14 — the polymorphic verbal-order receipt + 48h deadline timer;
      // `target_kind='medication_order'` for an M12 row). Write it through M11's published
      // OrderSignatureProvider seam, never M11's Drizzle table directly — a direct cross-module schema
      // read/write is a table-ownership violation (`arch:tables`); "access it through the owner's exported
      // repository/service" is the sanctioned pattern this seam exists for (D4). Called OUTSIDE `withOrg`,
      // mirroring the `caseloadPatientIds`/`patientInCaseload` precedent above: the seam opens its own
      // ambient-request-scoped transaction (`withOrgContextFromRequest`), and nesting one `withOrgContext`
      // inside another would rebind the GUC on an already-bound connection.
      //
      // Written BEFORE the local status flip, deliberately: if the write tx below then fails, the result is
      // an orphaned `verbal_order` row M11's expiry worker and M12's own `decideVerbalExpiry` consumer both
      // treat as a harmless skip (the medication order never actually reached `verbal_pending`). The
      // reverse order — flip the local status first — would leave a medication order sitting in
      // `verbal_pending` with no deadline row ever created to expire it, which is the worse failure mode
      // this write order exists to avoid.
      //
      // The deadline itself comes from M11's real per-org `order_verbal_policy` (via `verbalPolicyForOrg`,
      // not a second, DoseSpot-local computation) — the identical 48h-default/tenant-tightened math M11's
      // own `orders-route-service-db.ts` uses for its own verbal orders.
      await getOrderSignatureProvider().recordVerbalOrder({
        organizationId,
        targetKind: "medication_order",
        targetId: id,
        recordingMembershipId: userId,
        orderingPhysicianMdmId: args.namedPrescriberMdmId,
        verbalAttestation: args.verbalAttestation,
        receivedAt: args.receivedAt,
      });

      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        transitionMedicationOrder(r.status, {
          type: "recordVerbal",
          medClass: r.medClass,
          containsControlled: r.isControlledSubstance,
          recorderEligible: isVerbalRecorderDiscipline(args.recorderDiscipline),
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
    async cosignOrder(organizationId, userId, id, args) {
      // GAP-034 — decided from the SESSION roles + the STORED order; `args.cosignerRole` is only a claim.
      const standing = (tx: DbClient, r: MoRow) =>
        tx
          .select({ membershipId: DP.membershipId })
          .from(DP)
          .where(
            and(eq(DP.externalPhysicianMdmId, r.prescribingPhysicianMdmId), isNull(DP.revokedAt)),
          )
          .limit(1)
          .then(([signer]) =>
            assertCosignStanding({
              orderStatus: r.status,
              cosignRequired: r.cosignRequired,
              cosignStatus: r.cosignStatus,
              claimedRole: args.cosignerRole,
              heldRoles: args.cosignerDisciplines,
              cosignerMembershipId: userId,
              drafterMembershipId: r.prescriberMembershipId,
              signerMembershipId: signer?.membershipId ?? null,
            }),
          );
      // GAP-034 follow-up — SERIALISED per order. The old shape (read-only pre-check, then the M11 seam write
      // in its own committed tx, then a second tx) let two concurrent cosigns both pass the pre-check and
      // both commit an immutable cosignature ledger row before one lost with ALREADY_COSIGNED.
      // Now the whole sequence runs in ONE tx that holds `SELECT ... FOR UPDATE` on the medication_order row:
      // the second cosign blocks on the row lock until the first commits, then re-reads `cosign_status =
      // 'attached'` and is refused by `standing` BEFORE it ever reaches the seam, so at most one row is written.
      // The M11 seam cannot join this tx (it opens its own request-scoped tx via withOrgContextFromRequest and
      // joining would cross the module boundary), but it never touches the medication_order row — M12 owns it
      // and the seam only inserts into the M11 signature ledger — so the held lock cannot deadlock against it.
      // M11 owns the signature ledger (spec §1 / D3: M12 never writes it): the cosignature is recorded through
      // the published OrderSignatureProvider seam (signature_kind='cosignature', target_kind='medication_order').
      return withOrg(organizationId, async (tx) => {
        const r = await lockOrder(tx, id);
        await standing(tx, r); // refusals (incl. a concurrent cosign that already attached) write no ledger row.
        await getOrderSignatureProvider().cosignOrder({
          organizationId,
          targetKind: "medication_order",
          targetId: id,
          cosignerMembershipId: userId,
          cosignerRole: args.cosignerRole,
          attestationText: args.attestationText,
        });
        await tx
          .update(MO)
          .set({ cosignStatus: "attached", version: r.version + 1, updatedAt: new Date() })
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
    // F-205 (#248) — the user's decided trigger for M30's previously-unbound `m12.medication.error_reported`:
    // a new explicit clinician-initiated report action (not auto-derived from any order transition). Not a
    // status transition — the order's lifecycle/version is untouched, matching `recordVerbal`'s "an added
    // fact, not a state change" shape more than `discontinueOrder`'s. `reportedByMembershipId` carries the
    // REAL filing clinician (the F-165 correction — never a fictional M30-service sentinel).
    async reportMedicationError(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const r = await loadOrder(tx, id);
        const medicationErrorId = randomUUID();
        const reportedAt = new Date();
        await emit(tx, organizationId, "m12.medication.error_reported", "medication_order", id, {
          medicationErrorId,
          orderId: id,
          patientId: r.patientId,
          errorCategory: args.errorCategory,
          reportedByMembershipId: userId,
          reportedAt: reportedAt.toISOString(),
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
        });
        return { medicationErrorId, orderId: id, reportedAt: reportedAt.toISOString() };
      });
    },
    // COP27 (42 CFR 418.24(c)) — the hospice coverage determination. Not a lifecycle transition (status /
    // version untouched — the M13/M14 version-pinned reads must not see a "new" order), so it is allowed in
    // every status. Row-locked so two clinicians cannot interleave a change + its event. An unchanged re-save
    // is a no-op with no event. `coverage_determined_by_membership_id` is the SESSION membership.
    async setCoverageDetermination(organizationId, userId, id, args) {
      const reason = assertCoverageDetermination(args);
      return withOrg(organizationId, async (tx) => {
        const r = await lockOrder(tx, id);
        if (r.hospiceCoverage === args.hospiceCoverage && (r.coverageReason ?? null) === reason)
          return toOrderView(r);
        const at = new Date();
        await tx
          .update(MO)
          .set({
            hospiceCoverage: args.hospiceCoverage,
            coverageReason: reason,
            coverageDeterminedAt: at,
            coverageDeterminedByMembershipId: userId,
            updatedAt: at,
          })
          .where(eq(MO.id, id));
        await emit(
          tx,
          organizationId,
          "m12.medication_order.coverage_determination_changed",
          "medication_order",
          id,
          {
            orgId: organizationId,
            admissionId: r.admissionId,
            patientId: r.patientId,
            sourceId: id,
            hospiceCoverage: args.hospiceCoverage,
            previousHospiceCoverage: r.hospiceCoverage,
            reason,
            changedAt: at.toISOString(),
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
    async retransmit(organizationId, userId, id, args) {
      return withOrg(organizationId, async (tx) => {
        const original = await loadOrder(tx, id);
        if (original.status !== "transmission_failed")
          throw new NotFoundError(
            `medication order ${id} is ${original.status}; only a transmission_failed order may be retransmitted`,
          );
        // GAP-035 follow-up — the sign standing rule, from the session + the stored order + the roster.
        assertRetransmitStanding({
          disciplines: args.signerDisciplines,
          signerMembershipId: userId,
          signerMdmId: await activeRosterMdmId(tx, userId),
          orderPrescriberMembershipId: original.prescriberMembershipId,
          orderPrescribingPhysicianMdmId: original.prescribingPhysicianMdmId,
        });
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
    async reconcileHistory(organizationId, userId, historyRecordId, decision) {
      // §5.5 W-MR-05 — record the clinician's per-row decision (F-238). This path NEVER mints a
      // medication_order, for any source: for a `doclens_intake` row that is M12 D12 / AI Governance
      // §2.1.1 (its text came through an AI extraction, so it may not seed an order — not even as a
      // pre-filled draft); for a DoseSpot row the D10 carry-forward draft is not built yet. A clinician who
      // decides `carry_forward` writes the order themselves in the prescribe flow. One decision per row.
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ id: MHR.id, decision: MHR.reconciliationDecision })
          .from(MHR)
          .where(eq(MHR.id, historyRecordId))
          .for("update")
          .limit(1);
        if (!row) throw new NotFoundError(`medication history record ${historyRecordId}`);
        if (row.decision !== null) {
          throw new ChartWardenError(
            "HISTORY_ALREADY_RECONCILED",
            `medication history record is already reconciled (${row.decision})`,
            409,
          );
        }
        await tx
          .update(MHR)
          .set({
            reconciliationDecision: decision,
            reconciledByMembershipId: userId, // M12's route `userId` IS the acting membership id
            reconciledAt: new Date(),
          })
          .where(eq(MHR.id, historyRecordId));
        await emit(
          tx,
          organizationId,
          "m12.medication_history_reconciled",
          "medication_history_record",
          historyRecordId,
          { historyRecordId, decision, resultingOrderId: null },
        );
        return { resultingOrderId: null };
      });
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
    async rxBenefitLookup(organizationId, patientId, rxnormRxcui) {
      // GAP-019 -- a CACHED lookup, tenant-scoped (RLS) and patient-scoped. The cache is filled only from a
      // real vendor RxBenefit response (jobs/rx-benefit-prewarm.ts); with no fresh row the honest answer is
      // `unknown`, never `covered: true`.
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(RXB)
          .where(
            and(
              eq(RXB.organizationId, organizationId),
              eq(RXB.patientId, patientId),
              eq(RXB.rxnormRxcui, rxnormRxcui),
              gt(RXB.expiresAt, new Date()),
            ),
          )
          .limit(1);
        if (!row) return RX_BENEFIT_UNKNOWN;
        return {
          status: row.covered ? ("covered" as const) : ("not_covered" as const),
          covered: row.covered,
          copayCents: null,
          copayTier: row.copayTier ?? null,
          priorAuthRequired: row.priorAuthRequired,
          lookedUpAt: row.lookedUpAt.toISOString(),
        };
      });
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
          externalPhysicianMdmId: p.externalPhysicianMdmId ?? null,
        }));
        return { prescribers };
      });
    },
    async listNamedPrescribers(organizationId) {
      return withOrg(organizationId, async (tx) => ({
        prescribers: await activeNamedPrescribers(tx),
      }));
    },
    async enrollPrescriber(
      organizationId,
      membershipId,
      deaAuthorizedSchedules,
      externalPhysicianMdmId,
    ) {
      if (externalPhysicianMdmId) {
        const holder = await withOrg(organizationId, (tx) =>
          tx
            .select({ membershipId: DP.membershipId })
            .from(DP)
            .where(
              and(eq(DP.externalPhysicianMdmId, externalPhysicianMdmId), isNull(DP.revokedAt)),
            ),
        );
        if (holder.some((h) => h.membershipId !== membershipId)) throw mdmIdAlreadyEnrolled();
      }
      try {
        return await withOrg(organizationId, async (tx) => {
          const at = new Date();
          const row = firstOrThrow(
            await tx
              .insert(DP)
              .values({
                organizationId,
                membershipId,
                deaAuthorizedSchedules: deaAuthorizedSchedules as string[],
                externalPhysicianMdmId: externalPhysicianMdmId ?? null,
                enrolledAt: at,
              })
              .onConflictDoUpdate({
                target: [DP.organizationId, DP.membershipId],
                set: {
                  deaAuthorizedSchedules: deaAuthorizedSchedules as string[],
                  ...(externalPhysicianMdmId ? { externalPhysicianMdmId } : {}),
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
          return {
            membershipId,
            enrolled: true,
            deaAuthorizedSchedules,
            ial2Status: "not_started",
            externalPhysicianMdmId: externalPhysicianMdmId ?? null,
          };
        });
      } catch (err) {
        // A concurrent enroll that slipped past the pre-check still hits the unique index — same 409.
        if (isActiveMdmViolation(err)) throw mdmIdAlreadyEnrolled();
        throw err;
      }
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
    async loadOrderPatientId(organizationId, orderId) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ patientId: MO.patientId })
          .from(MO)
          .where(eq(MO.id, orderId))
          .limit(1);
        return row?.patientId ?? null;
      });
    },
    async loadHistoryRecordPatientId(organizationId, recordId) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ patientId: MHR.patientId })
          .from(MHR)
          .where(eq(MHR.id, recordId))
          .limit(1);
        return row?.patientId ?? null;
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
