import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/06-admission — M6 screen registration (Track B, ADR-0030).
// The §5 admission screens that have a backing M6 read route on the generated client: the Referral
// Inbox (§5.2.1), the Admission Census (§5.2.12 entry), the Admission Detail + activation gate
// (§5.2.4/§5.2.5), and the org-wide Compliance Dashboard (§5.2.11). Nav visibility is gated by the
// matching M6 permission key; the SERVER stays the only enforcement point (no frontend authz).
// TASK-031 adds the Referral Detail (fixes the dead-linked `/referrals/:id`, a param path — the shell
// omits `:`-containing paths from nav, so this one is reached only via a Referral Inbox row) and the
// direct-intake Admission Create (`/admissions/new`) — a real nav entry, `navGroup: "Admissions"`,
// same as M20's `incident-new.tsx` precedent for a create-form screen (any non-param path lands in the
// shell's nav somewhere; the only choice is which group).
import { lazy } from "react";
import type { ComponentType } from "react";
const AdmissionCensus = lazy(() =>
  import("./admission-census").then((m) => ({ default: m.AdmissionCensus })),
);
const AdmissionCreate = lazy(() =>
  import("./admission-create").then((m) => ({ default: m.AdmissionCreate })),
);
const AdmissionDetail = lazy(() =>
  import("./admission-detail").then((m) => ({ default: m.AdmissionDetail })),
);
const ComplianceDashboard = lazy(() =>
  import("./compliance-dashboard").then((m) => ({ default: m.ComplianceDashboard })),
);
const PatientElectionCert = lazy(() =>
  import("./patient-election-cert").then((m) => ({ default: m.PatientElectionCert })),
);
const ReferralDetail = lazy(() =>
  import("./referral-detail").then((m) => ({ default: m.ReferralDetail })),
);
const ReferralInbox = lazy(() =>
  import("./referral-inbox").then((m) => ({ default: m.ReferralInbox })),
);
const ReferralNew = lazy(() => import("./referral-new").then((m) => ({ default: m.ReferralNew })));

export const admissionScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 6,
  slug: "06-admission",
  screens: [
    {
      id: "admission.referrals",
      path: "/referrals",
      title: "Referral Inbox",
      navGroup: "Admissions",
      requiredPermission: "referral.read",
      screen: ReferralInbox,
    },
    {
      id: "admission.referral-new",
      path: "/referrals/new",
      title: "New referral",
      requiredPermission: "referral.create",
      screen: ReferralNew,
    },
    {
      id: "admission.census",
      path: "/admissions",
      title: "Admissions",
      navGroup: "Admissions",
      requiredPermission: "admission.read",
      screen: AdmissionCensus,
    },
    {
      id: "admission.compliance",
      path: "/compliance/admissions",
      title: "Compliance",
      navGroup: "Admissions",
      requiredPermission: "compliance.read",
      screen: ComplianceDashboard,
    },
    {
      // Detail screen — reached from a census row; omitted from nav (param path).
      id: "admission.detail",
      path: "/admissions/:id",
      title: "Admission",
      requiredPermission: "admission.read",
      screen: AdmissionDetail,
    },
    {
      // Referral detail — reached from a Referral Inbox row; omitted from nav (param path). Fixes the
      // dead `/referrals/:id` link `referral-inbox.tsx` has always pointed at (TASK-031).
      id: "admission.referral-detail",
      path: "/referrals/:id",
      title: "Referral",
      requiredPermission: "referral.read",
      screen: ReferralDetail,
    },
    {
      // Direct-intake create — also linked from the census header's "New admission" button.
      id: "admission.create",
      path: "/admissions/new",
      title: "New admission",
      navGroup: "Admissions",
      requiredPermission: "admission.create",
      screen: AdmissionCreate,
    },
    {
      // Patient-scoped Election & Certification — reached from the patient chart tab (param path, no nav).
      id: "admission.patient-election-cert",
      path: "/patients/:patientId/election-certification",
      title: "Election & Certification",
      requiredPermission: "election.read",
      screen: PatientElectionCert,
    },
  ],
};
