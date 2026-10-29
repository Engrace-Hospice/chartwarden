// F-081 (#91 AC5) — `e2e/specs/idg.spec.ts` drives the §2.2 D13 adjournment in a real browser: the
// commit point refuses a session with no fresh step-up, the coordinator re-authenticates with a passkey,
// and the same action then commits. Writing it found that step-up could not be satisfied by ANY user in
// ANY deployment (three defects, recorded in `02-identity/screens.ts`) and two things specific to here:
//
//   • THE DIALOG TOLD A COORDINATOR TO RE-AUTHENTICATE AND OFFERED NO WAY TO. `/step-up` is chromeless,
//     absent from nav, and reached only by a redirect — which M6, M8, M23, M27 and M39 all perform from
//     their own `authFailureRedirect` and M14 did not. So the D13 commit point had no path through it
//     from the UI at all. The lifecycle dialog now offers "Re-authenticate" on the 412, and only after
//     one has happened: a permanent step-up button beside a commit point would train people to
//     re-authenticate before being asked, which is the opposite of what a freshness window is for.
//   • THE SCHEDULE COULD NOT SHOW A MEETING IN SESSION. Its window was `now → now + 8 weeks` and the
//     server filters `scheduled_start >= from`, so a meeting VANISHED from the schedule the moment it
//     went live — a meeting in session started in the past by definition — along with everything that
//     finished earlier today. The screen's own status filter offers `Live` and `Adjourned`, neither of
//     which could ever match a row. It is anchored at the start of today now.
//
// RESOLVED: `/idg/schedule` is a per-location read, and the nav entry points at the bare path. The
// screen now names the sites the caller can see (`GET /locations`) in a picker and opens the first
// active one when `?location=` is absent, so the nav item lands on a real schedule instead of an
// EmptyState. Whether the shell should carry a location context of its own remains a design decision;
// this picker is local to the schedule and does not persist across screens.
import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/14-idg — M14 IDG screen registration (Track B, ADR-0030, M14-T07).
// The §5 IDG read screens that have a backing M14 read route on the generated client: the IDG Schedule
// (per-location), the pre-meeting Meeting Detail, the Live Meeting Surface, the per-patient Packet (chart
// embed), My Action Items, and the per-meeting Minutes. Nav visibility is gated by the matching M14 permission
// key; the SERVER stays the only enforcement point (no frontend authz, ADR-0030 — out-of-scope resources 404,
// never 403; SUD-flagged packet blocks redacted server-side per §7.2/W-SUD-01).
//
// #91 / F-062 — THE MEETING IS NOW CONDUCTABLE. The decision-recording panel, the attendance tracker, the
// action-item assignment and status transitions, the adjourn control (D13 fresh step-up), build-packets,
// start, cancel, reschedule, and the §7.8 minutes amendment request are all built and DOM-covered
// (`idg-writes.dom.test.tsx`). This header used to say they would "fill in as those write paths harden";
// the write paths were mounted, guarded and contract-enriched the whole time — but SIX of them wrote rows
// no read route in the module returned (`idg_attendance`, `idg_agenda_item`, `idg_decision`), and
// adjournment stamped the minutes `final` while writing none of the three snapshot columns that make them
// a record. Both were fixed on the server in the same change.
//
// STILL DEFERRED, and each for a reason rather than a schedule:
//   • Remove an agenda item — `DELETE /idg/agenda/:id` answers a typed 501 (the agenda is append-only: no delete
//     grant, no tombstone column) and changes nothing. No control is offered (the F-007 rule).
//   • The `care_plan_update` decision beyond `problem_add` — its other five mutation ops address M7 plan
//     elements by uuid and need the care-plan element picker on the M07 surface.
//   • Socket.IO real-time decision/action-item propagation (no realtime gateway exists yet), and the
//     Capacitor Mobile Live variant. Until then the live surface reloads its ledgers after each write AND
//     polls them every ~10s while the meeting is `live` and the tab is visible (`use-live-refresh.ts`).
//   • The action-item link-artifact / add-note surfaces — no route mints either.
//   • The M22 minutes/packet PDF render and the M28 FHIR CareTeam/Encounter projection (Wave F/H).
import { lazy } from "react";
import type { ComponentType } from "react";
const IdgSchedule = lazy(() => import("./idg-schedule").then((m) => ({ default: m.IdgSchedule })));
const LiveMeeting = lazy(() => import("./live-meeting").then((m) => ({ default: m.LiveMeeting })));
const MeetingDetail = lazy(() =>
  import("./meeting-detail").then((m) => ({ default: m.MeetingDetail })),
);
const Minutes = lazy(() => import("./minutes").then((m) => ({ default: m.Minutes })));
const MyActionItems = lazy(() =>
  import("./my-action-items").then((m) => ({ default: m.MyActionItems })),
);
const PatientIdgHistory = lazy(() =>
  import("./patient-idg-history").then((m) => ({ default: m.PatientIdgHistory })),
);
const PatientPacket = lazy(() =>
  import("./patient-packet").then((m) => ({ default: m.PatientPacket })),
);

export const idgScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 14,
  slug: "14-idg",
  screens: [
    {
      // IDG Schedule — the coordinator's per-location landing surface (location from `?location=`).
      id: "idg.schedule",
      path: "/idg/schedule",
      title: "IDG Schedule",
      navGroup: "Clinical",
      requiredPermission: "idg.read",
      screen: IdgSchedule,
    },
    {
      // Meeting Detail (pre-meeting) — packet readiness + lifecycle; reached from the schedule.
      id: "idg.meeting-detail",
      path: "/idg/meetings/:id",
      title: "IDG Meeting",
      requiredPermission: "idg.read",
      screen: MeetingDetail,
    },
    {
      // Live Meeting Surface — patient list + lifecycle; reached from the meeting detail.
      id: "idg.meeting-live",
      path: "/idg/meetings/:id/live",
      title: "Live IDG Meeting",
      requiredPermission: "idg.read",
      screen: LiveMeeting,
    },
    {
      // Per-Patient Packet (chart embed) — read-only packet digest; param path (no nav).
      id: "idg.packet",
      path: "/idg/meetings/:meetingId/packets/:patientId",
      title: "IDG Packet",
      requiredPermission: "idg.read",
      screen: PatientPacket,
    },
    {
      // Patient IDG History — reached from the patient chart "IDG History" tab; param path (no nav).
      id: "idg.patient-history",
      path: "/patients/:patientId/idg-history",
      title: "IDG History",
      requiredPermission: "idg.read",
      screen: PatientIdgHistory,
    },
    {
      // My Action Items — the caller's IDG action-item queue (`assignee=me` server-resolved).
      id: "idg.action-items",
      path: "/idg/action-items",
      title: "My Action Items",
      navGroup: "Clinical",
      requiredPermission: "idg.read",
      screen: MyActionItems,
    },
    {
      // Minutes (per meeting) — finalized/in-progress minutes; param path (no nav).
      id: "idg.minutes",
      path: "/idg/meetings/:id/minutes",
      title: "IDG Minutes",
      requiredPermission: "idg.read",
      screen: Minutes,
    },
  ],
};
