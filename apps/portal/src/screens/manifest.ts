// @wardenx/portal — §5.1 screen manifest (metadata only). PURE (no React): this is the single source of the
// portal's route → permission-key map, imported by both the concrete registry (which binds each id to its
// component) and the registry unit test (which asserts unique ids/paths + real permission keys). Keeping the
// metadata renderer-free lets the test run under the node vitest environment without a DOM.
//
// Hard navigation boundaries map 1:1 to the real `portal.*` / `telehealth.*` permission keys M31-T07
// contributed (§4.6). Nav visibility is gated here; the SERVER remains the only enforcement point — an
// off-grant navigation 404s (architecture §G), it does not 403.

export interface PortalScreenMeta {
  /** Stable id, unique across the portal. */
  id: string;
  /** react-router path (params as `:name`). */
  path: string;
  /** Human title for nav + document title. */
  title: string;
  /** Nav grouping label. */
  navGroup?: string;
  /** Permission key gating nav visibility (a real contributed key). */
  requiredPermission?: string;
  /** Chromeless (pre-session) surface — rendered standalone, omitted from nav. */
  chrome?: boolean;
}

export const PORTAL_SCREEN_MANIFEST: readonly PortalScreenMeta[] = [
  { id: "portal.sign-in", path: "/", title: "Sign in", chrome: false },
  {
    id: "portal.accept-invitation",
    path: "/accept-invitation",
    title: "Accept invitation",
    chrome: false,
  },
  {
    id: "portal.patient-picker",
    path: "/patient-picker",
    title: "Choose patient",
    navGroup: "Account",
    requiredPermission: "portal.session.read_own",
  },
  {
    id: "portal.dashboard",
    path: "/p/:patientId",
    title: "Home",
    navGroup: "Care",
    requiredPermission: "portal.care_summary.read",
  },
  {
    id: "portal.care-plan",
    path: "/p/:patientId/care-plan",
    title: "Care plan",
    navGroup: "Care",
    requiredPermission: "portal.care_plan.read_summary",
  },
  {
    id: "portal.visits",
    path: "/p/:patientId/visits",
    title: "Visits",
    navGroup: "Care",
    requiredPermission: "portal.visits.read_upcoming",
  },
  {
    id: "portal.telehealth",
    path: "/p/:patientId/visits/:visitId/telehealth",
    title: "Video visit",
    navGroup: "Care",
    requiredPermission: "telehealth.join_patient_or_caregiver",
  },
  {
    id: "portal.medications",
    path: "/p/:patientId/medications",
    title: "Medications",
    navGroup: "Care",
    requiredPermission: "portal.medications.read_summary",
  },
  {
    id: "portal.documents",
    path: "/p/:patientId/documents",
    title: "Documents",
    navGroup: "Care",
    requiredPermission: "portal.documents.read_list",
  },
  {
    id: "portal.messages",
    path: "/p/:patientId/messages",
    title: "Messages",
    navGroup: "Care",
    requiredPermission: "portal.messages.read_channel",
  },
  {
    id: "portal.amendments",
    path: "/p/:patientId/amendments",
    title: "Request a correction",
    navGroup: "Care",
    requiredPermission: "portal.amendment.read_own",
  },
  {
    id: "portal.preferences",
    path: "/p/:patientId/preferences",
    title: "Notifications",
    navGroup: "Account",
    requiredPermission: "portal.preferences.read_own",
  },
  {
    id: "portal.bereavement",
    path: "/p/:patientId/bereavement",
    title: "Bereavement support",
    navGroup: "Care",
    requiredPermission: "portal.bereavement.read_program",
  },
  {
    id: "portal.account",
    path: "/account",
    title: "Account & security",
    navGroup: "Account",
    requiredPermission: "portal.session.read_own",
  },
] as const;
