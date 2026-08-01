// apps/backend/src/modules/20-field-safety/routes/dashboard.routes.ts — M20 (§4.1) rows 26-29: the
// supervisor live-awareness board and the clinician's own consent surface.
//
// ── THE BOARD ANSWERS "IS EVERYONE OK?" WITHOUT A SINGLE COORDINATE ────────────────────────────────
//
// `SafetyClinicianStatusDto` carries a last-known-location SOURCE and AGE and no latitude at all (the
// type has no field for one). That is D6's boundary made structural: rendering the board can never trip
// the §8.7 coordinate audit path, because the coordinates live behind their own route, their own
// permission and their own warn-severity entry (sos.routes.ts row 10).
//
// A CLINICIAN WITH NO OVERSIGHT GRANT SEES ONLY HER OWN ROW, and that filter is the read service's.
// §6's "clinicians see their own state only" cannot be expressed by `caseload_or_scope` — an ABAC
// predicate answers yes/no for a REQUEST, not which rows come back. The guard admits her; the service
// narrows the snapshot AND recomputes the two tiles over the narrowed set, so a header and its own grid
// cannot disagree.
//
// ── THE CONSENT SURFACE IS THE CLINICIAN'S, AND THE MEMBERSHIP COMES FROM THE SESSION ──────────────
//
// §2.2.8 makes the WORKFORCE member the data subject. All three routes take the membership from
// `request.context` and never from a param, so one clinician reading another's consent row — or revoking
// it — is unrepresentable rather than merely refused. `safety.consent.*_self` sit in the `self_service`
// permission category for the same reason: a compliance-category grant would sweep them into the
// Compliance Officer template and make one person able to grant another's consent to be located, which is
// exactly the coercion §2.2.8's `expired`-vs-`revoked` split exists to make visible.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_DASHBOARD, ABAC_SELF, P } from "./guards";
import {
  ConsentQuery,
  DashboardQuery,
  GrantConsentBody,
  RevokeConsentBody,
  parse,
  parseQuery,
} from "./m20-typebox";
import type { M20ReadService } from "./read-service";
import type { M20WriteService } from "./write-service";

export interface DashboardRouteDeps {
  readonly readService: M20ReadService;
  readonly writeService: M20WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();

/**
 * §4.1 row 26 — the board surfaces a patient's FIRST NAME beside a clinician's current visit
 * (`currentPatientFirstName`, §8.2's minimum-necessary maximum), so it is an emission, not a waiver. It
 * is a LIST read: one aggregate row per refresh, not one per clinician, or a supervisor's 30-second
 * dashboard poll would bury every read that matters (§3.4).
 */
const DASHBOARD_PHI = {
  resourceKind: "safety_dashboard",
  fields: ["current_patient_first_name", "current_visit_id", "last_known_location"],
  list: true,
} as const;

/**
 * §4.1 row 27 — the clinician's own consent rows. Not patient PHI, but §3.3 puts emergency-contact PII in
 * `consent_scope_detail` and asks for an `info`-severity audit on READ, which is what this declaration
 * is. The projection itself never opens the ciphertext (`contactOnFile` is a boolean), so the fields
 * named here are the ones that actually reach the wire.
 */
const CONSENT_AUDIT = {
  resourceKind: "safety_emergency_contact_consent",
  fields: ["consent_purpose", "status", "acknowledgment_text_snapshot"],
  list: true,
} as const;

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const { readService, writeService } = deps;

  // 26 — the live-awareness board.
  app.get(
    "/api/v1/safety/dashboard",
    {
      preHandler: [P("safety.dashboard.read"), ABAC_DASHBOARD("safety.dashboard.read")],
      config: { auditRead: DASHBOARD_PHI },
    },
    async (request) =>
      readService.getDashboard(actorOf(request), parseQuery(DashboardQuery, request.query)),
  );

  // 27 — my own consents.
  app.get(
    "/api/v1/safety/consent",
    {
      preHandler: [
        P("safety.consent.read_self"),
        ABAC_SELF("safety.consent.read_self", () => ({})),
      ],
      config: { auditRead: CONSENT_AUDIT },
    },
    async (request) => {
      const { purpose } = parseQuery(ConsentQuery, request.query);
      return readService.getConsentSurface(actorOf(request), purpose);
    },
  );

  // 28 — grant one purpose. The three are separately grantable (M20-F16): declining `sos_coordinates`
  //      never disables SOS, and `continuous_location_during_sos` additionally needs the TENANT's
  //      `sosContinuousLocationEnabled` before a single stream row may be written — two independent
  //      gates, which is why neither lives on this row alone.
  app.post(
    "/api/v1/safety/consent/grant",
    {
      preHandler: [
        P("safety.consent.edit_self"),
        ABAC_SELF("safety.consent.edit_self", () => ({})),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(GrantConsentBody, request.body);
      const granted = await writeService.grantConsent(writeActorOf(request), body);
      return reply.code(201).send(granted);
    },
  );

  // 29 — revoke one purpose. Writes `revoked`, never `expired`: the rotation sweep owns the second, and a
  //      coercion review reads exactly that difference (§2.2.8).
  app.post(
    "/api/v1/safety/consent/revoke",
    {
      preHandler: [
        P("safety.consent.edit_self"),
        ABAC_SELF("safety.consent.edit_self", () => ({})),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const body = parse(RevokeConsentBody, request.body);
      return writeService.revokeConsent(writeActorOf(request), body);
    },
  );
}
