import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/26-cap — M26 Cap Management screen registration (R2, ADR-0030, §5). The read surface
// over the live /api/v1/cap/* + /api/v1/platform/cap/* backend (27 routes). Each `requiredPermission` is the
// REAL §4.6 M26 key the matching route gates on (already in packages/auth/src/permissions/contributed.ts via
// Phase 3) — the server stays the authoritative enforcer; this gates nav visibility only. The five tenant
// surfaces sit under "Billing" (revenue cycle); the platform-constant admin sits under "Platform".
import type { ComponentType } from "react";
import { CapDashboard } from "./cap-dashboard";
import { CapEvents } from "./cap-events";
import { CapPeriods } from "./cap-periods";
import { CapPlatformConstants } from "./cap-platform-constants";
import { CapPsrWorkbench } from "./cap-psr-workbench";
import { CapSettlement } from "./cap-settlement";

export const capScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 26,
  slug: "26-cap",
  screens: [
    {
      id: "cap.dashboard",
      path: "/cap",
      title: "Cap Watch",
      navGroup: "Billing",
      requiredPermission: "cap.projection.read",
      screen: CapDashboard,
    },
    {
      id: "cap.periods",
      path: "/cap/periods",
      title: "Cap Periods",
      navGroup: "Billing",
      requiredPermission: "cap.period.read",
      screen: CapPeriods,
    },
    {
      id: "cap.events",
      path: "/cap/events",
      title: "Threshold Events",
      navGroup: "Billing",
      requiredPermission: "cap.event.read",
      screen: CapEvents,
    },
    {
      id: "cap.settlement",
      path: "/cap/settlements",
      title: "Settlement",
      navGroup: "Billing",
      requiredPermission: "cap.settlement.read",
      screen: CapSettlement,
    },
    {
      id: "cap.psr",
      path: "/cap/psr",
      title: "PS&R Reconciliation",
      navGroup: "Billing",
      requiredPermission: "cap.psr.read",
      screen: CapPsrWorkbench,
    },
    {
      id: "cap.platform_constants",
      path: "/platform/cap/constants",
      title: "Cap Constants",
      navGroup: "Platform",
      requiredPermission: "cap.platform_constant.read",
      screen: CapPlatformConstants,
    },
  ],
};
