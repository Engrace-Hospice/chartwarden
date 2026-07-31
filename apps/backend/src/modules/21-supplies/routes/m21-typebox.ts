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
