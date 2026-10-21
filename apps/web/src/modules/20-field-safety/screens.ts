import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/20-field-safety — M20 Field Safety screen registration (Track B / ADR-0030, §5.1).
// The read + write surface over the live /api/v1/safety backend (30 routes, M20-T06).
//
// Each `requiredPermission` is the REAL §4.6 M20 key the matching route gates on
// (apps/backend/src/modules/20-field-safety/permission-keys.ts → `M20_CONTRIBUTED_PERMISSIONS` in
// @chartwarden/auth) — this gates NAV VISIBILITY only. The server stays the authoritative enforcer, and a call
// outside the caller's reach is a non-leaking 404 from the server, never a frontend hide.
//
// ── EACH SCREEN NAMES THE KEY ITS OWN PRIMARY READ GATES ON, NOT THE KEY ITS SUBJECT SUGGESTS ────────
//
// Three screens carry `safety.dashboard.read` — the board, the check-in status ledger and the metrics
// page — because `GET /safety/dashboard` is the read each of them opens with. The check-in ledger looks
// like it should carry `safety.check_in.read`, and it does spend that key on its by-id lookup panel; but
// a caller holding only that key would land on a page whose entire table 403s. Nav gating that promises a
// screen the caller cannot use is worse than one that hides it.
//
// ── `/me/safety` IS GATED ON `safety.sos.raise`, WHICH IS DELIBERATELY THE FIELD-CLINICIAN KEY ───────
//
// §6 gives `safety.sos.raise` to the six field disciplines and to no supervisor role. So the SOS surface
// appears in the nav for exactly the people who can press the button, and a DON does not see a control
// she cannot spend. Her equivalent is the board.
//
// ── THE CEREMONIES ARE NOT SEPARATE REGISTRY ENTRIES ────────────────────────────────────────────────
//
// Acknowledge, resolve, the coordinate reveal, the incident transition, the OSHA sign-off, the policy
// edit, the subscription add and the consent grant each live inside the parent screen that already read
// the row's INTEGER `version` — which is M20's `If-Match` (§2.5). A modal that had to re-read could act on
// a version that moved in between, and on an SOS "last write wins" means one responder's account of what
// they did silently overwrites another's. (The active-SOS board's acknowledge modal reads the row on OPEN
// for exactly this reason: the list projection carries no version.)
//
// PATH SHAPE: mounted at the shell root (`/safety/...`, `/me/safety/...`) per the
// M15/M16/M17/M18/M19/M21 convention, rather than under §5.1's sketched `/app/` prefix.
import { lazy } from "react";
import type { ComponentType } from "react";
const CheckInLedgerScreen = lazy(() =>
  import("./check-in-ledger").then((m) => ({ default: m.CheckInLedgerScreen })),
);
const HighRiskAreasScreen = lazy(() =>
  import("./high-risk-areas").then((m) => ({ default: m.HighRiskAreasScreen })),
);
const IncidentDetailScreen = lazy(() =>
  import("./incident-detail").then((m) => ({ default: m.IncidentDetailScreen })),
);
const IncidentLedgerScreen = lazy(() =>
  import("./incident-ledger").then((m) => ({ default: m.IncidentLedgerScreen })),
);
const IncidentNewScreen = lazy(() =>
  import("./incident-new").then((m) => ({ default: m.IncidentNewScreen })),
);
const MyCheckInsScreen = lazy(() =>
  import("./my-check-ins").then((m) => ({ default: m.MyCheckInsScreen })),
);
const MyConsentScreen = lazy(() =>
  import("./my-consent").then((m) => ({ default: m.MyConsentScreen })),
);
const MySafetyScreen = lazy(() =>
  import("./my-safety").then((m) => ({ default: m.MySafetyScreen })),
);
const SafetyDashboardScreen = lazy(() =>
  import("./safety-dashboard").then((m) => ({ default: m.SafetyDashboardScreen })),
);
const SafetyMetricsScreen = lazy(() =>
  import("./safety-metrics").then((m) => ({ default: m.SafetyMetricsScreen })),
);
const SafetyPolicyScreen = lazy(() =>
  import("./safety-policy").then((m) => ({ default: m.SafetyPolicyScreen })),
);
const ActiveSosScreen = lazy(() =>
  import("./sos-active").then((m) => ({ default: m.ActiveSosScreen })),
);
const SosDetailScreen = lazy(() =>
  import("./sos-detail").then((m) => ({ default: m.SosDetailScreen })),
);
const SupervisorSubscriptionsScreen = lazy(() =>
  import("./supervisor-subscriptions").then((m) => ({ default: m.SupervisorSubscriptionsScreen })),
);

export const fieldSafetyScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 20,
  slug: "20-field-safety",
  screens: [
    // --- §5.1 row 1: the supervisor live-awareness board and the module's nav entry point ---
    {
      id: "safety.dashboard",
      path: "/safety",
      title: "Safety board",
      navGroup: "Field safety",
      requiredPermission: "safety.dashboard.read",
      screen: SafetyDashboardScreen,
    },
    // --- §5.1 row 2: the one screen whose whole purpose is the minutes somebody is waiting ---
    {
      id: "safety.sos.active",
      path: "/safety/sos",
      title: "Active SOS",
      navGroup: "Field safety",
      requiredPermission: "safety.sos.read",
      screen: ActiveSosScreen,
    },
    // --- §5.1 row 3: one alert end to end, incl. the D6 coordinate reveal behind its own gate ---
    {
      id: "safety.sos.detail",
      path: "/safety/sos/:sosAlertId",
      title: "SOS alert",
      requiredPermission: "safety.sos.read",
      screen: SosDetailScreen,
    },
    // --- §5.1 row 4 ---
    {
      id: "safety.incidents",
      path: "/safety/incidents",
      title: "Safety incidents",
      navGroup: "Field safety",
      requiredPermission: "safety_incident.read",
      screen: IncidentLedgerScreen,
    },
    // --- §5.1 row 6: registered BEFORE the `:incidentId` detail so "new" is never read as an id ---
    {
      id: "safety.incident.new",
      path: "/safety/incidents/new",
      title: "Report an incident",
      navGroup: "Field safety",
      requiredPermission: "safety_incident.create",
      screen: IncidentNewScreen,
    },
    // --- §5.1 row 5: the §2.2.3 machine, the action plan and §7.6/D9's step-up'd OSHA sign-off ---
    {
      id: "safety.incident.detail",
      path: "/safety/incidents/:incidentId",
      title: "Safety incident",
      requiredPermission: "safety_incident.read",
      screen: IncidentDetailScreen,
    },
    // --- §5.1 row 7: built from the board + the by-id read, because §4.1 publishes no check-in list ---
    {
      id: "safety.check_ins",
      path: "/safety/check-ins",
      title: "Check-in status",
      navGroup: "Field safety",
      requiredPermission: "safety.dashboard.read",
      screen: CheckInLedgerScreen,
    },
    // --- §5.1 row 8: the D4 bands, the §2.2.4 replay read, and the step-up'd edit ---
    {
      id: "safety.policy",
      path: "/safety/policy",
      title: "Safety policy",
      navGroup: "Field safety",
      requiredPermission: "safety_policy.read",
      screen: SafetyPolicyScreen,
    },
    // --- §5.1 row 9: D8's paging configuration + the §2.2.5 coverage-gap report ---
    {
      id: "safety.subscriptions",
      path: "/safety/supervisor-subscriptions",
      title: "Supervisor subscriptions",
      navGroup: "Field safety",
      requiredPermission: "safety_supervisor.read",
      screen: SupervisorSubscriptionsScreen,
    },
    // --- §5.1 row 10: D12's advisory polygons ---
    {
      id: "safety.high_risk_areas",
      path: "/safety/high-risk-areas",
      title: "High-risk areas",
      navGroup: "Field safety",
      requiredPermission: "safety.high_risk_area.read",
      screen: HighRiskAreasScreen,
    },
    // --- §5.1 row 11: counts, not trends — the seam a real trend needs has no HTTP surface ---
    {
      id: "safety.metrics",
      path: "/safety/metrics",
      title: "Safety metrics",
      navGroup: "Field safety",
      requiredPermission: "safety.dashboard.read",
      screen: SafetyMetricsScreen,
    },
    // --- §5.2: the mobile-primary surface, and the ONLY place `safety.sos.raise` can be spent ---
    {
      id: "safety.me",
      path: "/me/safety",
      title: "My safety",
      navGroup: "Field safety",
      requiredPermission: "safety.sos.raise",
      screen: MySafetyScreen,
    },
    // --- §5.1 row 13: her own 90-day history + the five-minute amendment grace ---
    {
      id: "safety.me.check_ins",
      path: "/me/safety/check-ins",
      title: "My check-ins",
      navGroup: "Field safety",
      requiredPermission: "safety.check_in.read",
      screen: MyCheckInsScreen,
    },
    // --- §5.1 row 12: D6 / D10 / M20-F06 — three separately grantable purposes ---
    {
      id: "safety.me.consent",
      path: "/me/safety/consent",
      title: "My safety consent",
      navGroup: "Field safety",
      requiredPermission: "safety.consent.read_self",
      screen: MyConsentScreen,
    },
  ],
};
