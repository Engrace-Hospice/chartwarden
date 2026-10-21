import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/32-ai-platform — M32 §5.2–§5.4 tenant screen registration (Track A, ADR-0030,
// GAP-049). The three TENANT-facing AI-platform surfaces: the Compliance Officer view, the tenant
// admin's opt-in board and routing panel, and the clinician's personal opt-out.
//
// The §5.1 AI Safety Owner console is NOT here — it is platform-ops and lives in apps/admin.
//
// Each `requiredPermission` is a real §4.4 M32 key the matching route gates on; this only gates nav
// visibility. `ai.tenant_opt_in` (the WRITE key) guards both tenant-admin screens, because both exist to
// perform that write — a read-only visitor has nothing to do on either.
import { lazy } from "react";
import type { ComponentType } from "react";

const ComplianceAiView = lazy(() =>
  import("./compliance-ai").then((m) => ({ default: m.ComplianceAiView })),
);
const AiOptInBoard = lazy(() =>
  import("./opt-in-board").then((m) => ({ default: m.AiOptInBoard })),
);
const AiRoutingOverrides = lazy(() =>
  import("./routing-overrides").then((m) => ({ default: m.AiRoutingOverrides })),
);
const ClinicianAiPreferences = lazy(() =>
  import("./clinician-preferences").then((m) => ({ default: m.ClinicianAiPreferences })),
);

export const aiPlatformScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 32,
  slug: "32-ai-platform",
  screens: [
    {
      id: "ai.compliance",
      path: "/compliance/ai",
      title: "AI compliance",
      navGroup: "Compliance",
      requiredPermission: "ai.invocation.read",
      screen: ComplianceAiView,
    },
    {
      id: "ai.opt-in",
      path: "/organization/ai/opt-in",
      title: "AI capabilities",
      navGroup: "Admin",
      requiredPermission: "ai.tenant_opt_in",
      screen: AiOptInBoard,
    },
    {
      id: "ai.routing",
      path: "/organization/ai/routing",
      title: "AI routing",
      navGroup: "Admin",
      requiredPermission: "ai.tenant_opt_in",
      screen: AiRoutingOverrides,
    },
    {
      id: "ai.my-preferences",
      path: "/me/ai-preferences",
      title: "AI assistance",
      navGroup: "Admin",
      requiredPermission: "ai.clinician_opt_out.read",
      screen: ClinicianAiPreferences,
    },
  ],
};
