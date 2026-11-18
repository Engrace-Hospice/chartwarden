// modules-preview fixtures for M21 Supplies. Typed against the module's own wire shapes so a drifted field fails the
// typecheck instead of rendering blank. Every name and id is invented.
import { supplyScreens } from "../modules/21-supplies/screens";
import type {
  CursorPage,
  ParStockView,
  SupplyItemView,
  VendorRoutingRuleView,
} from "../modules/21-supplies/supplies-api";
import type { Fixtures } from "./mock-client";
import type { ModulePreview } from "./types";

const NOW = Date.now();
const iso = (days: number): string => new Date(NOW + days * 864e5).toISOString();
const page = <T>(data: T[]): CursorPage<T> => ({ data, next_cursor: null, has_more: false });

const item = (
  id: string,
  name: string,
  isPlatform: boolean,
  fields: Partial<SupplyItemView> = {},
): SupplyItemView => ({
  supplyItemId: id,
  isPlatform,
  hcpcs: isPlatform ? "E0250" : null,
  rxnorm: null,
  ndc: null,
  name,
  skuClass: isPlatform ? "E" : "internal",
  defaultUnit: "each",
  isBillable: isPlatform,
  isActive: true,
  isControlledSubstance: false,
  requiresLotTracking: false,
  requiresExpirationTracking: false,
  isSerializedAsset: false,
  effectiveFrom: iso(-200),
  effectiveTo: null,
  localSkuCode: isPlatform ? null : `LOCAL-${id}`,
  updatedAt: iso(-3),
  ...fields,
});

const items: SupplyItemView[] = [
  item("i1", "Hospital bed, semi-electric", true),
  item("i2", "Oxygen concentrator, 5 L", true, { hcpcs: "E1390", isSerializedAsset: true }),
  item("i3", "Morphine sulfate oral solution", true, {
    hcpcs: null,
    skuClass: "K",
    isControlledSubstance: true,
    requiresLotTracking: true,
    requiresExpirationTracking: true,
  }),
  item("i4", "Comfort cart linens set", false),
  item("i5", "Mouth care swabs, box of 100", false, { defaultUnit: "box" }),
];

const parStock: ParStockView[] = [
  ["p1", "Mouth care swabs, box of 100", "12", "box", "10", "ok"],
  ["p2", "Incontinence briefs, large", "6", "pack", "8", "below_threshold"],
  ["p3", "Nitrile gloves, medium", "1", "box", "4", "critical_low"],
].map(([id, name, qty, unit, reorder, severity]) => ({
  parStockId: id as string,
  locationId: "loc-1",
  skuId: null,
  tenantSkuExtensionId: `ext-${id}`,
  skuName: name as string,
  currentQuantity: qty as string,
  unit: unit as string,
  reorderPoint: reorder as string,
  reorderQuantity: "20",
  minSafetyStock: "2",
  severity: severity as ParStockView["severity"],
  isActive: true,
  lastParReviewAt: iso(-10),
  lastParReviewedByMembershipId: "m-lopez",
  reorderNotes: null,
  updatedAt: iso(-1),
}));

const rules: VendorRoutingRuleView[] = [
  ["r1", "tenant", null, "vendor", 100],
  ["r2", "sku", "i2", "internal_supply_hub", 50],
].map(([id, scope, scopeId, mode, priority]) => ({
  ruleId: id as string,
  isPlatform: false,
  scopeKind: scope as VendorRoutingRuleView["scopeKind"],
  scopeId: scopeId as string | null,
  skuClassPattern: null,
  assignedVendorId: mode === "vendor" ? "vendor-1" : null,
  assignedFulfillmentMode: mode as VendorRoutingRuleView["assignedFulfillmentMode"],
  defaultPharmacyDispatchMode: null,
  precedencePriority: priority as number,
  isActive: true,
  effectiveFrom: iso(-90),
  effectiveTo: null,
  updatedAt: iso(-2),
}));

const fixtures: Fixtures = {
  "/api/v1/supplies/supply-items": page(items),
  "/api/v1/supplies/par-stock": page(parStock),
  "/api/v1/supplies/vendor-routing-rules": page(rules),
};

export const preview21: ModulePreview = {
  screens: supplyScreens,
  fixtures,
  start: "/supplies/items",
  extraPermissions: [],
};
