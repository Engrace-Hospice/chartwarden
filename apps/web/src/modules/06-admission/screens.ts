import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/06-admission — M6 screen registration (Track B, ADR-0030).
// The §5 admission screens that have a backing M6 read route on the generated client: the Referral
// Inbox (§5.2.1), the Admission Census (§5.2.12 entry), the Admission Detail + activation gate
// (§5.2.4/§5.2.5), and the org-wide Compliance Dashboard (§5.2.11). Nav visibility is gated by the
// matching M6 permission key; the SERVER stays the only enforcement point (no frontend authz).
import type { ComponentType } from "react";
import { AdmissionCensus } from "./admission-census";
import { AdmissionDetail } from "./admission-detail";
import { ComplianceDashboard } from "./compliance-dashboard";
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
  ],
};
