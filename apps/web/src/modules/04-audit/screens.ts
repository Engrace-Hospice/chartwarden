import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/04-audit — M4 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const AuditLogViewer = lazy(() =>
  import("./audit-log-viewer").then((m) => ({ default: m.AuditLogViewer })),
);
// GAP-003 — the 3 compliance screens the route surface had no UI for.
const LegalHolds = lazy(() => import("./legal-holds").then((m) => ({ default: m.LegalHolds })));
const AuditIntegrityReport = lazy(() =>
  import("./audit-integrity-report").then((m) => ({ default: m.AuditIntegrityReport })),
);
const PrivacyWorkQueue = lazy(() =>
  import("./privacy-work-queue").then((m) => ({ default: m.PrivacyWorkQueue })),
);
const AuditExports = lazy(() =>
  import("./audit-exports").then((m) => ({ default: m.AuditExports })),
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
    {
      id: "audit.legal-holds",
      path: "/compliance/legal-holds",
      title: "Legal Holds",
      navGroup: "Admin",
      requiredPermission: "legalhold.read",
      screen: LegalHolds,
    },
    {
      id: "audit.integrity-report",
      path: "/compliance/audit/integrity",
      title: "Audit Integrity",
      navGroup: "Admin",
      requiredPermission: "audit.integrity",
      screen: AuditIntegrityReport,
    },
    {
      id: "audit.exports",
      path: "/compliance/audit/exports",
      title: "Compliance Exports",
      navGroup: "Admin",
      requiredPermission: "audit.export",
      screen: AuditExports,
    },
    // GAP-012 — staff HIPAA §164.526 / §164.528 work queue (amendment inbox, accounting, access report).
    {
      id: "audit.privacy-requests",
      path: "/compliance/privacy-requests",
      title: "Privacy Requests",
      navGroup: "Admin",
      requiredPermission: "audit.disclosure_report",
      screen: PrivacyWorkQueue,
    },
  ],
};
