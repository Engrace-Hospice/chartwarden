import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/31-portal - M31 staff screen registration (GAP-054, ADR-0030). The patient/family-facing
// screens live in apps/portal; these are the staff-side panes. Each `requiredPermission` is the REAL section 4.6
// M31 key the matching list route gates on (apps/backend/src/modules/31-portal/permission-keys.ts) - the server
// stays the authoritative enforcer; this only gates nav visibility.
import { lazy } from "react";
import type { ComponentType } from "react";
const PortalAdmin = lazy(() => import("./portal-admin").then((m) => ({ default: m.PortalAdmin })));
const PatientSignatures = lazy(() =>
  import("./patient-signatures").then((m) => ({ default: m.PatientSignatures })),
);
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
      // ADR-0107: the patient chart's Signatures tab (send admission documents for portal signing, review uploaded copies). Reached from
      // the chart tab strip (param path, no nav).
      id: "portal.patient-signatures",
      path: "/patients/:patientId/signatures",
      title: "Signatures",
      requiredPermission: "portal.signature_request.read",
      screen: PatientSignatures,
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
