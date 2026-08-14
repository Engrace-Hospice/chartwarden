import type { ScreenRegistryModule } from "@wardenx/types";
// apps/admin/src/modules/32-ai-platform — M32 §5.1 AI Safety Owner console registration (ADR-0030,
// GAP-049). The eight platform-ops screens contributed into the M34 admin shell.
//
// Each `requiredPermission` is a REAL §4.4 M32 key the matching `/api/v1/ai/*` route gates on
// (M32_CONTRIBUTED_PERMISSIONS in @wardenx/auth) — the server stays the authoritative enforcer; this only
// gates nav visibility. M34 owns the apps/admin shell; M32 owns this slice and registers into it at
// composition (apps/admin/src/main.tsx), never importing the shell's internals.
//
// KILL SWITCHES gates on `ai.kill_switch.read`, not `.activate`: the page is a status board first, and an
// operator who may SEE that a capability is stopped platform-wide but not resume it should still see it.
// The activate/deactivate dialogs are the operations the server refuses if the actor lacks `.activate`.
// LAZY, unlike the M34/M35 slices beside it. The admin app's initial bundle is already 412 kB against a
// 350 kB budget (WX-PR-022, pre-existing and undiagnosed); loading eight more screens eagerly added 45 kB
// to a chunk that is over budget before this slice exists. Code-splitting the console keeps it out of the
// initial payload entirely — an operator who never opens AI Platform never downloads it.
import { lazy } from "react";
import type { ComponentType } from "react";

const CapabilitiesList = lazy(() =>
  import("./capabilities-list").then((m) => ({ default: m.CapabilitiesList })),
);
const CapabilityDetail = lazy(() =>
  import("./capability-detail").then((m) => ({ default: m.CapabilityDetail })),
);
const DriftOverview = lazy(() => import("./drift").then((m) => ({ default: m.DriftOverview })));
const EvaluationRuns = lazy(() =>
  import("./evaluations").then((m) => ({ default: m.EvaluationRuns })),
);
const HallucinationQueue = lazy(() =>
  import("./hallucinations").then((m) => ({ default: m.HallucinationQueue })),
);
const InvocationSearch = lazy(() =>
  import("./invocations").then((m) => ({ default: m.InvocationSearch })),
);
const KillSwitches = lazy(() =>
  import("./kill-switches").then((m) => ({ default: m.KillSwitches })),
);
const TokenLedger = lazy(() => import("./tokens").then((m) => ({ default: m.TokenLedger })));

export const aiPlatformAdminScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 32,
  slug: "32-ai-platform",
  screens: [
    // ── §5.1.1 / §5.1.2 registry ──
    {
      id: "admin.ai-capabilities",
      path: "/admin/ai-platform/capabilities",
      title: "AI capabilities",
      navGroup: "AI Platform",
      requiredPermission: "ai.capability.read",
      screen: CapabilitiesList,
    },
    {
      id: "admin.ai-capability-detail",
      path: "/admin/ai-platform/capabilities/:capabilityId",
      title: "AI capability",
      navGroup: "AI Platform",
      requiredPermission: "ai.capability.read",
      screen: CapabilityDetail,
    },
    // ── §5.1.3 kill switches ──
    {
      id: "admin.ai-kill-switches",
      path: "/admin/ai-platform/kill-switches",
      title: "Kill switches",
      navGroup: "AI Platform",
      requiredPermission: "ai.kill_switch.read",
      screen: KillSwitches,
    },
    // ── §5.1.4 disclosure ledger ──
    {
      id: "admin.ai-invocations",
      path: "/admin/ai-platform/invocations",
      title: "AI invocations",
      navGroup: "AI Platform",
      requiredPermission: "ai.invocation.read",
      screen: InvocationSearch,
    },
    // ── §5.1.5 triage ──
    {
      id: "admin.ai-hallucinations",
      path: "/admin/ai-platform/hallucinations",
      title: "Hallucination triage",
      navGroup: "AI Platform",
      requiredPermission: "ai.hallucination.triage",
      screen: HallucinationQueue,
    },
    // ── §5.1.6 spend ──
    {
      id: "admin.ai-tokens",
      path: "/admin/ai-platform/tokens",
      title: "Token ledger",
      navGroup: "AI Platform",
      requiredPermission: "ai.tokens.read",
      screen: TokenLedger,
    },
    // ── §5.1.7 evaluation evidence ──
    {
      id: "admin.ai-evaluations",
      path: "/admin/ai-platform/evaluations",
      title: "Evaluation runs",
      navGroup: "AI Platform",
      requiredPermission: "ai.capability.read",
      screen: EvaluationRuns,
    },
    // ── §5.1.8 drift ──
    {
      id: "admin.ai-drift",
      path: "/admin/ai-platform/drift",
      title: "Drift overview",
      navGroup: "AI Platform",
      requiredPermission: "ai.capability.read",
      screen: DriftOverview,
    },
  ],
};
