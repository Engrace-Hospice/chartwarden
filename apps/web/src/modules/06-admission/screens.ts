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
import type { ComponentType } from "react";
import { AdmissionCensus } from "./admission-census";
import { AdmissionCreate } from "./admission-create";
import { AdmissionDetail } from "./admission-detail";
import { ComplianceDashboard } from "./compliance-dashboard";
import { PatientElectionCert } from "./patient-election-cert";
import { ReferralDetail } from "./referral-detail";
import { ReferralInbox } from "./referral-inbox";

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
