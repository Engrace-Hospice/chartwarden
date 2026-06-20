// apps/web/src/modules/04-audit — M4 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { AuditLogViewer } from "./audit-log-viewer";

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
