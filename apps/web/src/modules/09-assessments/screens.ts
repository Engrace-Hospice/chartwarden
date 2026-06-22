// apps/web/src/modules/09-assessments — M9 screen registration (Track B, ADR-0030).
// The §5 Clinical Assessments screens that have a backing M9 read route on the generated client: the
// patient-scoped Assessment Timeline (§5.2), the Per-scale Trend (§5.2), the per-patient Significant-change
// Inbox (§5.2), the Assessment Summary (§5.2), and the org-admin Scale-license Registry + Scale-policy Editor
// (§5.2). Nav visibility is gated by the matching M9 permission key; the SERVER stays the only enforcement point
// (no frontend authz). The record-assessment modal and the ack/renew/policy write surfaces (§5.2) fill in as
// their write paths harden.
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { AssessmentSummary } from "./assessment-summary";
import { AssessmentTimeline } from "./assessment-timeline";
import { ScaleLicenseRegistry } from "./scale-license-registry";
import { ScalePolicyEditor } from "./scale-policy-editor";
import { ScaleTrend } from "./scale-trend";
import { SignificantChangeInbox } from "./significant-change-inbox";

export const assessmentScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 9,
  slug: "09-assessments",
  screens: [
    {
      // Patient assessment timeline — reached from the patient chart "Assessments" tab; param path (no nav).
      id: "assessment.timeline",
      path: "/patients/:patientId/assessments",
      title: "Assessments",
      requiredPermission: "assessment.read",
      screen: AssessmentTimeline,
    },
    {
      // Per-scale trend — reached from a timeline row; param path (no nav).
      id: "assessment.scale-trend",
      path: "/patients/:patientId/scales/:scaleType",
      title: "Scale Trend",
      requiredPermission: "assessment.read_trend",
      screen: ScaleTrend,
    },
    {
      // Per-patient significant-change inbox — reached from the chart; param path (no nav).
      id: "assessment.changes",
      path: "/patients/:patientId/assessments/changes",
      title: "Significant Changes",
      requiredPermission: "assessment.read",
      screen: SignificantChangeInbox,
    },
    {
      // Assessment summary — latest value per scale; param path (no nav).
      id: "assessment.summary",
      path: "/patients/:patientId/assessments/summary",
      title: "Assessment Summary",
      requiredPermission: "assessment.read_summary",
      screen: AssessmentSummary,
    },
    {
      // Scale-license registry — org-admin top-level surface.
      id: "assessment.scale-licenses",
      path: "/admin/scales/licenses",
      title: "Scale Licenses",
      navGroup: "Admin",
      requiredPermission: "assessment.license_read",
      screen: ScaleLicenseRegistry,
    },
    {
      // Scale-policy editor — org-admin top-level surface.
      id: "assessment.scale-policies",
      path: "/admin/scales/policies",
      title: "Scale Policies",
      navGroup: "Admin",
      requiredPermission: "assessment.policy_read",
      screen: ScalePolicyEditor,
    },
  ],
};
