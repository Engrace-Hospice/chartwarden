// The visit-note closure allowlist (bootstrap/note-closure-allowlist.ts) against the REAL registered route table.
//
// A hand-written list drifts from the route table in two ways, and this walks the same static route scan that feeds the OpenAPI
// document to catch both:
//   * an entry that names a route that does not exist (a typo, a renamed parameter, a route since removed) would silently allow nothing
//     and hide a screen that cannot be used while blocked;
//   * a new route that SHOULD stay closed (or be opened) is never looked at. Every GET under the chart prefixes, and every route of
//     the closing / patient-safety families, must be classified here: allowed, or explicitly denied. A new one fails this test until
//     somebody decides. The RUNTIME stays fail-closed regardless: an unlisted route is refused for a blocked clinician.
import { describe, expect, it } from "vitest";
import { scanRoutes } from "../../../scripts/openapi/scan-routes";
import { NOTE_CLOSURE_ALLOWED_ROUTES } from "../src/bootstrap/note-closure-allowlist";
import { noteClosureMayCall } from "../src/bootstrap/note-closure-gate";

const routes = scanRoutes();
const registered = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
const allowed = (method: string, path: string) =>
  noteClosureMayCall({ method, routeTemplate: path, rawUrl: path });
const pathOf = (entry: string) => entry.split(" ")[1] ?? "";
const under = (path: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/**
 * The whole allowlist, spelled out. Adding a pair means editing this list too, in the same change, so an addition cannot slip in under a
 * root the other checks here do not name (the test below compares the set to this list exactly).
 */
const EXPECTED_ALLOWLIST = [
  "DELETE /api/v1/encounters/:encounterId/care-plan-links/:linkId",
  "GET /api/v1/administrations",
  "GET /api/v1/administrations/:id",
  "GET /api/v1/administrations/iv-sessions/:sessionId",
  "GET /api/v1/admissions",
  "GET /api/v1/admissions/:admissionId/hope",
  "GET /api/v1/admissions/:id",
  "GET /api/v1/admissions/:id/discharge-details",
  "GET /api/v1/admissions/:id/discharge-order",
  "GET /api/v1/admissions/:id/level-of-care",
  "GET /api/v1/alerts/inbox",
  "GET /api/v1/auth/context",
  "GET /api/v1/auth/credential-status",
  "GET /api/v1/auth/csrf",
  "GET /api/v1/auth/memberships",
  "GET /api/v1/care-plans/:planId/problem-proposals",
  "GET /api/v1/care-plans/:planId/summary",
  "GET /api/v1/care-plans/:planId/versions",
  "GET /api/v1/care-plans/:planId/versions/:versionId",
  "GET /api/v1/care-plans/:planId/versions/:versionId/proposed-changes",
  "GET /api/v1/comfort-kits/deployments",
  "GET /api/v1/comfort-kits/deployments/:id",
  "GET /api/v1/documents",
  "GET /api/v1/documents/:id",
  "GET /api/v1/documents/:id/tags",
  "GET /api/v1/documents/:id/versions",
  "GET /api/v1/documents/:id/versions/:versionId",
  "GET /api/v1/documents/:id/versions/:versionId/content",
  "GET /api/v1/encounters",
  "GET /api/v1/encounters/:encounterId",
  "GET /api/v1/encounters/:encounterId/addenda/:addendumId/selections",
  "GET /api/v1/encounters/:encounterId/care-plan-links",
  "GET /api/v1/encounters/:encounterId/chart-promotions",
  "GET /api/v1/encounters/:encounterId/cosignature",
  "GET /api/v1/encounters/:encounterId/mileage",
  "GET /api/v1/encounters/:encounterId/selections",
  "GET /api/v1/encounters/:encounterId/template",
  "GET /api/v1/encounters/:encounterId/vitals",
  "GET /api/v1/encounters/closure-status",
  "GET /api/v1/encounters/cosignature-queue",
  "GET /api/v1/encounters/my-drafts",
  "GET /api/v1/encounters/overdue-notes",
  "GET /api/v1/escalations",
  "GET /api/v1/hope/assessments/:id",
  "GET /api/v1/hope/assessments/:id/review",
  "GET /api/v1/hope/assessments/:id/validation",
  "GET /api/v1/hope/assessments/:id/workspace",
  "GET /api/v1/idg/meetings/:id",
  "GET /api/v1/idg/meetings/:id/agenda",
  "GET /api/v1/idg/meetings/:id/decisions",
  "GET /api/v1/idg/meetings/:id/discipline-notes",
  "GET /api/v1/idg/meetings/:id/minutes",
  "GET /api/v1/idg/meetings/:id/packets",
  "GET /api/v1/idg/meetings/:meetingId/packets/:patientId",
  "GET /api/v1/inpatient-units",
  "GET /api/v1/locations",
  "GET /api/v1/mdm/:kind/:id",
  "GET /api/v1/mdm/:kind/search",
  "GET /api/v1/me/permissions",
  "GET /api/v1/me/session",
  "GET /api/v1/medication-orders",
  "GET /api/v1/medication-orders/:id",
  "GET /api/v1/medication-orders/:id/transmission",
  "GET /api/v1/messaging/channels",
  "GET /api/v1/messaging/channels/:id",
  "GET /api/v1/messaging/channels/:id/messages",
  "GET /api/v1/messaging/channels/:id/urgent-messages/options",
  "GET /api/v1/messaging/emergencies",
  "GET /api/v1/messaging/emergencies/mine",
  "GET /api/v1/messaging/messages/:messageId/emergency",
  "GET /api/v1/messaging/oncall/coverage",
  "GET /api/v1/missed-doses",
  "GET /api/v1/oncall/current",
  "GET /api/v1/orders",
  "GET /api/v1/orders/:id",
  "GET /api/v1/orders/cosign-pending",
  "GET /api/v1/orders/held-transmissions",
  "GET /api/v1/orders/pending-signature",
  "GET /api/v1/orders/results-pending-review",
  "GET /api/v1/orders/suggestions/:patientId",
  "GET /api/v1/orders/verbal-expiring",
  "GET /api/v1/orgs/:id/care-team-staff",
  "GET /api/v1/orgs/:id/members",
  "GET /api/v1/patients",
  "GET /api/v1/patients/:id",
  "GET /api/v1/patients/:id/addresses",
  "GET /api/v1/patients/:id/allergies",
  "GET /api/v1/patients/:id/care-team",
  "GET /api/v1/patients/:id/caregivers",
  "GET /api/v1/patients/:id/code-status",
  "GET /api/v1/patients/:id/demographics",
  "GET /api/v1/patients/:id/identifiers",
  "GET /api/v1/patients/:id/payers",
  "GET /api/v1/patients/:id/privacy",
  "GET /api/v1/patients/:id/privacy-flags",
  "GET /api/v1/patients/:id/wristband",
  "GET /api/v1/patients/:patientId/admissions",
  "GET /api/v1/patients/:patientId/assessments",
  "GET /api/v1/patients/:patientId/assessments/:id",
  "GET /api/v1/patients/:patientId/assessments/summary",
  "GET /api/v1/patients/:patientId/care-plan",
  "GET /api/v1/patients/:patientId/consents",
  "GET /api/v1/patients/:patientId/dpoa/active-primary",
  "GET /api/v1/patients/:patientId/hope/assessments",
  "GET /api/v1/patients/:patientId/idg-history",
  "GET /api/v1/patients/:patientId/intake-summaries",
  "GET /api/v1/patients/:patientId/medications/active",
  "GET /api/v1/patients/:patientId/medications/history",
  "GET /api/v1/patients/:patientId/scales/:scaleType/delta",
  "GET /api/v1/patients/:patientId/scales/:scaleType/latest",
  "GET /api/v1/patients/:patientId/scales/:scaleType/series",
  "GET /api/v1/patients/:patientId/significant-changes",
  "GET /api/v1/provider-entities",
  "GET /api/v1/safety/check-ins/:checkInId",
  "GET /api/v1/safety/check-ins/me/today",
  "GET /api/v1/safety/consent",
  "GET /api/v1/safety/incidents",
  "GET /api/v1/safety/incidents/:incidentId",
  "GET /api/v1/safety/sos/:sosAlertId",
  "GET /api/v1/safety/sos/:sosAlertId/location-stream",
  "GET /api/v1/safety/sos/:sosAlertId/psap",
  "GET /api/v1/safety/sos/:sosAlertId/terminus",
  "GET /api/v1/safety/sos/active",
  "GET /api/v1/scheduled-doses",
  "GET /api/v1/standing-orders",
  "GET /api/v1/standing-orders/:id",
  "GET /api/v1/system/feature-flags",
  "GET /api/v1/terminology/:system/:code",
  "GET /api/v1/terminology/:system/search",
  "GET /api/v1/terminology/value-sets/:id/expand",
  "GET /api/v1/triage-calls",
  "GET /api/v1/triage-calls/:triageCallId",
  "GET /api/v1/triage-calls/:triageCallId/transcript-decrypt",
  "GET /api/v1/triage-calls/paper-reentry/worklist",
  "GET /api/v1/triage-protocols",
  "GET /api/v1/triage-protocols/:protocolId",
  "GET /api/v1/visits",
  "GET /api/v1/visits/:visitId",
  "GET /health",
  "GET /ready",
  "PATCH /api/v1/encounters/:encounterId/addenda/:addendumId/selections",
  "PATCH /api/v1/encounters/:encounterId/hearthnote/modifications/:modId/decisions",
  "PATCH /api/v1/encounters/:encounterId/mileage",
  "PATCH /api/v1/encounters/:encounterId/selections",
  "PATCH /api/v1/encounters/:encounterId/vitals/:vitalId",
  "PATCH /api/v1/medication-orders/:id",
  "PATCH /api/v1/orders/:id",
  "PATCH /api/v1/quality/incidents/:incidentId",
  "PATCH /api/v1/safety/check-ins/:checkInId",
  "PATCH /api/v1/safety/incidents/:incidentId",
  "PATCH /api/v1/triage-calls/:triageCallId/answers/:answerId/correct",
  "POST /api/v1/administrations",
  "POST /api/v1/administrations/:id/acknowledge-caregiver",
  "POST /api/v1/administrations/:id/correct",
  "POST /api/v1/administrations/:id/dispute-caregiver",
  "POST /api/v1/administrations/:id/void",
  "POST /api/v1/administrations/caregiver-attested",
  "POST /api/v1/administrations/offline-sync",
  "POST /api/v1/administrations/refuse",
  "POST /api/v1/administrations/witness-attest",
  "POST /api/v1/alerts/:id/read",
  "POST /api/v1/alerts/read-all",
  "POST /api/v1/auth/password/complete-required-change",
  "POST /api/v1/auth/select-organization",
  "POST /api/v1/auth/unlock",
  "POST /api/v1/breakglass",
  "POST /api/v1/breakglass/:id/cosign",
  "POST /api/v1/breakglass/:id/revoke",
  "POST /api/v1/encounters",
  "POST /api/v1/encounters/:encounterId/addenda",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/finalize",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/sign",
  "POST /api/v1/encounters/:encounterId/administrative-override",
  "POST /api/v1/encounters/:encounterId/care-plan-links",
  "POST /api/v1/encounters/:encounterId/chart-promotions/:requestId/reject",
  "POST /api/v1/encounters/:encounterId/cosignature/acknowledge",
  "POST /api/v1/encounters/:encounterId/cosignature/sign",
  "POST /api/v1/encounters/:encounterId/cosignature/supervisor-release",
  "POST /api/v1/encounters/:encounterId/evv-reconcile",
  "POST /api/v1/encounters/:encounterId/finalize",
  "POST /api/v1/encounters/:encounterId/hearthnote/enhance",
  "POST /api/v1/encounters/:encounterId/late-entry-override",
  "POST /api/v1/encounters/:encounterId/mileage",
  "POST /api/v1/encounters/:encounterId/sign",
  "POST /api/v1/encounters/:encounterId/vitals",
  "POST /api/v1/encounters/closure-overrides",
  "POST /api/v1/encounters/closure-overrides/:overrideId/revoke",
  "POST /api/v1/escalations/:escalationId/acknowledge",
  "POST /api/v1/escalations/:escalationId/resolve",
  "POST /api/v1/evv/check-out",
  "POST /api/v1/evv/offline-sync",
  "POST /api/v1/evv/offline-sync/v2",
  "POST /api/v1/ipu-restraint/:id/reassess",
  "POST /api/v1/ipu-restraint/:id/release",
  "POST /api/v1/medication-orders",
  "POST /api/v1/medication-orders/:id/complete",
  "POST /api/v1/medication-orders/:id/correct",
  "POST /api/v1/medication-orders/:id/cosign",
  "POST /api/v1/medication-orders/:id/discontinue",
  "POST /api/v1/medication-orders/:id/report-error",
  "POST /api/v1/medication-orders/:id/request-signature",
  "POST /api/v1/medication-orders/:id/resolve-held-transmission",
  "POST /api/v1/medication-orders/:id/retransmit",
  "POST /api/v1/medication-orders/:id/sign",
  "POST /api/v1/medication-orders/:id/sign-controlled/complete",
  "POST /api/v1/medication-orders/:id/sign-controlled/initiate",
  "POST /api/v1/medication-orders/:id/verbal",
  "POST /api/v1/messaging/channels/:id/messages",
  "POST /api/v1/messaging/channels/:id/urgent-messages",
  "POST /api/v1/messaging/death-notifications/:notificationId/ack",
  "POST /api/v1/messaging/emergencies/:emergencyId/ack",
  "POST /api/v1/messaging/messages/:messageId/emergency",
  "POST /api/v1/missed-doses/:id/acknowledge",
  "POST /api/v1/orders",
  "POST /api/v1/orders/:id/complete",
  "POST /api/v1/orders/:id/correct",
  "POST /api/v1/orders/:id/cosign",
  "POST /api/v1/orders/:id/discontinue",
  "POST /api/v1/orders/:id/recover-transmission",
  "POST /api/v1/orders/:id/recover-transmission/:requestId/cancel",
  "POST /api/v1/orders/:id/recover-transmission/:requestId/cosign",
  "POST /api/v1/orders/:id/request-signature",
  "POST /api/v1/orders/:id/resend-transmission",
  "POST /api/v1/orders/:id/review-results",
  "POST /api/v1/orders/:id/sign",
  "POST /api/v1/orders/:id/sign-on-behalf",
  "POST /api/v1/orders/:id/verbal",
  "POST /api/v1/patients/:id/code-status",
  "POST /api/v1/patients/:id/code-status/:entryId/entered-in-error",
  "POST /api/v1/patients/:id/deceased",
  "POST /api/v1/quality/incidents",
  "POST /api/v1/quality/incidents/:incidentId/submit",
  "POST /api/v1/safety/check-ins",
  "POST /api/v1/safety/consent/grant",
  "POST /api/v1/safety/consent/revoke",
  "POST /api/v1/safety/incidents",
  "POST /api/v1/safety/incidents/:incidentId/osha-signoff",
  "POST /api/v1/safety/incidents/:incidentId/state",
  "POST /api/v1/safety/incidents/:incidentId/submit",
  "POST /api/v1/safety/sos",
  "POST /api/v1/safety/sos/:sosAlertId/acknowledge",
  "POST /api/v1/safety/sos/:sosAlertId/cancel",
  "POST /api/v1/safety/sos/:sosAlertId/resolve",
  "POST /api/v1/scheduled-doses/:id/intentional-hold",
  "POST /api/v1/sessions/step-up",
  "POST /api/v1/sessions/step-up/initiate",
  "POST /api/v1/standing-orders/:id/discontinue",
  "POST /api/v1/standing-orders/:id/pause",
  "POST /api/v1/standing-orders/:id/spawn",
  "POST /api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient",
  "POST /api/v1/triage-calls",
  "POST /api/v1/triage-calls/:triageCallId/abandon",
  "POST /api/v1/triage-calls/:triageCallId/answers",
  "POST /api/v1/triage-calls/:triageCallId/apply-protocol",
  "POST /api/v1/triage-calls/:triageCallId/awaiting-callback",
  "POST /api/v1/triage-calls/:triageCallId/complete-protocol",
  "POST /api/v1/triage-calls/:triageCallId/disposition",
  "POST /api/v1/triage-calls/:triageCallId/document",
  "POST /api/v1/triage-calls/:triageCallId/escalations",
  "POST /api/v1/triage-calls/:triageCallId/identify-patient",
  "POST /api/v1/triage-calls/:triageCallId/request-summary",
  "POST /api/v1/triage-calls/:triageCallId/resume",
  "POST /api/v1/triage-calls/paper-reentry",
  "POST /api/v1/verbal-orders",
  "PUT /api/v1/medication-orders/:id/coverage-determination",
];

/** Chart prefixes: every GET under one is allowed (above) or named in DENIED_CHART_GETS. Writes under them are closed by default. */
const CHART_GET_PREFIXES = [
  "/api/v1/patients",
  "/api/v1/admissions",
  "/api/v1/care-plans",
  "/api/v1/documents",
  "/api/v1/hope",
  "/api/v1/idg",
  "/api/v1/visits",
  "/api/v1/comfort-kits",
  "/api/v1/oncall",
  "/api/v1/refills",
  "/api/v1/consents",
  "/api/v1/cti",
  "/api/v1/face-to-face",
  "/api/v1/election-statements",
  "/api/v1/scales",
  "/api/v1/discharges",
  "/api/v1/ipu-admissions",
] as const;

/** The closing / patient-safety families: EVERY method under one is allowed (above) or named in DENIED_FAMILY_ROUTES. */
const FAMILY_PREFIXES = [
  "/api/v1/encounters",
  "/api/v1/administrations",
  "/api/v1/orders",
  "/api/v1/medication-orders",
  "/api/v1/verbal-orders",
  "/api/v1/standing-orders",
  "/api/v1/triage-calls",
  "/api/v1/triage-protocols",
  "/api/v1/escalations",
  "/api/v1/safety",
  "/api/v1/ipu-restraint",
  "/api/v1/alerts",
  "/api/v1/scheduled-doses",
  "/api/v1/missed-doses",
] as const;

/**
 * Reads a blocked clinician does NOT get: organization-wide worklists, dashboards and KPIs, and administrative, billing,
 * compliance-tracking and staffing reads. Each is a real route (checked below).
 */
const DENIED_CHART_GETS = [
  "GET /api/v1/admissions/:id/compliance-windows",
  "GET /api/v1/admissions/:id/election-addendum",
  "GET /api/v1/admissions/:id/election-periods",
  "GET /api/v1/admissions/:id/nomnc",
  "GET /api/v1/admissions/:id/nor",
  "GET /api/v1/admissions/:id/physician-signers",
  "GET /api/v1/admissions/:id/readiness",
  "GET /api/v1/admissions/:id/readmission-context",
  "GET /api/v1/care-plans/:planId/overdue-status",
  "GET /api/v1/care-plans/:planId/readiness",
  "GET /api/v1/care-plans/:planId/review-status",
  "GET /api/v1/consents/:consentId",
  "GET /api/v1/consents/:consentId/dpoa-agents",
  "GET /api/v1/consents/:consentId/eval-audit",
  "GET /api/v1/consents/:consentId/recipients",
  "GET /api/v1/consents/:consentId/renewal-cycle",
  "GET /api/v1/consents/:consentId/version-chain",
  "GET /api/v1/consents/eval-audit/by-patient",
  "GET /api/v1/consents/post-mortem-eligible/:patientId",
  "GET /api/v1/cti/:id",
  "GET /api/v1/discharges/:id/cosign-context",
  "GET /api/v1/discharges/worklist",
  "GET /api/v1/election-statements/:id",
  "GET /api/v1/face-to-face/:id",
  "GET /api/v1/hope/assessments/:id/submissions",
  "GET /api/v1/hope/dashboard/compliance",
  "GET /api/v1/hope/schedules",
  "GET /api/v1/hope/schedules/:id",
  "GET /api/v1/hope/sfv",
  "GET /api/v1/hope/sfv/:id",
  "GET /api/v1/hope/submissions",
  "GET /api/v1/hope/submissions/:id",
  "GET /api/v1/hope/submissions/:id/package",
  "GET /api/v1/idg/action-items",
  "GET /api/v1/idg/meetings/:id/attendance",
  "GET /api/v1/idg/meetings/:id/attendance-eligibility",
  "GET /api/v1/idg/meetings/:id/chart-promotions",
  "GET /api/v1/idg/meetings/:id/recert-windows",
  "GET /api/v1/idg/schedule",
  "GET /api/v1/ipu-admissions",
  "GET /api/v1/ipu-admissions/:id",
  "GET /api/v1/ipu-admissions/:id/gip-criteria",
  "GET /api/v1/ipu-admissions/:id/irc-episodes",
  "GET /api/v1/ipu-admissions/:id/restraints",
  "GET /api/v1/oncall/external-vendors",
  "GET /api/v1/oncall/policy",
  "GET /api/v1/oncall/shifts",
  "GET /api/v1/patients/:id/amendments",
  "GET /api/v1/patients/:id/assignments",
  "GET /api/v1/patients/:patientId/benefit-period-plan",
  "GET /api/v1/patients/:patientId/delegated-access",
  "GET /api/v1/patients/:patientId/election-certification",
  "GET /api/v1/patients/:patientId/expiring-consents",
  "GET /api/v1/patients/:patientId/intake-pending-address",
  "GET /api/v1/patients/census-metrics",
  "GET /api/v1/patients/messaging-search",
  "GET /api/v1/refills",
  "GET /api/v1/refills/:id",
  "GET /api/v1/scales",
];

/** Family routes a blocked clinician does NOT get: voiding a note, the closure policy, authoring (not acting on) standing orders and triage protocols, safety administration. */
const DENIED_FAMILY_ROUTES = [
  "DELETE /api/v1/safety/supervisor-subscriptions/:subscriptionId",
  "GET /api/v1/encounters/closure-policy",
  "GET /api/v1/safety/admin/terminus-readiness",
  "GET /api/v1/safety/dashboard",
  "GET /api/v1/safety/high-risk-areas",
  "GET /api/v1/safety/policy",
  "GET /api/v1/safety/supervisor-subscriptions",
  "PATCH /api/v1/safety/high-risk-areas/:areaId",
  "PATCH /api/v1/safety/policy",
  "PATCH /api/v1/standing-orders/:id",
  "PATCH /api/v1/triage-protocols/:protocolId",
  "POST /api/v1/encounters/:encounterId/void",
  "POST /api/v1/safety/high-risk-areas",
  "POST /api/v1/safety/supervisor-subscriptions",
  "POST /api/v1/standing-orders",
  "POST /api/v1/standing-orders/:id/resume",
  "POST /api/v1/triage-protocols",
  "POST /api/v1/triage-protocols/:protocolId/questions",
  "PUT /api/v1/encounters/closure-policy",
];

/** Entries that sit under a forbidden root on purpose: a reporter's own incident routes and the comfort kit deployed at the bedside. */
const FORBIDDEN_ROOT_CARVE_OUTS = [
  "POST /api/v1/quality/incidents",
  "PATCH /api/v1/quality/incidents/:incidentId",
  "POST /api/v1/quality/incidents/:incidentId/submit",
  "POST /api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient",
];

/**
 * Writes that look like patient-safety or regulatory duties but are DELIBERATELY refused for a blocked clinician (the owner's decision:
 * only the IPU restraint release and reassess were added). Each carries the reason it stays closed, and the test below keeps the table
 * honest both ways: every entry is a real route, is not on the allowlist, and has a stated reason, so a future allowlist change that
 * opens one must delete its row here and say why in the same change.
 */
const DENIED_SAFETY_DUTY_WRITES: readonly (readonly [route: string, reason: string])[] = [
  [
    "POST /api/v1/admissions/:id/revocation",
    "hospice election revocation is a patient or representative decision that can wait for the note; revoking it releases the benefit period",
  ],
  [
    "POST /api/v1/admissions/:id/discharge",
    "a discharge is an administrative and billing event with its own notices and deadlines, not an emergency",
  ],
  [
    "POST /api/v1/patients/:id/allergies/:allergyId/entered-in-error",
    "an allergy write (here, retracting one) alters the safety record and can wait; reading allergies stays open",
  ],
  [
    "POST /api/v1/patients/:id/allergies/:allergyId/verify",
    "an allergy write (here, verifying one) alters the safety record and can wait; reading allergies stays open",
  ],
  [
    "POST /api/v1/consents/:consentId/revoke",
    "consent revocation is a disclosure and billing decision that can wait for the note",
  ],
  [
    "POST /api/v1/ipu-admissions/:id/restraint",
    "applying a NEW restraint is new clinical work; only releasing or reassessing one already applied stays open",
  ],
];

describe("the note-closure allowlist against the registered route table", () => {
  it("scans a plausible route table (the guard against an empty scan passing everything vacuously)", () => {
    expect(routes.length).toBeGreaterThan(500);
    expect(registered.has("GET /api/v1/encounters/closure-status")).toBe(true);
  });

  it("the allowlist is exactly the reviewed list (no pair under any root can be added unseen)", () => {
    expect([...NOTE_CLOSURE_ALLOWED_ROUTES].sort()).toEqual([...EXPECTED_ALLOWLIST].sort());
  });

  it("every allowlisted entry names a route that exists", () => {
    const missing = [...NOTE_CLOSURE_ALLOWED_ROUTES].filter((entry) => !registered.has(entry));
    expect(missing).toEqual([]);
  });

  it("every explicitly denied route exists and is not allowed (a stale or contradictory entry fails)", () => {
    for (const entry of [...DENIED_CHART_GETS, ...DENIED_FAMILY_ROUTES]) {
      expect(registered.has(entry), `${entry} must be a real route`).toBe(true);
      expect(NOTE_CLOSURE_ALLOWED_ROUTES.has(entry), `${entry} is both allowed and denied`).toBe(
        false,
      );
    }
  });

  it("every GET under a chart prefix is classified: allowed or explicitly denied", () => {
    const unclassified = routes
      .filter((r) => r.method.toUpperCase() === "GET" && under(r.path, CHART_GET_PREFIXES))
      .map((r) => `GET ${r.path}`)
      .filter((e) => !NOTE_CLOSURE_ALLOWED_ROUTES.has(e) && !DENIED_CHART_GETS.includes(e));
    expect(unclassified, "classify these: add to the allowlist or to DENIED_CHART_GETS").toEqual(
      [],
    );
  });

  it("every route of a closing / patient-safety family is classified: allowed or explicitly denied", () => {
    const unclassified = routes
      .filter((r) => under(r.path, FAMILY_PREFIXES))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`)
      .filter((e) => !NOTE_CLOSURE_ALLOWED_ROUTES.has(e) && !DENIED_FAMILY_ROUTES.includes(e));
    expect(unclassified, "classify these: add to the allowlist or to DENIED_FAMILY_ROUTES").toEqual(
      [],
    );
  });

  it("every deliberately refused safety-duty write is a real route, is not on the allowlist, and says why", () => {
    for (const [entry, reason] of DENIED_SAFETY_DUTY_WRITES) {
      expect(registered.has(entry), `${entry} must be a real route`).toBe(true);
      expect(NOTE_CLOSURE_ALLOWED_ROUTES.has(entry), `${entry} is both allowed and denied`).toBe(
        false,
      );
      expect(reason.length, `${entry} needs a reason`).toBeGreaterThan(30);
    }
  });

  it("the IPU restraint family is classified: release and reassess stay open (42 CFR 418.110), applying a new one does not", () => {
    for (const entry of [
      "POST /api/v1/ipu-restraint/:id/release",
      "POST /api/v1/ipu-restraint/:id/reassess",
    ]) {
      expect(registered.has(entry), `${entry} must be a real route`).toBe(true);
      expect(NOTE_CLOSURE_ALLOWED_ROUTES.has(entry), entry).toBe(true);
    }
    expect(allowed("POST", "/api/v1/ipu-admissions/:id/restraint")).toBe(false);
  });

  it.each([
    ["POST", "/api/v1/encounters/:encounterId/void"],
    ["GET", "/api/v1/encounters/closure-policy"],
    ["PUT", "/api/v1/encounters/closure-policy"],
    ["POST", "/api/v1/visits"],
    ["POST", "/api/v1/visits/:visitId/start"],
    ["POST", "/api/v1/evv/check-in"],
    ["POST", "/api/v1/referrals"],
    ["GET", "/api/v1/billing/claims"],
    ["GET", "/api/v1/hope/schedules"],
    ["GET", "/api/v1/patients/census-metrics"],
    ["POST", "/api/v1/standing-orders"],
    ["GET", "/api/v1/safety/policy"],
    ["POST", "/api/v1/quality/incidents/:incidentId/triage"],
    ["POST", "/api/v1/quality/incidents/:incidentId/investigation"],
    ["POST", "/api/v1/quality/incidents/:incidentId/investigate"],
    ["POST", "/api/v1/quality/incidents/:incidentId/resolve"],
    ["POST", "/api/v1/quality/incidents/:incidentId/close"],
    ["POST", "/api/v1/quality/incidents/:incidentId/reopen"],
    ["GET", "/api/v1/quality/incidents"],
    ["POST", "/api/v1/supplies/comfort-kit-dispatches"],
    ["POST", "/api/v1/admissions/:id/revocation"],
  ])("%s %s exists and stays refused for a blocked clinician", (method, path) => {
    expect(
      registered.has(`${method} ${path}`),
      "the route this refusal is about must be real",
    ).toBe(true);
    expect(allowed(method, path)).toBe(false);
  });

  it.each([
    ["POST", "/api/v1/encounters/:encounterId/sign"],
    ["POST", "/api/v1/encounters/:encounterId/finalize"],
    ["POST", "/api/v1/encounters"],
    ["POST", "/api/v1/encounters/closure-overrides"],
    ["POST", "/api/v1/encounters/closure-overrides/:overrideId/revoke"],
    ["GET", "/api/v1/encounters/closure-status"],
    ["GET", "/api/v1/encounters/overdue-notes"],
    ["POST", "/api/v1/administrations"],
    ["POST", "/api/v1/orders/:id/verbal"],
    ["POST", "/api/v1/verbal-orders"],
    ["POST", "/api/v1/triage-calls"],
    ["POST", "/api/v1/safety/sos"],
    ["POST", "/api/v1/messaging/emergencies/:emergencyId/ack"],
    ["POST", "/api/v1/messaging/channels/:id/urgent-messages"],
    ["GET", "/api/v1/alerts/inbox"],
    ["POST", "/api/v1/sessions/step-up"],
    ["GET", "/api/v1/auth/context"],
    ["POST", "/api/v1/quality/incidents"],
    ["PATCH", "/api/v1/quality/incidents/:incidentId"],
    ["POST", "/api/v1/quality/incidents/:incidentId/submit"],
    ["POST", "/api/v1/patients/:id/deceased"],
    ["POST", "/api/v1/patients/:id/code-status"],
    ["POST", "/api/v1/patients/:id/code-status/:entryId/entered-in-error"],
    ["POST", "/api/v1/messaging/death-notifications/:notificationId/ack"],
    ["POST", "/api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient"],
    ["POST", "/api/v1/evv/check-out"],
    ["POST", "/api/v1/evv/offline-sync"],
    ["POST", "/api/v1/evv/offline-sync/v2"],
    ["POST", "/api/v1/breakglass/:id/cosign"],
    ["POST", "/api/v1/breakglass/:id/revoke"],
  ])("%s %s exists and stays open: it closes the note or protects a patient", (method, path) => {
    expect(registered.has(`${method} ${path}`), "the route must be real").toBe(true);
    expect(allowed(method, path)).toBe(true);
  });

  it("no administrative, billing, platform or reporting root is on the list, except the reviewed safety-duty carve-outs", () => {
    const forbiddenRoots = [
      "/api/v1/admin",
      "/api/admin",
      "/api/v1/billing",
      "/api/v1/claims",
      "/api/v1/platform",
      "/api/v1/portal",
      "/api/v1/tenant",
      "/api/v1/reporting",
      "/api/v1/quality",
      "/api/v1/referrals",
      "/api/v1/intake",
      "/api/v1/supplies",
      "/api/v1/cap",
      "/api/v1/cost-reports",
      "/api/v1/bereavement",
      "/api/v1/ai",
      "/api/v1/audit",
    ];
    for (const entry of NOTE_CLOSURE_ALLOWED_ROUTES) {
      if (FORBIDDEN_ROOT_CARVE_OUTS.includes(entry)) continue;
      expect(under(pathOf(entry), forbiddenRoots), entry).toBe(false);
    }
  });

  it("the carve-outs are exactly the reporter's three quality routes and the bedside comfort-kit deployment, and are all allowed", () => {
    expect(
      [...NOTE_CLOSURE_ALLOWED_ROUTES].filter((e) => under(pathOf(e), ["/api/v1/quality"])).sort(),
    ).toEqual(
      [
        "PATCH /api/v1/quality/incidents/:incidentId",
        "POST /api/v1/quality/incidents",
        "POST /api/v1/quality/incidents/:incidentId/submit",
      ].sort(),
    );
    expect(
      [...NOTE_CLOSURE_ALLOWED_ROUTES].filter((e) => under(pathOf(e), ["/api/v1/supplies"])),
    ).toEqual(["POST /api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient"]);
    for (const entry of FORBIDDEN_ROOT_CARVE_OUTS) {
      expect(NOTE_CLOSURE_ALLOWED_ROUTES.has(entry), entry).toBe(true);
    }
  });
});
