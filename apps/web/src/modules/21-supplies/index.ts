// apps/web/src/modules/21-supplies — M21 Supplies / DME / Comfort-Kit web slice (Track B / ADR-0030, §5.1).
// The supply-team queue and the §2.2 fulfillment machine; the DEA 21 CFR §1304 comfort-kit dispatch, its
// per-lot perpetual log and the §2.6 return reconciliation; and the agency operations surfaces — the D4
// vendor-routing ladder, the D5 par shelf, the D3 kit templates and the D11 SKU catalog.
export { supplyScreens } from "./screens";
export { SupplyTeamDashboard } from "./supply-dashboard";
export { SupplyRequestDetailScreen } from "./supply-request-detail";
export { ComfortKitDispatchCreate } from "./dispatch-create";
export { ComfortKitDispatchDetail } from "./dispatch-detail";
export { ComfortKitPerpetualLog } from "./perpetual-log";
export { ComfortKitReturnReconciliation } from "./return-reconciliation";
export { ParStockAdmin } from "./par-stock-admin";
export { VendorRoutingAdmin } from "./vendor-routing-admin";
export { ComfortKitTemplateAdmin } from "./comfort-kit-template-admin";
export { SupplyItemCatalog } from "./supply-item-catalog";
