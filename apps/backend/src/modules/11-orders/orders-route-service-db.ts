// apps/backend/src/modules/11-orders — PRODUCTION OrderRouteService + OrderAbacResolver (M11L reads +
// writes over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (order worklists by patient/admission/kind/status, the pending-signature /
// verbal-expiring / cosign-pending / results-review queues, standing-order lists + detail, and the per-org
// verbal-order policy) run as real Drizzle queries over the M11-owned tables inside `withOrgContext`, so RLS
// scopes every row by `app.org_id` as the unprivileged `wardenx_app` role. `order_record` is PARTITION BY
// RANGE(created_at) with a DEFAULT partition — reads query the parent, inserts always land.
//
// The WRITE lifecycle is now real and heavily TRIGGER-DRIVEN — the §3.4 migration (0037) triggers do the
// state work the service must NOT duplicate:
//   * `verbal_order_set_target_pending_trg` — inserting a `verbal_order` flips the linked order
//     pending_signature → verbal_pending (RAISES `TARGET_NOT_PENDING_SIGNATURE` otherwise). `recordVerbal`
//     inserts the receipt; the pure machine is the pre-check.
//   * `order_signature_apply_to_target_trg` — inserting a primary `signature` flips the order to `active`
//     (WHERE cosign prerequisites met). This trigger is SILENT on an unmet cosign, so the pure
//     `transitionOrder({type:'sign', cosignAttached})` guard is the real 409 (`COSIGN_PENDING`) path.
//   * `order_record_replace_supersede_trg` — inserting a correcting order (replaces_order_id set)
//     discontinues the original + writes its `order_discontinuation` ledger row (RAISES
//     `REPLACED_ORDER_NOT_REPLACEABLE` if the original is not replaceable). `correctOrder` just inserts.
//   * `trg_m11_lab_initial_states` — a lab order becoming `active` sets its transmission/results states.
//
// Every mutation emits its `m11.order.*` event on the caller's transactional outbox (the bound publisher
// Value.Checks each payload against the boot catalog — events-by-m11.ts — and rolls back on mismatch), so
// the payloads here are the STRICT catalog shapes, not the loose in-memory-slice shapes.
//
// The downstream kind-specific signed fan-out IS now emitted here (F-120, #248) — it never was, despite
// `packages/orders/src/catalog.ts`'s `downstreamSignedEvents` computing it as a `transitionOrder` effect
// on every sign since the pure machine shipped, and despite the catalog's own per-event descriptions
// asserting "M11 emits the typed event today" for two of the five. `signInternal` called `transitionOrder`
// only for its guard/throw and discarded `.effects` entirely — a signed lab order never requested an
// outbound HL7 ORM, a signed dme/supply/comfort_kit order never asked M21 to fulfill it, and a signed
// level-of-care-change/recertification order never told M6. `emitDownstreamSignedEvent` below builds the
// real catalogued payload per kind from `order_record.data` (already validated at draft time against the
// exact TypeBox `packages/orders/src/kinds.ts` uses). `hl7_orm_requested`'s full `OrmRequestedPayload` needs
// patient demographics + a resolved M40 provider identity + a destination M11 does not hold in its own tables:
// F-181 (#248) binds it through INJECTED ports (`./orm-request/orm-requested.ts` — read its header for the
// refuse-never-fabricate contract). Without `orm` ports (unit tests, the standing/verbal workers) a signed lab
// order emits nothing, exactly as before. The returned object IS BOTH the OrderRouteService AND the §4.7
// AbacResolver.
import { randomUUID } from "node:crypto";

import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_COSIGN_POLICY,
  ORDER_KIND_VERSION,
  type OrderCosignPolicy,
  assertSpawnAllowed,
  assertVerbalReceivedAtPlausible,
  computeNextSpawnAt,
  computeVerbalDeadline,
  disciplineCanOrder,
  hoursOverdue,
  lpnCosignRequired,
  planCosignAttest,
  planStandingCreation,
  planStandingDiscontinuation,
  planStandingSpawn,
  planVerbalExpiry,
  resolveCosignRequirement,
  resolveOrderKindVersion,
  signerEligible,
  transitionOrder,
  validateOrderData,
  validateVerbalWindowHours,
} from "@wardenx/orders";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  NotFoundError,
  type OrderDiscontinuationReason,
  type OrderKind,
  type OrderPriority,
  type OrderStatus,
  type StandingOrderCadence,
  type StandingOrderStatus,
} from "@wardenx/types";
import { ValidationError } from "@wardenx/types";
import { type SQL, and, asc, desc, eq, gt, gte, inArray, lte, ne, sql } from "drizzle-orm";
import {
  RenderPayloadBuildError,
  buildRenderPayloadOrOmit,
  createRenderBuildCtx,
  logRenderPayload,
} from "../../bootstrap/render-payload-sources";
import {
  RECOVERY_ANOMALY_THRESHOLD,
  RECOVERY_ANOMALY_WINDOW_MS,
  RECOVERY_ESCALATION_THRESHOLD,
  RECOVERY_ORG_RATE_THRESHOLD,
  RECOVERY_REQUEST_TTL_MS,
  type RecoveryAlertKind,
  type RecoveryControls,
  buildRecoveryAlert,
  buildRecoveryAnomalyAlert,
  decideRecoveryCosign,
  decideRecoveryEscalation,
  recoveryAlertEventPayload,
} from "./orm-request/orm-recovery-dual-control";
import { type OrmRequestedPorts, resolveOrmRequested } from "./orm-request/orm-requested";
import {
  ORM_REFUSAL_PREFIX,
  classifyOrmResend,
  classifyRecoveryContradiction,
  classifyTransmissionRecovery,
} from "./orm-request/orm-resend";
import { buildOrderRecordRenderPayload } from "./render-payloads";
import { deriveCosignFacts, isVerbalRecorderDiscipline } from "./routes/server-derived-facts";
import {
  EMPTY_ORDER_DETAIL_ACTOR,
  ORDER_LIST_LIMIT,
  buildOrderWorkflowProjection,
} from "./routes/service";
import type {
  CreateOrderArgs,
  OrderAbacFacts,
  OrderDetailActor,
  OrderDetailView,
  OrderReadScope,
  OrderRouteService,
  OrderView,
  RecoverLabTransmissionResult,
  RecoveryRequestView,
  ResendLabTransmissionResult,
  StandingOrderView,
  TransmissionAttestationView,
  VerbalPolicyView,
} from "./routes/service";
import {
  type OrderCaseloadResolver,
  assertActorHoldsDiscipline,
  assertMayEditDraft,
  assertPatientInActorScope,
  seamCaseloadResolver,
} from "./routes/service-actor-guards";

const OR = schema.orderRecords;
const SO = schema.standingOrders;
const SOI = schema.standingOrderInstances;
const OS = schema.orderSignatures;
const VO = schema.verbalOrders;
const VP = schema.orderVerbalPolicies;
const OD = schema.orderDiscontinuations;
const ATT = schema.orderTransmissionAttestations;
const REQ = schema.orderRecoveryRequests;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The order-side facts `signInternal` already holds that the F-181 lab-ORM producer needs. */
interface LabSignContext {
  readonly patientId: string;
  readonly orderingPhysicianMdmId: string;
  readonly priority: string | null;
  readonly signedAt: Date;
}

/** The transactional-outbox port (§4.4): the bound publisher validates every emit against the boot catalog
 * and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests commit
 * without a dispatcher. Mirrors M7/M8/M9/M10. */
export interface OrderWriteOutboxPort {
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
const NOOP_OUTBOX: OrderWriteOutboxPort = { async publish() {} };

/** First row of a RETURNING/SELECT, or a 500 (unreachable after a successful write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new NotFoundError(msg);
  return r;
}

/** The default per-org verbal policy the read returns when no `order_verbal_policy` row exists (mirrors the slice). */
const DEFAULT_POLICY: VerbalPolicyView = {
  windowHours: 48,
  businessHoursOnly: false,
  lpnCosignRequiredKinds: DEFAULT_COSIGN_POLICY.lpnCosignRequiredKinds,
  npCosignRequiredKinds: DEFAULT_COSIGN_POLICY.npCosignRequiredKinds,
  platformFloorWindowHours: 48,
  policyVersion: "v1",
};

/** The joined order-record read projection (order_record + its unique verbal-order + primary signature). */
type OrderRow = {
  id: string;
  patientId: string;
  admissionId: string;
  kind: string;
  kindVersion: string;
  data: unknown;
  status: string;
  priority: string;
  version: number;
  drafterMembershipId: string;
  drafterDiscipline: string;
  orderingPhysicianMdmId: string;
  cosignRequired: boolean;
  cosignStatus: string | null;
  transmissionStatus: string;
  /** Detail-only: projected (and redacted) by `buildOrderWorkflowProjection`, never put on the list view. */
  transmissionFailureReason: string | null;
  resultsStatus: string;
  replacesOrderId: string | null;
  triggeringAssessmentId: string | null;
  triggeringHopeAssessmentId: string | null;
  signedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  verbalDeadlineAt: Date | null;
  verbalStatus: string | null;
  verbalReceivedAt: Date | null;
  verbalEffectiveAt: Date | null;
  verbalSignedAt: Date | null;
  verbalReadBackVerified: boolean | null;
  verbalAttestation: string | null;
  signedBy: string | null;
};

const toOrderView = (r: OrderRow): OrderView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  kind: r.kind as OrderKind,
  status: r.status as OrderStatus,
  priority: r.priority as OrderPriority,
  version: Number(r.version),
  drafterMembershipId: r.drafterMembershipId,
  drafterDiscipline: r.drafterDiscipline,
  orderingPhysicianMdmId: r.orderingPhysicianMdmId,
  cosignRequired: r.cosignRequired,
  cosignStatus: (r.cosignStatus as "pending" | "attached" | null) ?? null,
  transmissionStatus: r.transmissionStatus,
  resultsStatus: r.resultsStatus,
  verbalDeadlineAt: iso(r.verbalDeadlineAt),
  // The discontinuation reason lives in `order_discontinuation` (no uniqueness → not joined to avoid
  // row-multiplication in the worklists); read null here — `getOrder` is the single-row detail read.
  discontinuationReason: null as OrderDiscontinuationReason | null,
  replacesOrderId: r.replacesOrderId,
  triggeringAssessmentId: r.triggeringAssessmentId,
  triggeringHopeAssessmentId: r.triggeringHopeAssessmentId,
  signedAt: iso(r.signedAt),
  signedBy: r.signedBy,
  completedAt: iso(r.completedAt),
  createdAt: (iso(r.createdAt) as string) ?? new Date(0).toISOString(),
});
const toOrderDetailView = (
  r: OrderRow,
  actor: OrderDetailActor,
  cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director" | null = null,
): OrderDetailView => ({
  ...toOrderView(r),
  kindVersion: r.kindVersion,
  data: r.data,
  verbalOrder:
    r.verbalStatus &&
    r.verbalReceivedAt &&
    r.verbalEffectiveAt &&
    r.verbalDeadlineAt &&
    r.verbalReadBackVerified !== null &&
    r.verbalAttestation
      ? {
          status: r.verbalStatus,
          receivedAt: iso(r.verbalReceivedAt) as string,
          effectiveAt: iso(r.verbalEffectiveAt) as string,
          deadlineAt: iso(r.verbalDeadlineAt) as string,
          signedAt: iso(r.verbalSignedAt),
          readBackVerified: r.verbalReadBackVerified,
          attestation: r.verbalAttestation,
        }
      : null,
  ...buildOrderWorkflowProjection(
    {
      ...toOrderView(r),
      kindVersion: r.kindVersion,
      data: r.data,
      transmissionFailureReason: r.transmissionFailureReason,
    },
    actor,
    cosignerRoleNeeded,
  ),
  // F-202 — `readOrder` fills these for a lab order (a second read of the append-only ledger); everything else has none.
  transmissionAttestations: [],
  pendingRecovery: null,
});

const toStandingView = (r: {
  id: string;
  patientId: string;
  admissionId: string;
  kind: string;
  cadence: string;
  status: string;
  nextSpawnAt: Date | null;
  spawnCount: number;
  maxSpawns: number | null;
}): StandingOrderView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  kind: r.kind as OrderKind,
  cadence: r.cadence as StandingOrderCadence,
  status: r.status as StandingOrderStatus,
  nextSpawnAt: iso(r.nextSpawnAt),
  spawnCount: Number(r.spawnCount),
  maxSpawns: r.maxSpawns == null ? null : Number(r.maxSpawns),
});

/**
 * The production, RLS-backed OrderRouteService + §4.7 OrderAbacResolver. Reads + writes are live. Org is
 * bound from the request context by the caller and passed as `organizationId` — never the body. Every
 * operation runs under `withOrgContext` so RLS scopes rows to the active org; writes go through the DB
 * state-transition triggers (0037) and emit `m11.order.*` on the bound transactional outbox.
 */
export function createDbOrderBackend(
  db: DbClient,
  outbox: OrderWriteOutboxPort = NOOP_OUTBOX,
  /** F-181 (#248) — the ports the outbound lab-ORM producer reads through. Omitted ⇒ a signed lab emits no ORM. */
  orm?: OrmRequestedPorts,
  /**
   * F-202 — the two-person recovery control's knobs (compliance alert port, request TTL, repeat-attester window and
   * threshold, clock). Every one has a documented default in `./orm-request/orm-recovery-dual-control`; omitting the
   * alert port still files/co-signs/expires requests, it just raises no notification (unit tests, the workers).
   */
  recovery: RecoveryControls = {},
  /** GAP-030 — the caseload the write guards re-check through; defaults to M5's `CaseloadProvider` seam. */
  caseloadPatientIds: OrderCaseloadResolver = seamCaseloadResolver,
): OrderRouteService {
  const assertInScope = (actor: OrderDetailActor, organizationId: string, patientId: string) =>
    assertPatientInActorScope(actor, organizationId, patientId, caseloadPatientIds);
  const nowFn = recovery.now ?? (() => new Date());
  const recoveryTtlMs = recovery.ttlMs ?? RECOVERY_REQUEST_TTL_MS;
  const anomalyWindowMs = recovery.anomalyWindowMs ?? RECOVERY_ANOMALY_WINDOW_MS;
  const anomalyThreshold = recovery.anomalyThreshold ?? RECOVERY_ANOMALY_THRESHOLD;
  const escalationThreshold = recovery.escalationThreshold ?? RECOVERY_ESCALATION_THRESHOLD;
  const orgRateThreshold = recovery.orgRateThreshold ?? RECOVERY_ORG_RATE_THRESHOLD;
  type RecoveryAlert =
    | ReturnType<typeof buildRecoveryAlert>
    | ReturnType<typeof buildRecoveryAnomalyAlert>;

  /**
   * The lab contact's NAME and the lab's reference are a third party's personal data — only the recovery authority sees
   * them (F-203: `orders.transmission.recover`, or the high-trust co-signer's `orders.transmission.cosign_escalated`;
   * it was the broad `orders.amend`).
   */
  const canSeeRecoveryEvidence = (actor: OrderDetailActor): boolean =>
    actor.permissions.has("orders.transmission.recover") ||
    actor.permissions.has("orders.transmission.cosign_escalated");

  const toRequestView = (
    r: typeof REQ.$inferSelect,
    actor: OrderDetailActor,
  ): RecoveryRequestView => {
    const see = canSeeRecoveryEvidence(actor);
    return {
      id: r.id,
      orderId: r.orderRecordId,
      status: r.status as RecoveryRequestView["status"],
      supersededReason: r.supersededReason,
      requestedByMembershipId: r.requestedByMembershipId,
      requestedAt: r.requestedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      cosignedByMembershipId: r.cosignedByMembershipId,
      resolvedAt: iso(r.resolvedAt),
      labContactName: see ? r.labContactName : null,
      labReference: see ? r.labReference : null,
    };
  };

  const toAttestationView = (
    r: typeof ATT.$inferSelect,
    actor: OrderDetailActor,
  ): TransmissionAttestationView => {
    const see = canSeeRecoveryEvidence(actor);
    return {
      id: r.id,
      attestation: r.attestation as TransmissionAttestationView["attestation"],
      outcome: r.outcome as TransmissionAttestationView["outcome"],
      priorFailureReason: r.priorFailureReason,
      attestedByMembershipId: r.attestedByMembershipId,
      cosignedByMembershipId: r.cosignedByMembershipId,
      attemptId: r.attemptId,
      createdAt: r.createdAt.toISOString(),
      labContactName: see ? r.labContactName : null,
      labReference: see ? r.labReference : null,
    };
  };

  /**
   * F-203 — DURABLE compliance alerts. Each alert is published as an `m11.order.recovery_alert_requested` outbox event on
   * the recovery's OWN transaction, so it commits or rolls back WITH the recovery (an alert can never describe a recovery
   * that did not happen, and a recovery can never commit without its alert intent). `buildM11RecoveryAlertConsumer` hands
   * it to M36; a delivery failure is retried by the relay and the alert's correlation id makes a redelivery idempotent.
   * (F-202 emitted after commit and swallowed a failure, so an emitter outage lost the notification.)
   */
  async function publishRecoveryAlerts(
    t: DbClient,
    organizationId: string,
    orderId: string,
    alerts: readonly RecoveryAlert[],
  ): Promise<void> {
    for (const a of alerts) {
      await emit(
        t,
        organizationId,
        "m11.order.recovery_alert_requested",
        orderId,
        recoveryAlertEventPayload(a),
      );
    }
  }
  /** Emit one `m11.order.*` event on the caller's tx (validated + persisted by the bound publisher). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind: "order",
      aggregateId,
    });
  }

  /** The reusable order-record select — parent partition, left-joined to its unique verbal-order + primary signature. */
  const selectOrders = (tx: DbClient, where: SQL | undefined) =>
    tx
      .select({
        id: OR.id,
        patientId: OR.patientId,
        admissionId: OR.admissionId,
        kind: OR.kind,
        kindVersion: OR.kindVersion,
        data: OR.data,
        status: OR.status,
        priority: OR.priority,
        version: OR.version,
        drafterMembershipId: OR.drafterMembershipId,
        drafterDiscipline: OR.drafterDiscipline,
        orderingPhysicianMdmId: OR.orderingPhysicianMdmId,
        cosignRequired: OR.cosignRequired,
        cosignStatus: OR.cosignStatus,
        transmissionStatus: OR.transmissionStatus,
        transmissionFailureReason: OR.transmissionFailureReason,
        resultsStatus: OR.resultsStatus,
        replacesOrderId: OR.replacesOrderId,
        triggeringAssessmentId: OR.triggeringAssessmentId,
        triggeringHopeAssessmentId: OR.triggeringHopeAssessmentId,
        signedAt: OR.signedAt,
        completedAt: OR.completedAt,
        createdAt: OR.createdAt,
        verbalDeadlineAt: VO.deadlineAt,
        verbalStatus: VO.status,
        verbalReceivedAt: VO.receivedAt,
        verbalEffectiveAt: VO.effectiveAt,
        verbalSignedAt: VO.signedAt,
        verbalReadBackVerified: VO.readBackVerified,
        verbalAttestation: VO.verbalAttestation,
        signedBy: OS.signerMembershipId,
      })
      .from(OR)
      .leftJoin(VO, and(eq(VO.targetKind, "order"), eq(VO.targetId, OR.id)))
      .leftJoin(
        OS,
        and(eq(OS.targetKind, "order"), eq(OS.targetId, OR.id), eq(OS.signatureKind, "signature")),
      )
      .where(where)
      .orderBy(desc(OR.createdAt), desc(OR.id));

  const listWhere = async (
    organizationId: string,
    extra: SQL | undefined,
    scope?: OrderReadScope,
  ): Promise<{ orders: OrderView[] }> => {
    // GAP-030 — narrow to the caller's caseload in SQL; an empty caseload reads nothing (no query).
    const patientIds = scope?.patientIds ?? null;
    if (patientIds !== null && patientIds.length === 0) return { orders: [] };
    const where = patientIds === null ? extra : and(extra, inArray(OR.patientId, [...patientIds]));
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = (await selectOrders(tx as DbClient, where).limit(
        ORDER_LIST_LIMIT,
      )) as unknown as OrderRow[];
      return { orders: rows.map(toOrderView) };
    });
  };

  /** Re-read one order (post-write, RLS-scoped) as the joined view or a non-leaking 404. */
  async function readOrder(
    tx: DbClient,
    id: string,
    actor: OrderDetailActor,
  ): Promise<OrderDetailView> {
    const rows = (await selectOrders(tx, eq(OR.id, id)).limit(1)) as unknown as OrderRow[];
    const row = firstOrThrow(rows, `order ${id} not found`);
    const policy = await cosignPolicyOf(tx);
    const needed = row.cosignRequired
      ? lpnCosignRequired(row.drafterDiscipline, row.kind as OrderKind, policy)
        ? "rn_case_manager"
        : null
      : null;
    const view = toOrderDetailView(row, actor, needed);
    // F-202 — the attested-recovery history, for a lab order only (nothing else can have one).
    if (row.kind !== "lab") return view;
    const attestations = await tx
      .select()
      .from(ATT)
      .where(eq(ATT.orderRecordId, id))
      .orderBy(asc(ATT.createdAt));
    const [pending] = await tx
      .select()
      .from(REQ)
      .where(and(eq(REQ.orderRecordId, id), eq(REQ.status, "pending_cosign")))
      .limit(1);
    return {
      ...view,
      transmissionAttestations: attestations.map((a) => toAttestationView(a, actor)),
      pendingRecovery: pending ? toRequestView(pending, actor) : null,
    };
  }

  /** The standing-order view projection reused by every standing read/write (same-tx, RLS-scoped). */
  const standingCols = {
    id: SO.id,
    patientId: SO.patientId,
    admissionId: SO.admissionId,
    kind: SO.kind,
    cadence: SO.cadence,
    status: SO.status,
    nextSpawnAt: SO.nextSpawnAt,
    spawnCount: SO.spawnCount,
    maxSpawns: SO.maxSpawns,
  };

  /** Re-read one standing order WITHIN the caller's tx (a nested `withOrgContext` would not see the write). */
  async function readStanding(tx: DbClient, id: string): Promise<StandingOrderView> {
    const [r] = await tx.select(standingCols).from(SO).where(eq(SO.id, id)).limit(1);
    if (!r) throw new NotFoundError(`standing order ${id} not found`);
    return toStandingView(r);
  }

  /** Read the verbal policy WITHIN the caller's tx as the view (default when unseeded). */
  async function readPolicy(tx: DbClient): Promise<VerbalPolicyView> {
    const [r] = (await tx
      .select({
        windowHours: VP.windowHours,
        businessHoursOnly: VP.businessHoursOnly,
        lpnCosignRequiredKinds: VP.lpnCosignRequiredKinds,
        npCosignRequiredKinds: VP.npCosignRequiredKinds,
        platformFloorWindowHours: VP.platformFloorWindowHours,
        policyVersion: VP.policyVersion,
      })
      .from(VP)
      .limit(1)) as VerbalPolicyView[];
    if (!r) return DEFAULT_POLICY;
    return {
      windowHours: Number(r.windowHours),
      businessHoursOnly: r.businessHoursOnly,
      lpnCosignRequiredKinds: (r.lpnCosignRequiredKinds as OrderKind[]) ?? [],
      npCosignRequiredKinds: (r.npCosignRequiredKinds as OrderKind[]) ?? [],
      platformFloorWindowHours: Number(r.platformFloorWindowHours),
      policyVersion: r.policyVersion,
    };
  }

  /** Load the raw order row (RLS-scoped) for the write guards, or the non-leaking 404. */
  async function loadOrderRow(tx: DbClient, id: string) {
    const [r] = (await tx
      .select()
      .from(OR)
      .where(eq(OR.id, id))
      .limit(1)) as (typeof OR.$inferSelect)[];
    if (!r) throw new NotFoundError(`order ${id} not found`);
    return r;
  }

  /** Load the per-org cosign policy (the projection the cosign rules consume), default-filled when unseeded. */
  async function cosignPolicyOf(tx: DbClient): Promise<OrderCosignPolicy> {
    const [r] = (await tx
      .select({ lpn: VP.lpnCosignRequiredKinds, np: VP.npCosignRequiredKinds })
      .from(VP)
      .limit(1)) as { lpn: unknown; np: unknown }[];
    if (!r) return DEFAULT_COSIGN_POLICY;
    return {
      lpnCosignRequiredKinds:
        (r.lpn as OrderKind[]) ?? DEFAULT_COSIGN_POLICY.lpnCosignRequiredKinds,
      npCosignRequiredKinds: (r.np as OrderKind[]) ?? [],
    };
  }

  /** Load the full verbal policy view (for the deadline window), default when unseeded. */
  async function verbalPolicyOf(tx: DbClient): Promise<VerbalPolicyView> {
    const [r] = (await tx
      .select({
        windowHours: VP.windowHours,
        businessHoursOnly: VP.businessHoursOnly,
        lpnCosignRequiredKinds: VP.lpnCosignRequiredKinds,
        npCosignRequiredKinds: VP.npCosignRequiredKinds,
        platformFloorWindowHours: VP.platformFloorWindowHours,
        policyVersion: VP.policyVersion,
      })
      .from(VP)
      .limit(1)) as VerbalPolicyView[];
    return r ?? DEFAULT_POLICY;
  }

  /** Insert a draft `order_record` (shared by createDraft + correctOrder), emitting `draft_created`. */
  async function insertDraft(
    tx: DbClient,
    organizationId: string,
    userId: string,
    args: CreateOrderArgs,
    replacesOrderId: string | null,
  ): Promise<string> {
    // §2.1 / §4.7 author floor (defense-in-depth on top of the route's `discipline_can_order` ABAC).
    if (!disciplineCanOrder(args.drafterDiscipline, args.kind))
      throw new NotFoundError(
        `discipline '${args.drafterDiscipline}' may not author a '${args.kind}' order`,
      );
    // F-232 — a later payload contract (`dme.v2`/`supply.v2`) is opt-in per order; absent = `<kind>.v1`.
    const kindVersion = resolveOrderKindVersion(args.kind, args.kindVersion);
    if (kindVersion === null)
      throw new ValidationError("Unsupported order payload version", [
        {
          field: "kindVersion",
          code: "INVALID",
          message: `'${args.kindVersion ?? ""}' is not a supported ${args.kind} payload version.`,
        },
      ]);
    const isLab = args.kind === "lab";
    const row = firstOrThrow(
      await tx
        .insert(OR)
        .values({
          organizationId,
          patientId: args.patientId,
          admissionId: args.admissionId,
          kind: args.kind,
          kindVersion,
          data: args.data ?? {},
          priority: args.priority ?? "routine",
          indicationText: args.indicationText ?? null,
          status: "draft",
          version: 1,
          drafterMembershipId: userId,
          drafterDiscipline: args.drafterDiscipline,
          orderingPhysicianMdmId: args.orderingPhysicianMdmId,
          sourceEncounterId: args.sourceEncounterId ?? null,
          triggeringAssessmentId: args.triggeringAssessmentId ?? null,
          triggeringHopeAssessmentId: args.triggeringHopeAssessmentId ?? null,
          replacesOrderId, // the AFTER-INSERT supersede trigger fires when this is set
          cosignRequired: false,
          cosignStatus: null,
          transmissionStatus: isLab ? "pending" : "not_required",
          resultsStatus: isLab ? "awaiting_results" : "not_expected",
        })
        .returning({ id: OR.id }),
      "order_record insert returned no row",
    );
    await emit(tx, organizationId, "m11.order.draft_created", row.id, {
      orderId: row.id,
      patientId: args.patientId,
      admissionId: args.admissionId,
      kind: args.kind,
      drafterMembershipId: userId,
    });
    return row.id;
  }

  /**
   * F-120 (#248) — the §4.4 kind-specific signed fan-out `packages/orders/src/catalog.ts` computes as a
   * `downstreamSignedEvents` effect on every sign, built here from `order_record.data` (already validated
   * at draft time against the exact per-kind TypeBox `packages/orders/src/kinds.ts` uses, so every field
   * this reads is guaranteed present). Only the three kinds whose full catalogued payload is derivable
   * from data M11 already holds are wired here; `lab` goes through {@link emitOrmRequested} (F-181) because its
   * payload needs facts from M5/M40 that arrive via injected ports.
   */
  async function emitDownstreamSignedEvent(
    tx: DbClient,
    organizationId: string,
    orderId: string,
    kind: OrderKind,
    admissionId: string,
    data: unknown,
    lab: LabSignContext,
  ): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    if (kind === "lab") {
      await emitOrmRequested(tx, organizationId, orderId, data, lab);
    } else if (kind === "level_of_care_change") {
      await emit(tx, organizationId, "m11.order.level_of_care_change_signed", orderId, {
        orderId,
        fromLevel: d.fromLevel,
        toLevel: d.toLevel,
        effectiveAt: d.effectiveAt,
        admissionId,
      });
    } else if (kind === "recertification") {
      await emit(tx, organizationId, "m11.order.recertification_signed", orderId, {
        orderId,
        admissionId,
        periodEndDate: d.periodEndDate,
        certifyingPhysicianMdmId: d.certifyingPhysicianMdmId,
      });
    } else if (kind === "dme" || kind === "supply" || kind === "comfort_kit") {
      // `preferredDeliveryWindow` on the wire is a descriptive STRING (events-by-m11.ts), not the
      // `comfort_kit` data shape's `{startAt,endAt}` object (packages/orders/src/kinds.ts) — no format for
      // that conversion is specified anywhere, so this reports `null` rather than inventing one.
      await emit(tx, organizationId, "m11.order.supply_fulfillment_requested", orderId, {
        orderId,
        kind,
        supplyDetail: data ?? {},
        preferredDeliveryWindow: null,
        deploymentSite:
          kind === "comfort_kit" && typeof d.deploymentSite === "string" ? d.deploymentSite : null,
      });
    }
  }

  /**
   * F-181 (#248) — a signed lab order requests the outbound HL7 ORM^O01 IN THE SIGN TRANSACTION. The facts come
   * through the injected ports; if ANY is unresolvable the order stays signed, `transmission_status` becomes
   * `failed` (`orm_refused:<reason>` in `transmission_failure_reason` — existing columns, no migration) and
   * `m11.order.transmission_terminal_failed` raises the ordering-provider alert with `transmittedAttempts: 0`.
   * Nothing partial is ever published. No ports ⇒ no-op (the pre-F-181 behavior).
   */
  async function emitOrmRequested(
    tx: DbClient,
    organizationId: string,
    orderId: string,
    data: unknown,
    lab: LabSignContext,
  ): Promise<void> {
    if (!orm) return;
    const outcome = await resolveOrmRequested(orm, tx, {
      orderId,
      organizationId,
      patientId: lab.patientId,
      orderingPhysicianMdmId: lab.orderingPhysicianMdmId,
      priority: lab.priority,
      signedAt: lab.signedAt,
      data,
    });
    if (outcome.kind === "ok") {
      // F-188 — every emission mints its own attempt id, persisted on the order in the SAME transaction, so a
      // `dispatch_refused` for THIS attempt can be told apart from one redelivered from an earlier attempt.
      const attemptId = randomUUID();
      await emit(tx, organizationId, "m11.order.hl7_orm_requested", orderId, {
        ...outcome.payload,
        attemptId,
      } as unknown as Record<string, unknown>);
      await tx
        .update(OR)
        .set({ transmissionAttemptId: attemptId })
        .where(and(eq(OR.organizationId, organizationId), eq(OR.id, orderId), eq(OR.kind, "lab")));
      return;
    }
    await tx
      .update(OR)
      .set({
        transmissionStatus: "failed",
        transmissionFailureReason: `orm_refused:${outcome.reason}`,
        updatedAt: lab.signedAt,
      })
      .where(and(eq(OR.organizationId, organizationId), eq(OR.id, orderId), eq(OR.kind, "lab")));
    await emit(tx, organizationId, "m11.order.transmission_terminal_failed", orderId, {
      orderId,
      organizationId,
      failureReason: `orm_refused:${outcome.reason}`,
      transmittedAttempts: 0,
      lastAttemptAt: lab.signedAt.toISOString(),
      orderingPhysicianMdmId: lab.orderingPhysicianMdmId,
    });
  }

  /** Shared sign path (§2.2 sign from pending_signature or verbal_pending). Inserts the primary signature
   * (the DB apply-trigger flips the order to `active`); the pure machine is the cosign/onBehalf guard. */
  async function signInternal(
    tx: DbClient,
    organizationId: string,
    userId: string,
    id: string,
    signerDiscipline: string,
    onBehalf: boolean,
    actor: OrderDetailActor,
    onBehalfArgs?: { onBehalfOf: string; reason: string },
  ): Promise<OrderDetailView> {
    assertActorHoldsDiscipline(actor, signerDiscipline);
    const r = await loadOrderRow(tx, id);
    await assertInScope(actor, organizationId, r.patientId);
    if (!signerEligible(signerDiscipline, r.kind))
      throw new NotFoundError(
        `discipline '${signerDiscipline}' is not eligible to sign a '${r.kind}' order`,
      );
    const fromVerbal = r.status === "verbal_pending";
    // Throws COSIGN_PENDING / ILLEGAL_ORDER_TRANSITION — the DB apply-trigger is silent on an unmet cosign.
    transitionOrder(r.status, {
      type: "sign",
      kind: r.kind as OrderKind,
      cosignAttached: r.cosignStatus !== "pending",
      onBehalf,
    });
    const at = new Date();
    const sig = firstOrThrow(
      await tx
        .insert(OS)
        .values({
          organizationId,
          targetKind: "order",
          targetId: id,
          signatureKind: "signature",
          signerMembershipId: userId,
          signerDiscipline,
          onBehalfOfMembershipId: onBehalf ? (onBehalfArgs?.onBehalfOf ?? null) : null,
          onBehalfReason: onBehalf ? (onBehalfArgs?.reason ?? null) : null,
          signedAt: at,
        })
        .returning({ id: OS.id }),
      "order_signature insert returned no row",
    );
    await emit(tx, organizationId, "m11.order.signed", id, {
      orderId: id,
      kind: r.kind,
      signatureId: sig.id,
      signerMembershipId: userId,
      signedAt: at.toISOString(),
      viaVerbal: fromVerbal,
    });
    // GAP-023 — the §4.4 M22 render handshake. The catalog has declared this event as a "mirror of
    // `m11.order.signed`" since M11-T04 and M22's consumer allowlist has named it just as long, but NO code
    // path ever emitted it: a signed order's PDF was never requested, let alone rendered. `formTemplate` is
    // M22's PUBLISHED template key (`order_record`), not an M11-local form name — M22 resolves the
    // descriptor by that key and refuses an unknown one. `patientId` rides inside `renderPayload` (whose
    // catalog schema is `Type.Unknown()`, so this needs no payload-schema change) because the rendered
    // `document` row is chart-filed against the patient; without it the PDF would file with a NULL patient.
    const typedOrder = await buildRenderPayloadOrOmit(
      "m11",
      logRenderPayload,
      { organizationId, orderId: id },
      () =>
        buildOrderRecordRenderPayload(createRenderBuildCtx(tx, organizationId), r, {
          signerMembershipId: userId,
          signedAt: at,
          viaVerbal: fromVerbal,
          onBehalfOfMembershipId: onBehalf ? (onBehalfArgs?.onBehalfOf ?? null) : null,
        }),
    );
    await emit(tx, organizationId, "m11.order.document_requested", id, {
      orderId: id,
      formTemplate: "order_record",
      renderPayload: {
        patientId: r.patientId,
        admissionId: r.admissionId,
        kind: r.kind,
        signedAt: at.toISOString(),
        signerMembershipId: userId,
        viaVerbal: fromVerbal,
        ...(typedOrder ?? {}),
      },
    });
    if (onBehalf && onBehalfArgs) {
      await emit(tx, organizationId, "m11.order.signed_on_behalf", id, {
        orderId: id,
        signerMembershipId: userId,
        onBehalfOfMembershipId: onBehalfArgs.onBehalfOf,
        reason: onBehalfArgs.reason,
      });
    }
    await emitDownstreamSignedEvent(
      tx,
      organizationId,
      id,
      r.kind as OrderKind,
      r.admissionId,
      r.data,
      {
        patientId: r.patientId,
        orderingPhysicianMdmId: r.orderingPhysicianMdmId,
        priority: r.priority,
        signedAt: at,
      },
    );
    if (fromVerbal) {
      const [v] = (await tx
        .select({ id: VO.id, deadlineAt: VO.deadlineAt })
        .from(VO)
        .where(and(eq(VO.targetKind, "order"), eq(VO.targetId, id)))
        .limit(1)) as { id: string; deadlineAt: Date }[];
      if (v) {
        await tx.update(VO).set({ status: "signed_in_time", signedAt: at }).where(eq(VO.id, v.id));
        await emit(tx, organizationId, "m11.order.verbal_signed_in_time", id, {
          orderId: id,
          verbalOrderId: v.id,
          signedAt: at.toISOString(),
          hoursBeforeDeadline: Math.max(0, (v.deadlineAt.getTime() - at.getTime()) / 3_600_000),
        });
      }
    }
    return readOrder(tx, id, actor);
  }

  return {
    // ── Order reads ────────────────────────────────────────────────────────────────────────────────
    async listOrders(organizationId, filter, scope) {
      const conds: SQL[] = [];
      if (filter.patientId) conds.push(eq(OR.patientId, filter.patientId));
      if (filter.admissionId) conds.push(eq(OR.admissionId, filter.admissionId));
      if (filter.kind) conds.push(eq(OR.kind, filter.kind as OrderKind));
      if (filter.status) conds.push(eq(OR.status, filter.status as OrderStatus));
      return listWhere(organizationId, conds.length ? and(...conds) : undefined, scope);
    },
    async getOrder(organizationId, id, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        return readOrder(tx as DbClient, id, actor);
      });
    },
    async pendingSignature(organizationId, scope) {
      return listWhere(organizationId, eq(OR.status, "pending_signature"), scope);
    },
    async verbalExpiring(organizationId, scope) {
      return listWhere(organizationId, eq(OR.status, "verbal_pending"), scope);
    },
    async cosignPending(organizationId, scope) {
      return listWhere(organizationId, eq(OR.cosignStatus, "pending"), scope);
    },
    async resultsPendingReview(organizationId, scope) {
      return listWhere(
        organizationId,
        and(eq(OR.kind, "lab"), eq(OR.resultsStatus, "results_received")),
        scope,
      );
    },
    async suggestions(_organizationId, patientId) {
      // §2.7 assessment/HOPE order suggestions are event-driven projections owed to the consumers track.
      return { patientId, suggestions: [] };
    },

    // ── Order writes (§2.2 lifecycle; the DB triggers do the state transitions) ──────────────────────
    async createDraft(organizationId, userId, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      assertActorHoldsDiscipline(actor, args.drafterDiscipline);
      await assertInScope(actor, organizationId, args.patientId);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const id = await insertDraft(t, organizationId, userId, args, args.replacesOrderId ?? null);
        return readOrder(t, id, actor);
      });
    },

    async createVerbalOrder(organizationId, userId, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      assertActorHoldsDiscipline(actor, args.order.drafterDiscipline);
      await assertInScope(actor, organizationId, args.order.patientId);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const id = await insertDraft(t, organizationId, userId, args.order, null);
        const r = await loadOrderRow(t, id);
        const findings = validateOrderData(r.kind as OrderKind, r.kindVersion, r.data);
        if (findings.length)
          throw new ValidationError(
            "Order is not ready for signature",
            findings.map((finding) => ({
              field: `data.${finding.field}`,
              code: "INVALID",
              message: finding.message,
            })),
          );
        const requirement = resolveCosignRequirement({
          kind: r.kind as OrderKind,
          drafterDiscipline: r.drafterDiscipline,
          ...deriveCosignFacts(r),
          policy: await cosignPolicyOf(t),
        });
        transitionOrder(r.status, {
          type: "requestSignature",
          requiredFieldsComplete: true,
          cosignRequired: requirement != null,
          cosignerRoleNeeded: requirement?.cosignerRoleNeeded,
        });
        await t
          .update(OR)
          .set({
            status: "pending_signature",
            cosignRequired: requirement != null,
            cosignStatus: requirement != null ? "pending" : "attached",
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.signature_requested", id, {
          orderId: id,
          kind: r.kind,
          orderingPhysicianMdmId: r.orderingPhysicianMdmId,
        });
        if (requirement)
          await emit(t, organizationId, "m11.order.cosign_requested", id, {
            orderId: id,
            kind: r.kind,
            cosignerRoleNeeded: requirement.cosignerRoleNeeded,
          });
        if (!args.verbal.readBackVerified)
          throw Object.assign(new Error("Verbal order must be read back and verified"), {
            code: "VERBAL_READ_BACK_REQUIRED",
            statusCode: 422,
          });
        transitionOrder("pending_signature", {
          type: "recordVerbal",
          kind: r.kind as OrderKind,
          attestationRecorded: args.verbal.verbalAttestation.length >= 100,
          recorderEligible: isVerbalRecorderDiscipline(args.order.drafterDiscipline),
        });
        // GAP-017 -- the 48h clock starts at receivedAt: bound it against SERVER time, not the client's.
        assertVerbalReceivedAtPlausible(args.verbal.receivedAt, new Date().toISOString());
        const policy = await verbalPolicyOf(t);
        const deadlineIso = computeVerbalDeadline(args.verbal.receivedAt, {
          windowHours: policy.windowHours,
          businessHoursOnly: policy.businessHoursOnly,
          policyVersion: policy.policyVersion,
        });
        const v = firstOrThrow(
          await t
            .insert(VO)
            .values({
              organizationId,
              targetKind: "order",
              targetId: id,
              recordingMembershipId: userId,
              orderingPhysicianMdmId: args.verbal.orderingPhysicianMdmId,
              verbalAttestation: args.verbal.verbalAttestation,
              readBackVerified: true,
              effectiveAt: new Date(args.verbal.effectiveAt),
              receivedAt: new Date(args.verbal.receivedAt),
              deadlineAt: new Date(deadlineIso),
              deadlinePolicyVersion: policy.policyVersion,
              status: "pending",
            })
            .returning({ id: VO.id }),
          "verbal_order insert returned no row",
        );
        await t
          .update(OR)
          .set({
            orderingPhysicianMdmId: args.verbal.orderingPhysicianMdmId,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.verbal_received", id, {
          orderId: id,
          verbalOrderId: v.id,
          deadlineAt: deadlineIso,
          orderingPhysicianMdmId: args.verbal.orderingPhysicianMdmId,
          recordingMembershipId: userId,
        });
        return readOrder(t, id, actor);
      });
    },

    async editDraft(
      organizationId,
      id,
      data,
      priority,
      actor = EMPTY_ORDER_DETAIL_ACTOR,
      indicationText?: string,
    ) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        await assertInScope(actor, organizationId, r.patientId);
        if (r.status !== "draft")
          throw new NotFoundError(`order ${id} is not a draft and cannot be edited`);
        assertMayEditDraft(actor, r);
        await t
          .update(OR)
          .set({
            data: data ?? {},
            priority: priority ?? r.priority,
            ...(indicationText !== undefined ? { indicationText } : {}),
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        return readOrder(t, id, actor);
      });
    },

    async requestSignature(organizationId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      assertActorHoldsDiscipline(actor, args.signerDiscipline);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        await assertInScope(actor, organizationId, r.patientId);
        const findings = validateOrderData(r.kind as OrderKind, r.kindVersion, r.data);
        if (findings.length)
          throw new ValidationError(
            "Order is not ready for signature",
            findings.map((finding) => ({
              field: `data.${finding.field}`,
              code: "INVALID",
              message: finding.message,
            })),
          );
        const requirement = resolveCosignRequirement({
          kind: r.kind as OrderKind,
          drafterDiscipline: r.drafterDiscipline,
          // GAP-031 — signer + level transition come from the stored order, never the request body.
          ...deriveCosignFacts(r),
          policy: await cosignPolicyOf(t),
        });
        // Validates ORDER_REQUIRED_FIELDS_INCOMPLETE / ILLEGAL_ORDER_TRANSITION.
        transitionOrder(r.status, {
          type: "requestSignature",
          requiredFieldsComplete: true,
          cosignRequired: requirement != null,
          cosignerRoleNeeded: requirement?.cosignerRoleNeeded,
        });
        await t
          .update(OR)
          .set({
            status: "pending_signature",
            cosignRequired: requirement != null,
            cosignStatus: requirement != null ? "pending" : "attached",
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.signature_requested", id, {
          orderId: id,
          kind: r.kind,
          orderingPhysicianMdmId: r.orderingPhysicianMdmId,
        });
        if (requirement)
          await emit(t, organizationId, "m11.order.cosign_requested", id, {
            orderId: id,
            kind: r.kind,
            cosignerRoleNeeded: requirement.cosignerRoleNeeded,
          });
        return readOrder(t, id, actor);
      });
    },

    async signOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        signInternal(
          tx as unknown as DbClient,
          organizationId,
          userId,
          id,
          args.signerDiscipline,
          false,
          actor,
        ),
      );
    },
    async signOnBehalf(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        signInternal(
          tx as unknown as DbClient,
          organizationId,
          userId,
          id,
          args.signerDiscipline,
          true,
          actor,
          {
            onBehalfOf: args.onBehalfOf,
            reason: args.reason,
          },
        ),
      );
    },

    async recordVerbal(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      assertActorHoldsDiscipline(actor, args.recorderDiscipline);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        await assertInScope(actor, organizationId, r.patientId);
        if (!args.readBackVerified) {
          throw Object.assign(new Error("Verbal order must be read back and verified"), {
            code: "VERBAL_READ_BACK_REQUIRED",
            statusCode: 422,
          });
        }
        // Validates VERBAL_NOT_ALLOWED_FOR_KIND / VERBAL_ATTESTATION_REQUIRED / ILLEGAL_ORDER_TRANSITION.
        transitionOrder(r.status, {
          type: "recordVerbal",
          kind: r.kind as OrderKind,
          attestationRecorded: args.verbalAttestation.length >= 100,
          recorderEligible: isVerbalRecorderDiscipline(args.recorderDiscipline),
        });
        // GAP-017 -- the 48h clock starts at receivedAt: bound it against SERVER time, not the client's.
        assertVerbalReceivedAtPlausible(args.receivedAt, new Date().toISOString());
        const policy = await verbalPolicyOf(t);
        const deadlineIso = computeVerbalDeadline(args.receivedAt, {
          windowHours: policy.windowHours,
          businessHoursOnly: policy.businessHoursOnly,
          policyVersion: policy.policyVersion,
        });
        // Inserting the verbal_order fires `verbal_order_set_target_pending_trg` → order → verbal_pending
        // (RAISES TARGET_NOT_PENDING_SIGNATURE if the order is not pending_signature).
        const v = firstOrThrow(
          await t
            .insert(VO)
            .values({
              organizationId,
              targetKind: "order",
              targetId: id,

              recordingMembershipId: userId,
              orderingPhysicianMdmId: args.orderingPhysicianMdmId,

              verbalAttestation: args.verbalAttestation,

              readBackVerified: args.readBackVerified,
              effectiveAt: new Date(args.effectiveAt),

              receivedAt: new Date(args.receivedAt),

              deadlineAt: new Date(deadlineIso),
              deadlinePolicyVersion: policy.policyVersion,

              status: "pending",
            })
            .returning({ id: VO.id }),
          "verbal_order insert returned no row",
        );
        // Reflect the physician the RN attributed the verbal order to (the trigger already bumped version).
        await t
          .update(OR)
          .set({
            orderingPhysicianMdmId: args.orderingPhysicianMdmId,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.verbal_received", id, {
          orderId: id,
          verbalOrderId: v.id,
          deadlineAt: deadlineIso,
          orderingPhysicianMdmId: args.orderingPhysicianMdmId,
          recordingMembershipId: userId,
        });
        return readOrder(t, id, actor);
      });
    },

    async cosignOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        await assertInScope(actor, organizationId, r.patientId);
        // `order_record` carries no cosigner_role_needed column; re-derive it from the persisted facts:
        // the LPN axis (drafter+kind driven) demands an RN; the escalation-jump / NP axes both demand MD.
        const cosignerRoleNeeded = lpnCosignRequired(
          r.drafterDiscipline,
          r.kind as OrderKind,
          await cosignPolicyOf(t),
        )
          ? "rn_case_manager"
          : "medical_director";
        // Validates COSIGN_NOT_REQUIRED / ALREADY_COSIGNED / COSIGNER_NOT_ELIGIBLE (incl. self-cosign).
        planCosignAttest({
          orderId: id,
          cosignRequired: r.cosignRequired,
          alreadyCosigned: r.cosignStatus === "attached",
          cosignerRole: args.cosignerRole,
          cosignerRoleNeeded,
          cosignerIsAuthor: r.drafterMembershipId === userId,
        });
        const cosig = firstOrThrow(
          await t
            .insert(OS)
            .values({
              organizationId,
              targetKind: "order",
              targetId: id,
              signatureKind: "cosignature",
              signerMembershipId: userId,
              signerDiscipline: args.cosignerRole,
              cosignerRole: args.cosignerRole,
              attestationText: args.attestationText,
              signedAt: new Date(),
            })
            .returning({ id: OS.id }),
          "order_signature (cosignature) insert returned no row",
        );
        await t
          .update(OR)
          .set({ cosignStatus: "attached", updatedAt: new Date() })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.cosigned", id, {
          orderId: id,
          cosignatureId: cosig.id,
          cosignerRole: args.cosignerRole,
          cosignerMembershipId: userId,
        });
        return readOrder(t, id, actor);
      });
    },

    async discontinueOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        await assertInScope(actor, organizationId, r.patientId);
        // Validates ILLEGAL_ORDER_TRANSITION for a terminal order.
        transitionOrder(r.status, {
          type: "discontinue",
          kind: r.kind as OrderKind,
          reason: args.reason,
          fulfillmentInFlight: false,
        });
        const disc = firstOrThrow(
          await t
            .insert(OD)
            .values({
              organizationId,
              orderRecordId: id,
              actorMembershipId: userId,
              reason: args.reason,
              notes: args.notes ?? null,
              effectiveAt: new Date(args.effectiveAt),
            })
            .returning({ id: OD.id }),
          "order_discontinuation insert returned no row",
        );
        await t
          .update(OR)
          .set({
            status: "discontinued",
            discontinuedAt: new Date(),
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.discontinued", id, {
          orderId: id,
          discontinuationId: disc.id,
          reason: args.reason,
          actorMembershipId: userId,
          effectiveAt: new Date(args.effectiveAt).toISOString(),
        });
        return readOrder(t, id, actor);
      });
    },

    async correctOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      assertActorHoldsDiscipline(actor, args.drafterDiscipline);
      // The corrected draft may name a different patient than the original: both must be in scope.
      await assertInScope(actor, organizationId, args.patientId);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const original = await loadOrderRow(t, id); // 404 if the original is cross-tenant/absent
        await assertInScope(actor, organizationId, original.patientId);
        const findings = validateOrderData(
          args.kind,
          resolveOrderKindVersion(args.kind, args.kindVersion) ?? "unsupported",
          args.data,
        );
        if (findings.length)
          throw new ValidationError(
            "Corrected order clinical details are invalid",
            findings.map((finding) => ({
              field: `data.${finding.field}`,
              code: "INVALID",
              message: finding.message,
            })),
          );
        // Inserting the correcting draft fires `order_record_replace_supersede_trg` → discontinues the
        // original + writes its ledger row (RAISES REPLACED_ORDER_NOT_REPLACEABLE if not replaceable).
        const newId = await insertDraft(t, organizationId, userId, args, id);
        await emit(t, organizationId, "m11.order.corrected", newId, {
          newOrderId: newId,
          replacedOrderId: id,
          kind: args.kind,
          drafterMembershipId: userId,
        });
        return readOrder(t, newId, actor);
      });
    },

    /**
     * F-182 (#248) — re-run F-181's producer for a lab order whose ORM request was refused. Everything below is ONE
     * transaction, so a caller never observes `pending` without the published request or the reverse:
     *   1. `SELECT … FOR UPDATE` the order row — two resends (a double-click, two tabs) serialize here; the second
     *      then reads the first's committed `pending` and is refused as `not_failed`.
     *   2. {@link classifyOrmResend} — only an `orm_refused:*` failure is resendable (see its header for what is
     *      not, and why).
     *   3. {@link resolveOrmRequested} — the SAME producer the sign path runs, over the SAME ports.
     *   4. success: a CONDITIONAL update (`WHERE transmission_status='failed' AND reason = <the one we read>`) back to
     *      `pending` + one `m11.order.hl7_orm_requested`. The conditional update is the second, independent guard —
     *      it holds even if the row lock were ever dropped. Refusal: the reason is refreshed if it changed, and NO
     *      alert is raised (the provider was alerted at sign; a repeat would be spam).
     * M29's idempotency key is `(feed, 'orm', orderId)`. A refused order never reached M29, so it has no outbound
     * row for that key to collide with — the resend therefore needs no per-attempt key and can never double-send.
     * `auditUserId` is set on the transaction so the M4 write-audit trigger records WHO pressed resend on the
     * `order_record` update (before: failed/orm_refused:x → after: pending); the module's other writes pass "".
     */
    async resendLabTransmission(
      organizationId,
      _membershipId,
      id,
      actor = EMPTY_ORDER_DETAIL_ACTOR,
      auditUserId = "",
    ): Promise<ResendLabTransmissionResult> {
      if (!orm) {
        throw new ConflictError(
          "ORM resend not allowed (not_configured): outbound lab requests are not configured",
        );
      }
      return withOrgContext(db, { organizationId, userId: auditUserId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t
          .select()
          .from(OR)
          .where(and(eq(OR.organizationId, organizationId), eq(OR.id, id)))
          .limit(1)
          .for("update")) as (typeof OR.$inferSelect)[];
        if (!r) throw new NotFoundError(`order ${id} not found`);
        const verdict = classifyOrmResend({
          kind: r.kind,
          status: r.status,
          transmissionStatus: r.transmissionStatus,
          transmissionFailureReason: r.transmissionFailureReason,
        });
        if (!verdict.ok) {
          throw new ConflictError(`ORM resend not allowed (${verdict.code}): ${verdict.message}`);
        }
        const at = new Date();
        const outcome = await resolveOrmRequested(orm, t, {
          orderId: id,
          organizationId,
          patientId: r.patientId,
          orderingPhysicianMdmId: r.orderingPhysicianMdmId,
          priority: r.priority,
          signedAt: r.signedAt ?? at,
          data: r.data,
        });
        const stillFailed = and(
          eq(OR.organizationId, organizationId),
          eq(OR.id, id),
          eq(OR.kind, "lab"),
          eq(OR.transmissionStatus, "failed"),
          eq(OR.transmissionFailureReason, verdict.priorReason),
        );
        if (outcome.kind === "ok") {
          // F-188 — a NEW attempt: a `dispatch_refused` redelivered from the previous attempt no longer matches.
          const attemptId = randomUUID();
          const claimed = await t
            .update(OR)
            .set({
              transmissionStatus: "pending",
              transmissionFailureReason: null,
              transmissionAttemptId: attemptId,
              updatedAt: at,
            })
            .where(stillFailed)
            .returning({ id: OR.id });
          if (claimed.length === 0) {
            throw new ConflictError(
              "ORM resend not allowed (not_failed): the order was resent concurrently",
            );
          }
          await emit(t, organizationId, "m11.order.hl7_orm_requested", id, {
            ...outcome.payload,
            attemptId,
          } as unknown as Record<string, unknown>);
          return {
            outcome: "requested",
            refusalReason: null,
            order: await readOrder(t, id, actor),
          };
        }
        const refusal = `${ORM_REFUSAL_PREFIX}${outcome.reason}`;
        if (refusal !== verdict.priorReason) {
          await t
            .update(OR)
            .set({ transmissionFailureReason: refusal, updatedAt: at })
            .where(stillFailed);
        }
        return {
          outcome: "still_refused",
          refusalReason: outcome.reason,
          order: await readOrder(t, id, actor),
        };
      });
    },

    /**
     * F-187 (#248) — the operator's ATTESTED recovery of a lab order that failed AFTER a message was built
     * (`dlq_exhausted`, including F-183's "held, delivery unverified", or `application_reject`). F-182's resend refuses
     * these on purpose: the lab MAY have the order, and re-emitting would order the test twice. The one fact the
     * system cannot know is what the lab actually holds, so a human establishes it by calling the lab and ATTESTS:
     *   • `not_received_by_lab` → the DUPLICATE-RISK attestation. F-202: it no longer executes on the first call — it
     *     FILES a `pending_cosign` request (`order_recovery_request`, expires in 24 h) that a DIFFERENT authorized person
     *     must co-sign (`cosignLabTransmissionRecovery`), which then re-runs the producer and publishes ONE
     *     `m11.order.hl7_orm_requested` carrying a fresh `redispatchAttestationId` (M29's worker treats that id as the
     *     single sanctioned exception to F-183's one-ORM-per-order guard). The order is untouched while it waits.
     *   • `received_by_lab`     → nothing is sent; the order is marked `transmitted`. Single-person (it cannot duplicate).
     * The single-dispatch guards from F-187/F-188 are unchanged and now live in the CO-SIGN: `SELECT … FOR UPDATE` on the
     * order row and a CONDITIONAL update (`WHERE transmission_status='failed' AND reason = <the one we read>`), inside ONE
     * transaction. F-188's ledger row (`order_transmission_attestation`, append-only) is written by the execution — now
     * carrying the co-signer and the request it executed — and the order's `transmission_failure_reason` is cleared.
     * BEFORE anything is filed or written, `not_received_by_lab` is checked against what the system CAN verify (a lab
     * result already returned, an acked/queued/in-flight outbound row): a contradiction is a 409 — again at co-sign time,
     * against fresh evidence. If the producer REFUSES (a fact is missing) the order is left EXACTLY as it was.
     */
    async recoverLabTransmission(
      organizationId,
      membershipId,
      id,
      attestation,
      evidence,
      actor = EMPTY_ORDER_DETAIL_ACTOR,
      auditUserId = "",
    ): Promise<RecoverLabTransmissionResult> {
      if (!orm) {
        throw new ConflictError(
          "Transmission recovery not allowed (not_configured): outbound lab requests are not configured",
        );
      }
      return withOrgContext(db, { organizationId, userId: auditUserId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t
          .select()
          .from(OR)
          .where(and(eq(OR.organizationId, organizationId), eq(OR.id, id)))
          .limit(1)
          .for("update")) as (typeof OR.$inferSelect)[];
        if (!r) throw new NotFoundError(`order ${id} not found`);
        const verdict = classifyTransmissionRecovery(
          {
            kind: r.kind,
            status: r.status,
            transmissionStatus: r.transmissionStatus,
            transmissionFailureReason: r.transmissionFailureReason,
          },
          attestation,
        );
        if (!verdict.ok) {
          throw new ConflictError(
            `Transmission recovery not allowed (${verdict.code}): ${verdict.message}`,
          );
        }
        // F-188 — the CONTRADICTION CHECK, BEFORE anything is written: an operator's `not_received_by_lab` is a
        // phone call the system cannot verify, but it CAN see whether the lab has already returned a result for the
        // order, acknowledged the message, or still has a send under way. Any of those refuses the attestation with
        // a specific 409; a missing evidence port fails CLOSED. `received_by_lab` is never blocked (it sends nothing).
        if (attestation === "not_received_by_lab") {
          const observed = orm.outboundEvidence
            ? await orm.outboundEvidence(t, organizationId, id)
            : null;
          const contradiction = classifyRecoveryContradiction(
            attestation,
            {
              resultsStatus: r.resultsStatus,
              resultsFirstReceivedAt: r.resultsFirstReceivedAt,
            },
            observed,
          );
          if (contradiction) {
            throw new ConflictError(
              `Transmission recovery not allowed (${contradiction.code}): ${contradiction.message}`,
            );
          }
        }
        const at = nowFn();

        if (attestation === "received_by_lab") {
          const attestationId = randomUUID();
          const claimed = await t
            .update(OR)
            // F-188 — a delivered order carries NO failure reason; what was attested, by whom, with what evidence,
            // lives in `order_transmission_attestation`.
            .set({
              transmissionStatus: "transmitted",
              transmissionFailureReason: null,
              updatedAt: at,
            })
            .where(
              and(
                eq(OR.organizationId, organizationId),
                eq(OR.id, id),
                eq(OR.kind, "lab"),
                eq(OR.transmissionStatus, "failed"),
                eq(OR.transmissionFailureReason, verdict.priorReason),
              ),
            )
            .returning({ id: OR.id });
          if (claimed.length === 0) {
            throw new ConflictError(
              "Transmission recovery not allowed (not_failed): the order was recovered concurrently",
            );
          }
          await t.insert(ATT).values({
            id: attestationId,
            organizationId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            orderRecordId: id,
            attestation,
            outcome: "marked_transmitted",
            labContactName: evidence.contactName,
            labReference: evidence.labReference,
            priorFailureReason: verdict.priorReason,
            attemptId: null,
            attestedByMembershipId: membershipId || null,
            attestedByUserId: auditUserId || null,
            createdAt: at,
          });
          await emit(t, organizationId, "m11.order.transmission_status_changed", id, {
            orderId: id,
            organizationId,
            fromStatus: "failed",
            toStatus: "transmitted",
            sourceM29EventId: attestationId,
          });
          return {
            outcome: "marked_transmitted",
            refusalReason: null,
            order: await readOrder(t, id, actor),
            recovery: null,
          };
        }

        // ── `not_received_by_lab`: FILE the request; a DIFFERENT person's co-signature executes it (F-202). ──────
        // The distinctness rule compares Better Auth USER ids, so an empty one (a non-HTTP caller) cannot file.
        if (!auditUserId) {
          throw new ConflictError(
            "Transmission recovery not allowed (no_actor): a recovery request needs an authenticated user",
          );
        }
        // A dry run of the producer: filing a request the co-signer could never execute is noise, so a fact that is
        // missing NOW is reported now and nothing is filed. The co-sign re-runs it against the facts of THAT moment.
        const dryRun = await resolveOrmRequested(orm, t, {
          orderId: id,
          organizationId,
          patientId: r.patientId,
          orderingPhysicianMdmId: r.orderingPhysicianMdmId,
          priority: r.priority,
          signedAt: r.signedAt ?? at,
          data: r.data,
        });
        if (dryRun.kind !== "ok") {
          return {
            outcome: "still_refused",
            refusalReason: dryRun.reason,
            order: await readOrder(t, id, actor),
            recovery: null,
          };
        }
        // F-204 — a two-person control needs a second person. If nobody else in the organization can co-sign, say so
        // now rather than filing a request that can only lapse.
        if (recovery.countEligibleCosigners) {
          const eligible = await recovery.countEligibleCosigners(organizationId, auditUserId);
          if (eligible === 0) {
            throw new ConflictError(
              "Transmission recovery not allowed (no_eligible_cosigner): no other active user in this organization can co-sign a recovery — an administrator must grant 'orders.transmission.recover' (or 'orders.transmission.cosign_escalated') to a second person first",
            );
          }
        }
        const [existing] = await t
          .select({ id: REQ.id })
          .from(REQ)
          .where(and(eq(REQ.orderRecordId, id), eq(REQ.status, "pending_cosign")))
          .limit(1);
        if (existing) {
          throw new ConflictError(
            "Transmission recovery not allowed (already_pending): a recovery for this order is already awaiting its co-signature",
          );
        }
        const [filed] = await t
          .insert(REQ)
          .values({
            organizationId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            orderRecordId: id,
            attestation: "not_received_by_lab",
            labContactName: evidence.contactName,
            labReference: evidence.labReference,
            priorFailureReason: verdict.priorReason,
            requestedByMembershipId: membershipId || null,
            requestedByUserId: auditUserId,
            requestedAt: at,
            expiresAt: new Date(at.getTime() + recoveryTtlMs),
          })
          .returning();
        return {
          outcome: "pending_cosign",
          refusalReason: null,
          order: await readOrder(t, id, actor),
          recovery: toRequestView(filed as typeof REQ.$inferSelect, actor),
        };
      });
    },

    /**
     * F-202 — the SECOND person of the two-person control. Mirrors M3 `BreakGlassStore.cosign`: the guards that make
     * it two-person live in the UPDATE's WHERE (still pending, not lapsed, co-signer ≠ requester) so two co-signers
     * racing cannot both win, with the `order_recovery_request_cosigner_distinct_chk` CHECK behind them; the friendly
     * 409s come from the pure `decideRecoveryCosign` (a settled or lapsed request reports THAT, never whether the caller
     * is its requester). Then the same single-dispatch execution the one-person path had — re-checking the order is
     * STILL a recoverable failure, the contradiction check against FRESH evidence, and the producer against the facts of
     * THIS moment — in ONE transaction: the conditional order update, the append-only ledger row (requester as attester,
     * this user as co-signer, the request id), the request → `executed`, and the single `hl7_orm_requested`. The
     * compliance alert goes out after commit, with the repeat-attester count.
     */
    async cosignLabTransmissionRecovery(
      organizationId,
      membershipId,
      orderId,
      requestId,
      actor = EMPTY_ORDER_DETAIL_ACTOR,
      auditUserId = "",
    ): Promise<RecoverLabTransmissionResult> {
      if (!orm) {
        throw new ConflictError(
          "Transmission recovery not allowed (not_configured): outbound lab requests are not configured",
        );
      }
      return withOrgContext(db, { organizationId, userId: auditUserId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const alerts: RecoveryAlert[] = [];
        // The ORDER row lock first (as every path that moves the order takes it): a supersede — the trigger fired by a
        // concurrent transition of this order — is serialized against this co-sign by it, so a request superseded by a
        // committed transition is read below as `superseded`, never executed.
        const [r] = (await t
          .select()
          .from(OR)
          .where(and(eq(OR.organizationId, organizationId), eq(OR.id, orderId)))
          .limit(1)
          .for("update")) as (typeof OR.$inferSelect)[];
        if (!r) throw new NotFoundError(`order ${orderId} not found`);
        const [q] = await t
          .select()
          .from(REQ)
          .where(
            and(
              eq(REQ.organizationId, organizationId),
              eq(REQ.id, requestId),
              eq(REQ.orderRecordId, orderId),
            ),
          )
          .limit(1);
        if (!q) throw new NotFoundError(`recovery request ${requestId} not found`);
        const at = nowFn();
        const cosign = decideRecoveryCosign(
          {
            status: q.status,
            requestedByUserId: q.requestedByUserId,
            expiresAt: q.expiresAt,
            supersededReason: q.supersededReason,
          },
          auditUserId,
          at,
        );
        if (!cosign.ok) {
          throw new ConflictError(
            `Transmission recovery not allowed (${cosign.code}): ${cosign.message}`,
          );
        }

        // F-203 — the COLLUSION BOUND. Serialize concurrent co-signs that involve either person (advisory locks, taken in
        // a fixed order so two co-signs cannot deadlock), then count the EXECUTED recoveries in the window for this
        // requester, for this exact pair (either way round) and for the whole org. At the bound, only a holder of
        // `orders.transmission.cosign_escalated` may co-sign. This raises the cost of two people agreeing to lie; it
        // does not verify the lab — nothing inside the platform can.
        for (const who of [q.requestedByUserId, auditUserId].sort()) {
          await t.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`m11-recovery:${organizationId}:${who}`}))`,
          );
        }
        const windowStart = new Date(at.getTime() - anomalyWindowMs);
        const [tally] = await t
          .select({
            requester: sql<number>`count(*) filter (where ${ATT.attestedByUserId} = ${q.requestedByUserId})::int`,
            pair: sql<number>`count(*) filter (where (${ATT.attestedByUserId} = ${q.requestedByUserId} and ${ATT.cosignedByUserId} = ${auditUserId}) or (${ATT.attestedByUserId} = ${auditUserId} and ${ATT.cosignedByUserId} = ${q.requestedByUserId}))::int`,
            org: sql<number>`count(*)::int`,
          })
          .from(ATT)
          .where(
            and(
              eq(ATT.organizationId, organizationId),
              eq(ATT.attestation, "not_received_by_lab"),
              eq(ATT.outcome, "redispatched"),
              gte(ATT.createdAt, windowStart),
              // The window is [at − W, at]: a row stamped AFTER this moment (clock skew, a test's private clock) is not "recent".
              lte(ATT.createdAt, at),
            ),
          );
        const priorRequester = Number(tally?.requester ?? 0);
        const priorPair = Number(tally?.pair ?? 0);
        const priorOrg = Number(tally?.org ?? 0);
        const escalation = decideRecoveryEscalation(
          { requesterExecuted: priorRequester, pairExecuted: priorPair },
          escalationThreshold,
        );
        if (escalation.required && !actor.permissions.has("orders.transmission.cosign_escalated")) {
          throw new ConflictError(
            `Transmission recovery not allowed (escalation_required): ${
              escalation.reason === "pair_bound"
                ? "this requester and co-signer have"
                : "this requester has"
            } already executed ${escalationThreshold} recoveries in the last ${Math.round(
              anomalyWindowMs / 3_600_000,
            )} hours — a co-signer holding 'orders.transmission.cosign_escalated' (an administrator or compliance officer) must approve this one`,
          );
        }

        const verdict = classifyTransmissionRecovery(
          {
            kind: r.kind,
            status: r.status,
            transmissionStatus: r.transmissionStatus,
            transmissionFailureReason: r.transmissionFailureReason,
          },
          "not_received_by_lab",
        );
        if (!verdict.ok) {
          throw new ConflictError(
            `Transmission recovery not allowed (${verdict.code}): ${verdict.message}`,
          );
        }
        const observed = orm.outboundEvidence
          ? await orm.outboundEvidence(t, organizationId, orderId)
          : null;
        const contradiction = classifyRecoveryContradiction(
          "not_received_by_lab",
          {
            resultsStatus: r.resultsStatus,
            resultsFirstReceivedAt: r.resultsFirstReceivedAt,
          },
          observed,
        );
        if (contradiction) {
          throw new ConflictError(
            `Transmission recovery not allowed (${contradiction.code}): ${contradiction.message}`,
          );
        }
        const outcome = await resolveOrmRequested(orm, t, {
          orderId,
          organizationId,
          patientId: r.patientId,
          orderingPhysicianMdmId: r.orderingPhysicianMdmId,
          priority: r.priority,
          signedAt: r.signedAt ?? at,
          data: r.data,
        });
        if (outcome.kind !== "ok") {
          // A fact is missing NOW: nothing executes, the order and the (still pending) request are left exactly as they were.
          return {
            outcome: "still_refused" as const,
            refusalReason: outcome.reason,
            order: await readOrder(t, orderId, actor),
            recovery: toRequestView(q, actor),
          };
        }
        const attemptId = randomUUID();
        const attestationId = randomUUID();
        // BOTH guards in the WHERE, not in a read-then-write (the break-glass shape): a concurrent co-signer, a lapse
        // between the read above and now, a supersede, or the requester themselves all match no row. F-203 — this runs
        // BEFORE the order is moved: the order's own transition would otherwise fire the supersede trigger on this very
        // request. Anything that fails below rolls this back with the rest of the transaction.
        const executed = await t
          .update(REQ)
          .set({
            status: "executed",
            cosignedByMembershipId: membershipId || null,
            cosignedByUserId: auditUserId,
            resolvedAt: at,
            attestationId,
            cosignedEscalated: escalation.required,
          })
          .where(
            and(
              eq(REQ.id, requestId),
              eq(REQ.status, "pending_cosign"),
              gt(REQ.expiresAt, at),
              ne(REQ.requestedByUserId, auditUserId),
            ),
          )
          .returning();
        if (executed.length === 0) {
          throw new ConflictError(
            "Transmission recovery not allowed (not_pending): the recovery request was resolved concurrently",
          );
        }
        const claimed = await t
          .update(OR)
          .set({
            transmissionStatus: "pending",
            transmissionFailureReason: null,
            transmissionAttemptId: attemptId,
            updatedAt: at,
          })
          .where(
            and(
              eq(OR.organizationId, organizationId),
              eq(OR.id, orderId),
              eq(OR.kind, "lab"),
              eq(OR.transmissionStatus, "failed"),
              eq(OR.transmissionFailureReason, verdict.priorReason),
            ),
          )
          .returning({ id: OR.id });
        if (claimed.length === 0) {
          throw new ConflictError(
            "Transmission recovery not allowed (not_failed): the order was recovered concurrently",
          );
        }
        await t.insert(ATT).values({
          id: attestationId,
          organizationId,
          providerEntityId: r.providerEntityId,
          locationId: r.locationId,
          orderRecordId: orderId,
          attestation: "not_received_by_lab",
          outcome: "redispatched",
          labContactName: q.labContactName,
          labReference: q.labReference,
          priorFailureReason: verdict.priorReason,
          attemptId,
          // The REQUESTER attested; this user co-signed. The ledger's NOT VALID CHECK requires both, distinct.
          attestedByMembershipId: q.requestedByMembershipId,
          attestedByUserId: q.requestedByUserId,
          cosignedByMembershipId: membershipId || null,
          cosignedByUserId: auditUserId,
          recoveryRequestId: requestId,
          createdAt: at,
        });
        await emit(t, organizationId, "m11.order.hl7_orm_requested", orderId, {
          ...outcome.payload,
          redispatchAttestationId: attestationId,
          attemptId,
        } as unknown as Record<string, unknown>);

        // The repeat-attester signal: how many requests this requester filed inside the window (this one included).
        const [counted] = await t
          .select({ n: sql<number>`count(*)::int` })
          .from(REQ)
          .where(
            and(
              eq(REQ.organizationId, organizationId),
              eq(REQ.requestedByUserId, q.requestedByUserId),
              gte(REQ.requestedAt, windowStart),
            ),
          );
        alerts.push(
          buildRecoveryAlert("m11.order.recovery_executed", {
            orderId,
            requestId,
            requestedByMembershipId: q.requestedByMembershipId,
            cosignedByMembershipId: membershipId || null,
            requesterCountInWindow: Number(counted?.n ?? 0),
            anomalyThreshold,
            pairExecutionsInWindow: priorPair + 1,
            escalatedCosign: escalation.required,
          }),
        );
        // F-203 — the collusion / rate signals, each DEDUPLICATED per window by its own correlation id.
        if (priorPair + 1 >= escalationThreshold) {
          alerts.push(
            buildRecoveryAnomalyAlert("repeat_pair", {
              orderId,
              at,
              windowMs: anomalyWindowMs,
              executionsInWindow: priorPair + 1,
              threshold: escalationThreshold,
              pairUserIds: [q.requestedByUserId, auditUserId],
            }),
          );
        }
        if (priorOrg + 1 >= orgRateThreshold) {
          alerts.push(
            buildRecoveryAnomalyAlert("org_rate", {
              orderId,
              at,
              windowMs: anomalyWindowMs,
              executionsInWindow: priorOrg + 1,
              threshold: orgRateThreshold,
            }),
          );
        }
        // Durable: the alert intents commit with the recovery (see `publishRecoveryAlerts`).
        await publishRecoveryAlerts(t, organizationId, orderId, alerts);
        return {
          outcome: "redispatched" as const,
          refusalReason: null,
          order: await readOrder(t, orderId, actor),
          recovery: toRequestView(executed[0] as typeof REQ.$inferSelect, actor),
        };
      });
    },

    /** F-202 — cancel a pending recovery (either person). The guard is the WHERE; a miss re-reads to say WHY. */
    async cancelLabTransmissionRecovery(
      organizationId,
      membershipId,
      orderId,
      requestId,
      actor = EMPTY_ORDER_DETAIL_ACTOR,
      auditUserId = "",
    ) {
      if (!auditUserId) {
        throw new ConflictError(
          "Transmission recovery not allowed (no_actor): cancelling a recovery needs an authenticated user",
        );
      }
      return withOrgContext(db, { organizationId, userId: auditUserId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const at = nowFn();
        const [cancelled] = await t
          .update(REQ)
          .set({
            status: "cancelled",
            cancelledByMembershipId: membershipId || null,
            cancelledByUserId: auditUserId,
            resolvedAt: at,
          })
          .where(
            and(
              eq(REQ.id, requestId),
              eq(REQ.organizationId, organizationId),
              eq(REQ.orderRecordId, orderId),
              eq(REQ.status, "pending_cosign"),
            ),
          )
          .returning();
        if (!cancelled) {
          const [q] = await t
            .select({
              status: REQ.status,
              supersededReason: REQ.supersededReason,
            })
            .from(REQ)
            .where(
              and(
                eq(REQ.organizationId, organizationId),
                eq(REQ.id, requestId),
                eq(REQ.orderRecordId, orderId),
              ),
            )
            .limit(1);
          if (!q) throw new NotFoundError(`recovery request ${requestId} not found`);
          throw new ConflictError(
            `Transmission recovery not allowed (${q.status === "superseded" ? "superseded" : "not_pending"}): this recovery request is ${q.status}${
              q.supersededReason ? ` (${q.supersededReason})` : ""
            }, not awaiting a co-signature`,
          );
        }
        await publishRecoveryAlerts(t, organizationId, orderId, [
          buildRecoveryAlert("m11.order.recovery_cancelled", {
            orderId,
            requestId,
            requestedByMembershipId: cancelled.requestedByMembershipId,
            cancelledByMembershipId: membershipId || null,
          }),
        ]);
        return {
          recovery: toRequestView(cancelled, actor),
          order: await readOrder(t, orderId, actor),
        };
      });
    },

    /**
     * F-202 — the sweep. One UPDATE flips every pending request past its `expires_at` to `expired` (the guard is the
     * WHERE, so a request co-signed a millisecond ago is not touched) and each raises the compliance alert. The system
     * actor is empty, so the audit trigger records no user — an expiry is not a person's act.
     *
     * F-203 — the same tick is the BACKSTOP for stranded requests: any pending request whose order is no longer a failed
     * lab order (or no longer exists) is superseded. The `order_record` trigger supersedes at the moment the order moves,
     * so this only ever catches a request that trigger could not see (an order row rewritten with triggers disabled, a
     * restore) — it is a net, not the mechanism. Its alerts are the expiry ones only: a supersede is not a compliance
     * event (nothing was executed, nothing lapsed unattended), and the co-sign answers a clear 409 with the reason.
     */
    async expireStaleLabRecoveryRequests(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const at = nowFn();
        const rows = await t
          .update(REQ)
          .set({ status: "expired", resolvedAt: at })
          .where(
            and(
              eq(REQ.organizationId, organizationId),
              eq(REQ.status, "pending_cosign"),
              lte(REQ.expiresAt, at),
            ),
          )
          .returning();
        for (const row of rows) {
          await publishRecoveryAlerts(t, organizationId, row.orderRecordId, [
            buildRecoveryAlert("m11.order.recovery_expired", {
              orderId: row.orderRecordId,
              requestId: row.id,
              requestedByMembershipId: row.requestedByMembershipId,
            }),
          ]);
        }
        const stranded = await t
          .update(REQ)
          .set({
            status: "superseded",
            resolvedAt: at,
            supersededReason: "order_no_longer_recoverable",
          })
          .where(
            and(
              eq(REQ.organizationId, organizationId),
              eq(REQ.status, "pending_cosign"),
              sql`NOT EXISTS (
                SELECT 1 FROM order_record o
                 WHERE o.id = ${REQ.orderRecordId}
                   AND o.organization_id = ${REQ.organizationId}
                   AND o.kind = 'lab'
                   AND o.transmission_status = 'failed'
              )`,
            ),
          )
          .returning({ id: REQ.id });
        return { expired: rows.length, superseded: stranded.length };
      });
    },

    async completeOrder(organizationId, userId, id, _reason, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        await assertInScope(actor, organizationId, r.patientId);
        transitionOrder(r.status, { type: "complete", criterionMet: true });
        const at = new Date();
        await t
          .update(OR)
          .set({ status: "completed", completedAt: at, updatedAt: at })
          .where(eq(OR.id, id));
        await emit(t, organizationId, "m11.order.completed", id, {
          orderId: id,
          completedAt: at.toISOString(),
          kindAutoOrManual: "manual",
        });
        return readOrder(t, id, actor);
      });
    },

    // ── Standing-order reads ─────────────────────────────────────────────────────────────────────────
    async listStandingOrders(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const where = patientId ? eq(SO.patientId, patientId) : undefined;
        const rows = await tx
          .select({
            id: SO.id,
            patientId: SO.patientId,
            admissionId: SO.admissionId,
            kind: SO.kind,
            cadence: SO.cadence,
            status: SO.status,
            nextSpawnAt: SO.nextSpawnAt,
            spawnCount: SO.spawnCount,
            maxSpawns: SO.maxSpawns,
          })
          .from(SO)
          .where(where)
          .orderBy(desc(SO.createdAt));
        return { standingOrders: rows.map(toStandingView) };
      });
    },
    async getStandingOrder(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: SO.id,
            patientId: SO.patientId,
            admissionId: SO.admissionId,
            kind: SO.kind,
            cadence: SO.cadence,
            status: SO.status,
            nextSpawnAt: SO.nextSpawnAt,
            spawnCount: SO.spawnCount,
            maxSpawns: SO.maxSpawns,
          })
          .from(SO)
          .where(eq(SO.id, id))
          .limit(1);
        if (!r) throw new NotFoundError(`standing order ${id} not found`);
        return toStandingView(r);
      });
    },

    // ── Standing-order writes (§2.4 D5) ──────────────────────────────────────────────────────────────
    async createStandingOrder(organizationId, userId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        planStandingCreation({
          kind: args.kind,
          signerDiscipline: args.signerDiscipline,
        }); // §2.4 D5 guards
        const at = new Date();
        const effectiveFrom = args.effectiveFrom ? new Date(args.effectiveFrom) : at;
        const row = firstOrThrow(
          await t
            .insert(SO)
            .values({
              organizationId,
              patientId: args.patientId,
              admissionId: args.admissionId,
              kind: args.kind,
              kindVersion: ORDER_KIND_VERSION[args.kind],
              templateData: args.data ?? {},
              cadence: args.cadence,
              effectiveFrom,
              effectiveUntil: args.effectiveUntil ? new Date(args.effectiveUntil) : null,
              maxSpawns: args.maxSpawns ?? null,
              spawnCount: 0,
              // Scheduled templates must have a cursor from creation; PRN remains null by definition.
              nextSpawnAt: computeNextSpawnAt(args.cadence, {}, effectiveFrom.toISOString())
                ? new Date(computeNextSpawnAt(args.cadence, {}, effectiveFrom.toISOString())!)
                : null,
              orderingPhysicianMdmId: args.orderingPhysicianMdmId,
              signedByMembershipId: userId,
              signerDiscipline: args.signerDiscipline,
              signedAt: at,
              status: "active",
            })
            .returning({
              id: SO.id,
              patientId: SO.patientId,
              admissionId: SO.admissionId,
              kind: SO.kind,
              cadence: SO.cadence,
              status: SO.status,
              nextSpawnAt: SO.nextSpawnAt,
              spawnCount: SO.spawnCount,
              maxSpawns: SO.maxSpawns,
            }),
          "standing_order insert returned no row",
        );
        await emit(t, organizationId, "m11.order.standing_created", row.id, {
          standingOrderId: row.id,
          patientId: args.patientId,
          admissionId: args.admissionId,
          kind: args.kind,
          cadence: args.cadence,
        });
        return toStandingView(row);
      });
    },
    async editStandingOrder(organizationId, id, patch) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [existing] = (await t
          .select()
          .from(SO)
          .where(eq(SO.id, id))
          .limit(1)) as (typeof SO.$inferSelect)[];
        if (!existing) throw new NotFoundError(`standing order ${id} not found`);
        if (
          patch.data !== undefined ||
          patch.effectiveUntil !== undefined ||
          patch.maxSpawns != null
        )
          await t
            .update(SO)
            .set({
              ...(patch.data !== undefined ? { templateData: patch.data } : {}),
              ...(patch.effectiveUntil !== undefined
                ? { effectiveUntil: new Date(patch.effectiveUntil) }
                : {}),
              ...(patch.maxSpawns != null ? { maxSpawns: patch.maxSpawns } : {}),
              updatedAt: new Date(),
            })
            .where(eq(SO.id, id));
        return readStanding(t, id);
      });
    },
    async pauseStandingOrder(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await readStanding(t, id); // 404 if absent/cross-tenant
        await t.update(SO).set({ status: "paused", updatedAt: new Date() }).where(eq(SO.id, id));
        return readStanding(t, id);
      });
    },
    async resumeStandingOrder(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await readStanding(t, id); // 404 if absent/cross-tenant
        await t.update(SO).set({ status: "active", updatedAt: new Date() }).where(eq(SO.id, id));
        return readStanding(t, id);
      });
    },
    async discontinueStandingOrder(organizationId, id, alsoDiscontinueInstances) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await readStanding(t, id); // 404 if absent/cross-tenant
        planStandingDiscontinuation(alsoDiscontinueInstances); // §2.4 — active spawned instances continue (D-loop deferred)
        await t
          .update(SO)
          .set({
            status: "discontinued",
            discontinuedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(SO.id, id));
        await emit(t, organizationId, "m11.order.standing_discontinued", id, {
          standingOrderId: id,
          reason: "template_discontinued",
        });
        return readStanding(t, id);
      });
    },
    async spawnStandingOrder(organizationId, userId, id, requestedTrigger, scheduledFor) {
      const trigger = requestedTrigger ?? "clinician_request";
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [tmpl] = (await t
          .select()
          .from(SO)
          .where(eq(SO.id, id))
          .limit(1)
          .for("update")) as (typeof SO.$inferSelect)[];
        if (!tmpl) throw new NotFoundError(`standing order ${id} not found`);
        if (!tmpl.signerDiscipline || !tmpl.signedByMembershipId)
          throw new ValidationError(
            "Standing-order template signature attribution requires repair",
            [
              {
                field: "signerDiscipline",
                code: "LEGACY_SIGNATURE_ATTRIBUTION_MISSING",
                message:
                  "The signed template predates persisted signer discipline and cannot safely materialize.",
              },
            ],
          );
        if (scheduledFor && tmpl.nextSpawnAt?.toISOString() !== scheduledFor)
          return { orderId: "" }; // another locked worker already consumed this deterministic occurrence
        if (tmpl.status !== "active")
          throw new NotFoundError(
            `standing order ${id} is ${tmpl.status}; only an active template may spawn`,
          );
        assertSpawnAllowed(
          {
            status: tmpl.status,
            isSigned: tmpl.signedAt !== null,
            effectiveFrom: tmpl.effectiveFrom.toISOString(),
            effectiveUntil: tmpl.effectiveUntil?.toISOString() ?? null,
            maxSpawns: tmpl.maxSpawns,
            spawnCount: tmpl.spawnCount,
          },
          new Date().toISOString(),
        );
        const plan = planStandingSpawn({
          kind: tmpl.kind as OrderKind,
          cadence: tmpl.cadence as StandingOrderCadence,
          cadenceDetail: {},
          spawnedBy: trigger,
          now: new Date().toISOString(),
        });
        const findings = validateOrderData(
          tmpl.kind as OrderKind,
          tmpl.kindVersion,
          tmpl.templateData,
        );
        if (findings.length)
          throw new ValidationError(
            "Standing-order template clinical details are invalid",
            findings.map((finding) => ({
              field: `data.${finding.field}`,
              code: "INVALID",
              message: finding.message,
            })),
          );
        const isLab = tmpl.kind === "lab";
        const at = new Date();
        // The spawned order is born `active` (signature inherited from the template anchor, §2.4 D5); the
        // BEFORE lab-initial-states trigger sets its transmission/results states on the active insert.
        const spawned = firstOrThrow(
          await t
            .insert(OR)
            .values({
              organizationId,
              patientId: tmpl.patientId,
              admissionId: tmpl.admissionId,
              kind: tmpl.kind as OrderKind,
              kindVersion: tmpl.kindVersion,
              data: tmpl.templateData,
              priority: "routine",
              status: plan.spawnedOrderStatus,
              version: 1,
              // The worker/requester materializes an already-authorized protocol; the template signer is
              // the clinical author attribution of the active instance.
              drafterMembershipId: tmpl.signedByMembershipId,
              drafterDiscipline: tmpl.signerDiscipline,
              orderingPhysicianMdmId: tmpl.orderingPhysicianMdmId,
              standingOrderId: id,
              cosignRequired: false,
              cosignStatus: "attached",
              transmissionStatus: isLab ? "pending" : "not_required",
              resultsStatus: isLab ? "awaiting_results" : "not_expected",
              signedAt: at,
            })
            .returning({ id: OR.id }),
          "spawned order_record insert returned no row",
        );
        const inst = firstOrThrow(
          await t
            .insert(SOI)
            .values({
              organizationId,
              standingOrderId: id,
              orderRecordId: spawned.id,
              spawnedBy: "clinician_request",
              spawnedByMembershipId: trigger === "clinician_request" ? userId : null,
              scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
            })
            .returning({ id: SOI.id }),
          "standing_order_instance insert returned no row",
        );
        await t
          .update(SO)
          .set({
            spawnCount: tmpl.spawnCount + 1,
            nextSpawnAt: plan.nextSpawnAt ? new Date(plan.nextSpawnAt) : tmpl.nextSpawnAt,
            updatedAt: at,
          })
          .where(eq(SO.id, id));
        await emit(t, organizationId, "m11.order.standing_spawned", spawned.id, {
          standingOrderId: id,
          instanceId: inst.id,
          orderId: spawned.id,
          spawnedBy: trigger,
        });
        // D5's signature is inherited, not re-recorded on each instance.  The template id is therefore
        // deliberately the signature-anchor identifier in this projection event; no synthetic
        // `order_signature` row is created for a spawned order.
        await emit(t, organizationId, "m11.order.signed", spawned.id, {
          orderId: spawned.id,
          kind: tmpl.kind,
          signatureId: id,
          signerMembershipId: tmpl.signedByMembershipId,
          signedAt: (tmpl.signedAt ?? at).toISOString(),
          viaVerbal: false,
        });
        const spawnedRow = await loadOrderRow(t, spawned.id);
        const typedSpawned = await buildRenderPayloadOrOmit(
          "m11",
          logRenderPayload,
          { organizationId, orderId: spawned.id },
          async () => {
            const templateSigner = tmpl.signedByMembershipId;
            if (templateSigner === null)
              throw new RenderPayloadBuildError("order_record", "the standing order has no signer");
            return buildOrderRecordRenderPayload(
              createRenderBuildCtx(t, organizationId),
              spawnedRow,
              {
                signerMembershipId: templateSigner,
                signedAt: tmpl.signedAt ?? at,
                viaVerbal: false,
                inheritedFromStandingOrder: true,
              },
            );
          },
        );
        await emit(t, organizationId, "m11.order.document_requested", spawned.id, {
          orderId: spawned.id,
          formTemplate: "order_record",
          renderPayload: {
            patientId: tmpl.patientId,
            admissionId: tmpl.admissionId,
            kind: tmpl.kind,
            signedAt: (tmpl.signedAt ?? at).toISOString(),
            signerMembershipId: tmpl.signedByMembershipId,
            viaVerbal: false,
            standingOrderId: id,
            ...(typedSpawned ?? {}),
          },
        });
        return { orderId: spawned.id };
      });
    },
    async spawnDueStandingOrders(organizationId, at = new Date().toISOString()) {
      const candidates = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        tx
          .select({ id: SO.id, nextSpawnAt: SO.nextSpawnAt })
          .from(SO)
          .where(and(eq(SO.status, "active"), lte(SO.nextSpawnAt, new Date(at)))),
      );
      const spawnedOrderIds: string[] = [];
      for (const candidate of candidates) {
        if (!candidate.nextSpawnAt) continue;
        try {
          const result = await this.spawnStandingOrder(
            organizationId,
            "",
            candidate.id,
            "system",
            candidate.nextSpawnAt.toISOString(),
          );
          if (result.orderId) spawnedOrderIds.push(result.orderId);
        } catch {
          // Isolate an invalid/legacy template; the next candidate still receives its own RLS transaction.
        }
      }
      return { spawnedOrderIds };
    },

    // ── §2.3 D3 / §4.8 `orders.verbal_timer` — the ONE timer for both M11's own `order_record` verbals
    // AND an M12 `medication_order` verbal recorded through the OrderSignatureProvider seam (§2.8 D14).
    // M12's own spec names this design explicitly: no parallel M12 timer, because `verbal_order.target_kind`
    // already discriminates the row M11's single sweep scans. Each candidate gets its own transaction so one
    // stale/raced row (signed or discontinued between the scan and this tx) never aborts the rest of the
    // org's sweep — the `spawnDueStandingOrders` per-candidate isolation convention immediately above.
    async expireOverdueVerbals(organizationId, at = new Date().toISOString()) {
      const now = new Date(at);
      const candidates = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        tx
          .select({
            id: VO.id,
            targetKind: VO.targetKind,
            targetId: VO.targetId,
            deadlineAt: VO.deadlineAt,
            orderingPhysicianMdmId: VO.orderingPhysicianMdmId,
          })
          .from(VO)
          .where(and(eq(VO.status, "pending"), lte(VO.deadlineAt, now))),
      );
      const expiredVerbalOrderIds: string[] = [];
      for (const candidate of candidates) {
        try {
          const expired = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
            const t = tx as unknown as DbClient;
            const deadlineIso = candidate.deadlineAt.toISOString();
            if (candidate.targetKind === "order") {
              const [r] = await t
                .select({ status: OR.status, version: OR.version })
                .from(OR)
                .where(eq(OR.id, candidate.targetId))
                .limit(1);
              if (!r || r.status !== "verbal_pending") return false; // already resolved elsewhere
              // Validates NOT_SYSTEM_ACTOR / VERBAL_DEADLINE_NOT_REACHED / ILLEGAL_ORDER_TRANSITION before
              // any write — the guard-before-write discipline every other M11 write method follows.
              planVerbalExpiry(at, deadlineIso);
              const updatedOr = await t
                .update(OR)
                .set({
                  status: "expired_unsigned",
                  version: r.version + 1,
                  updatedAt: now,
                })
                .where(and(eq(OR.id, candidate.targetId), eq(OR.status, "verbal_pending")))
                .returning({ id: OR.id });
              if (updatedOr.length === 0) return false; // lost the race
            }
            // For a `medication_order` target M11 has no local row to transition — M12 owns that
            // lifecycle and flips it itself, via `decideVerbalExpiry`, on receiving the event below.
            const updatedVo = await t
              .update(VO)
              .set({ status: "expired_unsigned", expiredAt: now })
              .where(and(eq(VO.id, candidate.id), eq(VO.status, "pending")))
              .returning({ id: VO.id });
            if (updatedVo.length === 0) return false; // lost the race (signed/discontinued in the gap)
            // Audit-symmetry discontinuation row (§2.6), regardless of target kind — `order_discontinuation`
            // is M11-owned and its `target_kind`/`order_record_id` columns already discriminate exactly
            // this way for the seam's own `insertDiscontinuation` (mig 0156); system actor, no membership.
            await t.insert(OD).values({
              organizationId,
              orderRecordId: candidate.targetId,
              targetKind: candidate.targetKind,
              actorMembershipId: null,
              reason: "expired_verbal",
              effectiveAt: now,
            });
            await outbox.publish(t, {
              eventName: "m11.order.verbal_expired_unsigned",
              organizationId,
              aggregateKind: candidate.targetKind,
              aggregateId: candidate.targetId,
              payload: {
                orderId: candidate.targetId,
                verbalOrderId: candidate.id,
                targetKind: candidate.targetKind,
                expiredAt: at,
                hoursOverdue: hoursOverdue(at, deadlineIso),
                orderingPhysicianMdmId: candidate.orderingPhysicianMdmId,
              },
            });
            return true;
          });
          if (expired) expiredVerbalOrderIds.push(candidate.id);
        } catch {
          // Isolate one illegal/raced row; the rest of the org's sweep must still complete.
        }
      }
      return { expiredVerbalOrderIds };
    },

    // ── Verbal-order policy (one row per org; upsert on the per-org unique index) ─────────────────────
    async getVerbalPolicy(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            windowHours: VP.windowHours,
            businessHoursOnly: VP.businessHoursOnly,
            lpnCosignRequiredKinds: VP.lpnCosignRequiredKinds,
            npCosignRequiredKinds: VP.npCosignRequiredKinds,
            platformFloorWindowHours: VP.platformFloorWindowHours,
            policyVersion: VP.policyVersion,
          })
          .from(VP)
          .limit(1);
        if (!r) return DEFAULT_POLICY;
        return {
          windowHours: Number(r.windowHours),
          businessHoursOnly: r.businessHoursOnly,
          lpnCosignRequiredKinds: (r.lpnCosignRequiredKinds as OrderKind[]) ?? [],
          npCosignRequiredKinds: (r.npCosignRequiredKinds as OrderKind[]) ?? [],
          platformFloorWindowHours: Number(r.platformFloorWindowHours),
          policyVersion: r.policyVersion,
        };
      });
    },
    async putVerbalPolicy(organizationId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        validateVerbalWindowHours(args.windowHours); // §2.3 D3 tighten-only floor guard (≤ 48h, ≥ 1h)
        const current = await verbalPolicyOf(t);
        await t
          .insert(VP)
          .values({
            organizationId,
            windowHours: args.windowHours,
            businessHoursOnly: args.businessHoursOnly ?? current.businessHoursOnly,
            lpnCosignRequiredKinds: (args.lpnCosignRequiredKinds ??
              current.lpnCosignRequiredKinds) as OrderKind[],
            npCosignRequiredKinds: (args.npCosignRequiredKinds ??
              current.npCosignRequiredKinds) as OrderKind[],
            platformFloorWindowHours: 48,
            policyVersion: current.policyVersion,
          })
          .onConflictDoUpdate({
            target: VP.organizationId,
            set: {
              windowHours: args.windowHours,
              businessHoursOnly: args.businessHoursOnly ?? current.businessHoursOnly,
              lpnCosignRequiredKinds: (args.lpnCosignRequiredKinds ??
                current.lpnCosignRequiredKinds) as OrderKind[],
              npCosignRequiredKinds: (args.npCosignRequiredKinds ??
                current.npCosignRequiredKinds) as OrderKind[],
              updatedAt: new Date(),
            },
          });
        return readPolicy(t);
      });
    },
    async regenerateVerbalTimer(organizationId, id, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        if (r.status !== "verbal_pending")
          throw new NotFoundError(`order ${id} is not verbal_pending`);
        const [v] = (await t
          .select({
            id: VO.id,
            orderingPhysicianMdmId: VO.orderingPhysicianMdmId,
            recordingMembershipId: VO.recordingMembershipId,
          })
          .from(VO)
          .where(and(eq(VO.targetKind, "order"), eq(VO.targetId, id)))
          .limit(1)) as {
          id: string;
          orderingPhysicianMdmId: string;
          recordingMembershipId: string;
        }[];
        if (!v) throw new NotFoundError(`order ${id} has no verbal-order receipt`);
        const policy = await verbalPolicyOf(t);
        const deadlineIso = computeVerbalDeadline(new Date().toISOString(), {
          windowHours: policy.windowHours,
          businessHoursOnly: policy.businessHoursOnly,
          policyVersion: policy.policyVersion,
        });
        await t
          .update(VO)
          .set({ deadlineAt: new Date(deadlineIso) })
          .where(eq(VO.id, v.id));
        await emit(t, organizationId, "m11.order.verbal_received", id, {
          orderId: id,
          verbalOrderId: v.id,
          deadlineAt: deadlineIso,
          orderingPhysicianMdmId: v.orderingPhysicianMdmId,
          recordingMembershipId: v.recordingMembershipId,
        });
        return readOrder(t, id, actor);
      });
    },

    // ── §4.7 ABAC resolver (loadOrder) — org-scoped, RLS-backstopped; null fails the predicate closed ──
    async loadOrder(organizationId, orderId): Promise<OrderAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            patientId: OR.patientId,
            kind: OR.kind,
            drafterMembershipId: OR.drafterMembershipId,
            drafterDiscipline: OR.drafterDiscipline,
            cosignRequired: OR.cosignRequired,
            cosignStatus: OR.cosignStatus,
          })
          .from(OR)
          .where(eq(OR.id, orderId))
          .limit(1);
        if (!r) return null;
        // Re-derive the resolved cosigner axis from the persisted facts (order_record has no explicit
        // column): the LPN axis demands an RN, the escalation-jump / NP axes demand a medical_director.
        const cosignerRoleNeeded = r.cosignRequired
          ? lpnCosignRequired(r.drafterDiscipline, r.kind as OrderKind)
            ? "rn_case_manager"
            : "medical_director"
          : null;
        return {
          patientId: r.patientId,
          kind: r.kind as OrderKind,
          drafterMembershipId: r.drafterMembershipId,
          cosignerRoleNeeded,
          cosignRequired: r.cosignRequired,
          alreadyCosigned: r.cosignStatus === "attached",
        };
      });
    },

    // No events are buffered in-process (the transactional outbox persists them); drain is a no-op.
    drainEvents: () => [],
  };
}
