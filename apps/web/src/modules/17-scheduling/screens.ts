// apps/web/src/modules/17-scheduling — M17 Scheduling screen registration (Track B, ADR-0030, M17-T08).
// The §5.1 scheduling read screens that have a backing M17 read route on the generated client: the Day View,
// the Week View, the Proposal Inbox, the Recurring Policies list, the Time-Off Queue, the single Visit Detail,
// the clinician's My Visits, and the org-wide Scheduling Metrics. Nav visibility is gated by the matching M17
// permission key; the SERVER stays the only enforcement point (no frontend authz, ADR-0030 — out-of-scope
// visits 404, never 403; the §4.7 pre-schedule ABAC + RLS narrow every read). The drag-drop reschedule,
// publish-all, create/discontinue-recurring, approve/deny-time-off, availability editor, and the OSRM map
// (polyline) surfaces — plus the Capacitor mobile Today/Map variants and the M31 portal upcoming-visit view —
// fill in as those write paths / Phase-2 modules land.
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { MyVisits } from "./my-visits";
import { SchedulingDay } from "./day-view";
import { SchedulingMetrics } from "./scheduling-metrics";
import { SchedulingProposals } from "./proposals";
import { SchedulingRecurring } from "./recurring";
import { SchedulingTimeOff } from "./time-off";
import { SchedulingWeek } from "./week-view";
import { VisitDetail } from "./visit-detail";

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
