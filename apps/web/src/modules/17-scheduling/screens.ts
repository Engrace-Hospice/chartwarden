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
// F-079 (#91 AC5) — `e2e/specs/scheduling.spec.ts` drives the create in a real browser, and getting it
// to pass took un-blocking the route. `db:seed:scenario-field-ops` had been INSERTING its visit row
// directly under a header reading "GENUINE GAP … `POST /api/v1/visits` is unconditionally unreachable in
// production", because `SchedulingAbacResolver` hard-coded `credentialsActiveForPurpose`→false and three
// siblings. True when written; GAP-093 and GAP-031 later replaced all four with real reads, and nobody
// returned to the workaround. One cause remained and it was not in the platform: `membership_credential`
// was EMPTY on every seeded stack, so `clinician_credentials_active` correctly refused every assignee for
// want of a licence. `seed-staff-personas.ts` now issues one per licensable discipline — and only for the
// nine `credential_discipline` values, because `rn_case_manager` / `hospice_physician` /
// `clinical_supervisor` are AUTHORITY grants, and issuing licences for them would widen the very gate
// that exists to know a lapsed licence from a held role. The field-ops seed now schedules through the
// route, because a DB-seeded row proves nothing about whether a clinician could have booked it.
//
// TWO FINDINGS THE SPEC SURFACED AND DOES NOT FIX:
//   • SCHEDULING IS ADMINISTRATOR-ONLY IN PRACTICE. The "Assign to" picker is filled from
//     `GET /api/v1/orgs/:id/members`, which requires `member.manage` — a tenant-ADMINISTRATION
//     permission no clinical role holds. The RN case manager and the clinical supervisor both get a
//     roster read refused, so the select renders with only its placeholder and Schedule stays disabled,
//     with nothing on screen saying why: an empty roster is indistinguishable from an agency with no
//     staff. The people who actually build a schedule cannot use this screen.
//   • A DOUBLE-BOOKING IS A 500. `visit` carries a per-clinician no-overlap EXCLUSION constraint;
//     violating it raises Postgres `23P01`, and `classifyDatabaseError` — the F-022 registry built to
//     turn exactly this kind of written-down rule into a 409 — recognises only `23505`. So the most
//     ordinary scheduling mistake there is arrives as "An unexpected error occurred". Registering it
//     needs a decision the registry does not make yet: `visit` is PARTITIONED, so the constraint name
//     carries a `<YYYY_MM>` suffix, and the registry is exact-match on purpose.
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
  import("./scheduling-metrics").then((m) => ({
    default: m.SchedulingMetrics,
  })),
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
const CalendarPage = lazy(() =>
  import("./calendar-page").then((m) => ({
    default: m.CalendarPage,
  })),
);

export const schedulingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 17,
  slug: "17-scheduling",
  screens: [
    {
      id: "scheduling.calendar",
      path: "/calendar",
      title: "Calendar",
      navGroup: "Scheduling",
      screen: CalendarPage,
    },
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
