// apps/backend/src/bootstrap/note-closure-allowlist.ts — what a clinician whose visit note is past its block instant may still call
// (ADR-0113 D6). Data only; the decision lives in note-closure-gate.ts.
//
// THE LIST IS EXACT `METHOD + ROUTE TEMPLATE` PAIRS, matched on the template Fastify resolved (`request.routeOptions.url`), the way
// onboarding-org-gate.ts does it. It is an ALLOWlist: a route added later is refused for a blocked clinician until someone adds it
// here on purpose, and `__tests__/note-closure-gate-routes.test.ts` fails when an entry names a route that does not exist and when a
// chart GET is neither allowed nor explicitly denied there.
//
// WHAT STAYS REACHABLE, and why each group is here:
//   * closing the note: the encounter's own routes (selections, vitals, finalize, sign, addenda, cosignature, late-entry and
//     administrative override, ...), the shared read routes the note screens call, and creating an ad-hoc note (it starts its own
//     clock). A blocked supervisor also keeps the closure-status / overdue-notes reads and the override grant / revoke routes, so
//     they can unblock OTHERS.
//   * patient safety: eMAR, orders and verbal orders, standing orders, triage calls and on-call, escalations, field-safety SOS /
//     incidents / check-ins, emergency messaging and its acknowledgment, break-glass (grant, cosign, revoke), the alert inbox.
//   * regulatory and patient-safety DUTIES that cannot wait for a note: reporting a patient incident or an abuse allegation (the
//     reporter's own three routes only), recording a death and acknowledging its notification, changing or correcting a code
//     status, deploying a comfort kit at the patient's bedside, releasing or reassessing an inpatient restraint (42 CFR 418.110: a
//     restraint must be released as soon as the need ends and reassessed on its schedule, so a confined clinician cannot be locked
//     out of ending one), and finishing a visit that is ALREADY in progress (EVV check-out, and the offline syncs, which carry the
//     closing events of visits started before the block; the two sync routes also accept check-IN events, so a batch that contains
//     one is refused for a blocked clinician by the route itself, through the gate's `assertNotBlocked`, see note-closure-gate.ts).
//   * what the app chrome and those screens read: session plumbing, feature flags, name / terminology lookups, the read-only
//     patient chart, and the patient / admission / document / order lists those screens and pickers call (`GET /patients`,
//     `GET /admissions`, `GET /documents`, `GET /orders/pending-signature`, `GET /orders/cosign-pending` ...).
//
// WHAT IS DELIBERATELY NOT HERE: voiding a note (`.../void`), reading or writing the closure policy (a blocked administrator must not
// release themselves), starting or scheduling visits and checking IN to one (a new visit is new work), the triage, investigation,
// resolution and closure of a quality incident (only the reporter's routes are here), applying a NEW inpatient restraint, hospice
// election revocation, discharge, allergy writes and consent revocation (each is a decision that can wait for the note; the owner
// decided to keep them refused, and note-closure-gate-routes.test.ts pins each with its reason), confirming the delivery mode of a
// note signed earlier (`.../visit-modality`: signing carries the modality in its own body), HOPE / billing / referral /
// reporting / messaging administration, and the organization-wide dashboards, KPIs and compliance trackers.
import { SESSION_PLUMBING_ROUTES } from "./onboarding-org-gate";

/** M8: close the note, create an ad-hoc one, and the supervisor's closure-status / override routes. NOT `void`, NOT closure-policy. */
const NOTE_CLOSING_ROUTES: readonly string[] = [
  "GET /api/v1/encounters",
  "POST /api/v1/encounters",
  "GET /api/v1/encounters/:encounterId",
  "POST /api/v1/encounters/:encounterId/addenda",
  "GET /api/v1/encounters/:encounterId/addenda/:addendumId/cosignature",
  "GET /api/v1/encounters/:encounterId/addenda/:addendumId/draft",
  "PUT /api/v1/encounters/:encounterId/addenda/:addendumId/draft/sections/:sectionId",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/cosignature/acknowledge",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/cosignature/sign",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/cosignature/supervisor-release",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/finalize",
  "GET /api/v1/encounters/:encounterId/addenda/:addendumId/selections",
  "PATCH /api/v1/encounters/:encounterId/addenda/:addendumId/selections",
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/sign",
  "GET /api/v1/encounters/:encounterId/adl",
  "PUT /api/v1/encounters/:encounterId/adl",
  "POST /api/v1/encounters/:encounterId/administrative-override",
  "GET /api/v1/encounters/:encounterId/care-plan-links",
  "POST /api/v1/encounters/:encounterId/care-plan-links",
  "DELETE /api/v1/encounters/:encounterId/care-plan-links/:linkId",
  "GET /api/v1/encounters/:encounterId/chart-promotions",
  "POST /api/v1/encounters/:encounterId/chart-promotions/:requestId/reject",
  "GET /api/v1/encounters/:encounterId/cosignature",
  "POST /api/v1/encounters/:encounterId/cosignature/acknowledge",
  "POST /api/v1/encounters/:encounterId/cosignature/sign",
  "POST /api/v1/encounters/:encounterId/cosignature/supervisor-release",
  "GET /api/v1/encounters/:encounterId/discipline-plan-elements",
  "PUT /api/v1/encounters/:encounterId/discipline-plan-elements/:elementId",
  "GET /api/v1/encounters/:encounterId/draft",
  "PUT /api/v1/encounters/:encounterId/draft/sections/:sectionId",
  "POST /api/v1/encounters/:encounterId/evv-reconcile",
  "POST /api/v1/encounters/:encounterId/finalize",
  "POST /api/v1/encounters/:encounterId/hearthnote/enhance",
  "PATCH /api/v1/encounters/:encounterId/hearthnote/modifications/:modId/decisions",
  "POST /api/v1/encounters/:encounterId/late-entry-override",
  "GET /api/v1/encounters/:encounterId/fall-incidents",
  "GET /api/v1/encounters/:encounterId/mileage",
  "PATCH /api/v1/encounters/:encounterId/mileage",
  "POST /api/v1/encounters/:encounterId/mileage",
  "GET /api/v1/encounters/:encounterId/nutrition",
  "PUT /api/v1/encounters/:encounterId/nutrition",
  "GET /api/v1/encounters/:encounterId/selections",
  "PATCH /api/v1/encounters/:encounterId/selections",
  "POST /api/v1/encounters/:encounterId/sign",
  "GET /api/v1/encounters/:encounterId/template",
  "GET /api/v1/encounters/:encounterId/vitals",
  "POST /api/v1/encounters/:encounterId/vitals",
  "PATCH /api/v1/encounters/:encounterId/vitals/:vitalId",
  "GET /api/v1/encounters/:encounterId/weight-history",
  "POST /api/v1/encounters/closure-overrides",
  "POST /api/v1/encounters/closure-overrides/:overrideId/revoke",
  "GET /api/v1/encounters/closure-status",
  "GET /api/v1/encounters/cosignature-queue",
  "GET /api/v1/encounters/my-drafts",
  "GET /api/v1/encounters/overdue-notes",
  "GET /api/v1/encounters/visit-reasons",
  // WF09 — wounds are recorded WHILE documenting the visit (the composer's wound step registers a wound, adds the day's observation,
  // corrects a mis-entry or resolves a healed wound), so a blocked clinician must still reach them to close the note.
  "GET /api/v1/patients/:patientId/wounds",
  "POST /api/v1/patients/:patientId/wounds",
  "GET /api/v1/patients/:patientId/wounds/:woundId",
  "POST /api/v1/patients/:patientId/wounds/:woundId/observations",
  "POST /api/v1/patients/:patientId/wounds/:woundId/observations/:observationId/corrections",
  "POST /api/v1/patients/:patientId/wounds/:woundId/resolve",
  // WF09 — plan changes are recorded WHILE documenting the visit (the composer's plan-of-care step lists, records, replaces and withdraws
  // them). Deciding one (accept / dismiss) is a case manager's call that can wait for the note, so those two are not here.
  "GET /api/v1/patients/:patientId/care-plan-change-proposals",
  "GET /api/v1/care-plans/:planId/change-proposals",
  "POST /api/v1/care-plans/:planId/change-proposals",
  "PUT /api/v1/care-plans/:planId/change-proposals/:proposalId",
  "DELETE /api/v1/care-plans/:planId/change-proposals/:proposalId",
];

/** eMAR: administering, refusing, witnessing and correcting a dose, and the schedule and missed-dose reads and acknowledgements it needs. */
const EMAR_ROUTES: readonly string[] = [
  "GET /api/v1/administrations",
  "POST /api/v1/administrations",
  "GET /api/v1/administrations/:id",
  "POST /api/v1/administrations/:id/acknowledge-caregiver",
  "POST /api/v1/administrations/:id/correct",
  "POST /api/v1/administrations/:id/dispute-caregiver",
  "POST /api/v1/administrations/:id/void",
  "POST /api/v1/administrations/caregiver-attested",
  "GET /api/v1/administrations/iv-sessions/:sessionId",
  "POST /api/v1/administrations/offline-sync",
  "POST /api/v1/administrations/refuse",
  "POST /api/v1/administrations/witness-attest",
  "GET /api/v1/missed-doses",
  "POST /api/v1/missed-doses/:id/acknowledge",
  "GET /api/v1/scheduled-doses",
  "POST /api/v1/scheduled-doses/:id/intentional-hold",
];

/** Orders, medication orders and verbal orders in full; of the standing orders only what acts on an existing one for a patient. */
const ORDER_ROUTES: readonly string[] = [
  "GET /api/v1/medication-orders",
  "POST /api/v1/medication-orders",
  "GET /api/v1/medication-orders/:id",
  "PATCH /api/v1/medication-orders/:id",
  "POST /api/v1/medication-orders/:id/complete",
  "POST /api/v1/medication-orders/:id/correct",
  "POST /api/v1/medication-orders/:id/cosign",
  "PUT /api/v1/medication-orders/:id/coverage-determination",
  "POST /api/v1/medication-orders/:id/discontinue",
  "POST /api/v1/medication-orders/:id/report-error",
  "POST /api/v1/medication-orders/:id/request-signature",
  "POST /api/v1/medication-orders/:id/resolve-held-transmission",
  "POST /api/v1/medication-orders/:id/retransmit",
  "POST /api/v1/medication-orders/:id/sign",
  "POST /api/v1/medication-orders/:id/sign-controlled/complete",
  "POST /api/v1/medication-orders/:id/sign-controlled/initiate",
  "GET /api/v1/medication-orders/:id/transmission",
  "POST /api/v1/medication-orders/:id/verbal",
  "GET /api/v1/orders",
  "POST /api/v1/orders",
  "GET /api/v1/orders/:id",
  "PATCH /api/v1/orders/:id",
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
  "GET /api/v1/orders/cosign-pending",
  "GET /api/v1/orders/held-transmissions",
  "GET /api/v1/orders/pending-signature",
  "GET /api/v1/orders/results-pending-review",
  "GET /api/v1/orders/suggestions/:patientId",
  "GET /api/v1/orders/verbal-expiring",
  "POST /api/v1/verbal-orders",
  // Standing orders: read, spawn a patient order from one, pause and discontinue. Authoring, editing and resuming one is not here.
  "GET /api/v1/standing-orders",
  "GET /api/v1/standing-orders/:id",
  "POST /api/v1/standing-orders/:id/discontinue",
  "POST /api/v1/standing-orders/:id/pause",
  "POST /api/v1/standing-orders/:id/spawn",
];

/** After-hours triage and on-call: every triage-call route, the read-only protocols they apply, escalations, and who is on call now. */
const TRIAGE_ROUTES: readonly string[] = [
  "GET /api/v1/escalations",
  "POST /api/v1/escalations/:escalationId/acknowledge",
  "POST /api/v1/escalations/:escalationId/resolve",
  "GET /api/v1/oncall/current",
  "GET /api/v1/messaging/oncall/coverage",
  "GET /api/v1/triage-calls",
  "POST /api/v1/triage-calls",
  "GET /api/v1/triage-calls/:triageCallId",
  "POST /api/v1/triage-calls/:triageCallId/abandon",
  "POST /api/v1/triage-calls/:triageCallId/answers",
  "PATCH /api/v1/triage-calls/:triageCallId/answers/:answerId/correct",
  "POST /api/v1/triage-calls/:triageCallId/apply-protocol",
  "POST /api/v1/triage-calls/:triageCallId/awaiting-callback",
  "POST /api/v1/triage-calls/:triageCallId/complete-protocol",
  "POST /api/v1/triage-calls/:triageCallId/disposition",
  "POST /api/v1/triage-calls/:triageCallId/document",
  "POST /api/v1/triage-calls/:triageCallId/escalations",
  "POST /api/v1/triage-calls/:triageCallId/identify-patient",
  "POST /api/v1/triage-calls/:triageCallId/request-summary",
  "POST /api/v1/triage-calls/:triageCallId/resume",
  "GET /api/v1/triage-calls/:triageCallId/transcript-decrypt",
  "POST /api/v1/triage-calls/paper-reentry",
  "GET /api/v1/triage-calls/paper-reentry/worklist",
  "GET /api/v1/triage-protocols",
  "GET /api/v1/triage-protocols/:protocolId",
];

/** Field safety: SOS, incidents and check-ins in full, plus the location-sharing consent the SOS depends on. */
const FIELD_SAFETY_ROUTES: readonly string[] = [
  "POST /api/v1/safety/check-ins",
  "GET /api/v1/safety/check-ins/:checkInId",
  "PATCH /api/v1/safety/check-ins/:checkInId",
  "GET /api/v1/safety/check-ins/me/today",
  "GET /api/v1/safety/consent",
  "POST /api/v1/safety/consent/grant",
  "POST /api/v1/safety/consent/revoke",
  "GET /api/v1/safety/incidents",
  "POST /api/v1/safety/incidents",
  "GET /api/v1/safety/incidents/:incidentId",
  "PATCH /api/v1/safety/incidents/:incidentId",
  "POST /api/v1/safety/incidents/:incidentId/osha-signoff",
  "POST /api/v1/safety/incidents/:incidentId/state",
  "POST /api/v1/safety/incidents/:incidentId/submit",
  "POST /api/v1/safety/sos",
  "GET /api/v1/safety/sos/:sosAlertId",
  "POST /api/v1/safety/sos/:sosAlertId/acknowledge",
  "POST /api/v1/safety/sos/:sosAlertId/cancel",
  "GET /api/v1/safety/sos/:sosAlertId/location-stream",
  "GET /api/v1/safety/sos/:sosAlertId/psap",
  "POST /api/v1/safety/sos/:sosAlertId/resolve",
  "GET /api/v1/safety/sos/:sosAlertId/terminus",
  "GET /api/v1/safety/sos/active",
];

/**
 * Emergency messaging and its acknowledgment, the urgent SBAR send, and the message-send route an emergency attaches to (an emergency
 * is DECLARED on an already-sent message, so the send, the channel list and the thread read must stay open; they cannot be told
 * apart from ordinary chat at the route level). Break-glass is the emergency chart access for a restricted patient: its grant, the
 * cosignature that reviews it and the revocation that ends it.
 */
const EMERGENCY_ROUTES: readonly string[] = [
  "GET /api/v1/messaging/channels",
  "GET /api/v1/messaging/channels/:id",
  "GET /api/v1/messaging/channels/:id/messages",
  "POST /api/v1/messaging/channels/:id/messages",
  "POST /api/v1/messaging/channels/:id/urgent-messages",
  "GET /api/v1/messaging/channels/:id/urgent-messages/options",
  "GET /api/v1/messaging/messages/:messageId/emergency",
  "POST /api/v1/messaging/messages/:messageId/emergency",
  "GET /api/v1/messaging/emergencies",
  "GET /api/v1/messaging/emergencies/mine",
  "POST /api/v1/messaging/emergencies/:emergencyId/ack",
  "POST /api/v1/breakglass",
  "POST /api/v1/breakglass/:id/cosign",
  "POST /api/v1/breakglass/:id/revoke",
];

/**
 * Regulatory and patient-safety duties that cannot wait for a note. The quality routes are the REPORTER's only (create, edit the draft,
 * submit: each is gated on ownership of the incident); triage, investigation, resolution and closure stay refused. EVV check-out and
 * the offline syncs finish visits that were already in progress when the block began; EVV check-in (starting a new visit) stays refused,
 * and an offline-sync batch that carries a check-in event is refused by the route itself (it asks the gate's `assertNotBlocked`). The
 * two IPU restraint routes (release, reassess; 42 CFR 418.110) let a confined clinician end or reassess a restraint already applied.
 */
const SAFETY_DUTY_ROUTES: readonly string[] = [
  "POST /api/v1/quality/incidents",
  "PATCH /api/v1/quality/incidents/:incidentId",
  "POST /api/v1/quality/incidents/:incidentId/submit",
  "POST /api/v1/patients/:id/deceased",
  "POST /api/v1/patients/:id/code-status",
  "POST /api/v1/patients/:id/code-status/:entryId/entered-in-error",
  "POST /api/v1/messaging/death-notifications/:notificationId/ack",
  "POST /api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient",
  "POST /api/v1/evv/check-out",
  "POST /api/v1/evv/offline-sync",
  "POST /api/v1/evv/offline-sync/v2",
  "POST /api/v1/ipu-restraint/:id/reassess",
  "POST /api/v1/ipu-restraint/:id/release",
];

/** The alert inbox: the closure alert itself arrives here, so a confined clinician must keep reading and clearing it. */
const ALERT_INBOX_ROUTES: readonly string[] = [
  "GET /api/v1/alerts/inbox",
  "POST /api/v1/alerts/:id/read",
  "POST /api/v1/alerts/read-all",
];

/** The app chrome's boot and lookup reads (feature flags, names, terminology and master-data pickers, staff, locations, units). */
const SHELL_ROUTES: readonly string[] = [
  "GET /api/v1/system/feature-flags",
  "GET /api/v1/mdm/:kind/:id",
  "GET /api/v1/mdm/:kind/search",
  "GET /api/v1/terminology/:system/:code",
  "GET /api/v1/terminology/:system/search",
  "GET /api/v1/terminology/value-sets/:id/expand",
  "GET /api/v1/orgs/:id/members",
  "GET /api/v1/orgs/:id/care-team-staff",
  "GET /api/v1/locations",
  "GET /api/v1/provider-entities",
  "GET /api/v1/inpatient-units",
];

/**
 * The read-only patient chart: one patient's clinical record, which a clinician needs at the bedside or to write the note, plus the
 * patient / admission / document lists the chart screens and pickers call. An organization-wide dashboard or KPI, and an
 * administrative, billing or compliance-tracking read, is NOT here.
 */
const CHART_READ_ROUTES: readonly string[] = [
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
  "GET /api/v1/admissions",
  "GET /api/v1/admissions/:id",
  "GET /api/v1/admissions/:admissionId/hope",
  "GET /api/v1/admissions/:id/discharge-details",
  "GET /api/v1/admissions/:id/discharge-order",
  "GET /api/v1/admissions/:id/level-of-care",
  "GET /api/v1/care-plans/:planId/problem-proposals",
  "GET /api/v1/care-plans/:planId/summary",
  "GET /api/v1/care-plans/:planId/versions",
  "GET /api/v1/care-plans/:planId/versions/:versionId",
  "GET /api/v1/care-plans/:planId/versions/:versionId/proposed-changes",
  "GET /api/v1/documents",
  "GET /api/v1/documents/:id",
  "GET /api/v1/documents/:id/tags",
  "GET /api/v1/documents/:id/versions",
  "GET /api/v1/documents/:id/versions/:versionId",
  "GET /api/v1/documents/:id/versions/:versionId/content",
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
  "GET /api/v1/visits",
  "GET /api/v1/visits/:visitId",
  "GET /api/v1/comfort-kits/deployments",
  "GET /api/v1/comfort-kits/deployments/:id",
];

/** Every pair a note-closure-blocked clinician may call. (Better Auth's `/api/auth/*` wildcard is admitted by path in the gate.) */
export const NOTE_CLOSURE_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  ...SESSION_PLUMBING_ROUTES,
  ...NOTE_CLOSING_ROUTES,
  ...EMAR_ROUTES,
  ...ORDER_ROUTES,
  ...TRIAGE_ROUTES,
  ...FIELD_SAFETY_ROUTES,
  ...EMERGENCY_ROUTES,
  ...SAFETY_DUTY_ROUTES,
  ...ALERT_INBOX_ROUTES,
  ...SHELL_ROUTES,
  ...CHART_READ_ROUTES,
]);
