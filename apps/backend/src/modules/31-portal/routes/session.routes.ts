// apps/backend/src/modules/31-portal/routes/session.routes.ts — M31 (§4.1) the portal session surface.
//
// The four session routes run under a portal session class. select-patient binds the ONE patient the
// session is scoped to (D2) by resolving the account's ACTIVE grant for that patient; `current` returns the
// session context; logout closes server-side (M2 owns the session row); step-up is the TOTP re-auth M2
// validates. M31 owns no `portal_session` table (the manifest owns three tables), so these handlers read
// the owned `portal_access_grant` for scope and hand the binding to M2 — the response is the context the
// portal SPA renders, not a new persisted row here.
import { ForbiddenError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { scopeSetContains } from "../lifecycle/scope-set";
import { actorOf, portalAccountIdOf } from "./actor";
import { ABAC_ACCOUNT, P } from "./guards";
import type { PortalRouteDeps } from "./index";
import { SelectPatientRequest, StepUpRequest, parse } from "./portal-typebox";

interface PatientReaderArm {
  findById(input: { organizationId: string; id: string }): Promise<{ displayName?: string } | null>;
}
const PORTAL_CATEGORIES = [
  "care_plan",
  "medications",
  "administrations",
  "visits",
  "documents",
  "messages",
  "supplies",
  "triage",
  "bereavement",
] as const;

export function registerPortalSessionRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { store } = deps;

  // select-patient — bind the session to (patient, grant) after login (D2). No ABAC_GRANT preHandler here
  // (TASK-050A/TEST-003 finding, fixed): `ABAC_GRANT`'s `getTarget` reads `patientId` from
  // `context.attributes.portalPatientId` — the SESSION's already-bound patient — but that is precisely the
  // fact this route exists to establish; on a fresh session it is always empty, so the guard always denied,
  // unconditionally, before a session could ever select its first patient. The handler below already
  // performs the equivalent (and here, correct) check itself: `store.activeGrant(organizationId,
  // portalAccountId, patientId)` against the REQUEST BODY's patientId — the only legitimate source for an
  // as-yet-unbound session — and throws the same 403 `ForbiddenError` on no active grant. Composing
  // `ABAC_GRANT` here was both broken and redundant with that check, not merely broken.
  app.post(
    "/api/v1/portal/sessions/select-patient",
    { preHandler: [P("portal.session.select_patient")] },
    async (request) => {
      const actor = actorOf(request);
      const portalAccountId = portalAccountIdOf(actor);
      const { patientId } = parse(SelectPatientRequest, request.body);
      const grant = await store.activeGrant(actor.organizationId, portalAccountId, patientId);
      if (!grant) {
        throw new ForbiddenError("no active grant for this account and patient (§8.3.1)");
      }
      let displayName = "your family member";
      try {
        const identity = await (getSeam("PatientReader") as unknown as PatientReaderArm).findById({
          organizationId: actor.organizationId,
          id: patientId,
        });
        if (identity?.displayName) displayName = identity.displayName;
      } catch {
        /* fail closed to the generic label */
      }
      return {
        sessionId: actor.portalAccountId ?? portalAccountId,
        activePatientId: patientId,
        activeGrantId: grant.grantId,
        scopeSet: PORTAL_CATEGORIES.filter((c) => scopeSetContains(grant.scopeSet, c)),
        layPatientLabel: displayName,
      };
    },
  );

  // current session context.
  app.get(
    "/api/v1/portal/sessions/current",
    {
      preHandler: [P("portal.session.read_own"), ABAC_ACCOUNT("portal.session.read_own")],
      config: { auditRead: { resourceKind: "portal_session" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const portalAccountId = portalAccountIdOf(actor);
      const account = await store.accountById(actor.organizationId, portalAccountId);
      const grant =
        actor.portalPatientId !== null
          ? await store.activeGrant(actor.organizationId, portalAccountId, actor.portalPatientId)
          : null;
      return {
        portalAccountId,
        activePatientId: actor.portalPatientId,
        activeGrantId: grant?.grantId ?? null,
        scopeSet: grant ? PORTAL_CATEGORIES.filter((c) => scopeSetContains(grant.scopeSet, c)) : [],
        relationship: account?.relationship ?? "unknown",
        status: account?.status ?? "unknown",
      };
    },
  );

  // logout — server-side session close (M2 owns the row; the handler acknowledges).
  app.post("/api/v1/portal/sessions/logout", async (request) => {
    actorOf(request);
    return { ok: true };
  });

  // step-up — TOTP re-auth for high-PHI actions (M2 validates the code + stamps the session window).
  app.post(
    "/api/v1/portal/sessions/step-up",
    { preHandler: [P("portal.session.step_up_own"), ABAC_ACCOUNT("portal.session.step_up_own")] },
    async (request) => {
      actorOf(request);
      parse(StepUpRequest, request.body);
      return { ok: true };
    },
  );
}
