import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/18-evv — M18 EVV screen registration (Track B, ADR-0030, M18-T07).
// The §5.1 EVV screens: the org-wide EVV Dashboard + Metrics (the EvvMetricsProvider seam), the
// coordinate-free Event Ledger + single Event Detail, the Missing-EVV Resolution queue, the per-state
// Aggregator Submission queue, the Geofence Policy view, the Devices-pending roster, and the clinician
// self-service My Devices. Nav visibility is gated by the matching M18 permission key; the SERVER stays the
// only enforcement point (no frontend authz, ADR-0030 — out-of-scope events 404, never 403; the §4.7
// capture ABAC + RLS narrow every read). Coordinates are NEVER projected by these read paths (D10 —
// evv.read_coords is a separate permission/path).
//
// #91 — the FOUR write surfaces this header used to defer are built (`evv-api.ts` + `evv-modals.tsx`):
// device approve/reject/suspend/retire on the roster, the two D6 human closes on the resolution queue,
// resubmit/cancel on the aggregator queue, and the tenant + per-address geofence edits. Device actions
// appear on the supervisor roster only; `/me/evv/devices` is a clinician looking at their own handsets,
// and approving one is an act on someone else's.
//
// F-078 (#91 AC5) — `e2e/specs/evv.spec.ts` drives the one M18 write a browser can: a supervisor
// approves a pending handset and it leaves the queue. `db:seed:scenario-field-ops` self-registered one
// device and approved it in the same breath, so `/evv/devices/pending` was permanently empty and the
// ceremony had nothing to act on; the seed now leaves a second pending. The spec also asserts the
// negative half — `/me/evv/devices` offers no approve control, because approving your own handset would
// defeat the point of the control.
//
// TWO GAPS FOUND AND NOT FIXED THERE, recorded because they are compliance-shaped:
//   • `evv_missing_resolution` has exactly ONE writer — the correction-of-record path, which needs a
//     check-in to already exist in order to correct it. A visit that simply never captured produces
//     nothing. The designed producer is M17's late-check sweep emitting
//     `m17.visit.late_check_out_suspected`, whose own catalog entry reads "M18 opens an
//     evv_missing_resolution row (M18 §7 / D6)". M18's side is a REGISTERED deferral in
//     `outbox-deferred-consumers.ts` — a declared absence, correctly tracked. The M17 side is not:
//     nothing in the codebase EMITS that event, so binding the consumer would still deliver nothing.
//     The queue that exists to prove a visit happened when the device did not record it is unreachable.
//   • The Aggregator Submission queue is empty for the same reason, so its resubmit/cancel controls
//     are unexercisable on a seeded stack.
//
// STILL NOT HERE, and neither is a deferral: the check-in/check-out CAPTURE surfaces are the Capacitor
// mobile flow (§5.2, owned by the M17 visit-detail CTA) — a browser has no attested device and no §12.4
// posture to report, so there is nothing for a web screen to do. Device SELF-registration is the same
// flow. The M31 portal arrival view is M31's surface, not this one.
import { lazy } from "react";
import type { ComponentType } from "react";
const EvvAggregatorSubmissions = lazy(() =>
  import("./aggregator-submissions").then((m) => ({ default: m.EvvAggregatorSubmissions })),
);
const EvvDevicesPending = lazy(() =>
  import("./devices").then((m) => ({ default: m.EvvDevicesPending })),
);
const EvvMyDevices = lazy(() => import("./devices").then((m) => ({ default: m.EvvMyDevices })));
const EvvEventDetail = lazy(() =>
  import("./event-detail").then((m) => ({ default: m.EvvEventDetail })),
);
const EvvEvents = lazy(() => import("./events").then((m) => ({ default: m.EvvEvents })));
const EvvGeofencePolicy = lazy(() =>
  import("./geofence-policy").then((m) => ({ default: m.EvvGeofencePolicy })),
);
const EvvDashboard = lazy(() => import("./metrics").then((m) => ({ default: m.EvvDashboard })));
const EvvMetrics = lazy(() => import("./metrics").then((m) => ({ default: m.EvvMetrics })));
const EvvMissingResolutions = lazy(() =>
  import("./missing-resolutions").then((m) => ({ default: m.EvvMissingResolutions })),
);

export const evvScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 18,
  slug: "18-evv",
  screens: [
    {
      // EVV Dashboard — org-wide EVV health KPIs (compliant / missing / aggregator / geofence rates).
      id: "evv.dashboard",
      path: "/evv/dashboard",
      title: "EVV Dashboard",
      navGroup: "EVV",
      requiredPermission: "evv.read_metrics",
      screen: EvvDashboard,
    },
    {
      // Event Ledger — searchable, caseload-scoped capture events.
      id: "evv.events",
      path: "/evv/events",
      title: "EVV Events",
      navGroup: "EVV",
      requiredPermission: "evv.read",
      screen: EvvEvents,
    },
    {
      // Event Detail — one event's raw + computed fields; param path (no nav).
      id: "evv.event-detail",
      path: "/evv/events/:eventId",
      title: "EVV Event Detail",
      requiredPermission: "evv.read",
      screen: EvvEventDetail,
    },
    {
      // Missing-EVV Resolutions — the late-checkout resolution backlog.
      id: "evv.missing-resolutions",
      path: "/evv/missing-resolutions",
      title: "Missing-EVV Resolutions",
      navGroup: "EVV",
      requiredPermission: "evv.missing_resolution.read",
      screen: EvvMissingResolutions,
    },
    {
      // Aggregator Submissions — the per-state aggregator submission queue.
      id: "evv.aggregator-submissions",
      path: "/evv/aggregator-submissions",
      title: "Aggregator Submissions",
      navGroup: "EVV",
      requiredPermission: "evv.aggregator.read",
      screen: EvvAggregatorSubmissions,
    },
    {
      // Geofence Policy — tenant tighten-only default + per-address overrides.
      id: "evv.geofence-policy",
      path: "/evv/geofence-policy",
      title: "Geofence Policy",
      navGroup: "EVV",
      requiredPermission: "evv.policy.read",
      screen: EvvGeofencePolicy,
    },
    {
      // Devices — the team device roster (pending approvals surface first).
      id: "evv.devices",
      path: "/evv/devices/pending",
      title: "EVV Devices",
      navGroup: "EVV",
      requiredPermission: "evv.device.read",
      screen: EvvDevicesPending,
    },
    {
      // EVV Metrics — trend rates over the trailing window (DON / Compliance).
      id: "evv.metrics",
      path: "/admin/evv-metrics",
      title: "EVV Metrics",
      navGroup: "Admin",
      requiredPermission: "evv.read_metrics",
      screen: EvvMetrics,
    },
    {
      // My EVV Devices — clinician self-service device list + approval status.
      id: "evv.my-devices",
      path: "/me/evv/devices",
      title: "My EVV Devices",
      navGroup: "Clinical",
      requiredPermission: "evv.device.read",
      screen: EvvMyDevices,
    },
  ],
};
