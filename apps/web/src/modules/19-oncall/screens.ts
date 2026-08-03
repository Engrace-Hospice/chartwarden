import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/19-oncall — M19 On-Call Triage screen registration (Track B / ADR-0030, §5.1).
// The read + write surface over the live /api/v1 triage backend (38 routes, M19-T07).
//
// Each `requiredPermission` is the REAL §4.6 M19 key the matching route gates on
// (apps/backend/src/modules/19-oncall/permission-keys.ts → `M19_CONTRIBUTED_PERMISSIONS` in
// @wardenx/auth) — this gates NAV VISIBILITY only. The server stays the authoritative enforcer, and a call
// outside the caller's reach is a non-leaking 404 from the server, never a frontend hide; that 404 is
// deliberate, because "this call 403s" would tell an unauthorized caller that a particular patient rang the
// after-hours line.
//
// THREE ENTRIES EXIST BECAUSE THEY CARRY A DIFFERENT PERMISSION, and nav gating is per-screen. Folding any
// of them into a parent would make the parent's key the effective gate on strictly more than §4.6 grants:
//
//   • `/triage/calls/:id/transcript` — `triage.read_transcript` (plus an M2 step-up and a per-access audit
//     row). A clinician who may WORK a call must not thereby acquire the decrypted words of every call
//     they can see.
//   • `/triage/paper-reentry` — `triage.paper_reentry`, the one write that can back-date a call past a
//     coverage gap. §4.6 gives it a `compliance`-category key of its own; a permission with no screen to
//     spend it on is one that gets granted and forgotten.
//   • `/triage/policy` and `/triage/vendors` — both `oncall.read_policy` for the READ, but the vendor
//     screen's writes are `oncall.admin_policy`. They are separate screens because §5.1 lists them
//     separately and because a DON configuring an escalation ladder and a compliance officer checking a
//     BAA are looking for different pages, not different tabs.
//
// THE §5 CEREMONIES ARE NOT SEPARATE REGISTRY ENTRIES. Identify-patient, apply-protocol, record-answer,
// the disposition composer, escalate, acknowledge, resolve, document, abandon, go-on-shift and the BAA
// renewal each live inside the parent screen that already read the row's `version` — which is M19's
// `If-Match` value (§2.5). A modal that had to re-read the row could act on a version that moved in
// between, and for a triage call "last write wins" means a supervisor's disposition silently overwrites
// two answers, one of which may have been a red flag.
//
// PATH SHAPE: mounted at the shell root (`/triage/...`, `/me/oncall`) per the M15/M16/M17/M18/M21
// convention, rather than under §5.1's sketched `/app/` prefix.
import { lazy } from "react";
import type { ComponentType } from "react";
const EscalationInboxScreen = lazy(() =>
  import("./escalation-inbox").then((m) => ({ default: m.EscalationInboxScreen })),
);
const MyOnCallScreen = lazy(() =>
  import("./my-oncall").then((m) => ({ default: m.MyOnCallScreen })),
);
const OnCallPolicyScreen = lazy(() =>
  import("./oncall-policy").then((m) => ({ default: m.OnCallPolicyScreen })),
);
const OnCallShiftDetailScreen = lazy(() =>
  import("./oncall-shift-detail").then((m) => ({ default: m.OnCallShiftDetailScreen })),
);
const OnCallShiftsScreen = lazy(() =>
  import("./oncall-shifts").then((m) => ({ default: m.OnCallShiftsScreen })),
);
const PaperReentryWorklistScreen = lazy(() =>
  import("./paper-reentry").then((m) => ({ default: m.PaperReentryWorklistScreen })),
);
const TriageProtocolCatalogScreen = lazy(() =>
  import("./protocol-catalog").then((m) => ({ default: m.TriageProtocolCatalogScreen })),
);
const TriageProtocolDetailScreen = lazy(() =>
  import("./protocol-detail").then((m) => ({ default: m.TriageProtocolDetailScreen })),
);
const TriageCallHistoryScreen = lazy(() =>
  import("./triage-call-history").then((m) => ({ default: m.TriageCallHistoryScreen })),
);
const TriageIntakeScreen = lazy(() =>
  import("./triage-intake").then((m) => ({ default: m.TriageIntakeScreen })),
);
const TriageMetricsScreen = lazy(() =>
  import("./triage-metrics").then((m) => ({ default: m.TriageMetricsScreen })),
);
const TriageCallPanel = lazy(() =>
  import("./triage-panel").then((m) => ({ default: m.TriageCallPanel })),
);
const TriageQueueScreen = lazy(() =>
  import("./triage-queue").then((m) => ({ default: m.TriageQueueScreen })),
);
const TriageTranscriptScreen = lazy(() =>
  import("./triage-transcript").then((m) => ({ default: m.TriageTranscriptScreen })),
);
const ExternalVendorAdminScreen = lazy(() =>
  import("./vendor-admin").then((m) => ({ default: m.ExternalVendorAdminScreen })),
);

export const oncallScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 19,
  slug: "19-oncall",
  screens: [
    // --- S19.3: the module's nav entry point and the supervisor board ---
    {
      id: "triage.queue",
      path: "/triage",
      title: "Triage queue",
      navGroup: "On-call",
      requiredPermission: "triage.read",
      screen: TriageQueueScreen,
    },
    // --- S19.1: where a call enters the record ---
    {
      id: "triage.intake",
      path: "/triage/intake",
      title: "Take a call",
      navGroup: "On-call",
      requiredPermission: "triage.open",
      screen: TriageIntakeScreen,
    },
    // --- S19.2: the §2.2.1 call machine over HTTP ---
    {
      id: "triage.call",
      path: "/triage/calls/:triageCallId",
      title: "Triage call",
      requiredPermission: "triage.read",
      screen: TriageCallPanel,
    },
    // --- S19.12: the same read with no write anywhere on the page (surveyor-safe) ---
    {
      id: "triage.call.history",
      path: "/triage/calls/:triageCallId/history",
      title: "Call history",
      requiredPermission: "triage.read",
      screen: TriageCallHistoryScreen,
    },
    // --- §4.1 row 14: its own permission + step-up + a per-access audit row ---
    {
      id: "triage.call.transcript",
      path: "/triage/calls/:triageCallId/transcript",
      title: "Call transcript",
      requiredPermission: "triage.read_transcript",
      screen: TriageTranscriptScreen,
    },
    // --- S19.4: the D7 ladder's inbox — the two writes §7.2 waits on ---
    {
      id: "triage.escalations",
      path: "/triage/escalations",
      title: "Escalations",
      navGroup: "On-call",
      requiredPermission: "triage.read_escalations",
      screen: EscalationInboxScreen,
    },
    // --- S19.5 / S19.6: the CoP 418.100(c)(2) coverage record ---
    {
      id: "oncall.shifts",
      path: "/triage/shifts",
      title: "On-call roster",
      navGroup: "On-call",
      requiredPermission: "oncall.read_schedule",
      screen: OnCallShiftsScreen,
    },
    {
      id: "oncall.shift",
      path: "/triage/shifts/:shiftId",
      title: "On-call shift",
      requiredPermission: "oncall.read_schedule",
      screen: OnCallShiftDetailScreen,
    },
    // --- S19.13: the clinician's own view, mobile-first ---
    {
      id: "oncall.me",
      path: "/me/oncall",
      title: "My on-call",
      navGroup: "On-call",
      requiredPermission: "oncall.read_schedule",
      screen: MyOnCallScreen,
    },
    // --- S19.7 / S19.8: the D4 two-layer catalog ---
    {
      id: "triage.protocols",
      path: "/triage/protocols",
      title: "Triage protocols",
      navGroup: "On-call",
      requiredPermission: "triage.read",
      screen: TriageProtocolCatalogScreen,
    },
    {
      id: "triage.protocol",
      path: "/triage/protocols/:protocolId",
      title: "Triage protocol",
      requiredPermission: "triage.read",
      screen: TriageProtocolDetailScreen,
    },
    // --- S19.10 / S19.9: the tenant configuration surfaces ---
    {
      id: "oncall.policy",
      path: "/triage/policy",
      title: "On-call policy",
      navGroup: "On-call",
      requiredPermission: "oncall.read_policy",
      screen: OnCallPolicyScreen,
    },
    {
      id: "oncall.vendors",
      path: "/triage/vendors",
      title: "External triage vendors",
      navGroup: "On-call",
      requiredPermission: "oncall.read_policy",
      screen: ExternalVendorAdminScreen,
    },
    // --- §2.7: the BCP re-entry path, on its own compliance-category key ---
    {
      id: "triage.paper_reentry",
      path: "/triage/paper-reentry",
      title: "Paper re-entry",
      navGroup: "On-call",
      requiredPermission: "triage.paper_reentry",
      screen: PaperReentryWorklistScreen,
    },
    // --- S19.11: program health, page-derived and honest about it ---
    {
      id: "triage.metrics",
      path: "/triage/metrics",
      title: "On-call metrics",
      navGroup: "On-call",
      requiredPermission: "triage.read",
      screen: TriageMetricsScreen,
    },
  ],
};
