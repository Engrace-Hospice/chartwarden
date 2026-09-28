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
// exact TypeBox `packages/orders/src/kinds.ts` uses); `hl7_orm_requested`'s full `OrmRequestedPayload`
// needs patient demographics + a resolved M40 provider identity M11 does not hold, so lab stays unbound —
// M29's outbound ORM worker is still Wave H (see events-by-m11.ts). The returned object IS BOTH the
// OrderRouteService AND the §4.7 AbacResolver.
import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_COSIGN_POLICY,
  ORDER_KIND_VERSION,
  type OrderCosignPolicy,
  assertSpawnAllowed,
  computeNextSpawnAt,
  computeVerbalDeadline,
  disciplineCanOrder,
  lpnCosignRequired,
  planCosignAttest,
  planStandingCreation,
  planStandingDiscontinuation,
  planStandingSpawn,
  resolveCosignRequirement,
  signerEligible,
  transitionOrder,
  validateOrderData,
  validateVerbalWindowHours,
} from "@wardenx/orders";
import { withOrgContext } from "@wardenx/tenancy";
import {
  NotFoundError,
  type OrderDiscontinuationReason,
  type OrderKind,
  type OrderPriority,
  type OrderStatus,
  type StandingOrderCadence,
  type StandingOrderStatus,
} from "@wardenx/types";
import { ValidationError } from "@wardenx/types";
import { type SQL, and, desc, eq, lte } from "drizzle-orm";
import { EMPTY_ORDER_DETAIL_ACTOR, buildOrderWorkflowProjection } from "./routes/service";
import type {
  CreateOrderArgs,
  OrderAbacFacts,
  OrderDetailActor,
  OrderDetailView,
  OrderRouteService,
  OrderView,
  StandingOrderView,
  VerbalPolicyView,
} from "./routes/service";

const OR = schema.orderRecords;
const SO = schema.standingOrders;
const SOI = schema.standingOrderInstances;
const OS = schema.orderSignatures;
const VO = schema.verbalOrders;
const VP = schema.orderVerbalPolicies;
const OD = schema.orderDiscontinuations;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

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
    { ...toOrderView(r), kindVersion: r.kindVersion, data: r.data },
    actor,
    cosignerRoleNeeded,
  ),
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
): OrderRouteService {
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

  const listWhere = (
    organizationId: string,
    extra: SQL | undefined,
  ): Promise<{ orders: OrderView[] }> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = (await selectOrders(tx as DbClient, extra)) as unknown as OrderRow[];
      return { orders: rows.map(toOrderView) };
    });

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
    return toOrderDetailView(row, actor, needed);
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
    const isLab = args.kind === "lab";
    const row = firstOrThrow(
      await tx
        .insert(OR)
        .values({
          organizationId,
          patientId: args.patientId,
          admissionId: args.admissionId,
          kind: args.kind,
          kindVersion: `${args.kind}.v1`,
          data: args.data ?? {},
          priority: args.priority ?? "routine",
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
   * from data M11 already holds are wired: `lab` stays unbound (`OrmRequestedPayload` needs patient
   * demographics + a resolved M40 provider identity M11 does not have — M29's Wave H outbound worker).
   */
  async function emitDownstreamSignedEvent(
    tx: DbClient,
    organizationId: string,
    orderId: string,
    kind: OrderKind,
    admissionId: string,
    data: unknown,
  ): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    if (kind === "level_of_care_change") {
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
    const r = await loadOrderRow(tx, id);
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
    async listOrders(organizationId, filter) {
      const conds: SQL[] = [];
      if (filter.patientId) conds.push(eq(OR.patientId, filter.patientId));
      if (filter.admissionId) conds.push(eq(OR.admissionId, filter.admissionId));
      if (filter.kind) conds.push(eq(OR.kind, filter.kind as OrderKind));
      if (filter.status) conds.push(eq(OR.status, filter.status as OrderStatus));
      return listWhere(organizationId, conds.length ? and(...conds) : undefined);
    },
    async getOrder(organizationId, id, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        return readOrder(tx as DbClient, id, actor);
      });
    },
    async pendingSignature(organizationId) {
      return listWhere(organizationId, eq(OR.status, "pending_signature"));
    },
    async verbalExpiring(organizationId) {
      return listWhere(organizationId, eq(OR.status, "verbal_pending"));
    },
    async cosignPending(organizationId) {
      return listWhere(organizationId, eq(OR.cosignStatus, "pending"));
    },
    async resultsPendingReview(organizationId) {
      return listWhere(
        organizationId,
        and(eq(OR.kind, "lab"), eq(OR.resultsStatus, "results_received")),
      );
    },
    async suggestions(_organizationId, patientId) {
      // §2.7 assessment/HOPE order suggestions are event-driven projections owed to the consumers track.
      return { patientId, suggestions: [] };
    },

    // ── Order writes (§2.2 lifecycle; the DB triggers do the state transitions) ──────────────────────
    async createDraft(organizationId, userId, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const id = await insertDraft(t, organizationId, userId, args, args.replacesOrderId ?? null);
        return readOrder(t, id, actor);
      });
    },

    async createVerbalOrder(organizationId, userId, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
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
          signerDiscipline: args.order.drafterDiscipline,
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
          recorderEligible: true,
        });
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

    async editDraft(organizationId, id, data, priority, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
        if (r.status !== "draft")
          throw new NotFoundError(`order ${id} is not a draft and cannot be edited`);
        await t
          .update(OR)
          .set({
            data: data ?? {},
            priority: priority ?? r.priority,
            version: r.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(OR.id, id));
        return readOrder(t, id, actor);
      });
    },

    async requestSignature(organizationId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
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
          signerDiscipline: args.signerDiscipline,
          levelChange: args.levelChange,
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
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
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
          recorderEligible: true,
        });
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
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadOrderRow(t, id); // 404 if the original is cross-tenant/absent
        const findings = validateOrderData(args.kind, ORDER_KIND_VERSION[args.kind], args.data);
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

    async completeOrder(organizationId, userId, id, _reason, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadOrderRow(t, id);
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
