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
const DischargesHub = lazy(() =>
  import("./discharges-hub").then((m) => ({ default: m.DischargesHub })),
);
const DischargeWorkflow = lazy(() =>
  import("./discharge-workflow").then((m) => ({ default: m.DischargeWorkflow })),
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
const DeathPronouncement = lazy(() =>
  import("./death-pronouncement").then((m) => ({ default: m.DeathPronouncement })),
);
const DischargeDetails = lazy(() =>
  import("./discharge-details").then((m) => ({ default: m.DischargeDetails })),
);
const DischargeCosign = lazy(() =>
  import("./discharge-cosign").then((m) => ({ default: m.DischargeCosign })),
);
const TransferIn = lazy(() => import("./transfer-in").then((m) => ({ default: m.TransferIn })));
const Readmission = lazy(() => import("./readmission").then((m) => ({ default: m.Readmission })));
const ReadmitList = lazy(() => import("./readmit-list").then((m) => ({ default: m.ReadmitList })));
const LevelOfCareChange = lazy(() =>
  import("./level-of-care-change").then((m) => ({ default: m.LevelOfCareChange })),
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
      // Discharge / revocation / transfer-out stepper (WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER) — reached
      // from the Admission Detail header of an active / on-hold admission; omitted from nav (param path).
      // `discharge.create` is the umbrella key (route 39's fallback gate); the server derives the real
      // per-reason key (`discharge.moved`, `transfer.out`, `revocation.create`, …) on submit.
      id: "admission.discharge",
      path: "/admissions/:id/discharge",
      title: "Discharge / transfer",
      requiredPermission: "discharge.create",
      screen: DischargeWorkflow,
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
      // End-of-episode hub — nav entry right below "New admission" (primary-nav.ts childOrder). Lists admissions
      // ready for a discharge / transfer / death, ended stays missing a claim detail, and (medical directors)
      // for-cause discharges awaiting cosign, from GET /api/v1/discharges/worklist. The screen registry gates nav on
      // ONE key: `discharge.create`, the discharge workflow's umbrella key (route 39's fallback gate). The row actions
      // are gated per key inside the hub (DISCHARGE_WORKFLOW_PERMISSIONS / discharge.death / cosign_for_cause).
      // Static path: react-router ranks it above `/admissions/:id`.
      id: "admission.discharges",
      path: "/admissions/discharges",
      title: "Discharge / transfer",
      navGroup: "Admissions",
      requiredPermission: "discharge.create",
      screen: DischargesHub,
    },
    {
      // Readmit — the patients who can come back (the worklist's `recently_discharged` bucket), each with "Readmit…" →
      // `/admissions/:id/readmit`. Nav entry right after "Discharge / transfer" (primary-nav.ts childOrder). Gated on
      // `admission.create`, which intake supervisors and — since migration 0379 — the nursing / physician / NP / PA
      // roles hold; the server scopes the rows (intake org-wide, clinicians their own site). Static path: react-router
      // ranks it above `/admissions/:id`.
      id: "admission.readmit-list",
      path: "/admissions/readmit",
      title: "Readmit",
      navGroup: "Admissions",
      requiredPermission: "admission.create",
      screen: ReadmitList,
    },
    {
      // Patient-scoped Election & Certification — reached from the patient chart tab (param path, no nav).
      id: "admission.patient-election-cert",
      path: "/patients/:patientId/election-certification",
      title: "Election & Certification",
      requiredPermission: "election.read",
      screen: PatientElectionCert,
    },
    {
      // Death & Pronouncement (WARDENX_UI_DEATH_PRONOUNCEMENT) — launched from the admission detail.
      id: "admission.death-pronouncement",
      path: "/admissions/:id/death",
      title: "Death & Pronouncement",
      requiredPermission: "discharge.death",
      screen: DeathPronouncement,
    },
    {
      // Transfer-in (WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER, separate entry) — pre-activation intake.
      id: "admission.transfer-in",
      path: "/admissions/:id/transfer-in",
      title: "Transfer-in",
      requiredPermission: "transfer.in",
      screen: TransferIn,
    },
    {
      // Readmit a live-discharged patient: previous episode, benefit period (HETS-confirmed or a warning), the
      // period's requirements, intake, review → POST /api/v1/admissions (readmittedFromAdmissionId + benefitPeriod).
      // Reached from the Readmit list, the admission detail of a discharged stay, the discharge hub's "Recently
      // discharged" list and the patient chart. No nav entry of its own (it acts on one admission).
      id: "admission.readmit",
      path: "/admissions/:id/readmit",
      title: "Readmit patient",
      requiredPermission: "admission.create",
      screen: Readmission,
    },
    {
      // For-cause discharge medical-director cosign (route 40). The server also applies the 418.26(b) order-signer ABAC (medical director, designee or IDG physician).
      id: "admission.discharge-cosign",
      path: "/discharges/:id/cosign",
      title: "Cosign for-cause discharge",
      requiredPermission: "discharge.cosign_for_cause",
      screen: DischargeCosign,
    },
    {
      // Discharge details for billing — completes a death discharge / transfer-out recorded before the place of
      // death / receiving care setting was captured (the final claim's patient status needs it). Reached from the
      // admission detail's alert and a blocked claim's "Fix discharge details". Reading is admission.read; the
      // save is gated server-side on discharge.death / transfer.out (+ admission scope) and says so on a 403.
      id: "admission.discharge-details",
      path: "/admissions/:id/discharge-details",
      title: "Discharge details for billing",
      requiredPermission: "admission.read",
      screen: DischargeDetails,
    },
    {
      // M6 screen 13 / D12 — step up or down between levels of care; selecting GIP shows the three required
      // attestations. The server re-enforces everything (loc.change + admission.scope + 412 on a missing attestation).
      id: "admission.level-of-care-change",
      path: "/admissions/:id/level-of-care/new",
      title: "Change level of care",
      requiredPermission: "loc.change",
      screen: LevelOfCareChange,
    },
  ],
};
