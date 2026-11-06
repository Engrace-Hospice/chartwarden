// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/routes.ts — M23 (ADR-0053 amendment 2026-11-06): the
// tenant's own clearinghouse choice. `GET|PUT /api/v1/tenant/clearinghouse`, `POST …/verify`, `POST …/activate`.
//
// Gated by the MAC-credential permissions (the same setup step, the same roles as the EDI profile): the read
// `billing.mac_credential.read`; every write `billing.mac_credential.admin` + a FRESH step-up (§D14) + the §D13 AI-block +
// `Idempotency-Key`. A first PUT omits `If-Match`; a change carries the version last read (428 / 412). The credential is
// write-only (sealed, never returned). Org and membership binding is server-side. A tenant admin may keep editing after
// go-live (like every other billing setting); vendor and mode lock once a production submission exists (409).
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "../routes/actor";
import { parse } from "../routes/billing-typebox";
import { parseIfMatch, requireIdempotencyKey } from "../routes/concurrency";
import { P, STEP_UP } from "../routes/guards";
import type { TenantClearinghouseRouteService } from "./tenant-service";
import { PutClearinghouseBodySchema, VerifyClearinghouseBodySchema } from "./typebox";

export interface TenantClearinghouseRouteDeps {
  readonly tenantClearinghouseService: TenantClearinghouseRouteService;
}

const READ = P("billing.mac_credential.read");
const ADMIN = P("billing.mac_credential.admin");
const ADMIN_STEPUP = STEP_UP("billing.mac_credential.admin");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const WRITE = [ADMIN, ADMIN_STEPUP, NO_AI, IDEMPOTENT];

/** The optional `If-Match` version (present only when changing an existing config). */
function optionalIfMatch(request: Parameters<typeof parseIfMatch>[0]): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? parseIfMatch(request) : undefined;
}

export function registerTenantClearinghouseRoutes(
  app: FastifyInstance,
  deps: TenantClearinghouseRouteDeps,
): void {
  const { tenantClearinghouseService: service } = deps;

  // GET — what the organization chose (masked: `hasSecret`, never the credential).
  app.get(
    "/api/v1/tenant/clearinghouse",
    {
      preHandler: [READ],
      config: { auditRead: { none: "clearinghouse choice and status (never the credential) — no patient data" } },
    },
    async (request) => service.get(actorOf(request)),
  );

  // PUT — choose stedi | claimmd | outside, with its mode and credential. 201 on the first choice, 200 on a change.
  app.put("/api/v1/tenant/clearinghouse", { preHandler: WRITE }, async (request, reply) => {
    const actor = writeActorOf(request);
    const body = parse(PutClearinghouseBodySchema, request.body);
    const { created, view } = await service.put(actor, body, optionalIfMatch(request));
    return reply.code(created ? 201 : 200).send(view);
  });

  // POST verify — a connection test where the vendor has a safe probe (Claim.MD), an attestation with evidence where it has none (Stedi).
  app.post("/api/v1/tenant/clearinghouse/verify", { preHandler: WRITE }, async (request) => {
    const actor = writeActorOf(request);
    const body = parse(VerifyClearinghouseBodySchema, request.body);
    const { view, test } = await service.verify(actor, body);
    return { config: view, test };
  });

  // POST activate — verified -> active: claims and eligibility work is allowed.
  app.post("/api/v1/tenant/clearinghouse/activate", { preHandler: WRITE }, async (request) =>
    service.activate(writeActorOf(request)),
  );
}
