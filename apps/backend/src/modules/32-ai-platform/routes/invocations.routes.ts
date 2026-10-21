// apps/backend/src/modules/32-ai-platform/routes/invocations.routes.ts — §4.1 rows R16-R17: the
// §164.528 disclosure ledger.
//
// THESE TWO ROUTES ARE THE ONLY M32 SURFACE THAT READS PHI, AND THEY ARE THE ONLY ONES THAT EMIT A READ
// AUDIT. §3.2.8 makes an `ai_invocation` row the record that a named patient's chart context went to a
// model vendor — so reading the ledger IS a PHI access, and M4's read-audit entry is what a later
// accounting-of-disclosures review scans. Every other M32 read surface is platform-shared or
// aggregate-by-construction; auditing those too would bury the one entry that means something under
// thousands that do not (../permission-keys.ts states the rule and the §10 test asserts the set).
//
// ── MASKING IS STRUCTURAL, NOT A BRANCH ────────────────────────────────────────────────────────────
//
// §4.1's R16 says "PHI fields masked unless `chartwarden.phi.full_read` granted". The projection has NO field
// for the prompt, the response or the chart context at all (read-service.ts), so the strongest grant on
// the platform cannot surface them through this route — they are DEK-enveloped and M32 binds no decipher
// port. What the grant actually unlocks is the PATIENT IDENTITY and the free-text `errorMessage`; without
// it the row still reports `touchedPatientChart`, which is the fact §164.528 turns on. Refusing the whole
// row to a compliance officer who may not read free text would break the review the route exists for.
//
// ── R17 IS 404-ON-DENY AND R16 IS NOT ──────────────────────────────────────────────────────────────
//
// An invocation id is 1:1 with "this named patient's chart went to a vendor at this hour", which §8.2's
// isolation test asks to be unprobeable — so a denied per-row read answers 404 (guards.ts rule 2). The
// SEARCH is a collection over the caller's own org and discloses nothing by existing, so it answers 403.
import type { FastifyInstance } from "fastify";

import { NotFoundError } from "@chartwarden/types";

import { actorOf } from "./actor";
import { ABAC_INVOCATION_ROW, ABAC_INVOCATION_SEARCH, P } from "./guards";
import { InvocationIdParams, InvocationSearchQuery, parse, parseQuery } from "./m32-typebox";
import type { M32ReadService } from "./read-service";

export interface InvocationRouteDeps {
  readonly read: M32ReadService;
}

/**
 * §4.1's Read-Audit declaration for both rows.
 *
 * The fields named are the ones the ROUTE can surface, not the ones the table holds: `patient_id` is the
 * disclosure subject, `capability_key` + `backend_key` + `model_version_pin` are WHO it went to, and
 * `zdr_confirmed` is D19's claim about what happened to it there. Naming the three cipher columns would
 * declare an audit for fields no caller can reach.
 */
const INVOCATION_PHI_FIELDS = [
  "patient_id",
  "capability_key",
  "backend_key",
  "model_version_pin",
  "zdr_confirmed",
] as const;

/**
 * R16 is a collection: `list: true` takes the list-read branch (a `list_viewed` row with a count), because
 * the single-resource branch would write an empty `resource_id` that the uuid column rejects — and the
 * best-effort emitter swallows that failure, leaving the read with no trail (GAP-055).
 */
export const INVOCATION_SEARCH_AUDIT = {
  resourceKind: "ai_invocation",
  fields: INVOCATION_PHI_FIELDS,
  list: true,
} as const;

/** R17 is one row: the row id is the audited resource; the response's `patientId` is the disclosure subject. */
export const INVOCATION_ROW_AUDIT = {
  resourceKind: "ai_invocation",
  fields: INVOCATION_PHI_FIELDS,
  resourceIdParam: "invocationId",
  patientIdPayloadPath: "patientId",
} as const;

export function registerInvocationRoutes(app: FastifyInstance, deps: InvocationRouteDeps): void {
  const { read } = deps;

  // R16 — the compliance search. The default window is ninety days (read-service-drizzle.ts) because
  //       `ai_invocation` is RANGE-partitioned on `invoked_at` and an unbounded default would scan every
  //       monthly partition the deployment has ever written; an explicit `from` reaches back further,
  //       which is what a 2031 accounting for a 2026 disclosure supplies anyway.
  app.get(
    "/api/v1/ai/invocations",
    {
      preHandler: [P("ai.invocation.read"), ABAC_INVOCATION_SEARCH("ai.invocation.read")],
      config: { auditRead: INVOCATION_SEARCH_AUDIT },
    },
    async (request) => {
      const actor = await actorOf(request);
      const query = parseQuery(InvocationSearchQuery, request.query);
      const page = await read.searchInvocations(actor, query);
      return {
        ...page,
        // Stated rather than inferred: a console showing masked rows must be able to say WHY a patient
        // column is empty, and "you lack phi.full_read" and "this call touched no chart" are opposite
        // answers that an empty cell alone cannot distinguish.
        phiMasked: !actor.phiFullRead,
      };
    },
  );

  // R17 — one row. The ABAC predicate itself ORs the cross-tenant safety owner in (§4.7), so this is a
  //       single `requireAbac` and not a disjunction of guards — the cross-tenant read that satisfies it
  //       is made once against the row rather than twice against a guard.
  app.get(
    "/api/v1/ai/invocations/:invocationId",
    {
      preHandler: [P("ai.invocation.read"), ABAC_INVOCATION_ROW("ai.invocation.read")],
      config: { auditRead: INVOCATION_ROW_AUDIT },
    },
    async (request) => {
      const actor = await actorOf(request);
      const { invocationId } = parse(InvocationIdParams, request.params);
      const row = await read.getInvocation(actor, invocationId);
      // 404 and not 403: see the header. The guard has already refused a cross-tenant id with a 404, so
      // this arm is reached for a row that is genuinely absent or outside the default window.
      if (row === null) throw new NotFoundError("ai_invocation");
      return { ...row, phiMasked: !actor.phiFullRead };
    },
  );
}
