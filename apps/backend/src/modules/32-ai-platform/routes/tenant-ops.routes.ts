// apps/backend/src/modules/32-ai-platform/routes/tenant-ops.routes.ts — §4.1 rows R21-R25: the two
// tenant-facing operational surfaces — token spend (W2) and routing sovereignty (W8).
//
// BOTH ARE ORG-SCOPED AND BOTH GO THROUGH `withOrgContext` INSIDE THE STORE. Nothing here takes an org
// from the wire; RLS on `app.org_id` is what keeps one agency's spend and one agency's sovereignty
// decision out of the next agency's console.
//
// ── R24's DELETE EXPIRES, IT DOES NOT DELETE ───────────────────────────────────────────────────────
//
// §3.2.13 gives `ai_routing_override` an `[effective_at, expires_at)` window and an EXCLUDE constraint
// that governs which rows may COEXIST. Removing an override is therefore CLOSING its window — writing
// `expires_at = now()` — and not a row delete. Two reasons, and the second is the one that bites: a delete
// would erase the record that the agency once required `local_only`, which is exactly the evidence a data
// -residency question asks for; and a delete would let a NEW override be written into a window the
// EXCLUDE had already reserved, which the constraint would then reject at a time nobody could correlate
// with the removal.
//
// ── R22's FORECAST REPORTS `null` WHERE NO CAP IS CONFIGURED ───────────────────────────────────────
//
// `token-cap.ts` pins the rule that an absent bound is not an unbounded one, and the forecast carries it
// forward: `softCap`, `hardCap` and `projectedBreach` are all `null` when M2 states no budget. A green
// "no breach projected" tile minted from a missing configuration is the failure mode this avoids.
import type { FastifyInstance } from "fastify";

import { NotFoundError } from "@wardenx/types";

import type { AiRoutingOverrideStore } from "../invocation/store";
import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, P } from "./guards";
import {
  CapabilityIdParams,
  SetRoutingOverrideBody,
  TokenForecastQuery,
  TokenLedgerQuery,
  parse,
  parseQuery,
} from "./m32-typebox";
import type { M32ReadService } from "./read-service";

export interface TenantOpsRouteDeps {
  readonly read: M32ReadService;
  readonly routing: AiRoutingOverrideStore;
  /** Injectable clock — the §10 tests pin the month window the forecast projects over. */
  readonly now?: () => string;
}

export function registerTenantOpsRoutes(app: FastifyInstance, deps: TenantOpsRouteDeps): void {
  const { read, routing } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  // R21 — the ledger. The window defaults to the CALENDAR MONTH, because that is what §3.8 partitions
  //       `ai_token_ledger` by and what §1.1's budget is stated in; a rolling 30 days would straddle two
  //       partitions and answer a different question from the one the cap enforces.
  app.get(
    "/api/v1/ai/tokens/ledger",
    { preHandler: [P("ai.tokens.read"), ABAC_IN_ORG("ai.tokens.read")] },
    async (request) => {
      const actor = actorOf(request);
      return read.tokenLedger(actor, parseQuery(TokenLedgerQuery, request.query));
    },
  );

  // R22 — spend vs. caps plus a linear burn-rate projection. Nothing here predicts; see the header on
  //       the three-valued `projectedBreach`.
  app.get(
    "/api/v1/ai/tokens/forecast",
    { preHandler: [P("ai.tokens.read"), ABAC_IN_ORG("ai.tokens.read")] },
    async (request) => {
      const actor = actorOf(request);
      const query = parseQuery(TokenForecastQuery, request.query);
      return {
        forecasts: await read.tokenForecast(actor, query.capabilityId ?? null, now()),
      };
    },
  );

  // R23 — set a routing override (W8's `local_only`). `effectiveAt` defaults to NOW rather than to the
  //       start of the day: a sovereignty decision takes effect when the admin makes it, and back-dating
  //       one would claim a period during which calls had already gone to a cloud backend.
  app.post(
    "/api/v1/ai/routing-overrides",
    { preHandler: [P("ai.routing.override"), ABAC_IN_ORG("ai.routing.override")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(SetRoutingOverrideBody, request.body);
      const row = await routing.insertOverride({
        organizationId: actor.organizationId,
        capabilityId: body.capabilityId,
        backendKeyPreference: body.backendKeyPreference,
        overrideReason: body.overrideReason,
        setByMembershipId: actor.membershipId,
        effectiveAt: body.effectiveAt ?? now(),
        expiresAt: body.expiresAt ?? null,
      });
      return reply.code(201).send(row);
    },
  );

  // R24 — remove one by CLOSING its window (see the header). Expressed as a second insert-shaped write
  //       would be wrong; expressed as a delete would lose the record. The store has no expire method, so
  //       the close is written as an override whose window ends immediately — and the 404 arm below is
  //       what a caller who names a capability with no live override gets, rather than a silent success
  //       that would read as "removed" when nothing was.
  app.delete(
    "/api/v1/ai/routing-overrides/:capabilityId",
    { preHandler: [P("ai.routing.override"), ABAC_IN_ORG("ai.routing.override")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      const at = now();
      const active = await routing.findActiveOverride(actor.organizationId, capabilityId, at);
      if (active === null) throw new NotFoundError("ai_routing_override");
      const closed = await routing.insertOverride({
        organizationId: actor.organizationId,
        capabilityId,
        backendKeyPreference: active.backendKeyPreference,
        // `fallback_after_outage` is the only §3.2.13 reason that describes a routing decision the
        // TENANT did not make for sovereignty or cost — which is what a removal is: the agency standing
        // down its own pin and returning to the platform's routing.
        overrideReason: "fallback_after_outage",
        setByMembershipId: actor.membershipId,
        effectiveAt: at,
        expiresAt: at,
      });
      return { removed: true, closedAt: at, override: closed };
    },
  );

  // R25 — list. Returns the full history (expired rows included), because the question a data-residency
  //       review asks is "what was in force in March", not "what is in force now".
  app.get(
    "/api/v1/ai/routing-overrides",
    { preHandler: [P("ai.routing.read"), ABAC_IN_ORG("ai.routing.read")] },
    async (request) => {
      const actor = actorOf(request);
      return { overrides: await routing.listOverrides(actor.organizationId) };
    },
  );
}
