// apps/backend/src/modules/21-supplies/routes/m21-typebox.ts — M21 (§4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 Supplies routes. They are the runtime
// validators today; the OpenAPI enrichment registry layers them onto the auto-discovered routes in M21-T06,
// so the generated client types the surface the §5 screens call (the M16-T07 precedent, where the
// enrichment landed with the screens rather than with the routes). Named
// `m21-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one — the M21-T01 gotcha, where even the WORD "alerts" in a comment tripped `arch:tables`.
//
// The string-literal unions MIRROR the frozen `@wardenx/db` pgEnum value lists (packages/db/src/enums.ts,
// M21-T01) — the schema wins on conflict. Org / actor / membership binding is server-side
// (`request.context`): no body or query carries an org id or an acting membership id, which is the DEA
// chain-of-custody control at the boundary (see routes/actor.ts).
//
// THE PER-KIND `data` PAYLOAD IS NOT RE-DECLARED HERE. §4.2.1 sketches a `kindPayload` union inline, but
// `@wardenx/supplies` already owns the D1 per-kind TypeBox (`SUPPLY_REQUEST_DATA_SCHEMAS`) plus the §2.10
// cross-field rules TypeBox cannot state. Restating the union in this file would be a second, drifting
// copy of the contract the write path validates against, so the body types `kindPayload` as a discriminated
// shell (`{ kind }` + passthrough) and the WRITE service runs `validateSupplyRequestData` — one validator,
// one error catalog, one place to change when a kind gains a field.
//
// A NOTE ON QUANTITIES. Every quantity that reaches a `numeric` column is typed as a decimal STRING here,
// never `Type.Number()`. A 0.1 mL of a CII solution that round-trips through a JS float is not the number
// the DEA perpetual log recorded, and §4.2.2's own sketch (which uses `Type.Number`) is the one place the
// spec contradicts its own §3.1 column types — the columns win.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  ComfortKitReturnDetail as ServiceComfortKitReturnDetail,
  ComfortKitReturnListItem as ServiceComfortKitReturnListItem,
  ComfortKitReturnedLineView as ServiceComfortKitReturnedLineView,
  ComfortKitTemplateMedicationView as ServiceComfortKitTemplateMedicationView,
  ComfortKitTemplateView as ServiceComfortKitTemplateView,
  DispatchDetail as ServiceDispatchDetail,
  DispatchListItem as ServiceDispatchListItem,
  ParStockView as ServiceParStockView,
  PerpetualLogLineView as ServicePerpetualLogLineView,
  PerpetualLogView as ServicePerpetualLogView,
  SupplyItemView as ServiceSupplyItemView,
  SupplyRequestDetail as ServiceSupplyRequestDetail,
  SupplyRequestListItem as ServiceSupplyRequestListItem,
  VendorRoutingRuleView as ServiceVendorRoutingRuleView,
} from "./read-service";
import type {
  CreateSupplyRequestResult as ServiceCreateSupplyRequestResult,
  ReconcileReturnResult as ServiceReconcileReturnResult,
} from "./write-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/**
 * Validate a request BODY at the route boundary — a malformed request is rejected BEFORE it reaches a
 * service. Deliberately does NOT run `Value.Convert`: a JSON body already carries real types, and coercing
 * would silently repair genuinely wrong input. Queries are the only place coercion is legitimate.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting the declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const UuidN = Type.Optional(Type.String({ format: "uuid" }));
const Instant = Type.String({ format: "date-time" });
/** A `numeric` column on the wire — see the header note on decimal strings. */
const Decimal = Type.String({ pattern: "^-?[0-9]+(\\.[0-9]+)?$" });
const LocalDate = Type.String({ minLength: 10, maxLength: 10 });
/** D13 free text — the columns behind these are audit-denylisted; the length cap is `FREE_TEXT_MAX_LENGTH`. */
const FreeText = (max = 500) => Type.String({ minLength: 1, maxLength: max });

// ── enum mirrors (`packages/db/src/enums.ts` is the source of truth) ─────────────────────────────────

/** `m21_supply_request_kind` (D1). */
export const SupplyRequestKind = Type.Union([
  Type.Literal("dme"),
  Type.Literal("supply"),
  Type.Literal("comfort_kit_deploy"),
  Type.Literal("comfort_kit_replenish"),
]);

/** `m21_supply_request_status` (§2.2 / D2). */
export const SupplyRequestStatus = Type.Union([
  Type.Literal("requested"),
  Type.Literal("vendor_assigned"),
  Type.Literal("ordered"),
  Type.Literal("in_transit"),
  Type.Literal("delivered"),
  Type.Literal("received_confirmed"),
  Type.Literal("completed"),
  Type.Literal("cancellation_pending"),
  Type.Literal("cancelled"),
  Type.Literal("returned"),
]);

/** `m21_delivery_method` (D7). */
export const SupplyDeliveryMethod = Type.Union([
  Type.Literal("agency_courier"),
  Type.Literal("vendor_direct_ship"),
  Type.Literal("pharmacy_partner_courier"),
  Type.Literal("patient_pickup"),
  Type.Literal("in_facility_internal"),
]);

/** `m21_supply_received_confirmed_actor` (§2.2). `system_auto_confirm` is NOT client-settable — it is the
 *  72h fallback the worker writes, and letting a caller claim it would erase the distinction the screen
 *  renders. The body union below therefore omits it. */
export const SupplyReceivedConfirmedActor = Type.Union([
  Type.Literal("caregiver"),
  Type.Literal("patient"),
  Type.Literal("supply_team"),
]);

/** `m21_comfort_kit_deployment_site` (D17). */
export const ComfortKitDeploymentSite = Type.Union([
  Type.Literal("home"),
  Type.Literal("alf"),
  Type.Literal("snf_residence"),
  Type.Literal("ipu_room"),
]);

/** `m21_comfort_kit_dispatch_source` — WHICH DEA registration the kit physically left from. */
export const ComfortKitDispatchSource = Type.Union([
  Type.Literal("supply_hub"),
  Type.Literal("pharmacy_partner"),
  Type.Literal("dosespot_pharmacy"),
]);

/** `m21_pharmacy_dispatch_mode` (D6 — who physically fills the kit). */
export const PharmacyDispatchMode = Type.Union([
  Type.Literal("supply_hub_dispatch"),
  Type.Literal("partner_pharmacy_dispatch"),
  Type.Literal("dosespot_to_partner_pharmacy"),
]);

/** `m21_comfort_kit_disposal_method` (§1.3 / DEA 21 CFR §1317). */
export const ComfortKitDisposalMethod = Type.Union([
  Type.Literal("take_back_by_supply_team"),
  Type.Literal("dispose_at_home_by_witnessed_destruction"),
  Type.Literal("transferred_to_disposing_pharmacy"),
]);

/** `controlled_substance_schedule`. */
export const ControlledSubstanceSchedule = Type.Union([
  Type.Literal("CII"),
  Type.Literal("CIII"),
  Type.Literal("CIV"),
  Type.Literal("CV"),
]);

/** `m21_vendor_routing_scope_kind` (D4). `platform` is absent by design: a tenant may never author a
 *  platform-scope rule, and the RLS write policy would refuse it anyway (§3.1.5). */
export const VendorRoutingScopeKind = Type.Union([
  Type.Literal("sku"),
  Type.Literal("location"),
  Type.Literal("tenant"),
]);

/** `m21_fulfillment_mode` (D4). Only `vendor` requires a non-null vendor id; on the other three a null
 *  vendor is CORRECT, not an unresolved routing failure (§3.1.5's `m21_routing_rule_vendor_mode` CHECK). */
export const SupplyFulfillmentMode = Type.Union([
  Type.Literal("vendor"),
  Type.Literal("internal_supply_hub"),
  Type.Literal("partner_pharmacy"),
  Type.Literal("dosespot_to_partner_pharmacy"),
]);

/** `m21_supply_sku_class` (D11 — the HCPCS letter family). */
export const SupplySkuClass = Type.Union([
  Type.Literal("E"),
  Type.Literal("A"),
  Type.Literal("B"),
  Type.Literal("K"),
  Type.Literal("L"),
  Type.Literal("Q"),
  Type.Literal("internal"),
]);

// ── path params ──────────────────────────────────────────────────────────────────────────────────────

export const IdParams = Type.Object({ id: Uuid });
export const RequestIdParams = Type.Object({ supplyRequestId: Uuid });
export const DispatchIdParams = Type.Object({ dispatchId: Uuid });
export const ReturnIdParams = Type.Object({ returnId: Uuid });
export const TemplateIdParams = Type.Object({ templateId: Uuid });
export const RuleIdParams = Type.Object({ ruleId: Uuid });
export const ParStockIdParams = Type.Object({ parStockId: Uuid });

// ── list queries ─────────────────────────────────────────────────────────────────────────────────────

const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
};

export const ListSupplyRequestsQuery = Type.Object({
  ...PageQuery,
  patientId: UuidN,
  status: Type.Optional(SupplyRequestStatus),
  kind: Type.Optional(SupplyRequestKind),
  locationId: UuidN,
  /** `true` narrows to the §2.2 non-terminal set (the dashboard's default view). */
  openOnly: Type.Optional(Type.Boolean()),
});

export const ListDispatchesQuery = Type.Object({
  ...PageQuery,
  patientId: UuidN,
  locationId: UuidN,
  ipuRoomId: UuidN,
});

export const ListReturnsQuery = Type.Object({
  ...PageQuery,
  patientId: UuidN,
  /** `true` narrows to the §2.6 open set — what the reconciliation worklist actually shows. */
  openOnly: Type.Optional(Type.Boolean()),
  /** `true` narrows to rows past `return_due_at` (the 30d compliance boundary). */
  overdueOnly: Type.Optional(Type.Boolean()),
});

export const ListSupplyItemsQuery = Type.Object({
  ...PageQuery,
  skuClass: Type.Optional(SupplySkuClass),
  /** Free-text prefix over `name` / `hcpcs`. Not PHI — this is a catalog of hospital beds and briefs. */
  q: Type.Optional(Type.String({ maxLength: 128 })),
  includeRetired: Type.Optional(Type.Boolean()),
});

export const ListTemplatesQuery = Type.Object({
  ...PageQuery,
  /** `false` hides the D3 platform-floor row; the admin screen shows it, a picker does not. */
  includePlatformFloor: Type.Optional(Type.Boolean()),
  includeSuperseded: Type.Optional(Type.Boolean()),
});

export const ListRoutingRulesQuery = Type.Object({
  ...PageQuery,
  scopeKind: Type.Optional(VendorRoutingScopeKind),
  includeRetired: Type.Optional(Type.Boolean()),
});

export const ListParStockQuery = Type.Object({
  ...PageQuery,
  locationId: UuidN,
  /** `true` narrows to rows at or below `reorder_point` — the replenishment worklist. */
  belowThresholdOnly: Type.Optional(Type.Boolean()),
});

export const PerpetualLogQuery = Type.Object({
  dispatchedContentId: UuidN,
});

// ── §4.2.1 create supply request ─────────────────────────────────────────────────────────────────────

/** D7 / §4.2.1 — the delivery-address snapshot frozen onto the request. */
export const DeliveryAddress = Type.Object({
  line1: Type.String({ minLength: 1, maxLength: 255 }),
  line2: Type.Optional(Type.String({ maxLength: 255 })),
  city: Type.String({ minLength: 1, maxLength: 128 }),
  state: Type.String({ minLength: 2, maxLength: 2 }),
  postalCode: Type.String({ minLength: 5, maxLength: 10 }),
});

/**
 * The per-kind payload shell. Only the discriminator is asserted here; the full D1 schema is enforced by
 * `validateSupplyRequestData` in the write service (see the module header for why there is one copy).
 */
export const KindPayloadShell = Type.Object(
  { kind: SupplyRequestKind },
  { additionalProperties: true },
);

export const CreateSupplyRequestBody = Type.Object({
  patientId: Uuid,
  admissionId: Uuid,
  locationId: Uuid,
  sourceOrderId: UuidN,
  deliveryAddress: DeliveryAddress,
  deliveryInstructions: Type.Optional(FreeText(1000)),
  kindPayload: KindPayloadShell,
});

// ── §2.2 transition bodies ───────────────────────────────────────────────────────────────────────────

/** D4 — a coordinator's manual override of the auto-routed vendor. `vendorId` null routes to the internal
 *  hub, which is why it is nullable rather than absent-or-uuid. */
export const AssignVendorBody = Type.Object({
  vendorId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  fulfillmentMode: SupplyFulfillmentMode,
  pharmacyDispatchMode: Type.Optional(PharmacyDispatchMode),
  overrideReason: Type.Optional(FreeText()),
});

/**
 * §2.2 `placeOrderWithVendor`. The machine's event carries an optional `dispatchLineCount` for the kit
 * kinds, but the DISPATCH ITSELF is not created here: §4.1 gives it its own route
 * (`POST /comfort-kit-dispatches`), and that route is the one §4.4 gates with
 * `controlled_substance_dispatcher_eligible`. Folding a dispatch body into this transition would let a
 * caller who holds only `supplies.request.mark_ordered` ship a kit of scheduled drugs through the side
 * door — the permission that gates a supply PO is not the permission that gates a CII movement.
 */
export const MarkOrderedBody = Type.Object({
  vendorOrderReference: Type.String({ minLength: 1, maxLength: 128 }),
});

export const MarkInTransitBody = Type.Object({
  trackingNumber: Type.String({ minLength: 1, maxLength: 128 }),
  carrier: Type.String({ minLength: 1, maxLength: 128 }),
});

/** D7 — the courier attestation. `deliveredByMembershipId` is NOT here: the server stamps the acting
 *  membership (routes/actor.ts). A courier who could name someone else has attested to nothing. */
export const MarkDeliveredBody = Type.Object({
  deliveredAt: Instant,
  deliveryMethod: SupplyDeliveryMethod,
  evidenceDocumentId: UuidN,
});

export const ConfirmReceivedBody = Type.Object({
  actor: SupplyReceivedConfirmedActor,
  confirmedAt: Instant,
});

export const CancelRequestBody = Type.Object({
  reason: FreeText(),
});

export const ReturnRequestBody = Type.Object({
  reason: FreeText(),
});

// ── §4.1 catalog bodies ──────────────────────────────────────────────────────────────────────────────

/** D11 — the PLATFORM catalog row. Platform-only (`supplies.item.write`); `supply_item` has no org. */
export const CreateSupplyItemBody = Type.Object({
  hcpcs: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
  rxnorm: Type.Optional(Type.String({ maxLength: 32 })),
  ndc: Type.Optional(Type.String({ maxLength: 32 })),
  name: Type.String({ minLength: 1, maxLength: 255 }),
  skuClass: SupplySkuClass,
  defaultUnit: Type.String({ minLength: 1, maxLength: 32 }),
  isBillable: Type.Optional(Type.Boolean()),
  isControlledSubstance: Type.Optional(Type.Boolean()),
  requiresLotTracking: Type.Optional(Type.Boolean()),
  requiresExpirationTracking: Type.Optional(Type.Boolean()),
  isSerializedAsset: Type.Optional(Type.Boolean()),
});

export const RetireSupplyItemBody = Type.Object({
  effectiveTo: Instant,
  reason: Type.Optional(FreeText()),
});

/** D11 — the TENANT overlay row (non-billable, agency-local). */
export const UpsertTenantSupplyItemBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  localSkuCode: Type.String({ minLength: 1, maxLength: 64 }),
  defaultUnit: Type.String({ minLength: 1, maxLength: 32 }),
  isBillable: Type.Optional(Type.Boolean()),
  isActive: Type.Optional(Type.Boolean()),
});

// ── §2.3 comfort-kit template bodies ─────────────────────────────────────────────────────────────────

/** One template medication line. `expectedQuantity` is a decimal string; `replenishmentThresholdPct` is a
 *  fraction in [0,1] and a tenant may only RAISE it above the floor (a higher threshold replenishes
 *  sooner = tighter). Enforced by `validateTenantTemplate` in `@wardenx/supplies`. */
export const TemplateMedicationInput = Type.Object({
  rxnorm: Type.String({ minLength: 1, maxLength: 32 }),
  ndc: Type.Optional(Type.String({ maxLength: 32 })),
  drugName: Type.String({ minLength: 1, maxLength: 255 }),
  strength: Type.String({ minLength: 1, maxLength: 64 }),
  dosageForm: Type.String({ minLength: 1, maxLength: 64 }),
  routeOfAdministration: Type.String({ minLength: 1, maxLength: 64 }),
  isControlledSubstance: Type.Boolean(),
  controlledSubstanceSchedule: Type.Optional(ControlledSubstanceSchedule),
  expectedQuantity: Decimal,
  expectedUnit: Type.String({ minLength: 1, maxLength: 32 }),
  replenishmentThresholdPct: Type.Optional(Decimal),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
  notes: Type.Optional(FreeText()),
});

export const CreateTemplateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  medications: Type.Array(TemplateMedicationInput, { minItems: 1, maxItems: 16 }),
  stateLabelingPolicy: Type.Optional(Type.Object({}, { additionalProperties: true })),
  controlledSubstanceHandlingPolicy: Type.Optional(
    Type.Object({}, { additionalProperties: true }),
  ),
});

/**
 * §2.3 — a template edit is a SUPERSESSION, never an in-place mutation: the new row points back through
 * `replaces_template_id` so a dispatch from three months ago still resolves the recipe it actually used.
 * That is why this body is the full new definition and not a patch.
 */
export const SupersedeTemplateBody = Type.Object({
  ...CreateTemplateBody.properties,
  effectiveFrom: Type.Optional(Instant),
});

// ── §2.5 dispatch bodies ─────────────────────────────────────────────────────────────────────────────

/** One dispatched line. `lotNumber` + `expirationDate` are REQUIRED on a controlled line (§3.1.9's CHECK
 *  and the §2.5 refusal `M21_LOT_NUMBER_REQUIRED`); the schema keeps them optional so the DOMAIN raises
 *  the typed refusal with its own code rather than the boundary raising a generic 422. */
export const DispatchLineInput = Type.Object({
  comfortKitTemplateMedicationId: Uuid,
  medicationOrderId: UuidN,
  dispatchedQuantity: Decimal,
  dispatchedUnit: Type.String({ minLength: 1, maxLength: 32 }),
  lotNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  expirationDate: Type.Optional(LocalDate),
  manufacturerNdc: Type.Optional(Type.String({ maxLength: 32 })),
});

export const CreateDispatchBody = Type.Object({
  supplyRequestId: Uuid,
  comfortKitTemplateId: Uuid,
  locationId: Uuid,
  deploymentSite: ComfortKitDeploymentSite,
  ipuRoomId: UuidN,
  facilityIdentifier: Type.Optional(
    Type.Object({
      facilityName: Type.String({ maxLength: 255 }),
      facilityNpi: Type.Optional(Type.String({ pattern: "^[0-9]{10}$" })),
      roomNumber: Type.Optional(Type.String({ maxLength: 32 })),
    }),
  ),
  dispatchSource: ComfortKitDispatchSource,
  pharmacyDispatchMode: PharmacyDispatchMode,
  pharmacyPartnerId: UuidN,
  kitSerialNumber: Type.String({ minLength: 1, maxLength: 64 }),
  contents: Type.Array(DispatchLineInput, { minItems: 1, maxItems: 16 }),
  specialHandlingNotes: Type.Optional(FreeText()),
});

export const DeployAtPatientBody = Type.Object({
  deployedAt: Instant,
});

// ── §2.6 return + reconciliation bodies ──────────────────────────────────────────────────────────────

export const CreateReturnBody = Type.Object({
  dispatchId: Uuid,
  returnReason: FreeText(),
  returnRequiredAt: Type.Optional(Instant),
});

export const AssignRetrieverBody = Type.Object({
  retrievingMembershipId: Uuid,
});

/**
 * §4.2.2 — the per-line reconciliation. §4.2.2's own sketch types the quantities as `Type.Number`; the
 * columns are `numeric` and the D8 math runs in Decimal, so this uses decimal STRINGS (header note).
 *
 * `consumedQuantity` from §4.2.2 is NOT accepted: §3.1's `m21_compute_return_discrepancy()` derives the
 * unaccounted quantity from `dispatched - returned - disposedAtHome`, and there is no consumed column to
 * write it to. Accepting a number the schema cannot store would let a reconciler believe they had
 * explained a shortfall they had only described.
 */
export const ReconcileLineInput = Type.Object({
  dispatchedContentId: Uuid,
  quantityReturned: Decimal,
  quantityDisposedAtHome: Decimal,
  discrepancyExplanation: Type.Optional(FreeText(1000)),
});

export const ReconcileReturnBody = Type.Object({
  disposalMethod: ComfortKitDisposalMethod,
  /** REQUIRED for `dispose_at_home_by_witnessed_destruction` (§3.1.10 CHECK + §4.4(c)); the domain raises
   *  `M21_WITNESS_REQUIRED_FOR_CONTROLLED_SUBSTANCE` rather than the boundary raising a generic 422. This
   *  is the ONE membership id a client may supply — a witness is by definition a second person. */
  disposalWitnessMembershipId: UuidN,
  perMedicationReconciliation: Type.Array(ReconcileLineInput, { minItems: 1, maxItems: 16 }),
  disposalNotes: Type.Optional(FreeText(1000)),
  discrepancyNotes: Type.Optional(FreeText(1000)),
});

/** §2.6 — the 90-day assumption-of-loss disposition. §3.1.10's CHECK requires both fields. */
export const DeclareUnreturnableBody = Type.Object({
  reason: FreeText(1000),
});

// ── §2.4 vendor-routing bodies ───────────────────────────────────────────────────────────────────────

export const UpsertRoutingRuleBody = Type.Object({
  scopeKind: VendorRoutingScopeKind,
  /** skuId for `sku`, locationId for `location`; absent for `tenant` (§3.1.5's CHECK). */
  scopeId: UuidN,
  skuClassPattern: Type.Optional(Type.String({ maxLength: 64 })),
  assignedVendorId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  assignedFulfillmentMode: SupplyFulfillmentMode,
  defaultPharmacyDispatchMode: Type.Optional(PharmacyDispatchMode),
  precedencePriority: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
});

// ── §2.7 par-stock bodies ────────────────────────────────────────────────────────────────────────────

export const UpdateParStockBody = Type.Object({
  reorderPoint: Type.Optional(Decimal),
  reorderQuantity: Type.Optional(Decimal),
  minSafetyStock: Type.Optional(Decimal),
  isActive: Type.Optional(Type.Boolean()),
  reorderNotes: Type.Optional(FreeText()),
});

/**
 * §2.7 — record an on-hand count. The observation SETS the quantity; it does not adjust it. A hub worker
 * counting a shelf knows what is on it, not what changed since the last count, and an adjustment-shaped
 * API would drift from the shelf every time a count was missed.
 */
export const ObserveParStockBody = Type.Object({
  parStockId: Uuid,
  observedQuantity: Decimal,
  observedAt: Type.Optional(Instant),
  reorderNotes: Type.Optional(FreeText()),
});

export type CreateSupplyRequestBody = Static<typeof CreateSupplyRequestBody>;
export type AssignVendorBody = Static<typeof AssignVendorBody>;
export type MarkOrderedBody = Static<typeof MarkOrderedBody>;
export type MarkInTransitBody = Static<typeof MarkInTransitBody>;
export type MarkDeliveredBody = Static<typeof MarkDeliveredBody>;
export type ConfirmReceivedBody = Static<typeof ConfirmReceivedBody>;
export type CancelRequestBody = Static<typeof CancelRequestBody>;
export type ReturnRequestBody = Static<typeof ReturnRequestBody>;
export type CreateSupplyItemBody = Static<typeof CreateSupplyItemBody>;
export type RetireSupplyItemBody = Static<typeof RetireSupplyItemBody>;
export type UpsertTenantSupplyItemBody = Static<typeof UpsertTenantSupplyItemBody>;
export type CreateTemplateBody = Static<typeof CreateTemplateBody>;
export type SupersedeTemplateBody = Static<typeof SupersedeTemplateBody>;
export type CreateDispatchBody = Static<typeof CreateDispatchBody>;
export type DeployAtPatientBody = Static<typeof DeployAtPatientBody>;
export type CreateReturnBody = Static<typeof CreateReturnBody>;
export type AssignRetrieverBody = Static<typeof AssignRetrieverBody>;
export type ReconcileReturnBody = Static<typeof ReconcileReturnBody>;
export type DeclareUnreturnableBody = Static<typeof DeclareUnreturnableBody>;
export type UpsertRoutingRuleBody = Static<typeof UpsertRoutingRuleBody>;
export type UpdateParStockBody = Static<typeof UpdateParStockBody>;
export type ObserveParStockBody = Static<typeof ObserveParStockBody>;
export type ListSupplyRequestsQuery = Static<typeof ListSupplyRequestsQuery>;
export type ListDispatchesQuery = Static<typeof ListDispatchesQuery>;
export type ListReturnsQuery = Static<typeof ListReturnsQuery>;
export type ListSupplyItemsQuery = Static<typeof ListSupplyItemsQuery>;
export type ListTemplatesQuery = Static<typeof ListTemplatesQuery>;
export type ListRoutingRulesQuery = Static<typeof ListRoutingRulesQuery>;
export type ListParStockQuery = Static<typeof ListParStockQuery>;

// ── §4.2 RESPONSE DTOs (M21-T06 OpenAPI enrichment) ─────────────────────────────────────────────────
// The §4.1 read + write routes returned typed service views (`SupplyRequestDetail`, `CursorPage<…>`, …)
// but published NO response contract, so the generated client typed every M21 body as `never`. These DTOs
// mirror the read-/write-service views 1:1 and are pinned to them by the compile-time `Conforms` aliases at
// the foot of this section, so a view field added or renamed breaks `bun run build` rather than silently
// drifting from the client. Every enum-shaped field reuses the frozen union declared above — a DTO that
// widened one to `Type.String()` is the "silent lie" the read-service header warns about. `*_pct` fields
// mirror the column type EXACTLY: the dispatched-content one is a FRACTION-valued `number` (§2.5), the
// template/returned-line ones are decimal STRINGS — published as-is, never re-shaped.
import type {
  ComfortKitDispatchedContentPayload as TComfortKitDispatchedContentPayload,
  DeaPerpetualLogEntry as TDeaPerpetualLogEntry,
  RoutingRuleResolved as TRoutingRuleResolved,
} from "@wardenx/types";

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Str = Type.String();
const NStr = Nullable(Type.String());
const Bool = Type.Boolean();
const Int = Type.Integer();
const Num = Type.Number();

/** The §2.4 D4 routing record frozen onto a request (`routing_rule_resolved_jsonb`). */
export const RoutingRuleResolvedSchema = Type.Object({
  resolverVersion: Str,
  resolvedAt: Str,
  precedenceLevelUsed: VendorRoutingScopeKind,
  matchedRuleId: NStr,
  assignedVendorId: NStr,
  assignedFulfillmentMode: SupplyFulfillmentMode,
  defaultPharmacyDispatchMode: Nullable(PharmacyDispatchMode),
  candidatesEvaluated: Type.Array(
    Type.Object({
      precedenceLevel: VendorRoutingScopeKind,
      ruleId: NStr,
      matched: Bool,
      reason: Str,
    }),
  ),
  routingPolicyDigest: Str,
});

/** §4.1 rows 2 / 3 — one supply request on the dashboard list (no D13 free text). */
export const SupplyRequestListItemSchema = Type.Object({
  supplyRequestId: Str,
  patientId: Str,
  locationId: Str,
  kind: SupplyRequestKind,
  status: SupplyRequestStatus,
  assignedVendorId: NStr,
  vendorOrderReference: NStr,
  trackingNumber: NStr,
  carrier: NStr,
  orderedAt: NStr,
  deliveredAt: NStr,
  createdAt: Str,
  updatedAt: Str,
});

/** §4.1 row 3 — the full request, with the D13 free text and the frozen D4 routing record. */
export const SupplyRequestDetailSchema = Type.Object({
  ...SupplyRequestListItemSchema.properties,
  admissionId: Str,
  providerEntityId: Str,
  sourceOrderId: NStr,
  sourceReplenishmentEventId: NStr,
  requestedByMembershipId: NStr,
  data: Type.Unknown(),
  routingRuleResolved: Nullable(RoutingRuleResolvedSchema),
  pharmacyPartnerId: NStr,
  documentId: NStr,
  deliveryInstructions: NStr,
  deliveryMethod: Nullable(SupplyDeliveryMethod),
  deliveredByMembershipId: NStr,
  deliveryEvidenceDocumentId: NStr,
  receivedConfirmedAt: NStr,
  receivedConfirmedActor: Nullable(
    Type.Union([...SupplyReceivedConfirmedActor.anyOf, Type.Literal("system_auto_confirm")]),
  ),
  completedAt: NStr,
  cancelledAt: NStr,
  cancellationPendingAt: NStr,
  cancellationReason: NStr,
  shippedAt: NStr,
  invoiceTotalCents: Nullable(Num),
  invoiceAccruedAt: NStr,
  invoiceReconciledAt: NStr,
  invoiceVarianceCents: Nullable(Num),
  dispatchId: NStr,
});

/** §4.2.1's create response — the created request plus the D4 resolution the router froze onto it. */
export const CreateSupplyRequestResultSchema = Type.Object({
  supplyRequestId: Str,
  status: Type.Literal("requested"),
  routingRuleResolved: Nullable(RoutingRuleResolvedSchema),
  updatedAt: Str,
});

/** §4.1 rows 11 / 13 — a catalog SKU (platform row or tenant overlay). */
export const SupplyItemViewSchema = Type.Object({
  supplyItemId: Str,
  isPlatform: Bool,
  hcpcs: NStr,
  rxnorm: NStr,
  ndc: NStr,
  name: Str,
  skuClass: SupplySkuClass,
  defaultUnit: Str,
  isBillable: Bool,
  isActive: Bool,
  isControlledSubstance: Nullable(Bool),
  requiresLotTracking: Nullable(Bool),
  requiresExpirationTracking: Nullable(Bool),
  isSerializedAsset: Nullable(Bool),
  effectiveFrom: Str,
  effectiveTo: NStr,
  localSkuCode: NStr,
  updatedAt: Str,
});

/** One line of a §2.3 comfort-kit template. `replenishmentThresholdPct` is a decimal STRING here. */
export const ComfortKitTemplateMedicationViewSchema = Type.Object({
  templateMedicationId: Str,
  rxnorm: Str,
  ndc: NStr,
  drugName: Str,
  strength: Str,
  dosageForm: Str,
  routeOfAdministration: Str,
  isControlledSubstance: Bool,
  controlledSubstanceSchedule: Nullable(ControlledSubstanceSchedule),
  expectedQuantity: Str,
  expectedUnit: Str,
  replenishmentThresholdPct: Str,
  systemLocked: Bool,
  displayOrder: Int,
});

/** §4.1 row 17 — a comfort-kit template with its lines. */
export const ComfortKitTemplateViewSchema = Type.Object({
  comfortKitTemplateId: Str,
  name: Str,
  isPlatformFloor: Bool,
  systemLocked: Bool,
  effectiveFrom: Str,
  effectiveTo: NStr,
  replacesTemplateId: NStr,
  medications: Type.Array(ComfortKitTemplateMedicationViewSchema),
  updatedAt: Str,
});

/** One dispatched line on the DEA 1304 manifest. `replenishmentThresholdPct` is a FRACTION-valued number. */
export const ComfortKitDispatchedContentSchema = Type.Object({
  dispatchedContentId: Str,
  comfortKitTemplateMedicationId: Str,
  medicationOrderId: NStr,
  rxnorm: Str,
  ndc: NStr,
  drugName: Str,
  strength: Str,
  dosageForm: Str,
  routeOfAdministration: Str,
  isControlledSubstance: Bool,
  controlledSubstanceSchedule: Nullable(ControlledSubstanceSchedule),
  dispatchedQuantity: Str,
  dispatchedUnit: Str,
  lotNumber: NStr,
  expirationDate: NStr,
  manufacturerNdc: NStr,
  replenishmentThresholdPct: Num,
});

/** §4.1 rows 21 / 22 — one comfort-kit dispatch on the list (no free text). */
export const DispatchListItemSchema = Type.Object({
  dispatchId: Str,
  supplyRequestId: Str,
  patientId: Str,
  locationId: Str,
  comfortKitTemplateId: Str,
  kitSerialNumber: Str,
  deploymentSite: ComfortKitDeploymentSite,
  dispatchStatus: Type.Union([
    Type.Literal("dispatched"),
    Type.Literal("deployed_at_patient"),
    Type.Literal("partially_returned"),
    Type.Literal("fully_returned"),
    Type.Literal("reconciled"),
    Type.Literal("reconciled_with_discrepancy"),
  ]),
  ipuRoomId: NStr,
  dispatchedAt: Str,
  deployedAtPatientAt: NStr,
  containsControlledSubstance: Bool,
  updatedAt: Str,
});

/** §4.1 row 22 — the full dispatch, incl. the per-line DEA 1304 outbound manifest. */
export const DispatchDetailSchema = Type.Object({
  ...DispatchListItemSchema.properties,
  admissionId: Str,
  providerEntityId: Str,
  dispatchSource: ComfortKitDispatchSource,
  pharmacyDispatchMode: PharmacyDispatchMode,
  pharmacyPartnerId: NStr,
  dispatchedByMembershipId: Str,
  deployedByMembershipId: NStr,
  bolDocumentId: NStr,
  m13DeploymentId: NStr,
  controlledSubstanceHandlingPolicyDigest: Str,
  facilityIdentifier: Type.Unknown(),
  specialHandlingNotes: NStr,
  contents: Type.Array(ComfortKitDispatchedContentSchema),
});

/** §4.1 rows 25 / 26 — one comfort-kit return on the reconciliation worklist. */
export const ComfortKitReturnListItemSchema = Type.Object({
  returnId: Str,
  dispatchId: Str,
  patientId: Str,
  locationId: Str,
  state: Type.Union([
    Type.Literal("requested"),
    Type.Literal("assigned"),
    Type.Literal("retrieving"),
    Type.Literal("retrieved"),
    Type.Literal("reconciled"),
    Type.Literal("overdue"),
    Type.Literal("unreturnable"),
  ]),
  returnRequiredAt: Str,
  returnDueAt: Str,
  assignedRetrievingMembershipId: NStr,
  reconciledAt: NStr,
  containsControlledSubstance: Bool,
  daysOverdue: Num,
  updatedAt: Str,
});

/** One reconciled line — the D8 discrepancy columns are trigger-computed decimal STRINGS (read, never sent). */
export const ComfortKitReturnedLineViewSchema = Type.Object({
  returnedContentId: Str,
  dispatchedContentId: Str,
  drugName: Str,
  lotNumber: NStr,
  isControlledSubstance: Bool,
  controlledSubstanceSchedule: Nullable(ControlledSubstanceSchedule),
  dispatchedQuantity: Str,
  quantityReturned: Str,
  quantityDisposedAtHome: Str,
  quantityUnaccounted: Str,
  discrepancyPct: Str,
  discrepancyFlagged: Bool,
});

/** §4.1 row 26 — the full return with per-line accounting and the disposal record. */
export const ComfortKitReturnDetailSchema = Type.Object({
  ...ComfortKitReturnListItemSchema.properties,
  admissionId: Str,
  providerEntityId: Str,
  m13DeploymentId: Str,
  retrievingAt: NStr,
  retrievedAt: NStr,
  returnedToHubAt: NStr,
  disposalMethod: Nullable(ComfortKitDisposalMethod),
  disposalWitnessMembershipId: NStr,
  disposalMethodJurisdictionPolicyDigest: NStr,
  reconciledByMembershipId: NStr,
  receiptDocumentId: NStr,
  disposalNotes: NStr,
  discrepancyNotes: NStr,
  unreturnableReason: NStr,
  unreturnableAttestedByMembershipId: NStr,
  lines: Type.Array(ComfortKitReturnedLineViewSchema),
  discrepancyDetected: Bool,
});

/** §4.2.2's reconcile response — the verdict, with the per-line accounting the DEA log records. */
export const ReconcileReturnResultSchema = Type.Object({
  returnId: Str,
  state: Type.Literal("reconciled"),
  discrepancyDetected: Bool,
  perMedication: Type.Array(ComfortKitReturnedLineViewSchema),
  updatedAt: Str,
});

/** §4.1 row 28 — a D4 routing rule. */
export const VendorRoutingRuleViewSchema = Type.Object({
  ruleId: Str,
  isPlatform: Bool,
  scopeKind: VendorRoutingScopeKind,
  scopeId: NStr,
  skuClassPattern: NStr,
  assignedVendorId: NStr,
  assignedFulfillmentMode: SupplyFulfillmentMode,
  defaultPharmacyDispatchMode: Nullable(PharmacyDispatchMode),
  precedencePriority: Num,
  isActive: Bool,
  effectiveFrom: Str,
  effectiveTo: NStr,
  updatedAt: Str,
});

/** §4.1 row 32 — one shelf row plus its DERIVED severity band. */
export const ParStockViewSchema = Type.Object({
  parStockId: Str,
  locationId: Str,
  skuId: NStr,
  tenantSkuExtensionId: NStr,
  skuName: Str,
  currentQuantity: Str,
  unit: Str,
  reorderPoint: Str,
  reorderQuantity: Str,
  minSafetyStock: Str,
  severity: Type.Union([
    Type.Literal("ok"),
    Type.Literal("below_threshold"),
    Type.Literal("critical_low"),
    Type.Literal("depleted"),
  ]),
  isActive: Bool,
  lastParReviewAt: NStr,
  lastParReviewedByMembershipId: NStr,
  reorderNotes: NStr,
  updatedAt: Str,
});

/** §8.1 — the DEA 21 CFR §1304 perpetual-log entry for one dispatched line. */
export const DeaPerpetualLogEntrySchema = Type.Object({
  transactionKind: Type.Union([
    Type.Literal("dispense"),
    Type.Literal("administer_drawdown"),
    Type.Literal("return"),
    Type.Literal("disposal"),
    Type.Literal("adjustment"),
  ]),
  quantityDelta: Str,
  balanceAfterQuantity: Str,
  unit: Str,
  recordedByMembershipId: Str,
  witnessMembershipId: NStr,
  occurredAt: Str,
  sourceReference: NStr,
});

/** §8.1 — the perpetual log for one dispatched line, oldest entry first. */
export const PerpetualLogLineViewSchema = Type.Object({
  dispatchedContentId: Str,
  drugName: Str,
  lotNumber: NStr,
  controlledSubstanceSchedule: Nullable(ControlledSubstanceSchedule),
  dispatchedQuantity: Str,
  dispatchedUnit: Str,
  expirationDate: NStr,
  entries: Type.Array(DeaPerpetualLogEntrySchema),
});

/** §8.1 — the whole kit's perpetual log, the unit an inspector actually asks for. */
export const PerpetualLogViewSchema = Type.Object({
  dispatchId: Str,
  kitSerialNumber: Str,
  dispatchedAt: Str,
  dispatchedByMembershipId: Str,
  lines: Type.Array(PerpetualLogLineViewSchema),
});

/** The cursor-paginated envelope the list reads return (`concurrency.ts` `CursorPage<T>`). */
const Page = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    next_cursor: NStr,
    has_more: Bool,
    total_count: Type.Optional(Int),
  });

export const SupplyRequestListResponseSchema = Page(SupplyRequestListItemSchema);
export const SupplyItemListResponseSchema = Page(SupplyItemViewSchema);
export const ComfortKitTemplateListResponseSchema = Page(ComfortKitTemplateViewSchema);
export const DispatchListResponseSchema = Page(DispatchListItemSchema);
export const ComfortKitReturnListResponseSchema = Page(ComfortKitReturnListItemSchema);
export const VendorRoutingRuleListResponseSchema = Page(VendorRoutingRuleViewSchema);
export const ParStockListResponseSchema = Page(ParStockViewSchema);

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _RoutingRuleResolved = Conforms<Static<typeof RoutingRuleResolvedSchema>, TRoutingRuleResolved>;
type _DispatchedContent = Conforms<
  Static<typeof ComfortKitDispatchedContentSchema>,
  TComfortKitDispatchedContentPayload
>;
type _PerpetualEntry = Conforms<Static<typeof DeaPerpetualLogEntrySchema>, TDeaPerpetualLogEntry>;
type _SupplyRequestListItem = Conforms<
  Static<typeof SupplyRequestListItemSchema>,
  ServiceSupplyRequestListItem
>;
type _SupplyRequestDetail = Conforms<
  Static<typeof SupplyRequestDetailSchema>,
  ServiceSupplyRequestDetail
>;
type _CreateSupplyRequestResult = Conforms<
  Static<typeof CreateSupplyRequestResultSchema>,
  ServiceCreateSupplyRequestResult
>;
type _SupplyItemView = Conforms<Static<typeof SupplyItemViewSchema>, ServiceSupplyItemView>;
type _ComfortKitTemplateMedicationView = Conforms<
  Static<typeof ComfortKitTemplateMedicationViewSchema>,
  ServiceComfortKitTemplateMedicationView
>;
type _ComfortKitTemplateView = Conforms<
  Static<typeof ComfortKitTemplateViewSchema>,
  ServiceComfortKitTemplateView
>;
type _DispatchListItem = Conforms<Static<typeof DispatchListItemSchema>, ServiceDispatchListItem>;
type _DispatchDetail = Conforms<Static<typeof DispatchDetailSchema>, ServiceDispatchDetail>;
type _ComfortKitReturnListItem = Conforms<
  Static<typeof ComfortKitReturnListItemSchema>,
  ServiceComfortKitReturnListItem
>;
type _ComfortKitReturnedLineView = Conforms<
  Static<typeof ComfortKitReturnedLineViewSchema>,
  ServiceComfortKitReturnedLineView
>;
type _ComfortKitReturnDetail = Conforms<
  Static<typeof ComfortKitReturnDetailSchema>,
  ServiceComfortKitReturnDetail
>;
type _ReconcileReturnResult = Conforms<
  Static<typeof ReconcileReturnResultSchema>,
  ServiceReconcileReturnResult
>;
type _VendorRoutingRuleView = Conforms<
  Static<typeof VendorRoutingRuleViewSchema>,
  ServiceVendorRoutingRuleView
>;
type _ParStockView = Conforms<Static<typeof ParStockViewSchema>, ServiceParStockView>;
type _PerpetualLogLineView = Conforms<
  Static<typeof PerpetualLogLineViewSchema>,
  ServicePerpetualLogLineView
>;
type _PerpetualLogView = Conforms<Static<typeof PerpetualLogViewSchema>, ServicePerpetualLogView>;
