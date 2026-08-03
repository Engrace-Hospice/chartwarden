import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/04-audit — M4 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const AuditLogViewer = lazy(() =>
  import("./audit-log-viewer").then((m) => ({ default: m.AuditLogViewer })),
);

export const auditScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 4,
  slug: "04-audit",
  screens: [
    {
      id: "audit.log-viewer",
      path: "/audit",
      title: "Audit Log",
      navGroup: "Admin",
      requiredPermission: "audit.read",
      screen: AuditLogViewer,
    },
  ],
};
