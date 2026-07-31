import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/16-bereavement — M16 Bereavement screen registration (Track B / ADR-0030, §5.1).
// The read + write surface over the live /api/v1/bereavement backend (33 routes, M16-T06).
//
// Each `requiredPermission` is the REAL §4.7 M16 key the matching route gates on
// (apps/backend/src/modules/16-bereavement/permission-keys.ts → `M16_CONTRIBUTED_PERMISSIONS` in
// @wardenx/auth) — this gates NAV VISIBILITY only; the server stays the authoritative enforcer, and an
// off-caseload plan is a non-leaking 404 from the server, never a frontend hide. A 404 there is deliberate:
// "this plan 403s" would tell an unauthorized caller that a particular patient died.
//
// TWO ROUTE-SHAPE DEPARTURES FROM §5.1, both because the architecture wins over the screen spec:
//
//   • §5.1 #7 proposes `/app/bereavement/contacts/:contactId`. M16 publishes no "get one contact" read —
//     a survivor is only ever returned inside their plan (route 2's rolled-up roster), which is what makes
//     the §7.13 redaction and the D10 volunteer scope ONE decision on ONE body. So the contact detail and
//     the §5.1 #13 grief screen are plan-scoped here rather than reading a route that does not exist.
//   • §5.1's paths are prefixed `/app/…`; the shell mounts module screens at the root, so the M15/M17/M18
//     convention (`/bereavement/…`) is followed.
//
// §5.1 modals are NOT separate registry entries — the assignment ceremonies, the add-contact form, the
// start/complete/cancel transitions, the opt-out review, the referral composer and the close ceremony each
// live inside the parent screen, because each one needs the parent's already-read row `version` for its
// `If-Match`. A modal that had to re-read the row could act on a version that moved in between.
import type { ComponentType } from "react";
import { BereavedContactDetail } from "./contact-detail";
import { BereavementCloseoutView } from "./closeout-view";
import { BereavementCounselorDashboard } from "./counselor-dashboard";
import { BereavementGriefScreen } from "./grief-screen";
import { BereavementIntakeQueue } from "./intake-queue";
import { BereavementOutreachPlanner } from "./outreach-planner";
import { BereavementPlanDetail } from "./plan-detail";
import { BereavementPlanHistory } from "./plan-history";
import { BereavementRiskView } from "./risk-view";
import { BereavementRosterSeed } from "./roster-seed";
import { BereavementSupervisorDashboard } from "./supervisor-dashboard";

export const bereavementScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 16,
  slug: "16-bereavement",
  screens: [
    // --- the two dashboards (§5.1 #1, #2) — the module's nav entry points ---
    {
      id: "bereavement.caseload",
      path: "/bereavement",
      title: "Bereavement",
      navGroup: "Bereavement",
      requiredPermission: "bereavement.dashboard.counselor",
      screen: BereavementCounselorDashboard,
    },
    {
      id: "bereavement.supervisor",
      path: "/bereavement/supervisor",
      title: "Bereavement Program",
      navGroup: "Bereavement",
      requiredPermission: "bereavement.dashboard.supervisor",
      screen: BereavementSupervisorDashboard,
    },
    // --- intake (§5.1 #4, with the #5 volunteer-assignment modal) ---
    {
      id: "bereavement.intake",
      path: "/bereavement/eligible",
      title: "Bereavement Intake",
      navGroup: "Bereavement",
      requiredPermission: "bereavement.plan.assign_counselor",
      screen: BereavementIntakeQueue,
    },
    // --- the plan (§5.1 #3), its opening ceremony (#6) and its closeout (#18) ---
    {
      id: "bereavement.plan",
      path: "/bereavement/plans/:planId",
      title: "Bereavement Plan",
      requiredPermission: "bereavement.plan.read",
      screen: BereavementPlanDetail,
    },
    {
      id: "bereavement.plan.seed",
      path: "/bereavement/plans/:planId/seed",
      title: "Seed Roster + Schedule",
      requiredPermission: "bereavement.plan.activate",
      screen: BereavementRosterSeed,
    },
    {
      id: "bereavement.plan.closeout",
      path: "/bereavement/plans/:planId/closeout",
      title: "Bereavement Closeout",
      requiredPermission: "bereavement.plan.read",
      screen: BereavementCloseoutView,
    },
    // --- the touchpoint book (§5.1 #9, with the #10 / #11 modals) ---
    {
      id: "bereavement.plan.outreach",
      path: "/bereavement/plans/:planId/outreach",
      title: "Outreach Planner",
      requiredPermission: "bereavement.outreach.read",
      screen: BereavementOutreachPlanner,
    },
    // --- risk (§5.1 #12) ---
    {
      id: "bereavement.plan.risk",
      path: "/bereavement/plans/:planId/risk",
      title: "Bereavement Risk",
      requiredPermission: "bereavement.risk.read",
      screen: BereavementRiskView,
    },
    // --- the survivor (§5.1 #7, with the #15 opt-out modal) and their screen (#13, with #14) ---
    {
      id: "bereavement.contact",
      path: "/bereavement/plans/:planId/contacts/:contactId",
      title: "Bereaved Contact",
      requiredPermission: "bereavement.plan.read",
      screen: BereavedContactDetail,
    },
    {
      id: "bereavement.contact.screen",
      path: "/bereavement/plans/:planId/contacts/:contactId/screen",
      title: "Complicated Grief Screen",
      requiredPermission: "bereavement.contact.flag_complicated_grief",
      screen: BereavementGriefScreen,
    },
    // --- §7.15 survey reconstruction (§5.1 #19) ---
    {
      id: "bereavement.plan.history",
      path: "/bereavement/plans/:planId/history",
      title: "Bereavement Plan History",
      requiredPermission: "bereavement.plan.read",
      screen: BereavementPlanHistory,
    },
  ],
};
