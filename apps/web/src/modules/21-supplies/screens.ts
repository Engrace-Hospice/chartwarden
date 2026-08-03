import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/21-supplies — M21 Supplies / DME / Comfort-Kit screen registration
// (Track B / ADR-0030, §5.1). The read + write surface over the live /api/v1/supplies backend
// (37 routes, M21-T05).
//
// Each `requiredPermission` is the REAL §4.3 M21 key the matching route gates on
// (apps/backend/src/modules/21-supplies/permission-keys.ts → `M21_CONTRIBUTED_PERMISSIONS` in
// @wardenx/auth) — this gates NAV VISIBILITY only; the server stays the authoritative enforcer, and a row
// outside the caller's organization is a non-leaking 404 from the server, never a frontend hide.
//
// THE PERPETUAL LOG IS A SEPARATE ENTRY BECAUSE IT IS A SEPARATE PERMISSION. §4.3 gives
// `comfort_kit.perpetual_log.read` its own `compliance`-category key, deliberately disjoint from
// `comfort_kit.dispatch.read`: a supply coordinator who may dispatch must not thereby acquire the lot-level
// DEA custody chain, and a compliance officer who reads it needs no dispatch permission at all. Nav gating
// is per-screen, so folding the log into the dispatch detail would have made the dispatch key the effective
// gate on the ledger — strictly wider than §4.3.
//
// §5.1's ceremonies are NOT separate registry entries. Assign-vendor, the five §2.2 transitions, the
// deploy/return edges, reconcile, declare-unreturnable, the par count and the routing-rule editor each live
// inside the parent screen that already read the row's `updated_at` — which is M21's `If-Match` value
// (§7.2; M21's tables have no version counter). A modal that had to re-read the row could act on a stamp
// that moved in between, and for a controlled-substance count "last write wins" means one of the two counts
// is silently gone.
//
// PATH SHAPE: §5.1's routes are followed verbatim (`/supplies/...`), which already matches the M15/M16/M17
// convention of mounting module screens at the shell root.
import { lazy } from "react";
import type { ComponentType } from "react";
const ComfortKitDispatchCreate = lazy(() =>
  import("./dispatch-create").then((m) => ({ default: m.ComfortKitDispatchCreate })),
);
const ComfortKitDispatchDetail = lazy(() =>
  import("./dispatch-detail").then((m) => ({ default: m.ComfortKitDispatchDetail })),
);
const ComfortKitPerpetualLog = lazy(() =>
  import("./perpetual-log").then((m) => ({ default: m.ComfortKitPerpetualLog })),
);
const ComfortKitReturnReconciliation = lazy(() =>
  import("./return-reconciliation").then((m) => ({ default: m.ComfortKitReturnReconciliation })),
);
const ComfortKitTemplateAdmin = lazy(() =>
  import("./comfort-kit-template-admin").then((m) => ({ default: m.ComfortKitTemplateAdmin })),
);
const ParStockAdmin = lazy(() =>
  import("./par-stock-admin").then((m) => ({ default: m.ParStockAdmin })),
);
const SupplyItemCatalog = lazy(() =>
  import("./supply-item-catalog").then((m) => ({ default: m.SupplyItemCatalog })),
);
const SupplyRequestDetailScreen = lazy(() =>
  import("./supply-request-detail").then((m) => ({ default: m.SupplyRequestDetailScreen })),
);
const SupplyTeamDashboard = lazy(() =>
  import("./supply-dashboard").then((m) => ({ default: m.SupplyTeamDashboard })),
);
const VendorRoutingAdmin = lazy(() =>
  import("./vendor-routing-admin").then((m) => ({ default: m.VendorRoutingAdmin })),
);

export const supplyScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 21,
  slug: "21-supplies",
  screens: [
    // --- S21.1: the module's nav entry point and the index for requests, dispatches and returns alike ---
    {
      id: "supplies.dashboard",
      path: "/supplies",
      title: "Supplies",
      navGroup: "Supplies",
      requiredPermission: "supplies.request.read",
      screen: SupplyTeamDashboard,
    },
    // --- S21.2: the §2.2 fulfillment machine over HTTP ---
    {
      id: "supplies.request",
      path: "/supplies/requests/:supplyRequestId",
      title: "Supply Request",
      requiredPermission: "supplies.request.read",
      screen: SupplyRequestDetailScreen,
    },
    // --- S21.3 / S21.4: the DEA 21 CFR §1304 dispatch surface ---
    {
      id: "supplies.dispatch.new",
      path: "/supplies/dispatches/new",
      title: "Dispatch a Comfort Kit",
      navGroup: "Supplies",
      requiredPermission: "comfort_kit.dispatch.create",
      screen: ComfortKitDispatchCreate,
    },
    {
      id: "supplies.dispatch",
      path: "/supplies/dispatches/:dispatchId",
      title: "Comfort-Kit Dispatch",
      requiredPermission: "comfort_kit.dispatch.read",
      screen: ComfortKitDispatchDetail,
    },
    {
      id: "supplies.dispatch.perpetual_log",
      path: "/supplies/dispatches/:dispatchId/perpetual-log",
      title: "DEA Perpetual Log",
      requiredPermission: "comfort_kit.perpetual_log.read",
      screen: ComfortKitPerpetualLog,
    },
    // --- S21.5: the §2.6 chain-of-custody close-out ---
    {
      id: "supplies.return",
      path: "/supplies/returns/:returnId",
      title: "Return Reconciliation",
      requiredPermission: "comfort_kit.return.read",
      screen: ComfortKitReturnReconciliation,
    },
    // --- S21.6 – S21.9: the agency operations + catalog surfaces (no patient appears on any of them) ---
    {
      id: "supplies.par_stock",
      path: "/supplies/par-stock",
      title: "Par Stock",
      navGroup: "Supplies",
      requiredPermission: "par_stock.read",
      screen: ParStockAdmin,
    },
    {
      id: "supplies.vendor_routing",
      path: "/supplies/vendor-routing",
      title: "Vendor Routing",
      navGroup: "Supplies",
      requiredPermission: "vendor_routing.read",
      screen: VendorRoutingAdmin,
    },
    {
      id: "supplies.comfort_kit_templates",
      path: "/supplies/comfort-kit-templates",
      title: "Comfort-Kit Templates",
      navGroup: "Supplies",
      requiredPermission: "comfort_kit.template.read",
      screen: ComfortKitTemplateAdmin,
    },
    {
      id: "supplies.items",
      path: "/supplies/items",
      title: "Supply Catalog",
      navGroup: "Supplies",
      requiredPermission: "supplies.item.read",
      screen: SupplyItemCatalog,
    },
  ],
};
