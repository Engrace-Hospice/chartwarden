import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/07-care-plan — M7 screen registration (Track B, ADR-0030).
// The §5 Care Plan (IPOC) screens that have a backing M7 read route on the generated client: the
// patient-scoped Care Plan View (§5.2), the Version History ledger (§5.1), and the patient-friendly
// Care Plan Summary (§5.2). Nav visibility is gated by the matching M7 permission key; the SERVER
// stays the only enforcement point (no frontend authz).
//
// F-031 (#91) — this header used to end "…fill in as their write surfaces harden", which made the
// screens.ts corpus the only accurate inventory of what the app could not do. It is accurate the other
// way now.
//
// WHAT IS BUILT, on the Care Plan View: the whole IPOC authoring surface — add / edit / resolve a
// problem, add / revise a goal, add / edit / discontinue an intervention — plus the §2 version
// lifecycle in the footer (open a version, close a draft for signature, sign, return to draft), each
// offered only in the state the server accepts it in. The plan of care is the legal predicate for
// delivering hospice care at all (42 CFR 418.56(b)) and the IDG must review it every 15 days
// (418.56(d)); the footer previously held three navigation buttons and a static quorum chip.
//
// The quorum chip now names the roles actually outstanding, from the signer SLOTS the server publishes.
// Both M7 screens typed `requiredSignerSet` as `string[]` when the wire has always sent
// `{ role, count }` — so the checklist compared an object to a role string and passed the object to
// `cap()`, which calls `s.replace`. It never threw only because the set is populated at FINALIZE and
// nothing in the product could finalize.
//
// F-066 (#161) — the plan BOOTSTRAP is now built. This header used to end: "`POST /patients/:id/
// care-plan` (plan bootstrap) has a client but no control — the plan shell is created on admission,
// and a 'create care plan' button would need an admissionId this screen does not read". Both halves
// were wrong in the same way: nothing in the product created the plan shell on admission, and no
// caller could resolve an admissionId for a patient at all until F-065 added
// `GET /patients/:patientId/admissions`. The Care Plan View's empty state now resolves the patient's
// OPEN admission through that read and offers "Start the care plan" — or says the patient has no open
// admission, which is the one honest reason not to offer it.
//
// STILL NOT BUILT: the IDG-review MEETING screens are M14's, not M7's (#91 lists them under M14); the
// AI care-plan suggestion rail is M29 and renders as a stated absence.
import { lazy } from "react";
import type { ComponentType } from "react";
const CarePlanView = lazy(() =>
  import("./care-plan-view").then((m) => ({ default: m.CarePlanView })),
);
const CarePlanSummary = lazy(() =>
  import("./summary").then((m) => ({ default: m.CarePlanSummary })),
);
const CarePlanVersionHistory = lazy(() =>
  import("./version-history").then((m) => ({ default: m.CarePlanVersionHistory })),
);

export const carePlanScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 7,
  slug: "07-care-plan",
  screens: [
    {
      // Patient-scoped Care Plan View — reached from the patient chart "Care Plan" tab; param path (no nav).
      id: "care-plan.view",
      path: "/patients/:patientId/care-plan",
      title: "Care Plan",
      requiredPermission: "care_plan.read",
      screen: CarePlanView,
    },
    {
      // Version history — reached from the Care Plan View aside; param path (no nav).
      id: "care-plan.versions",
      path: "/care-plans/:planId/versions",
      title: "Care Plan — Version History",
      requiredPermission: "care_plan.read",
      screen: CarePlanVersionHistory,
    },
    {
      // Patient-friendly summary — reached from the Care Plan View aside; param path (no nav).
      id: "care-plan.summary",
      path: "/care-plans/:planId/summary",
      title: "Care Plan Summary",
      requiredPermission: "care_plan.read_summary",
      screen: CarePlanSummary,
    },
  ],
};
