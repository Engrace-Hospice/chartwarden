// apps/backend/src/modules/19-oncall/routes/vendor-sessions.routes.ts — F-030 / #75.
//
//   POST /api/v1/oncall/vendor-sessions/bind — bind THIS session to an `external_triage_vendor`
//
// WHAT WAS MISSING. M19's `external_triage_actor` predicate decides whether a vendor-class session may
// touch a triage call by comparing the shift's `external_actor_id` against the session's. Nothing ever
// wrote the session's — no route bound one, and M2 had no surface to bind through — so the comparison
// ran against `undefined` on every request and no vendor-scoped call could be recognised as one.
//
// M19's spec promises that a Phase-2 tenant subscribing to an outsourced model is "a configuration flip
// + vendor-adapter package install, not a schema change". That promise did not hold: both would have
// landed on a session layer that cannot express a vendor. This route and M2's `VendorSessionBinder` are
// the session half, so the promise becomes true. THEY DO NOT TURN THE MODELS ON — the D3 gate below
// refuses unless the tenant's own policy already names an outsourced model, and the outbound
// PHI-minimized vendor dispatch (§7.5) remains unbuilt.
//
// FOUR THINGS ARE CHECKED BEFORE THE BIND, AND EACH ONE IS A DIFFERENT KIND OF WRONG:
//   1. the vendor is in THIS org         — cross-tenant binding (the RLS-shaped mistake)
//   2. the tenant's model is outsourced  — D3's feature gate; binding under `direct` would let a vendor
//                                          onto the line of an agency that never engaged one
//   3. the BAA is in effect and unexpired — D13/§7.7; a vendor without one may not receive PHI at all,
//                                          and a triage session IS a PHI surface
//   4. RN coverage is attested           — D13 again, and CoP 418.64(b): the outsourced model satisfies
//                                          24-hour nursing only through the vendor's own RNs
//
// None of these is the binder's job. The seam writes the binding; proving the vendor may HAVE one is
// this module's, because this module owns the vendor row and the policy.
import { ForbiddenError, NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { actorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_IN_ORG, P, STEP_UP } from "./guards";
import { BindVendorSessionBody, parse } from "./m19-typebox";

/** The facts the bind gate needs about a vendor + the tenant's on-call model. */
export interface VendorBindingFacts {
  /** The vendor's D13 posture, or null when no such vendor exists IN THIS ORG. */
  readonly vendor: {
    readonly id: string;
    readonly rnCoverageAttested: boolean;
    readonly baaInEffect: boolean;
    readonly baaExpiresOn: Date | null;
  } | null;
  /** The tenant's deployment model (D3). `direct` means no vendor may be bound at all. */
  readonly model: "direct" | "hybrid" | "centralized" | null;
}

/** The narrow read this route needs. Deliberately not on `M19ReadService`: it is an authorization
 *  precondition for one route, not part of the module's read surface. */
export interface VendorSessionBindReader {
  loadBindingFacts(input: {
    organizationId: string;
    externalActorId: string;
  }): Promise<VendorBindingFacts>;
}

export interface VendorSessionRouteDeps {
  readonly reader: VendorSessionBindReader;
  /** Injectable clock so the BAA-expiry branch is testable without waiting a year. */
  readonly now?: () => Date;
}

export function registerVendorSessionRoutes(
  app: FastifyInstance,
  deps: VendorSessionRouteDeps,
): void {
  const now = deps.now ?? (() => new Date());

  app.post(
    "/api/v1/oncall/vendor-sessions/bind",
    {
      preHandler: [
        P("oncall.bind_vendor_session"),
        ABAC_IN_ORG("oncall.bind_vendor_session"),
        // Step-up for the same reason the policy PATCH carries it: §8.3.2 names tampering with the
        // vendor binding as a threat, and this decides which outside party answers the agency's nights.
        STEP_UP("oncall.bind_vendor_session"),
        requireIdempotencyKey(),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { externalActorId, sessionClass } = parse(BindVendorSessionBody, request.body);

      const facts = await deps.reader.loadBindingFacts({
        organizationId: actor.organizationId,
        externalActorId,
      });
      // Absent and cross-tenant answer identically: the read is org-scoped, so a caller cannot use this
      // route to discover which vendor ids exist in other tenants.
      if (!facts.vendor) throw new NotFoundError("external triage vendor not found");

      if (facts.model !== "hybrid" && facts.model !== "centralized") {
        // Refused, never accepted-and-ignored — the same call the policy PATCH makes two files over: a
        // tenant must never believe a vendor is answering their nights when none is.
        throw new ForbiddenError(
          "the tenant's on-call model is not an outsourced one (D3 hybrid/centralized)",
        );
      }
      if (!facts.vendor.baaInEffect) {
        throw new ForbiddenError("no BAA in effect for this vendor (D13 / §7.7)");
      }
      // A NULL expiry means "no stated expiry", not "unknown" — the column's own documented semantics,
      // so it is not treated as lapsed.
      if (facts.vendor.baaExpiresOn && facts.vendor.baaExpiresOn.getTime() <= now().getTime()) {
        throw new ForbiddenError("the BAA for this vendor has expired (D13 / §7.7)");
      }
      if (!facts.vendor.rnCoverageAttested) {
        throw new ForbiddenError("the vendor's RN coverage is not attested (D13 / CoP 418.64(b))");
      }

      // The session id is server-assembled (the authenticate hook stamps it); it is never a body field,
      // so a caller cannot bind SOMEONE ELSE'S session to a vendor.
      const sessionId = request.context?.attributes?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new ForbiddenError("no resolvable session to bind");
      }

      const bound = await getSeam("VendorSessionBinder").bindVendorSession({
        scope: { orgId: actor.organizationId },
        sessionId,
        externalActorId,
        sessionClass,
      });
      return reply.code(200).send({ sessionClass: bound.sessionClass, externalActorId });
    },
  );
}
