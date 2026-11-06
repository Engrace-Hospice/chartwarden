// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/routes.ts — M23 (ADR-0053 amendment 2026-11-06): the
// tenant's own clearinghouse choice. `GET|PUT /api/v1/tenant/clearinghouse`, `POST …/verify`, `POST …/activate`.
//
// Gated by its OWN ORG-LEVEL permission pair (owner decision D3, 2026-11-06): the read `billing.clearinghouse.read`; every
// write `billing.clearinghouse.admin` + a FRESH step-up (§D14) + the §D13 AI-block + `Idempotency-Key`. The pair is bound to
// the org-wide admin roles only (`org_admin`, `administrator`), NOT to the provider-entity-scoped `billing.mac_credential.*`:
// a billing manager scoped to one provider entity must not be able to re-route EVERY entity's PHI to another vendor.
// A first PUT omits `If-Match`; a change carries the version last read (428 / 412). The credential is write-only (sealed,
// never returned). Org and membership binding is server-side. A tenant admin may keep editing after go-live (like every other
// billing setting); vendor and mode lock once a production submission exists (409). The tenant records its own vendor BAA
// (`POST …/baa`); a platform operator verifies it, and activation refuses until then.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "../routes/actor";
import { parse } from "../routes/billing-typebox";
import { parseIfMatch, requireIdempotencyKey } from "../routes/concurrency";
import { P, STEP_UP } from "../routes/guards";
import type { TenantClearinghouseRouteService } from "./tenant-service";
import {
  PutClearinghouseBodySchema,
  RecordBaaBodySchema,
  VerifyClearinghouseBodySchema,
} from "./typebox";

export interface TenantClearinghouseRouteDeps {
  readonly tenantClearinghouseService: TenantClearinghouseRouteService;
  /** Per-user cap on `verify` (a vendor call per request); fail-open like the other route limits. Absent = unlimited. */
  readonly verifyRateLimit?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const READ = P("billing.clearinghouse.read");
const ADMIN = P("billing.clearinghouse.admin");
const ADMIN_STEPUP = STEP_UP("billing.clearinghouse.admin");
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
  // The limiter runs AFTER the permission and step-up guards, so a caller who may not verify never spends the tenant's budget.
  const VERIFY = deps.verifyRateLimit ? [...WRITE, deps.verifyRateLimit] : WRITE;

  // GET — what the organization chose (masked: `hasSecret`, never the credential).
  app.get(
    "/api/v1/tenant/clearinghouse",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          none: "clearinghouse choice and status (never the credential) — no patient data",
        },
      },
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

  // POST baa — the tenant records the BAA it holds with its own vendor account (a platform operator verifies it).
  app.post("/api/v1/tenant/clearinghouse/baa", { preHandler: WRITE }, async (request) => {
    const actor = writeActorOf(request);
    const body = parse(RecordBaaBodySchema, request.body);
    return service.recordBaa(actor, body);
  });

  // POST verify — a connection test where the vendor has a safe probe (Claim.MD), an attestation with evidence where it has none (Stedi).
  app.post("/api/v1/tenant/clearinghouse/verify", { preHandler: VERIFY }, async (request) => {
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
