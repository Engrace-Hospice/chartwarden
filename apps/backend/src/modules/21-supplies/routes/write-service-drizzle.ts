import { createHash } from "node:crypto";
// apps/backend/src/modules/21-supplies/routes/write-service-drizzle.ts — the Drizzle-backed M21 WRITE
// service (§4.1's POST/PUT/DELETE rows).
//
// Shape of EVERY command: open `withOrgContext` (RLS pins app.org_id) → load the aggregate row → run the
// PURE §2.2–§2.7 decision (`../lifecycle`) over already-resolved facts → execute the transition's DECLARED
// side effects (`./effects-runner`) and apply the row change under the §7.2 optimistic-concurrency guard →
// emit the §4.5.2 outbox event on the SAME tx. No business rule lives in SQL, and no event can outlive a
// rolled-back write (§2.11).
//
// FIVE decisions that are load-bearing and easy to get wrong:
//
//   1. THE D4 ROUTING RESOLUTION IS FROZEN AT CREATE, NOT AT `vendor_assigned`. §2.2's `assignVendor` edge
//      is where the machine declares `freeze_routing`, and this service resolves the ladder at creation so
//      the response can tell the coordinator which vendor is about to get the order (§4.2.1's
//      `routingRuleResolved` field). The resolution is written to the column ONLY on the transition — a
//      request in `requested` carries no frozen record, exactly as the §3.1.7 CHECK requires.
//   2. THE M40 VENDOR CHECK IS A SEAM READ THAT FAILS CLOSED. §2.2's `assignVendor` guard takes
//      `vendorActive: boolean | null`, and `null` is only legal when the resolution names no vendor. An
//      unbound or throwing `MdmEntityProvider` therefore yields `false` — the assignment is refused with
//      `M21_VENDOR_NOT_ACTIVE`. Sending a hospital bed to a vendor whose contract lapsed is a bill the
//      agency cannot collect on and a delivery the patient may never get. Like the §4.4 dispatcher probe,
//      it is resolved BEFORE the transaction opens: both read through their own org context, and issuing
//      either from inside our transaction would hold one pooled connection while waiting for a second.
//   3. `createDispatch` DECREMENTS PAR IN THE SAME TRANSACTION. §2.5 makes an insufficient shelf a
//      dispatch-BLOCKING failure, so the decrement runs before the insert and its refusal rolls the whole
//      thing back. A kit that "shipped" off an empty shelf is a controlled-substance record of a movement
//      that did not happen.
//   4. THE M22 HANDOFF IS OUTBOX-ONLY, BOTH WAYS. A dispatch emits `document_requested` with
//      `documentKind: 'bill_of_lading'`; a reconciliation emits it with `'return_receipt'` (the DEA-1304
//      format receipt). M21 renders no PDF and imports no M22 schema; `document_id` /
//      `receipt_document_id` stay null until M22 answers with `m22.document.rendered`.
//   5. EVERY QUANTITY IS A DECIMAL STRING END TO END. The columns are `numeric`, the D8 math is Decimal,
//      and the wire types are strings. Nothing in this file parses a quantity into a JS number except the
//      one place `@wardenx/supplies` already does it for a positivity check.
import { type DbClient, schema } from "@wardenx/db";
import {
  COMFORT_KIT_PLATFORM_FLOOR,
  RETURN_WINDOW_HOURS_DEFAULT,
  ROUTING_RESOLVER_VERSION,
  type RoutingRuleCandidate,
  resolveVendorRouting,
  validateSupplyRequestData,
} from "@wardenx/supplies";
import { getRequestContext, withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@wardenx/types";
import type {
  ComfortKitDispatchedContentPayload,
  CreateDirectSupplyRequestInput,
  IsoInstant,
  M21EventName,
  RoutingRuleResolved,
} from "@wardenx/types";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  SupplyStateError,
  applyParStockMovement,
  assertCaregiverSignatureCaptureAllowed,
  assertDispatchLocationMatchesRequest,
  assertParThresholdsOrdered,
  assertTemplateEffective,
  authorTenantTemplate,
  caregiverSignatureEvidenceJsonbOf,
  decideCoverageDetermination,
  prepareDispatch,
  reconcileReturn,
  requireCaregiverSignatureEvidence,
  supersedeTemplate,
  transitionComfortKitDispatch,
  transitionComfortKitReturn,
  transitionSupplyRequest,
  verifyRequestServingLocation,
} from "../lifecycle/index";
import { getAdmissionStatusReader } from "../seams/index";
import type { M21WriteActor } from "./actor";
import { type EffectPatch, runEffects } from "./effects-runner";
import type { M21ReadService } from "./read-service";
import type {
  AlertPort,
  AssignRetrieverInput,
  AssignVendorInput,
  CancelRequestInput,
  CaptureCaregiverSignatureInput,
  ConfirmReceivedInput,
  CreateDispatchInput,
  CreateReturnInput,
  CreateSupplyItemInput,
  CreateSupplyRequestInput,
  CreateSupplyRequestResult,
  CreateTemplateInput,
  DeclareUnreturnableInput,
  DeployAtPatientInput,
  M21WriteService,
  MarkDeliveredInput,
  MarkInTransitInput,
  MarkOrderedInput,
  ObserveParStockInput,
  ReconcileReturnInput,
  ReconcileReturnResult,
  RetireSupplyItemInput,
  ReturnRequestInput,
  SetCoverageDeterminationInput,
  SupersedeTemplateInput,
  UpdateParStockInput,
  UpsertRoutingRuleInput,
  UpsertTenantSupplyItemInput,
  WriteOutboxPort,
} from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value ?? {}))
    .digest("hex");

/**
 * Apply an {@link EffectPatch} to `supply_request`, stamping `updated_at` from the tx clock.
 *
 * Module-level (not closed over `buildDrizzleM21WriteService`'s deps) so the §4.5.1 M11 cascade outbox
 * consumers (`outbox-consumers/m11-order-cascade.ts`) can apply the SAME `transitionSupplyRequest` +
 * `runEffects` write path a route does, rather than a second hand-rolled UPDATE that could drift from it —
 * the F-100/F-103 "two write paths for one table" lesson this document has paid for repeatedly.
 */
export async function patchSupplyRequest(
  tx: Tx,
  id: string,
  status: string,
  patch: EffectPatch,
  at: Date,
): Promise<void> {
  const REQUEST = schema.supplyRequest;
  await tx
    .update(REQUEST)
    .set({
      status: status as typeof REQUEST.$inferInsert.status,
      updatedAt: at,
      ...(patch.orderedAt !== undefined ? { orderedAt: patch.orderedAt } : {}),
      ...(patch.shippedAt !== undefined ? { shippedAt: patch.shippedAt } : {}),
      ...(patch.deliveredAt !== undefined ? { deliveredAt: patch.deliveredAt } : {}),
      ...(patch.receivedConfirmedAt !== undefined
        ? { receivedConfirmedAt: patch.receivedConfirmedAt }
        : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}),
      ...(patch.cancellationPendingAt !== undefined
        ? { cancellationPendingAt: patch.cancellationPendingAt }
        : {}),
      ...(patch.cancellationReason !== undefined
        ? { cancellationReason: patch.cancellationReason }
        : {}),
      ...(patch.routingRuleResolvedJsonb !== undefined
        ? { routingRuleResolvedJsonb: patch.routingRuleResolvedJsonb }
        : {}),
      ...(patch.assignedVendorId !== undefined ? { assignedVendorId: patch.assignedVendorId } : {}),
      ...(patch.vendorOrderReference !== undefined
        ? { vendorOrderReference: patch.vendorOrderReference }
        : {}),
      ...(patch.trackingNumber !== undefined ? { trackingNumber: patch.trackingNumber } : {}),
      ...(patch.carrier !== undefined ? { carrier: patch.carrier } : {}),
      ...(patch.deliveredByMembershipId !== undefined
        ? { deliveredByMembershipId: patch.deliveredByMembershipId }
        : {}),
      ...(patch.deliveryMethod !== undefined
        ? { deliveryMethod: patch.deliveryMethod as typeof REQUEST.$inferInsert.deliveryMethod }
        : {}),
      ...(patch.deliveryEvidenceDocumentId !== undefined
        ? { deliveryEvidenceDocumentId: patch.deliveryEvidenceDocumentId }
        : {}),
      ...(patch.receivedConfirmedActor !== undefined
        ? { receivedConfirmedActor: patch.receivedConfirmedActor }
        : {}),
    })
    .where(eq(REQUEST.id, id));
}

/** The §4.5.2 tenancy block every per-patient `m21.*` payload repeats.
 *
 * Module-level (not closed over `buildDrizzleM21WriteService`'s deps) for the same reason as
 * {@link patchSupplyRequest}: a §4.5.1 outbox consumer that never opens the write service needs the exact
 * same anchor shape a route builds, and a second hand-rolled projection is how the two drift.
 */
export const anchorOf = (row: {
  organizationId: string;
  patientId: string;
  admissionId: string;
  providerEntityId: string;
  locationId: string;
}) => ({
  orgId: row.organizationId,
  patientId: row.patientId,
  admissionId: row.admissionId,
  providerEntityId: row.providerEntityId,
  locationId: row.locationId,
});

/** The `skuClass` the D4 ladder matches on: the HCPCS family for a goods request, `comfort_kit` for a kit. */
function skuClassOf(kind: string, data: Record<string, unknown>): string {
  if (kind === "comfort_kit_deploy" || kind === "comfort_kit_replenish") return "comfort_kit";
  const hcpcs = typeof data.hcpcs === "string" ? data.hcpcs : "";
  return hcpcs.length > 0 ? hcpcs.slice(0, 1) : "internal";
}

/** The `skuId` the D4 per-SKU pin matches on (kits have none — they route on the kit class). */
function skuIdOf(data: Record<string, unknown>): string | null {
  const direct = data.supplyItemId;
  if (typeof direct === "string") return direct;
  const lines = data.lineItems;
  if (Array.isArray(lines) && lines.length > 0) {
    const first = lines[0] as Record<string, unknown>;
    if (typeof first?.supplyItemId === "string") return first.supplyItemId;
  }
  return null;
}

/**
 * D4 — resolve the routing ladder for a request. Reads every candidate rule (RLS gives the tenant's own
 * plus the platform-scope ones), runs the PURE precedence walk, and returns the immutable record with its
 * full roads-not-taken trace. A no-match is NOT an error here: §3.1.7 only requires the resolution to be
 * frozen before the row leaves `requested`, and a tenant that has not configured a rule needs to see the
 * empty trace on the request rather than a 500 at intake.
 *
 * Module-level for the same reason as {@link insertSupplyRequest} below, which is its only caller outside
 * `buildDrizzleM21WriteService`'s own `assignVendor`.
 */
async function resolveRouting(
  tx: Tx,
  input: {
    orgId: string;
    locationId: string;
    skuId: string | null;
    skuClass: string;
    at: Date;
  },
): Promise<RoutingRuleResolved> {
  const RULE = schema.vendorRoutingRule;
  const rows = await tx.select().from(RULE).where(eq(RULE.isActive, true));
  const candidates: RoutingRuleCandidate[] = rows.map((r) => ({
    ruleId: r.id,
    scopeKind: r.scopeKind,
    scopeId: r.scopeId ?? null,
    skuClassPattern: r.skuClassPattern ?? null,
    assignedVendorId: r.assignedVendorId ?? null,
    assignedFulfillmentMode: r.assignedFulfillmentMode,
    defaultPharmacyDispatchMode: r.defaultPharmacyDispatchMode ?? null,
    precedencePriority: r.precedencePriority,
    isActive: r.isActive,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
  }));
  const resolution = resolveVendorRouting(candidates, {
    orgId: input.orgId,
    locationId: input.locationId,
    skuId: input.skuId,
    skuClass: input.skuClass,
    resolvedAt: input.at,
    // The digest covers the RULE SET as evaluated, so a survey can prove the same inputs produce the
    // same answer years later even after every rule has been rewritten.
    routingPolicyDigest: sha256({ version: ROUTING_RESOLVER_VERSION, candidates }),
  });
  return resolution.resolved;
}

/**
 * The shared creation path — a route, an M11 cascade and the §4.8 seam all land here (see the service
 * port's `createDirect` doc-comment for why), and — as of the §2.1 replenishment-intake bind (F-153/#248's
 * m21 group) — an M13 `outbox-consumers` cascade too. `emitCreatedFromExternal` is the ONE behavioural
 * difference: §7.1 acceptance 3 is explicit that the M11 cascade must not emit it, and the same reasoning
 * applies to any system-actor cascade (M13's replenishment intake included) — `created_from_external`'s own
 * payload requires a real `createdByMembershipId`, which a cascade with no acting human cannot honestly
 * supply.
 *
 * Module-level (not closed over `buildDrizzleM21WriteService`'s deps) so a §4.5.1 outbox consumer can run
 * the SAME creation path a route runs, rather than a second hand-rolled INSERT that could drift from it —
 * the `patchSupplyRequest` / F-102 precedent this file already applies to the update side.
 */
export async function insertSupplyRequest(
  tx: Tx,
  outbox: WriteOutboxPort,
  input: {
    organizationId: string;
    patientId: string;
    admissionId: string;
    locationId: string;
    providerEntityId: string;
    kind: string;
    data: Record<string, unknown>;
    sourceOrderId: string | null;
    sourceReplenishmentEventId: string | null;
    requestedByMembershipId: string | null;
    deliveryInstructions: string | null;
    at: Date;
    emitCreatedFromExternal: boolean;
  },
): Promise<{ id: string; routingRuleResolved: RoutingRuleResolved; updatedAt: Date }> {
  const REQUEST = schema.supplyRequest;
  // D1 — the per-kind payload is validated against `@wardenx/supplies`'s TypeBox + the §2.10 cross-field
  // rules TypeBox cannot state. ONE validator: the route boundary asserts only the discriminator.
  const validation = validateSupplyRequestData(
    input.kind as Parameters<typeof validateSupplyRequestData>[0],
    input.data,
  );
  if (!validation.ok) {
    throw new ValidationError(
      "the supply-request payload does not satisfy its kind schema",
      validation.violations.map((v) => ({
        field: v.path,
        code: "INVALID",
        message: v.message,
      })),
    );
  }

  const routingRuleResolved = await resolveRouting(tx, {
    orgId: input.organizationId,
    locationId: input.locationId,
    skuId: skuIdOf(input.data),
    skuClass: skuClassOf(input.kind, input.data),
    at: input.at,
  });

  const [row] = await tx
    .insert(REQUEST)
    .values({
      organizationId: input.organizationId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      locationId: input.locationId,
      providerEntityId: input.providerEntityId,
      sourceOrderId: input.sourceOrderId,
      sourceReplenishmentEventId: input.sourceReplenishmentEventId,
      requestedByMembershipId: input.requestedByMembershipId,
      kind: input.kind as typeof REQUEST.$inferInsert.kind,
      data: input.data,
      status: "requested",
      deliveryInstructions: input.deliveryInstructions,
      // Rule 1 — the frozen record is written at `vendor_assigned`, never at intake. §3.1.7's CHECK only
      // requires it once the row LEAVES `requested`, and writing it here would claim a decision the
      // coordinator has not made yet.
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning();
  if (!row) throw new ConflictError("supply_request insert produced no row");

  const anchor = anchorOf(row);
  await outbox.publish(tx, {
    eventName: "m21.supply_request.status_changed",
    payload: {
      ...anchor,
      supplyRequestId: row.id,
      kind: row.kind,
      sourceOrderId: row.sourceOrderId ?? null,
      // §7.1 acceptance 4 — `fromStatus` is null on the intake insert.
      fromStatus: null,
      toStatus: row.status,
      occurredAt: iso(input.at),
    },
    organizationId: input.organizationId,
    aggregateKind: "supply_request",
    aggregateId: row.id,
  });
  if (input.emitCreatedFromExternal) {
    await outbox.publish(tx, {
      eventName: "m21.supply_request.created_from_external",
      payload: {
        ...anchor,
        supplyRequestId: row.id,
        kind: row.kind,
        createdByMembershipId: input.requestedByMembershipId ?? "",
        occurredAt: iso(input.at),
      },
      organizationId: input.organizationId,
      aggregateKind: "supply_request",
      aggregateId: row.id,
    });
  }
  return { id: row.id, routingRuleResolved, updatedAt: row.updatedAt };
}

/** RxNorm → the D3 floor key that line satisfies, or null for a tenant ADDITION. */
const FLOOR_KEY_BY_RXNORM = new Map(
  COMFORT_KIT_PLATFORM_FLOOR.map((m) => [m.rxNorm, m.key] as const),
);

/**
 * Project a submitted template line onto the shape `validateTenantTemplate` decides over.
 *
 * The `floorKey` is matched on RXNORM, not on the drug name: a tenant that writes "Morphine Sulfate
 * Solution 20mg/ml" must still be recognised as carrying the floor's morphine line, and a name comparison
 * would let a typo silently turn a floor medication into an unconstrained tenant addition — which is the
 * exact hole D3 exists to close (the floor check would then pass on a kit with no morphine in it).
 */
const floorLineOf = (m: {
  readonly rxnorm: string;
  readonly drugName: string;
  readonly isControlledSubstance: boolean;
  readonly expectedQuantity: string;
  readonly replenishmentThresholdPct?: string;
}) => ({
  floorKey: FLOOR_KEY_BY_RXNORM.get(m.rxnorm) ?? null,
  drugName: m.drugName,
  isControlledSubstance: m.isControlledSubstance,
  expectedQuantity: Number(m.expectedQuantity),
  replenishmentThresholdPct: Number(m.replenishmentThresholdPct ?? "0.25"),
});

/** The §4.4 probe the §2.5 dispatch validation re-runs inside the transaction (see rule 2 in guards.ts). */
export type DispatcherEligibilityProbe = (input: {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly locationId: string;
}) => Promise<boolean>;

/** The M40 vendor-activity probe. Unbound / throwing ⇒ `false` ⇒ the assignment is refused (rule 2). */
export type VendorActiveProbe = (input: {
  readonly organizationId: string;
  readonly vendorId: string;
}) => Promise<boolean>;

/** Deps the composition root binds. */
export interface M21WriteDeps {
  readonly outbox?: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly now?: () => Date;
  /**
   * §4.4 — is this membership a controlled-substance dispatcher for this Location? Defaults to a probe
   * that DENIES: an unbound authority check must not be read as "everyone may move a CII solution".
   */
  readonly dispatcherEligible?: DispatcherEligibilityProbe;
  /** M40 `DmeVendor` activity. Defaults to a probe that DENIES (rule 2). */
  readonly vendorActive?: VendorActiveProbe;
  /** §2.6 — the tenant's (possibly tightened) return window, in hours. */
  readonly returnWindowHours?: number;
}

/** The kinds that move a scheduled drug — the §4.1 row-1 conditional ABAC cell, re-checked in the service. */
const KIT_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "comfort_kit_deploy",
  "comfort_kit_replenish",
]);

export function buildDrizzleM21WriteService(
  db: DbClient,
  readService: M21ReadService,
  deps: M21WriteDeps = {},
): M21WriteService {
  const REQUEST = schema.supplyRequest;
  const ITEM = schema.supplyItem;
  const TENANT_ITEM = schema.tenantSupplyItemExtension;
  const TEMPLATE = schema.comfortKitTemplate;
  const TEMPLATE_MED = schema.comfortKitTemplateMedication;
  const DISPATCH = schema.comfortKitDispatch;
  const DISPATCHED = schema.comfortKitDispatchedContent;
  const RETURN = schema.comfortKitReturn;
  const RETURNED = schema.comfortKitReturnedContent;
  const RULE = schema.vendorRoutingRule;
  const PAR = schema.parStock;

  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const now = deps.now ?? (() => new Date());
  const returnWindowHours = deps.returnWindowHours ?? RETURN_WINDOW_HOURS_DEFAULT;
  // Fail-CLOSED defaults — see rule 2 and the `dispatcherEligible` doc-comment.
  const dispatcherEligible: DispatcherEligibilityProbe =
    deps.dispatcherEligible ?? (async () => false);
  const vendorActive: VendorActiveProbe = deps.vendorActive ?? (async () => false);

  const scoped = <T>(
    actor: { organizationId: string; userId: string },
    fn: (tx: Tx) => Promise<T>,
  ) => withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);

  /**
   * §7.2 / §7.3 — refuse a transition whose caller read a different row than the one it is about to write.
   * The stamp is the row's `updated_at` in ISO form (see routes/concurrency.ts for why there is no version
   * column). An ABSENT expectation is permitted here because the ROUTE decides which transitions require
   * `If-Match`; this function only enforces a mismatch it was given.
   */
  function assertFresh(row: { updatedAt: Date }, expected: string | undefined): void {
    if (expected === undefined) return;
    if (iso(row.updatedAt) !== iso(expected)) {
      throw new SupplyStateError(
        "M21_STALE_VERSION",
        `this row changed since you read it (current updated_at ${iso(row.updatedAt)})`,
      );
    }
  }

  /** Load one supply request or 404 (RLS already scoped the read). */
  async function loadRequest(tx: Tx, id: string) {
    const [row] = await tx.select().from(REQUEST).where(eq(REQUEST.id, id)).limit(1);
    if (!row) throw new NotFoundError("supply_request");
    return row;
  }

  /** Apply an {@link EffectPatch} to `supply_request`, stamping `updated_at` from the tx clock. */
  const patchRequest = (tx: Tx, id: string, status: string, patch: EffectPatch, at: Date) =>
    patchSupplyRequest(tx, id, status, patch, at);

  /**
   * Resolve the M6 provider entity for a patient's admission. M21's PHI tables carry
   * `provider_entity_id` NOT NULL (supply cost rolls per CCN to the M27 cost report), and M21 never reads
   * M6's schema — the fact comes through the boot-registered `AdmissionStatusReader` seam.
   *
   * An unresolvable admission is a REFUSAL, not a default. Guessing a CCN would put this request's spend
   * on another provider entity's cost report, which is a filing error nobody would ever notice.
   */
  async function providerEntityFor(organizationId: string, admissionId: string): Promise<string> {
    try {
      const summary = await getAdmissionStatusReader().getAdmissionSummary(
        organizationId,
        admissionId as never,
      );
      const providerEntityId = (summary as { providerEntityId?: string } | null)?.providerEntityId;
      if (typeof providerEntityId === "string" && providerEntityId.length > 0) {
        return providerEntityId;
      }
    } catch {
      // fall through to the refusal
    }
    throw new SupplyStateError(
      "M21_SERVING_LOCATION_UNRESOLVED",
      `no provider entity resolved for admission ${admissionId}; a supply request cannot be anchored to a CCN by guess`,
    );
  }

  /**
   * GAP-064 — the serving Location M6 holds for an admission (null when unsited / unreadable). Read through
   * the same `AdmissionStatusReader` seam as the provider entity; a failure is "no server fact", which the
   * verifier turns into a refusal rather than a trust-the-body fallback.
   */
  async function admissionLocationFor(
    organizationId: string,
    admissionId: string,
  ): Promise<string | null> {
    try {
      const siting = await getAdmissionStatusReader().getAdmissionSiting(
        organizationId,
        admissionId as never,
      );
      return siting?.locationId ?? null;
    } catch {
      return null;
    }
  }

  /** Run one §2.2 transition end to end (load → decide → effects → patch → return the fresh detail). */
  async function runRequestTransition(
    actor: M21WriteActor,
    supplyRequestId: string,
    expectedUpdatedAt: string | undefined,
    build: (
      row: typeof REQUEST.$inferSelect,
      at: Date,
      tx: Tx,
    ) => Promise<{
      event: Parameters<typeof transitionSupplyRequest>[2];
      payloads: Partial<Record<M21EventName, Record<string, unknown>>>;
    }>,
  ) {
    const at = now();
    await scoped(actor, async (tx) => {
      const row = await loadRequest(tx, supplyRequestId);
      assertFresh(row, expectedUpdatedAt);
      // `tx` is threaded in so a builder that needs a read (assignVendor re-resolves the D4 ladder) runs it
      // on the OPEN transaction. Opening a second `withOrgContext` inside this one would take a second
      // pooled connection while holding the first — a self-deadlock under any real concurrency.
      const { event, payloads } = await build(row, at, tx);
      const transition = transitionSupplyRequest(row.status, row.kind, event);
      const anchor = anchorOf(row);
      const patch = await runEffects(tx, transition.effects, {
        organizationId: actor.organizationId,
        at,
        outbox,
        alerts: deps.alerts,
        aggregateKind: "supply_request",
        aggregateId: row.id,
        payloads: {
          "m21.supply_request.status_changed": {
            ...anchor,
            supplyRequestId: row.id,
            kind: row.kind,
            sourceOrderId: row.sourceOrderId ?? null,
            fromStatus: transition.from,
            toStatus: transition.to,
            occurredAt: iso(at),
          },
          ...payloads,
        },
      });
      await patchRequest(tx, row.id, transition.to, patch, at);
    });
    return readService.getSupplyRequest(actor, supplyRequestId);
  }

  return {
    // ── §2.2 supply-request lifecycle ─────────────────────────────────────────────────────────────
    async createSupplyRequest(actor, input): Promise<CreateSupplyRequestResult> {
      const at = now();
      const providerEntityId = await providerEntityFor(actor.organizationId, input.admissionId);
      // GAP-064 — the body's Location is a claim: verify it against the admission's siting (or, for an
      // unsited admission, the actor's own Locations) and anchor the row to the VERIFIED value only.
      const servingLocationId = verifyRequestServingLocation({
        bodyLocationId: input.locationId,
        admissionLocationId: await admissionLocationFor(actor.organizationId, input.admissionId),
        actorLocationIds: actor.locationIds,
      });
      // A kit request moves a scheduled drug: re-check the §4.4 authority here (service layer — the
      // route's preHandler is the early refusal, this is the authority) over the VERIFIED Location.
      if (KIT_REQUEST_KINDS.has(input.kindPayload.kind)) {
        const eligible = await dispatcherEligible({
          organizationId: actor.organizationId,
          membershipId: actor.membershipId,
          locationId: servingLocationId,
        }).catch(() => false);
        if (!eligible) {
          throw new SupplyStateError(
            "M21_CONTROLLED_SUBSTANCE_DISPATCHER_DENIED",
            "the actor is not a controlled-substance dispatcher for this admission's serving Location",
          );
        }
      }
      const created = await scoped(actor, (tx) =>
        insertSupplyRequest(tx, outbox, {
          organizationId: actor.organizationId,
          patientId: input.patientId,
          admissionId: input.admissionId,
          locationId: servingLocationId,
          providerEntityId,
          kind: input.kindPayload.kind,
          // The D7 delivery-address snapshot rides inside `data` (§3.1.7 has no address columns): the
          // address at the time of the request must survive a later patient move. `kind` is the route-level
          // discriminator, not part of any per-kind `SUPPLY_REQUEST_DATA_SCHEMAS` shape (all declare
          // `additionalProperties: false`), so it must not leak into `data` alongside it. The per-kind
          // schemas require `PatientAddressSnapshotSchema` (adds `capturedAt`/`county` over the route body's
          // plain `deliveryAddress`); `capturedAt` is stamped here, server-side, at the moment of the write.
          data: (() => {
            const { kind: _kind, ...rest } = input.kindPayload;
            return { ...rest, deliveryAddress: { ...input.deliveryAddress, capturedAt: iso(at) } };
          })(),
          sourceOrderId: input.sourceOrderId ?? null,
          sourceReplenishmentEventId: null,
          requestedByMembershipId: actor.membershipId,
          deliveryInstructions: input.deliveryInstructions ?? null,
          at,
          // A ROUTE creation is a direct (non-M11) entry, which is exactly what §4.5.2's
          // `created_from_external` means — even when the coordinator pasted an order id into the form.
          emitCreatedFromExternal: true,
        }),
      );
      return {
        supplyRequestId: created.id,
        status: "requested",
        routingRuleResolved: created.routingRuleResolved,
        updatedAt: iso(created.updatedAt) as IsoInstant,
      };
    },

    async assignVendor(actor, supplyRequestId, input: AssignVendorInput) {
      // The M40 vendor check runs BEFORE the transaction opens. It is a cross-module SEAM call, and M40
      // opens its own org context to answer — issuing that from inside our transaction would hold one
      // pooled connection while waiting for a second, which self-deadlocks the pool under concurrency.
      // Hoisting it costs nothing the guard was buying: §2.2's `assignVendor` edge re-checks the answer
      // it is handed, and a vendor deactivated in the intervening milliseconds is caught by the same
      // §3.1.7 routing CHECK that catches every other stale assignment.
      const vendorIsActive =
        input.vendorId === null
          ? null
          : await vendorActive({
              organizationId: actor.organizationId,
              vendorId: input.vendorId,
            }).catch(() => false);
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (row, at, tx) => {
          const data = (row.data ?? {}) as Record<string, unknown>;
          const resolved = await resolveRouting(tx, {
            orgId: actor.organizationId,
            locationId: row.locationId,
            skuId: skuIdOf(data),
            skuClass: skuClassOf(row.kind, data),
            at,
          });
          // A coordinator override REPLACES the ladder's pick but keeps the trace: the record still shows
          // every rule that was evaluated, plus the human decision that overrode them. That is what makes
          // "why did this bed come from Apria" answerable when the answer is "because Dana said so".
          const overridden: RoutingRuleResolved = {
            ...resolved,
            assignedVendorId: input.vendorId,
            assignedFulfillmentMode: input.fulfillmentMode,
            defaultPharmacyDispatchMode: input.pharmacyDispatchMode ?? null,
            candidatesEvaluated: [
              ...resolved.candidatesEvaluated,
              {
                precedenceLevel: "tenant",
                ruleId: null,
                matched: true,
                reason: `manual_override:${input.overrideReason ?? "coordinator_assignment"}`,
              },
            ],
          };
          return {
            event: {
              type: "assignVendor" as const,
              resolved: overridden,
              // Rule 2 — `null` ONLY when no vendor is named; otherwise the probe decided, fail-closed.
              vendorActive: vendorIsActive,
              at: iso(at) as IsoInstant,
            },
            payloads: {},
          };
        },
      );
    },

    async markOrdered(actor, supplyRequestId, input: MarkOrderedInput) {
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (_row, at) => ({
          event: {
            type: "placeOrderWithVendor" as const,
            vendorOrderReference: input.vendorOrderReference,
            at: iso(at) as IsoInstant,
          },
          payloads: {},
        }),
      );
    },

    async markInTransit(actor, supplyRequestId, input: MarkInTransitInput) {
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (_row, at) => ({
          event: {
            type: "vendorConfirmedShipment" as const,
            trackingNumber: input.trackingNumber,
            carrier: input.carrier,
            at: iso(at) as IsoInstant,
          },
          payloads: {},
        }),
      );
    },

    async markDelivered(actor, supplyRequestId, input: MarkDeliveredInput) {
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (row, _at) => {
          const attestation = {
            // D7 — stamped from the SESSION, never the body (routes/actor.ts). A courier who could name
            // someone else has attested to nothing.
            deliveredByMembershipId: actor.membershipId as never,
            deliveredAt: input.deliveredAt,
            deliveryMethod: input.deliveryMethod,
            evidenceDocumentId: (input.evidenceDocumentId ?? null) as never,
          };
          return {
            event: { type: "confirmDeliveryAtAddress" as const, attestation },
            payloads: {
              "m21.supply_request.delivered": {
                ...anchorOf(row),
                supplyRequestId: row.id,
                kind: row.kind,
                courierAttestation: attestation,
              },
            },
          };
        },
      );
    },

    // F-193 (#248) — M21's own caregiver-signature capture. NOT `runRequestTransition`: the row's status
    // does not move (this is evidence about an already-`delivered` row, not a §2.2 edge), and there is no
    // outbox emission (the capture is synchronous within M21 — nothing else needs to react to it). The
    // guard order matches `../lifecycle/caregiver-signature.ts`'s own doc: freshness first (§7.2, the same
    // lost-update protection every other mutation gets), then "has this row even been delivered yet",
    // then "was this already captured", then the per-method evidence floor — each one a distinct,
    // separately-testable refusal rather than one combined boolean.
    async captureCaregiverSignature(actor, supplyRequestId, input: CaptureCaregiverSignatureInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const row = await loadRequest(tx, supplyRequestId);
        assertFresh(row, input.expectedUpdatedAt);
        assertCaregiverSignatureCaptureAllowed({
          deliveredAt: row.deliveredAt ? iso(row.deliveredAt) : null,
          existing: {
            capturedAt: row.caregiverSignatureCapturedAt
              ? iso(row.caregiverSignatureCapturedAt)
              : null,
          },
        });
        requireCaregiverSignatureEvidence(input.captureMethod, input);
        // Only the witnessed method's evidence document rides onto the row — a stray id sent alongside a
        // typed or declined capture is not this method's evidence and must not be persisted as if it were.
        const evidenceDocumentId =
          input.captureMethod === "witnessed_verbal_documented"
            ? (input.evidenceDocumentId ?? null)
            : null;
        await tx
          .update(REQUEST)
          .set({
            caregiverSignatureCaptureMethod:
              input.captureMethod as typeof REQUEST.$inferInsert.caregiverSignatureCaptureMethod,
            caregiverSignatureCapturedAt: at,
            // Stamped from the SESSION, never the body — the same D7 rule `deliveredByMembershipId`
            // follows (routes/actor.ts).
            caregiverSignatureCapturedByMembershipId: actor.membershipId,
            caregiverSignatureEvidenceDocumentId: evidenceDocumentId,
            caregiverSignatureEvidenceJsonb: caregiverSignatureEvidenceJsonbOf(
              input.captureMethod,
              input,
            ),
            updatedAt: at,
          })
          .where(eq(REQUEST.id, row.id));
      });
      return readService.getSupplyRequest(actor, supplyRequestId);
    },

    // COP27 (42 CFR 418.24(c)) — the hospice coverage determination. NOT `runRequestTransition` (status does
    // not move; allowed in any status — a plan-of-care change can re-classify equipment already delivered,
    // § 418.24(d)(2)). Freshness first (§7.2), then the kind + reason rules, row-locked so the change and
    // its event commit together. An unchanged re-save writes nothing and announces nothing. The determining
    // membership is the SESSION's (routes/actor.ts), never the body.
    async setCoverageDetermination(
      actor,
      supplyRequestId,
      input: SetCoverageDeterminationInput,
    ) {
      const at = now();
      await scoped(actor, async (tx) => {
        const [row] = await tx
          .select()
          .from(REQUEST)
          .where(eq(REQUEST.id, supplyRequestId))
          .limit(1)
          .for("update");
        if (!row) throw new NotFoundError("supply_request");
        assertFresh(row, input.expectedUpdatedAt);
        const reason = decideCoverageDetermination({
          kind: row.kind,
          hospiceCoverage: input.hospiceCoverage,
          reason: input.reason,
        });
        if (row.hospiceCoverage === input.hospiceCoverage && (row.coverageReason ?? null) === reason)
          return;
        await tx
          .update(REQUEST)
          .set({
            hospiceCoverage: input.hospiceCoverage,
            coverageReason: reason,
            coverageDeterminedAt: at,
            coverageDeterminedByMembershipId: actor.membershipId,
            updatedAt: at,
          })
          .where(and(eq(REQUEST.id, row.id), eq(REQUEST.createdAt, row.createdAt)));
        await outbox.publish(tx, {
          eventName: "m21.supply_request.coverage_determination_changed",
          payload: {
            orgId: row.organizationId,
            admissionId: row.admissionId,
            patientId: row.patientId,
            sourceId: row.id,
            hospiceCoverage: input.hospiceCoverage,
            previousHospiceCoverage: row.hospiceCoverage,
            reason,
            changedAt: iso(at),
          },
          organizationId: actor.organizationId,
          aggregateKind: "supply_request",
          aggregateId: row.id,
        });
      });
      return readService.getSupplyRequest(actor, supplyRequestId);
    },

    async confirmReceived(actor, supplyRequestId, input: ConfirmReceivedInput) {
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (row, _at) => ({
          event: {
            type: "caregiverOrPatientConfirmsReceipt" as const,
            actor: input.actor,
            at: input.confirmedAt,
            deliveredAt: row.deliveredAt ? (iso(row.deliveredAt) as IsoInstant) : undefined,
          },
          payloads: {},
        }),
      );
    },

    async cancelSupplyRequest(actor, supplyRequestId, input: CancelRequestInput) {
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (row, at) => {
          // §2.2 — the cancellation is IMMEDIATE before the vendor was told, and a two-phase REQUEST
          // after. Picking the edge by status here (rather than exposing two routes) keeps the caller
          // from having to know which side of `ordered` the row sits on; the machine refuses either edge
          // if the status disagrees.
          const preOrdered = row.status === "requested" || row.status === "vendor_assigned";
          const event = preOrdered
            ? { type: "cancel" as const, reason: input.reason, at: iso(at) as IsoInstant }
            : {
                type: "requestCancellation" as const,
                reason: input.reason,
                at: iso(at) as IsoInstant,
              };
          return {
            event,
            payloads: {
              "m21.supply_request.cancelled": {
                ...anchorOf(row),
                supplyRequestId: row.id,
                sourceOrderId: row.sourceOrderId ?? null,
                reason: input.reason,
                cancelledAt: iso(at),
                requiredVendorConfirmation: !preOrdered,
              },
            },
          };
        },
      );
    },

    async returnSupplyRequest(actor, supplyRequestId, input: ReturnRequestInput) {
      return runRequestTransition(
        actor,
        supplyRequestId,
        input.expectedUpdatedAt,
        async (_row, at) => ({
          event: { type: "initiateReturn" as const, at: iso(at) as IsoInstant },
          payloads: {},
        }),
      );
    },

    // ── D11 catalog ───────────────────────────────────────────────────────────────────────────────
    async createSupplyItem(actor, input: CreateSupplyItemInput) {
      const at = now();
      const id = await scoped(actor, async (tx) => {
        const [row] = await tx
          .insert(ITEM)
          .values({
            hcpcs: input.hcpcs ?? null,
            rxnorm: input.rxnorm ?? null,
            ndc: input.ndc ?? null,
            name: input.name,
            skuClass: input.skuClass,
            defaultUnit: input.defaultUnit,
            isBillable: input.isBillable ?? true,
            isControlledSubstance: input.isControlledSubstance ?? null,
            requiresLotTracking: input.requiresLotTracking ?? null,
            requiresExpirationTracking: input.requiresExpirationTracking ?? null,
            isSerializedAsset: input.isSerializedAsset ?? null,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: ITEM.id });
        if (!row) throw new ConflictError("supply_item insert produced no row");
        return row.id;
      });
      return readService.getSupplyItem(actor, id);
    },

    async retireSupplyItem(actor, supplyItemId, input: RetireSupplyItemInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        // Effective-dating, not deletion (§3.1.3): a retired HCPCS code must keep resolving for every
        // historical `supply_request` that was written against it.
        const updated = await tx
          .update(ITEM)
          .set({ effectiveTo: new Date(input.effectiveTo), isActive: false, updatedAt: at })
          .where(and(eq(ITEM.id, supplyItemId), isNull(ITEM.effectiveTo)))
          .returning({ id: ITEM.id });
        if (updated.length === 0) throw new NotFoundError("supply_item");
      });
      return readService.getSupplyItem(actor, supplyItemId);
    },

    async createTenantExtension(actor, input: UpsertTenantSupplyItemInput) {
      const at = now();
      const id = await scoped(actor, async (tx) => {
        const [row] = await tx
          .insert(TENANT_ITEM)
          .values({
            organizationId: actor.organizationId,
            name: input.name,
            localSkuCode: input.localSkuCode,
            defaultUnit: input.defaultUnit,
            isBillable: input.isBillable ?? false,
            isActive: input.isActive ?? true,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: TENANT_ITEM.id });
        if (!row) throw new ConflictError("tenant_supply_item_extension insert produced no row");
        return row.id;
      });
      return readService.getSupplyItem(actor, id);
    },

    async updateTenantExtension(actor, tenantItemId, input: UpsertTenantSupplyItemInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const updated = await tx
          .update(TENANT_ITEM)
          .set({
            name: input.name,
            localSkuCode: input.localSkuCode,
            defaultUnit: input.defaultUnit,
            ...(input.isBillable === undefined ? {} : { isBillable: input.isBillable }),
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
            updatedAt: at,
          })
          .where(eq(TENANT_ITEM.id, tenantItemId))
          .returning({ id: TENANT_ITEM.id });
        if (updated.length === 0) throw new NotFoundError("tenant_supply_item_extension");
      });
      return readService.getSupplyItem(actor, tenantItemId);
    },

    // ── §2.3 comfort-kit templates ────────────────────────────────────────────────────────────────
    async createComfortKitTemplate(actor, input: CreateTemplateInput) {
      const at = now();
      // D3 — the floor validation runs BEFORE anything is written, so a template that drops below the
      // four-medication floor never exists even transiently.
      authorTenantTemplate({
        lines: input.medications.map(floorLineOf),
        effectiveFrom: iso(at) as IsoInstant,
        effectiveTo: null,
      });
      const id = await scoped(actor, (tx) => insertTemplate(tx, actor, input, at, null));
      return readService.getComfortKitTemplate(actor, id);
    },

    async supersedeComfortKitTemplate(actor, templateId, input: SupersedeTemplateInput) {
      const at = now();
      const effectiveFrom = (input.effectiveFrom ?? iso(at)) as IsoInstant;
      const newId = await scoped(actor, async (tx) => {
        const [predecessor] = await tx
          .select()
          .from(TEMPLATE)
          .where(eq(TEMPLATE.id, templateId))
          .limit(1);
        if (!predecessor) throw new NotFoundError("comfort_kit_template");
        const outcome = supersedeTemplate({
          predecessor: {
            templateId: predecessor.id,
            isPlatformFloor: predecessor.isPlatformFloor,
            systemLocked: predecessor.systemLocked,
            effectiveFrom: iso(predecessor.effectiveFrom) as IsoInstant,
            effectiveTo: predecessor.effectiveTo
              ? (iso(predecessor.effectiveTo) as IsoInstant)
              : null,
          },
          successorEffectiveFrom: effectiveFrom,
          lines: input.medications.map(floorLineOf),
        });
        const patch = await runEffects(tx, outcome.effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          aggregateKind: "comfort_kit_template",
          aggregateId: predecessor.id,
          payloads: {},
        });
        await tx
          .update(TEMPLATE)
          .set({ effectiveTo: patch.effectiveTo ?? new Date(effectiveFrom), updatedAt: at })
          .where(eq(TEMPLATE.id, templateId));
        return insertTemplate(tx, actor, input, new Date(effectiveFrom), templateId);
      });
      return readService.getComfortKitTemplate(actor, newId);
    },

    // ── §2.5 dispatch ─────────────────────────────────────────────────────────────────────────────
    async createDispatch(actor, input: CreateDispatchInput) {
      const at = now();
      // GAP-064 — the Location a kit ships from is the one STORED on its supply request, never the body's.
      // Read it first, refuse a differing body value, and run every Location-bearing step (eligibility,
      // par-stock decrement, the dispatch row) against that verified value only.
      const storedRequest = await scoped(actor, (tx) => loadRequest(tx, input.supplyRequestId));
      const servingLocationId = assertDispatchLocationMatchesRequest(
        storedRequest.locationId,
        input.locationId,
      );
      // The §4.4 authority is re-checked HERE — after the preHandler, before the transaction opens — for
      // the same pool reason as `assignVendor` above: the probe reads M3's grant store through its own org
      // context, and nesting that inside the dispatch transaction would hold two connections per request.
      // It runs over the VERIFIED Location and the same resolver the predicate uses.
      const eligible = await dispatcherEligible({
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        locationId: servingLocationId,
      }).catch(() => false);
      const dispatchId = await scoped(actor, async (tx) => {
        const request = await loadRequest(tx, input.supplyRequestId);
        // The stored Location is immutable, but the transaction re-asserts it so a stale read cannot ship.
        assertDispatchLocationMatchesRequest(request.locationId, servingLocationId);
        const [template] = await tx
          .select()
          .from(TEMPLATE)
          .where(eq(TEMPLATE.id, input.comfortKitTemplateId))
          .limit(1);
        if (!template) throw new NotFoundError("comfort_kit_template");
        assertTemplateEffective(
          {
            templateId: template.id,
            isPlatformFloor: template.isPlatformFloor,
            systemLocked: template.systemLocked,
            effectiveFrom: iso(template.effectiveFrom) as IsoInstant,
            effectiveTo: template.effectiveTo ? (iso(template.effectiveTo) as IsoInstant) : null,
          },
          at,
        );

        const templateMeds = await tx
          .select()
          .from(TEMPLATE_MED)
          .where(eq(TEMPLATE_MED.templateId, template.id))
          .orderBy(asc(TEMPLATE_MED.displayOrder));
        const medById = new Map(templateMeds.map((m) => [m.id, m] as const));

        const lines = input.contents.map((line) => {
          const med = medById.get(line.comfortKitTemplateMedicationId);
          if (!med) {
            throw new SupplyStateError(
              "M21_DISPATCH_CONTENT_NOT_IN_TEMPLATE",
              `medication line ${line.comfortKitTemplateMedicationId} is not part of this template`,
            );
          }
          return {
            comfortKitTemplateMedicationId: line.comfortKitTemplateMedicationId,
            drugName: med.drugName,
            isControlledSubstance: med.isControlledSubstance,
            controlledSubstanceSchedule: med.controlledSubstanceSchedule ?? null,
            dispatchedQuantity: line.dispatchedQuantity,
            dispatchedUnit: line.dispatchedUnit,
            lotNumber: line.lotNumber ?? null,
            expirationDate: line.expirationDate ?? null,
            med,
          };
        });

        const digest = sha256(template.controlledSubstanceHandlingPolicyJsonb);
        const effects = prepareDispatch(
          lines,
          {
            kitSerialNumber: input.kitSerialNumber,
            dispatchedByMembershipId: actor.membershipId as never,
            dispatchSource: input.dispatchSource,
            pharmacyDispatchMode: input.pharmacyDispatchMode,
            pharmacyPartnerId: input.pharmacyPartnerId ?? null,
            controlledSubstanceHandlingPolicyDigest: digest,
          },
          {
            templateMedicationIds: templateMeds.map((m) => m.id),
            floorTemplateMedicationIds: templateMeds.filter((m) => m.systemLocked).map((m) => m.id),
            dispatcherControlledEligible: eligible,
            dispatchedAt: at,
            isReplenishment: request.kind === "comfort_kit_replenish",
          },
        );

        // Rule 3 — decrement the shelf BEFORE the insert, so an empty hub rolls the whole dispatch back.
        await decrementPar(tx, actor, servingLocationId, lines, at);

        const [dispatch] = await tx
          .insert(DISPATCH)
          .values({
            supplyRequestId: request.id,
            organizationId: actor.organizationId,
            patientId: request.patientId,
            admissionId: request.admissionId,
            locationId: servingLocationId,
            providerEntityId: request.providerEntityId,
            comfortKitTemplateId: template.id,
            deploymentSite: input.deploymentSite,
            dispatchStatus: "dispatched",
            ipuRoomId: input.ipuRoomId ?? null,
            facilityIdentifierJsonb: input.facilityIdentifier ?? null,
            pharmacyDispatchMode: input.pharmacyDispatchMode,
            dispatchSource: input.dispatchSource,
            pharmacyPartnerId: input.pharmacyPartnerId ?? null,
            kitSerialNumber: input.kitSerialNumber,
            dispatchedByMembershipId: actor.membershipId,
            dispatchedAt: at,
            controlledSubstanceHandlingPolicyDigest: digest,
            dispatchedContentsJsonb: lines.map(({ med: _med, ...line }) => line),
            specialHandlingNotes: input.specialHandlingNotes ?? null,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!dispatch) throw new ConflictError("comfort_kit_dispatch insert produced no row");

        for (const line of lines) {
          await tx.insert(DISPATCHED).values({
            dispatchId: dispatch.id,
            dispatchPartitionDispatchedAt: at,
            organizationId: actor.organizationId,
            providerEntityId: request.providerEntityId,
            locationId: servingLocationId,
            comfortKitTemplateMedicationId: line.comfortKitTemplateMedicationId,
            medicationOrderId:
              input.contents.find(
                (c) => c.comfortKitTemplateMedicationId === line.comfortKitTemplateMedicationId,
              )?.medicationOrderId ?? null,
            rxnorm: line.med.rxnorm,
            ndc: line.med.ndc ?? null,
            drugName: line.med.drugName,
            strength: line.med.strength,
            dosageForm: line.med.dosageForm,
            routeOfAdministration: line.med.routeOfAdministration,
            isControlledSubstance: line.isControlledSubstance,
            controlledSubstanceSchedule: line.controlledSubstanceSchedule,
            dispatchedQuantity: line.dispatchedQuantity,
            dispatchedUnit: line.dispatchedUnit,
            lotNumber: line.lotNumber,
            expirationDate: line.expirationDate,
            manufacturerNdc:
              input.contents.find(
                (c) => c.comfortKitTemplateMedicationId === line.comfortKitTemplateMedicationId,
              )?.manufacturerNdc ?? null,
            // D6 — the perpetual log opens with the DISPENSE entry: the unit left the registrant's stock,
            // and §1304 wants that first movement recorded with the same fidelity as every later one.
            deaPerpetualLogJsonb: [
              {
                transactionKind: "dispense",
                quantityDelta: `-${line.dispatchedQuantity}`,
                balanceAfterQuantity: line.dispatchedQuantity,
                unit: line.dispatchedUnit,
                recordedByMembershipId: actor.membershipId,
                witnessMembershipId: null,
                occurredAt: iso(at),
                sourceReference: dispatch.id,
              },
            ],
            createdAt: at,
          });
        }

        const anchor = anchorOf(dispatch);
        await runEffects(tx, effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          alerts: deps.alerts,
          aggregateKind: "comfort_kit_dispatch",
          aggregateId: dispatch.id,
          payloads: {
            "m21.comfort_kit.dispatched": {
              ...anchor,
              dispatchId: dispatch.id,
              supplyRequestId: request.id,
              comfortKitTemplateId: template.id,
              kitSerialNumber: dispatch.kitSerialNumber,
              dispatchSource: dispatch.dispatchSource,
              pharmacyDispatchMode: dispatch.pharmacyDispatchMode,
              pharmacyPartnerId: dispatch.pharmacyPartnerId ?? null,
              dispatchedByMembershipId: actor.membershipId,
              dispatchedAt: iso(at),
            },
          },
        });
        // Rule 4 — the M22 BOL handoff, outbox-only. `prepareDispatch` declares `request_document`, which
        // the runner deliberately does not execute (it does not carry the tenancy anchor); the payload is
        // assembled here, where the dispatch row is in hand.
        await outbox.publish(tx, {
          eventName: "m21.supply_request.document_requested",
          payload: {
            ...anchor,
            supplyRequestId: request.id,
            dispatchId: dispatch.id,
            documentKind: "bill_of_lading",
            requestedAt: iso(at),
          },
          organizationId: actor.organizationId,
          aggregateKind: "comfort_kit_dispatch",
          aggregateId: dispatch.id,
        });
        return dispatch.id;
      });
      return readService.getDispatch(actor, dispatchId);
    },

    async markDeployedAtPatient(actor, dispatchId, input: DeployAtPatientInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const [row] = await tx.select().from(DISPATCH).where(eq(DISPATCH.id, dispatchId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_dispatch");
        assertFresh(row, input.expectedUpdatedAt);
        const [request] = await tx
          .select({ kind: REQUEST.kind })
          .from(REQUEST)
          .where(eq(REQUEST.id, row.supplyRequestId))
          .limit(1);
        const transition = transitionComfortKitDispatch(row.dispatchStatus, {
          type: "deployAtPatient",
          deployedByMembershipId: actor.membershipId as never,
          at: input.deployedAt,
          isReplenishment: request?.kind === "comfort_kit_replenish",
        });
        const lines = await tx
          .select()
          .from(DISPATCHED)
          .where(eq(DISPATCHED.dispatchId, dispatchId))
          .orderBy(asc(DISPATCHED.createdAt));
        const contents: ComfortKitDispatchedContentPayload[] = lines.map(
          (l) =>
            ({
              dispatchedContentId: l.id,
              comfortKitTemplateMedicationId: l.comfortKitTemplateMedicationId,
              medicationOrderId: l.medicationOrderId ?? null,
              rxnorm: l.rxnorm,
              ndc: l.ndc ?? null,
              drugName: l.drugName,
              strength: l.strength,
              dosageForm: l.dosageForm,
              routeOfAdministration: l.routeOfAdministration,
              isControlledSubstance: l.isControlledSubstance,
              controlledSubstanceSchedule: l.controlledSubstanceSchedule ?? null,
              dispatchedQuantity: l.dispatchedQuantity,
              dispatchedUnit: l.dispatchedUnit,
              lotNumber: l.lotNumber ?? null,
              expirationDate: l.expirationDate ?? null,
              manufacturerNdc: l.manufacturerNdc ?? null,
              replenishmentThresholdPct: 0,
            }) as ComfortKitDispatchedContentPayload,
        );
        const anchor = anchorOf(row);
        const patch = await runEffects(tx, transition.effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          alerts: deps.alerts,
          aggregateKind: "comfort_kit_dispatch",
          aggregateId: row.id,
          payloads: {
            // §4.5.2 — M13 builds its deployment + drawdown rows FROM THIS PAYLOAD, which is why the full
            // manifest rides along: M13 must not have to read back through a seam to learn what is in the
            // kit it is about to track.
            "m21.comfort_kit.deployed_at_patient": {
              ...anchor,
              dispatchId: row.id,
              supplyRequestId: row.supplyRequestId,
              deploymentSite: row.deploymentSite,
              ipuRoomId: row.ipuRoomId ?? null,
              deployedAt: input.deployedAt,
              deployedByMembershipId: actor.membershipId,
              contents,
              bolDocumentId: row.bolDocumentId ?? null,
            },
            "m21.comfort_kit.replenished": {
              ...anchor,
              dispatchId: row.id,
              supplyRequestId: row.supplyRequestId,
              sourceDeploymentId: row.m13DeploymentId ?? "",
              replenishedAt: input.deployedAt,
              contents,
            },
          },
        });
        await tx
          .update(DISPATCH)
          .set({
            dispatchStatus: (patch.dispatchStatus ??
              transition.to) as typeof DISPATCH.$inferInsert.dispatchStatus,
            deployedAtPatientAt: patch.deployedAtPatientAt ?? new Date(input.deployedAt),
            // §3.1.8's CHECK moves these two together — a deployment time with no deployer is an
            // unattributable chain-of-custody link.
            deployedByMembershipId: actor.membershipId,
            updatedAt: at,
          })
          .where(eq(DISPATCH.id, dispatchId));
      });
      return readService.getDispatch(actor, dispatchId);
    },

    // ── §2.6 return + reconciliation ──────────────────────────────────────────────────────────────
    async createReturn(actor, input: CreateReturnInput) {
      const at = now();
      const returnId = await scoped(actor, async (tx) => {
        const [dispatch] = await tx
          .select()
          .from(DISPATCH)
          .where(eq(DISPATCH.id, input.dispatchId))
          .limit(1);
        if (!dispatch) throw new NotFoundError("comfort_kit_dispatch");
        if (dispatch.m13DeploymentId === null) {
          // `comfort_kit_return.m13_deployment_id` is NOT NULL (§3.1.10): M13 closes its drawdowns against
          // it. A return opened before M13 acked the deployment would have nothing to close.
          throw new SupplyStateError(
            "M21_DISPATCH_NOT_FOUND",
            `dispatch ${input.dispatchId} has no M13 deployment link yet; the return cannot be anchored`,
          );
        }
        const requiredAt = input.returnRequiredAt ?? (iso(at) as IsoInstant);
        const [row] = await tx
          .insert(RETURN)
          .values({
            dispatchId: dispatch.id,
            dispatchPartitionDispatchedAt: dispatch.dispatchedAt,
            m13DeploymentId: dispatch.m13DeploymentId,
            organizationId: actor.organizationId,
            patientId: dispatch.patientId,
            admissionId: dispatch.admissionId,
            providerEntityId: dispatch.providerEntityId,
            locationId: dispatch.locationId,
            returnRequiredAt: new Date(requiredAt),
            returnDueAt: new Date(new Date(requiredAt).getTime() + returnWindowHours * 3_600_000),
            state: "requested",
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row) throw new ConflictError("comfort_kit_return insert produced no row");
        // F-166 (#248) — this used to ALSO publish `m21.comfort_kit.returned` here, at the moment the
        // return is merely REQUESTED (state stays "requested"), with `disposalMethod`/
        // `reconciledByMembershipId` as placeholder empty strings — nothing has happened yet. M21's own
        // spec (WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:48) is unambiguous that
        // `.returned` fires only once reconciliation "captures per-medication quantity_returned +
        // quantity_disposed_at_home + disposal_method + disposal_witness_membership_id, and emits
        // `m21.comfort_kit.returned` + `m21.comfort_kit.return_reconciliation`" — i.e. from
        // `reconcileReturn`'s own `{ kind: "outbox", event: "m21.comfort_kit.returned" }` effect
        // (`../lifecycle/return.ts`), which fires below in `reconcileReturn` off the REAL disposal facts.
        // Emitting the SAME event name twice, once with garbage placeholders, meant a consumer bound to
        // `.returned` (M13, which flips `comfort_kit_deployment.disposal_status='returned'` on it) would
        // have flipped a kit to "returned" the instant a return was merely opened — before anyone
        // retrieved or reconciled anything. No consumer anywhere needs a "return was requested" signal
        // (`comfort_kit_deployment.disposal_status` has no state between `return_required` and `returned`
        // to carry one, and M21's own spec names no such event under any spelling), so this emission is
        // deleted outright rather than renamed to a new `return_requested` event nothing would consume.
        return row.id;
      });
      return readService.getReturn(actor, returnId);
    },

    async assignRetriever(actor, returnId, input: AssignRetrieverInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const [row] = await tx.select().from(RETURN).where(eq(RETURN.id, returnId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_return");
        assertFresh(row, input.expectedUpdatedAt);
        const transition = transitionComfortKitReturn(row.state, {
          type: "assignRetriever",
          retrievingMembershipId: input.retrievingMembershipId,
          at: iso(at) as IsoInstant,
        });
        const patch = await runEffects(tx, transition.effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          aggregateKind: "comfort_kit_return",
          aggregateId: row.id,
          payloads: {},
        });
        await tx
          .update(RETURN)
          .set({
            state: transition.to as typeof RETURN.$inferInsert.state,
            assignedRetrievingMembershipId:
              patch.assignedRetrievingMembershipId ?? input.retrievingMembershipId,
            updatedAt: at,
          })
          .where(eq(RETURN.id, returnId));
      });
      return readService.getReturn(actor, returnId);
    },

    async reconcileReturn(actor, returnId, input: ReconcileReturnInput) {
      const at = now();
      const outcome = await scoped(actor, async (tx) => {
        const [row] = await tx.select().from(RETURN).where(eq(RETURN.id, returnId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_return");
        assertFresh(row, input.expectedUpdatedAt);
        const [dispatch] = await tx
          .select()
          .from(DISPATCH)
          .where(eq(DISPATCH.id, row.dispatchId))
          .limit(1);
        if (!dispatch) throw new NotFoundError("comfort_kit_dispatch");
        const dispatchedLines = await tx
          .select()
          .from(DISPATCHED)
          .where(eq(DISPATCHED.dispatchId, row.dispatchId));
        const byId = new Map(dispatchedLines.map((l) => [l.id, l] as const));

        const submissions = input.perMedicationReconciliation.map((line) => {
          const dispatched = byId.get(line.dispatchedContentId);
          if (!dispatched) {
            throw new SupplyStateError(
              "M21_RECONCILIATION_LINE_COVERAGE_INCOMPLETE",
              `line ${line.dispatchedContentId} is not part of dispatch ${row.dispatchId}`,
            );
          }
          return {
            dispatchedContentId: line.dispatchedContentId,
            drugName: dispatched.drugName,
            dispatchedQuantity: dispatched.dispatchedQuantity,
            quantityReturned: line.quantityReturned,
            quantityDisposedAtHome: line.quantityDisposedAtHome,
            isControlledSubstance: dispatched.isControlledSubstance,
            controlledSubstanceSchedule: dispatched.controlledSubstanceSchedule ?? null,
          };
        });

        const digest = sha256({
          disposalMethod: input.disposalMethod,
          jurisdiction: dispatch.locationId,
        });
        // §2.6 / D8 — the transition AND the computed per-line accounting come out of ONE pure call. The
        // discrepancy flag is computed there and is never accepted from the caller.
        const reconciliation = reconcileReturn(row.state, {
          type: "reconcile",
          at: iso(at) as IsoInstant,
          reconciledByMembershipId: actor.membershipId as never,
          disposalMethod: input.disposalMethod,
          disposalWitnessMembershipId: (input.disposalWitnessMembershipId ?? null) as never,
          disposalMethodJurisdictionPolicyDigest: digest,
          lines: submissions,
          dispatchedContentIds: dispatchedLines.map((l) => l.id),
          dispatchedByMembershipId: dispatch.dispatchedByMembershipId as never,
          assignedRetrievingMembershipId: (row.assignedRetrievingMembershipId ?? null) as never,
        });

        for (const line of reconciliation.lines) {
          const dispatched = byId.get(line.dispatchedContentId);
          if (!dispatched) continue;
          const submitted = input.perMedicationReconciliation.find(
            (l) => l.dispatchedContentId === line.dispatchedContentId,
          );
          await tx.insert(RETURNED).values({
            returnId: row.id,
            dispatchedContentId: line.dispatchedContentId,
            organizationId: actor.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            quantityReturned: submitted?.quantityReturned ?? "0",
            quantityDisposedAtHome: submitted?.quantityDisposedAtHome ?? "0",
            // The three computed columns are ALSO written by migration 0106's BEFORE trigger. Writing the
            // domain's answer here as well is deliberate: the trigger is the backstop for a direct SQL
            // write, and the two implementations agreeing is what §9.2 asserts. If they ever disagree the
            // trigger wins, which is the safe direction — it is the one a `psql` session cannot bypass.
            quantityUnaccounted: line.quantityUnaccounted,
            discrepancyPct: String(line.discrepancyPct),
            discrepancyFlagged: line.discrepancyFlagged,
            isControlledSubstance: dispatched.isControlledSubstance,
            controlledSubstanceSchedule: dispatched.controlledSubstanceSchedule ?? null,
            createdAt: at,
            updatedAt: at,
          });
          // D6 / §1304 — close each line's perpetual log with its RETURN entry.
          await tx
            .update(DISPATCHED)
            .set({
              deaPerpetualLogJsonb: sql`coalesce(${DISPATCHED.deaPerpetualLogJsonb}, '[]'::jsonb) || ${JSON.stringify(
                [
                  {
                    transactionKind:
                      input.disposalMethod === "dispose_at_home_by_witnessed_destruction"
                        ? "disposal"
                        : "return",
                    quantityDelta: submitted?.quantityReturned ?? "0",
                    balanceAfterQuantity: line.quantityUnaccounted,
                    unit: dispatched.dispatchedUnit,
                    recordedByMembershipId: actor.membershipId,
                    witnessMembershipId: input.disposalWitnessMembershipId ?? null,
                    occurredAt: iso(at),
                    sourceReference: row.id,
                  },
                ],
              )}::jsonb`,
            })
            .where(eq(DISPATCHED.id, line.dispatchedContentId));
        }

        const anchor = anchorOf(row);
        const perMedicationPayload = reconciliation.lines.map((line) => {
          const dispatched = byId.get(line.dispatchedContentId);
          const submitted = input.perMedicationReconciliation.find(
            (l) => l.dispatchedContentId === line.dispatchedContentId,
          );
          return {
            returnedContentId: "",
            dispatchedContentId: line.dispatchedContentId,
            comfortKitTemplateMedicationId: dispatched?.comfortKitTemplateMedicationId ?? "",
            medicationOrderId: dispatched?.medicationOrderId ?? null,
            rxnorm: dispatched?.rxnorm ?? "",
            drugName: dispatched?.drugName ?? "",
            isControlledSubstance: dispatched?.isControlledSubstance ?? false,
            controlledSubstanceSchedule: dispatched?.controlledSubstanceSchedule ?? null,
            lotNumber: dispatched?.lotNumber ?? null,
            dispatchedQuantity: dispatched?.dispatchedQuantity ?? "0",
            quantityReturned: submitted?.quantityReturned ?? "0",
            quantityDisposedAtHome: submitted?.quantityDisposedAtHome ?? "0",
            quantityUnaccounted: line.quantityUnaccounted,
            discrepancyPct: line.discrepancyPct,
            discrepancyFlagged: line.discrepancyFlagged,
          };
        });

        const patch = await runEffects(tx, reconciliation.transition.effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          alerts: deps.alerts,
          aggregateKind: "comfort_kit_return",
          aggregateId: row.id,
          payloads: {
            "m21.comfort_kit.returned": {
              ...anchor,
              returnId: row.id,
              dispatchId: row.dispatchId,
              m13DeploymentId: row.m13DeploymentId,
              disposalMethod: input.disposalMethod,
              reconciledByMembershipId: actor.membershipId,
              disposalWitnessMembershipId: input.disposalWitnessMembershipId ?? null,
              reconciledAt: iso(at),
            },
            "m21.comfort_kit.return_reconciliation": {
              ...anchor,
              returnId: row.id,
              dispatchId: row.dispatchId,
              m13DeploymentId: row.m13DeploymentId,
              discrepancyDetected: reconciliation.discrepancyDetected,
              perMedicationReconciliation: perMedicationPayload,
              reconciledAt: iso(at),
            },
            "m21.controlled_substance.discrepancy_detected": {
              ...anchor,
              returnId: row.id,
              dispatchId: row.dispatchId,
              m13DeploymentId: row.m13DeploymentId,
              detectionSource: "return_reconciliation",
              discrepantMedications: perMedicationPayload.filter((l) => l.discrepancyFlagged),
              custodyChain: {
                dispatchedByMembershipId: dispatch.dispatchedByMembershipId,
                retrievingMembershipId: row.assignedRetrievingMembershipId ?? null,
                disposalWitnessMembershipId: input.disposalWitnessMembershipId ?? null,
                reconciledByMembershipId: actor.membershipId,
              },
              detectedAt: iso(at),
            },
          },
        });

        await tx
          .update(RETURN)
          .set({
            state: reconciliation.transition.to as typeof RETURN.$inferInsert.state,
            reconciledAt: patch.reconciledAt ?? at,
            reconciledByMembershipId: actor.membershipId,
            disposalMethod: (patch.disposalMethod ??
              input.disposalMethod) as typeof RETURN.$inferInsert.disposalMethod,
            disposalWitnessMembershipId: input.disposalWitnessMembershipId ?? null,
            disposalMethodJurisdictionPolicyDigest: digest,
            disposalNotes: input.disposalNotes ?? null,
            discrepancyNotes: input.discrepancyNotes ?? null,
            updatedAt: at,
          })
          .where(eq(RETURN.id, returnId));

        // The dispatch row outlives the request; move its own status to the matching terminal.
        const dispatchTransition = transitionComfortKitDispatch(dispatch.dispatchStatus, {
          type: "recordReconciliation",
          discrepancyDetected: reconciliation.discrepancyDetected,
        });
        await tx
          .update(DISPATCH)
          .set({
            dispatchStatus: dispatchTransition.to as typeof DISPATCH.$inferInsert.dispatchStatus,
            updatedAt: at,
          })
          .where(eq(DISPATCH.id, dispatch.id));

        // Rule 4 — the DEA-1304-format return receipt, outbox-only to M22.
        await outbox.publish(tx, {
          eventName: "m21.supply_request.document_requested",
          payload: {
            ...anchor,
            supplyRequestId: dispatch.supplyRequestId,
            dispatchId: dispatch.id,
            documentKind: "return_receipt",
            requestedAt: iso(at),
          },
          organizationId: actor.organizationId,
          aggregateKind: "comfort_kit_return",
          aggregateId: row.id,
        });

        return reconciliation.discrepancyDetected;
      });

      const detail = await readService.getReturn(actor, returnId);
      return {
        returnId,
        state: "reconciled",
        discrepancyDetected: outcome,
        perMedication: detail.lines,
        updatedAt: detail.updatedAt,
      } satisfies ReconcileReturnResult;
    },

    async declareUnreturnable(actor, returnId, input: DeclareUnreturnableInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const [row] = await tx.select().from(RETURN).where(eq(RETURN.id, returnId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_return");
        assertFresh(row, input.expectedUpdatedAt);
        const controlled = await tx
          .select({ id: DISPATCHED.id })
          .from(DISPATCHED)
          .where(
            and(
              eq(DISPATCHED.dispatchId, row.dispatchId),
              eq(DISPATCHED.isControlledSubstance, true),
            ),
          )
          .limit(1);
        const containsControlledSubstance = controlled.length > 0;
        const transition = transitionComfortKitReturn(row.state, {
          type: "markUnreturnable",
          at: iso(at) as IsoInstant,
          returnRequiredAt: iso(row.returnRequiredAt) as IsoInstant,
          reason: input.reason,
          attestedByMembershipId: actor.membershipId as never,
          containsControlledSubstance,
        });
        const anchor = anchorOf(row);
        const patch = await runEffects(tx, transition.effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          alerts: deps.alerts,
          aggregateKind: "comfort_kit_return",
          aggregateId: row.id,
          payloads: {
            "m21.comfort_kit.return_overdue": {
              ...anchor,
              returnId: row.id,
              dispatchId: row.dispatchId,
              returnRequiredAt: iso(row.returnRequiredAt),
              daysOverdue: Math.max(
                0,
                Math.floor((at.getTime() - row.returnDueAt.getTime()) / 86_400_000),
              ),
              escalation: "unreturnable_90d",
              containsControlledSubstance,
              detectedAt: iso(at),
            },
            "m21.controlled_substance.discrepancy_detected": {
              ...anchor,
              returnId: row.id,
              dispatchId: row.dispatchId,
              m13DeploymentId: row.m13DeploymentId,
              detectionSource: "unreturnable_90d",
              // The whole kit is unaccounted for; the per-line detail is what the dispatch says went out.
              discrepantMedications: [],
              custodyChain: {
                dispatchedByMembershipId: "",
                retrievingMembershipId: row.assignedRetrievingMembershipId ?? null,
                disposalWitnessMembershipId: null,
                reconciledByMembershipId: actor.membershipId,
              },
              detectedAt: iso(at),
            },
          },
        });
        await tx
          .update(RETURN)
          .set({
            state: transition.to as typeof RETURN.$inferInsert.state,
            unreturnableReason: patch.unreturnableReason ?? input.reason,
            unreturnableAttestedByMembershipId: actor.membershipId,
            updatedAt: at,
          })
          .where(eq(RETURN.id, returnId));
      });
      return readService.getReturn(actor, returnId);
    },

    // ── §2.4 vendor routing ───────────────────────────────────────────────────────────────────────
    async createVendorRoutingRule(actor, input: UpsertRoutingRuleInput) {
      const at = now();
      const id = await scoped(actor, async (tx) => {
        const [row] = await tx
          .insert(RULE)
          .values({
            organizationId: actor.organizationId,
            scopeKind: input.scopeKind,
            // A `tenant`-scope rule names the org itself (§3.1.5's CHECK allows a null `scope_id` there,
            // but D4's `scopeIdMatches` compares it against the org id, so writing it keeps the ladder
            // and the storage constraint agreeing).
            scopeId: input.scopeId ?? (input.scopeKind === "tenant" ? actor.organizationId : null),
            skuClassPattern: input.skuClassPattern ?? null,
            assignedVendorId: input.assignedVendorId,
            assignedFulfillmentMode: input.assignedFulfillmentMode,
            defaultPharmacyDispatchMode: input.defaultPharmacyDispatchMode ?? null,
            precedencePriority: input.precedencePriority ?? 100,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: RULE.id });
        if (!row) throw new ConflictError("vendor_routing_rule insert produced no row");
        return row.id;
      });
      return readService.getVendorRoutingRule(actor, id);
    },

    async updateVendorRoutingRule(actor, ruleId, input: UpsertRoutingRuleInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const updated = await tx
          .update(RULE)
          .set({
            scopeKind: input.scopeKind,
            scopeId: input.scopeId ?? (input.scopeKind === "tenant" ? actor.organizationId : null),
            skuClassPattern: input.skuClassPattern ?? null,
            assignedVendorId: input.assignedVendorId,
            assignedFulfillmentMode: input.assignedFulfillmentMode,
            defaultPharmacyDispatchMode: input.defaultPharmacyDispatchMode ?? null,
            precedencePriority: input.precedencePriority ?? 100,
            updatedAt: at,
          })
          .where(eq(RULE.id, ruleId))
          .returning({ id: RULE.id });
        if (updated.length === 0) throw new NotFoundError("vendor_routing_rule");
      });
      return readService.getVendorRoutingRule(actor, ruleId);
    },

    async retireVendorRoutingRule(actor, ruleId) {
      const at = now();
      await scoped(actor, async (tx) => {
        // RETIRED, never deleted: `routing_rule_resolved_jsonb` on every historical request names this
        // rule id, and a survey asking "which rule sent this bed to Apria" must still resolve it.
        const updated = await tx
          .update(RULE)
          .set({ isActive: false, effectiveTo: at, updatedAt: at })
          .where(and(eq(RULE.id, ruleId), isNull(RULE.effectiveTo)))
          .returning({ id: RULE.id });
        if (updated.length === 0) throw new NotFoundError("vendor_routing_rule");
      });
      return readService.getVendorRoutingRule(actor, ruleId);
    },

    // ── §2.7 par stock ────────────────────────────────────────────────────────────────────────────
    async updateParStock(actor, parStockId, input: UpdateParStockInput) {
      const at = now();
      await scoped(actor, async (tx) => {
        const [row] = await tx.select().from(PAR).where(eq(PAR.id, parStockId)).limit(1);
        if (!row) throw new NotFoundError("par_stock");
        assertFresh(row, input.expectedUpdatedAt);
        const next = {
          reorderPoint: input.reorderPoint ?? row.reorderPoint,
          minSafetyStock: input.minSafetyStock ?? row.minSafetyStock,
          reorderQuantity: input.reorderQuantity ?? row.reorderQuantity,
        };
        // §2.10 — mirrors the `m21_par_stock_thresholds_ordered` CHECK, so an inverted pair is a
        // field-anchored 422 instead of a 500 out of PostgreSQL.
        assertParThresholdsOrdered(next);
        await tx
          .update(PAR)
          .set({
            ...next,
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
            ...(input.reorderNotes === undefined ? {} : { reorderNotes: input.reorderNotes }),
            updatedAt: at,
          })
          .where(eq(PAR.id, parStockId));
      });
      return readService.getParStock(actor, parStockId);
    },

    async recordObservation(actor, input: ObserveParStockInput) {
      const at = input.observedAt ? new Date(input.observedAt) : now();
      await scoped(actor, async (tx) => {
        const [row] = await tx.select().from(PAR).where(eq(PAR.id, input.parStockId)).limit(1);
        if (!row) throw new NotFoundError("par_stock");
        // An observation SETS the shelf (see the TypeBox doc-comment), so the movement is the delta from
        // the recorded count to the observed one — run through the pure §2.7 rule so a negative result is
        // the typed refusal rather than a silent clamp.
        const delta = String(Number(input.observedQuantity) - Number(row.currentQuantity));
        const movement = applyParStockMovement(
          {
            parStockId: row.id,
            currentQuantity: row.currentQuantity,
            reorderPoint: row.reorderPoint,
            reorderQuantity: row.reorderQuantity,
            minSafetyStock: row.minSafetyStock,
            unit: row.unit,
            isActive: row.isActive,
          },
          { kind: "manual_adjustment", delta, reviewedAt: iso(at) as IsoInstant },
        );
        const patch = await runEffects(tx, movement.effects, {
          organizationId: actor.organizationId,
          at,
          outbox,
          aggregateKind: "par_stock",
          aggregateId: row.id,
          payloads: {},
        });
        await tx
          .update(PAR)
          .set({
            currentQuantity: movement.nextQuantity,
            lastParReviewAt: patch.lastParReviewAt ?? at,
            lastParReviewedByMembershipId: actor.membershipId,
            ...(input.reorderNotes === undefined ? {} : { reorderNotes: input.reorderNotes }),
            updatedAt: at,
          })
          .where(eq(PAR.id, input.parStockId));
      });
      return readService.getParStock(actor, input.parStockId);
    },

    // ── §4.8 seam entry (see the port's doc-comment) ──────────────────────────────────────────────
    async createDirect(input: CreateDirectSupplyRequestInput) {
      const at = now();
      const actorLike = { organizationId: "", userId: "" };
      // The seam runs inside the CALLER's request scope, so the org comes from the ambient context the
      // consumer already opened. A caller with no scope cannot create — the row would have no tenant.
      const ctx = getRequestContext();
      if (!ctx?.organizationId) {
        throw new SupplyStateError(
          "M21_SERVING_LOCATION_UNRESOLVED",
          "createDirectSupplyRequest was called outside a request scope; there is no tenant to write into",
        );
      }
      actorLike.organizationId = ctx.organizationId;
      actorLike.userId = ctx.userId ?? "";
      const providerEntityId = await providerEntityFor(ctx.organizationId, input.admissionId);
      const created = await scoped(actorLike, (tx) =>
        insertSupplyRequest(tx, outbox, {
          organizationId: ctx.organizationId,
          patientId: input.patientId,
          admissionId: input.admissionId,
          locationId: input.locationId,
          providerEntityId,
          kind: input.kind,
          data: (input.data ?? {}) as Record<string, unknown>,
          sourceOrderId: input.sourceOrderId,
          sourceReplenishmentEventId: input.sourceReplenishmentEventId,
          requestedByMembershipId: input.requestedByMembershipId,
          deliveryInstructions: null,
          at,
          emitCreatedFromExternal: true,
        }),
      );
      return { supplyRequestId: created.id, routingRuleResolved: created.routingRuleResolved };
    },
  };

  // ── local helpers that need the table handles above ────────────────────────────────────────────

  /** Insert a template + its medication lines; returns the new template id. */
  async function insertTemplate(
    tx: Tx,
    actor: M21WriteActor,
    input: CreateTemplateInput,
    effectiveFrom: Date,
    replacesTemplateId: string | null,
  ): Promise<string> {
    const [row] = await tx
      .insert(TEMPLATE)
      .values({
        organizationId: actor.organizationId,
        name: input.name,
        isPlatformFloor: false,
        systemLocked: false,
        effectiveFrom,
        replacesTemplateId,
        stateLabelingPolicyJsonb: input.stateLabelingPolicy ?? {},
        controlledSubstanceHandlingPolicyJsonb: input.controlledSubstanceHandlingPolicy ?? {},
        createdAt: effectiveFrom,
        updatedAt: effectiveFrom,
      })
      .returning({ id: TEMPLATE.id });
    if (!row) throw new ConflictError("comfort_kit_template insert produced no row");
    let order = 0;
    for (const med of input.medications) {
      await tx.insert(TEMPLATE_MED).values({
        templateId: row.id,
        organizationId: actor.organizationId,
        isPlatformFloor: false,
        rxnorm: med.rxnorm,
        ndc: med.ndc ?? null,
        drugName: med.drugName,
        strength: med.strength,
        dosageForm: med.dosageForm,
        routeOfAdministration: med.routeOfAdministration,
        isControlledSubstance: med.isControlledSubstance,
        controlledSubstanceSchedule: med.controlledSubstanceSchedule ?? null,
        expectedQuantity: med.expectedQuantity,
        expectedUnit: med.expectedUnit,
        replenishmentThresholdPct: med.replenishmentThresholdPct ?? "0.25",
        systemLocked: false,
        displayOrder: med.displayOrder ?? order,
        notes: med.notes ?? null,
        createdAt: effectiveFrom,
        updatedAt: effectiveFrom,
      });
      order += 1;
    }
    return row.id;
  }

  /**
   * Rule 3 — decrement the hub shelf for every dispatched line that HAS a par row at this Location. A line
   * with no par row is not an error: par stock is per (org, Location, SKU) and a kit medication the hub
   * does not par-manage simply has no shelf to draw down. What IS an error is a par row that would go
   * negative, and `applyParStockMovement` raises `M21_PAR_STOCK_INSUFFICIENT` for it, rolling the dispatch
   * back before a courier is sent for a kit that cannot be assembled (§2.5).
   */
  async function decrementPar(
    tx: Tx,
    actor: M21WriteActor,
    locationId: string,
    lines: readonly { readonly med: { rxnorm: string }; readonly dispatchedQuantity: string }[],
    at: Date,
  ): Promise<void> {
    const rxnorms = [...new Set(lines.map((l) => l.med.rxnorm))];
    if (rxnorms.length === 0) return;
    const parRows = await tx
      .select({ par: PAR, rxnorm: ITEM.rxnorm })
      .from(PAR)
      .innerJoin(ITEM, eq(ITEM.id, PAR.skuId))
      .where(and(eq(PAR.locationId, locationId), inArray(ITEM.rxnorm, rxnorms)));
    const byRxnorm = new Map(parRows.map((r) => [r.rxnorm ?? "", r.par] as const));
    for (const line of lines) {
      const par = byRxnorm.get(line.med.rxnorm);
      if (!par) continue;
      const movement = applyParStockMovement(
        {
          parStockId: par.id,
          currentQuantity: par.currentQuantity,
          reorderPoint: par.reorderPoint,
          reorderQuantity: par.reorderQuantity,
          minSafetyStock: par.minSafetyStock,
          unit: par.unit,
          isActive: par.isActive,
        },
        { kind: "dispatch_decrement", quantity: line.dispatchedQuantity },
      );
      await tx
        .update(PAR)
        .set({ currentQuantity: movement.nextQuantity, updatedAt: at })
        .where(eq(PAR.id, par.id));
      byRxnorm.set(line.med.rxnorm, { ...par, currentQuantity: movement.nextQuantity });
    }
  }
}
