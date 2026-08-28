import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/17-scheduling — M17 Scheduling screen registration (Track B, ADR-0030, M17-T08).
// The §5.1 scheduling read screens that have a backing M17 read route on the generated client: the Day View,
// the Week View, the Proposal Inbox, the Recurring Policies list, the Time-Off Queue, the single Visit Detail,
// the clinician's My Visits, and the org-wide Scheduling Metrics. Nav visibility is gated by the matching M17
// permission key; the SERVER stays the only enforcement point (no frontend authz, ADR-0030 — out-of-scope
// visits 404, never 403; the §4.7 pre-schedule ABAC + RLS narrow every read).
//
// #91 — VISITS CAN BE SCHEDULED NOW. Schedule (from the Day View, which resolves the patient's open
// admission and addresses first), reschedule, reassign, cancel, no-show, publish/dismiss a proposal, and
// approve/deny time off are built and DOM-covered (`scheduling-writes.dom.test.tsx`).
//
// THE PROPOSAL INBOX WAS THE SHARPEST CASE. M17 generates proposals from the care plan's frequency
// orders, the IDG's decisions and the supervisory cadence, and `publish` is what turns one into a real
// scheduled visit. With no caller, every proposal the platform produced sat in a list forever and the
// visits the plan of care called for were never created. The time-off queue was load-bearing in the same
// way: APPROVED time off is what the conflict rules refuse a visit against, so an approval nobody could
// record was also a clinician the scheduler kept booking.
//
// THE ASSIGNEE PICKER OFFERS THE ACTIVE ROSTER, NOT AN ELIGIBILITY LIST. The §4.7 D8 pre-schedule gate
// resolves the clinician's disciplines from their M3 role grants and checks the licence is current;
// filtering here would be a second, divergent implementation of a rule
// `discipline-derivation.test.ts` exists to keep singular.
//
// STILL DEFERRED, each for a reason rather than a schedule:
//   • Drag-and-drop rescheduling on the Day/Week grids — the ceremony exists on the visit detail, where
//     the reason field the route requires can actually be asked for. A drag has nowhere to put it.
//   • The availability editor (`PUT /availability/:membershipId`) — a weekly slot grid is its own
//     surface, and the read it would edit is already built.
//   • Recurring-policy CREATE — it takes an RRULE, and an RRULE builder is a screen, not a modal.
//     Discontinue is wired.
//   • The OSRM map polyline, the Capacitor mobile Today/Map variants, and the M31 portal view.
import { lazy } from "react";
import type { ComponentType } from "react";
const MyVisits = lazy(() => import("./my-visits").then((m) => ({ default: m.MyVisits })));
const SchedulingDay = lazy(() => import("./day-view").then((m) => ({ default: m.SchedulingDay })));
const SchedulingMetrics = lazy(() =>
  import("./scheduling-metrics").then((m) => ({ default: m.SchedulingMetrics })),
);
const SchedulingProposals = lazy(() =>
  import("./proposals").then((m) => ({ default: m.SchedulingProposals })),
);
const SchedulingRecurring = lazy(() =>
  import("./recurring").then((m) => ({ default: m.SchedulingRecurring })),
);
const SchedulingTimeOff = lazy(() =>
  import("./time-off").then((m) => ({ default: m.SchedulingTimeOff })),
);
const SchedulingWeek = lazy(() =>
  import("./week-view").then((m) => ({ default: m.SchedulingWeek })),
);
const VisitDetail = lazy(() => import("./visit-detail").then((m) => ({ default: m.VisitDetail })));

export const schedulingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 17,
  slug: "17-scheduling",
  screens: [
    {
      // Day View — the scheduler's per-clinician day grid (clinician `?membership=`, date `?date=`).
      id: "scheduling.day",
      path: "/scheduling/day",
      title: "Day View",
      navGroup: "Scheduling",
      requiredPermission: "visit.read_team",
      screen: SchedulingDay,
    },
    {
      // Week View — per-clinician week grid (week from `?weekStart=`).
      id: "scheduling.week",
      path: "/scheduling/week",
      title: "Week View",
      navGroup: "Scheduling",
      requiredPermission: "visit.read_team",
      screen: SchedulingWeek,
    },
    {
      // Proposal Inbox — pending frequency/order/IDG/supervisory proposals awaiting publish.
      id: "scheduling.proposals",
      path: "/scheduling/proposals",
      title: "Proposal Inbox",
      navGroup: "Scheduling",
      requiredPermission: "visit.proposal.read",
      screen: SchedulingProposals,
    },
    {
      // Recurring Policies — a patient's active recurring-visit policies (patient from `?patient=`).
      id: "scheduling.recurring",
      path: "/scheduling/recurring",
      title: "Recurring Policies",
      navGroup: "Scheduling",
      requiredPermission: "recurring_visit.read",
      screen: SchedulingRecurring,
    },
    {
      // Time-Off Queue — the supervisor PTO approval queue.
      id: "scheduling.time-off",
      path: "/scheduling/time-off",
      title: "Time-Off Queue",
      navGroup: "Scheduling",
      requiredPermission: "time_off.read_team",
      screen: SchedulingTimeOff,
    },
    {
      // Visit Detail — one visit's lifecycle + assignment; param path (no nav).
      id: "scheduling.visit-detail",
      path: "/scheduling/visits/:visitId",
      title: "Visit Detail",
      requiredPermission: "visit.read",
      screen: VisitDetail,
    },
    {
      // My Visits — the clinician's own visits today + upcoming 7 days.
      id: "scheduling.my-visits",
      path: "/me/visits",
      title: "My Visits",
      navGroup: "Clinical",
      requiredPermission: "visit.read",
      screen: MyVisits,
    },
    {
      // Scheduling Metrics — org-wide on-time / no-show / reschedule rates.
      id: "scheduling.metrics",
      path: "/admin/scheduling-metrics",
      title: "Scheduling Metrics",
      navGroup: "Admin",
      requiredPermission: "visit.read_metrics",
      screen: SchedulingMetrics,
    },
  ],
};
