import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/31-portal - M31 staff screen registration (GAP-054, ADR-0030). The patient/family-facing
// screens live in apps/portal; these are the staff-side panes. Each `requiredPermission` is the REAL section 4.6
// M31 key the matching list route gates on (apps/backend/src/modules/31-portal/permission-keys.ts) - the server
// stays the authoritative enforcer; this only gates nav visibility.
import { lazy } from "react";
import type { ComponentType } from "react";
const PortalAdmin = lazy(() => import("./portal-admin").then((m) => ({ default: m.PortalAdmin })));
const TelehealthRoom = lazy(() =>
  import("./telehealth-room").then((m) => ({ default: m.TelehealthRoom })),
);

export const portalStaffScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 31,
  slug: "31-portal",
  screens: [
    {
      id: "portal.admin",
      path: "/admin/portal",
      title: "Portal access",
      navGroup: "Admin",
      requiredPermission: "portal.account.read_list",
      screen: PortalAdmin,
    },
    {
      id: "portal.telehealth",
      path: "/telehealth",
      title: "Telehealth visits",
      navGroup: "Clinical",
      requiredPermission: "telehealth.read_list",
      screen: TelehealthRoom,
    },
  ],
};
