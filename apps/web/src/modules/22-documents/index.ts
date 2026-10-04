// apps/web/src/modules/22-documents — M22 Document Management web-slice (Track B, ADR-0030, M22-T10).
// Exports the screen-registry module the M1 shell registers in main.tsx. The screens read ONLY via the
// generated typed client; the server is the only authz point.
export { documentScreens } from "./screens";
// F-238 — the prospect summary of a completed DocLens review, reusable outside the review workspace.
export {
  PatientIntakeSummaries,
  SHOWS_INTAKE_SUMMARIES,
  ProspectSummaryPanel,
  ProspectSummaryView,
  loadProspectSummary,
  type ProspectSummary,
} from "./prospect-summary";
