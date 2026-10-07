import { requirePermission } from "@wardenx/auth";
// apps/backend/src/modules/38-terminology/routes/terminology-routes.ts — M38-T06 the terminology
// route inventory (M38 spec §4.1–4.2; the §4.4 permission handshake; §7.4 canonical lockdown).
//
// These are M38's consumer-facing routes: the version-aware read surface (validate / lookup /
// search / value-set expand / is-member / deprecation) and the ONLY mutating surface a tenant has
// — the add-only value-set extension pair (§2.4.3, §7.6). Every route is gated by the REAL
// Authorization Contract (`requirePermission` from @wardenx/auth, M3) on the §4.4 keys M38
// registers into M3's catalog (M38_CONTRIBUTED_PERMISSIONS). The read keys default to everyone
// (`terminology.read` is a foundational utility, like reading a dictionary, §4.4); the protective
// key sits at the one boundary where meaning can change per tenant — `terminology.value_set.extend`.
//
// §7.4 CANONICAL LOCKDOWN: M38 exposes NO route that writes a platform terminology table — the
// only write path here targets the org-scoped `value_set_tenant_extension` (add-only). Canonical
// loads are platform-ops-only (`terminology.admin.load`, step-up, BullMQ) and land with the jobs
// in T10; at the database, `wardenx_app` has no INSERT/UPDATE/DELETE grant on canonical tables
// (M38-T03 migration 0015), so the lockdown is enforced in depth, not just by route omission.
//
// The handlers compose over the injected `TerminologyProvider` seam (M38-T05) — the same surface
// every clinical/billing consumer imports. In the slice it wraps the in-memory store; production
// injects the Drizzle/Valkey-backed store, whose org-scoped extension writes run inside
// `withOrgContext` so RLS on `app.org_id` is the backstop. Org binding is always server-side: the
// actor's org/user come from `request.context`, never the body.
import type { CodeSystemId, ExpansionMember, TerminologyProvider } from "@wardenx/terminology";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ATTRIBUTION_HEADER,
  type AttributionResolver,
  attributionHeaderValue,
} from "../attribution";
import type { TerminologyOpsStore } from "../ops-store";
import type { createRemediationService } from "../remediation-service";
import {
  DeprecationParamsSchema,
  ExpandParamsSchema,
  ExpandQuerySchema,
  ExtensionBodySchema,
  ExtensionDeleteParamsSchema,
  ExtensionParamsSchema,
  IsMemberParamsSchema,
  IsMemberQuerySchema,
  LookupParamsSchema,
  LookupQuerySchema,
  RemediationQuerySchema,
  SearchParamsSchema,
  SearchQuerySchema,
  ValidateParamsSchema,
  ValidateQuerySchema,
  ValueSetCatalogQuerySchema,
  parse,
} from "./terminology-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Minimal feature-flag port for the §7.7 semantic-search gate. Structurally identical to M1's
 * `FeatureFlagReader` so boot wiring passes the same reader; when absent every flag reads off —
 * the Phase-1 default (semantic search is the `ai.full` capability, Phase 2, default OFF).
 */
export interface TerminologyFeatureFlagReader {
  forOrg(orgId: string): Promise<Record<string, boolean>>;
}

/** The capability flag that unlocks semantic search (§7.7) — Phase 2, default OFF. */
export const AI_FULL_FLAG = "ai.full";

/** The injection surface for the terminology routes (mirrors M4's `AuditRouteDeps`). */
export interface TerminologyRouteDeps {
  /** The version-aware resolution surface (in-memory in the slice; Drizzle/Valkey in prod). */
  provider: TerminologyProvider;
  /** Resolves an org's feature flags; absent → all flags off (Phase-1 default). */
  flags?: TerminologyFeatureFlagReader;
  /**
   * GAP-063 — the value-set catalog port. Absent ⇒ the `/value-sets` route is not registered at all,
   * so a boot that cannot serve the catalog 404s rather than answering an empty list that reads as
   * "this platform curates no value sets".
   */
  ops?: Pick<TerminologyOpsStore, "listValueSets">;
  /**
   * GAP-063 — the §7.3 remediation report service. Absent ⇒ the route is not registered (same stance:
   * a compliance report that cannot consult its producers must not answer "nothing to remediate").
   */
  remediation?: RemediationService;
  /**
   * GAP-108 — licence attribution. When bound, every `/:system/*` read of a system with an active attestation
   * carries the `X-Terminology-Attribution` header, and `GET /api/v1/terminology/attributions` is registered.
   */
  attribution?: AttributionResolver;
}

/** The §7.3 report surface the remediation route calls (see ../remediation-service.ts). */
export type RemediationService = ReturnType<typeof createRemediationService>;

/** The org-scoped actor (org binding is server-side: the context, never the body). */
function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Parse an optional `asOf` date string into a Date (provider defaults to "today" when absent). */
function asOfDate(asOf: string | undefined): Date | undefined {
  return asOf ? new Date(asOf) : undefined;
}

const READ = requirePermission("terminology.read") as PreHandler;
const EXTEND = requirePermission("terminology.value_set.extend") as PreHandler;
// §4.4 — the report is a Compliance/Privacy/Coder surface, deliberately NOT folded into
// `terminology.read`: reading a code is a dictionary lookup, seeing which of this tenant's records
// still use retired codes is a compliance exposure listing.
const REMEDIATION = requirePermission("terminology.deprecation_report") as PreHandler;

const notFound = (what: string) => new WardenXError("NOT_FOUND", `${what} not found`, 404);

export function registerTerminologyRoutes(app: FastifyInstance, deps: TerminologyRouteDeps): void {
  const { provider, flags, ops, remediation, attribution } = deps;

  /** `onSend` for the `/:system/*` routes: stamp the licence attribution header when the system has one. */
  const attributionHook = attribution
    ? {
        onSend: async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
          const system = (request.params as { system?: string } | undefined)?.system;
          // Best-effort and only on success: a failed attribution lookup must never turn a good (or already
          // failed) response into a different one, and an error response carries no data to attribute.
          if (system && reply.statusCode < 400) {
            try {
              const text = await attribution.textFor(system as CodeSystemId);
              if (text) reply.header(ATTRIBUTION_HEADER, attributionHeaderValue(text));
            } catch (err) {
              request.log.warn({ err, system }, "terminology attribution lookup failed");
            }
          }
          return payload;
        },
      }
    : {};

  // --- GAP-108 the licence attributions a UI must display (registered before `/:system/:code`) -----
  if (attribution) {
    app.get("/api/v1/terminology/attributions", { preHandler: [READ] }, async () => ({
      items: await attribution.all(),
    }));
  }

  // --- §4.1 the value-set catalog (GAP-063) ---------------------------------------------------
  // Registered BEFORE the `/:system/...` family, and static-vs-parametric anyway: Fastify's radix
  // router prefers the literal `value-sets` segment, so this never shadows a code system named
  // `value-sets` (there is none — `:system` is a closed enum).
  if (ops) {
    app.get("/api/v1/terminology/value-sets", { preHandler: [READ] }, async (request) => {
      const { scope } = parse(ValueSetCatalogQuerySchema, request.query);
      const all = await ops.listValueSets();
      return { items: scope ? all.filter((v) => v.scope === scope) : all };
    });
  }

  // --- §4.2 the per-tenant deprecation remediation report (GAP-063) ---------------------------
  // Org-scoped by construction: the org comes from `request.context`, never a query parameter, and
  // the producers self-scope under RLS. See ../remediation-service.ts for what is and is not covered.
  if (remediation) {
    app.get("/api/v1/terminology/remediation", { preHandler: [REMEDIATION] }, async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(RemediationQuerySchema, request.query);
      return remediation.report({
        organizationId,
        since: q.since,
        system: q.system as CodeSystemId | undefined,
        limit: q.limit,
      });
    });
  }

  /**
   * §7.7 semantic gate: `mode=semantic` rides the `ai.full` capability (Phase 2). In Phase 1 the
   * flag is OFF for every tenant, so the endpoint is reachable but the semantic path is gated —
   * the route returns FEATURE_NOT_ENABLED (403) rather than silently degrading, so a caller asking
   * for kNN learns the capability is off. exact/fuzzy are always available.
   */
  async function assertSemanticEnabled(request: FastifyRequest): Promise<void> {
    const orgId = request.context.organizationId;
    const resolved = orgId && flags ? await flags.forOrg(orgId) : {};
    if (!resolved[AI_FULL_FLAG]) {
      throw new WardenXError(
        "FEATURE_NOT_ENABLED",
        "semantic search requires the 'ai.full' capability (Phase 2); use mode=exact or mode=fuzzy",
        403,
      );
    }
  }

  // --- §4.2 binary validate (code, asOf) — the hot path on claim lines / problem lists --------
  app.get(
    "/api/v1/terminology/:system/validate",
    { preHandler: [READ], ...attributionHook },
    async (request) => {
      const { system } = parse(ValidateParamsSchema, request.params);
      const { code, asOf } = parse(ValidateQuerySchema, request.query);
      const result = await provider.validate(system as CodeSystemId, code, asOfDate(asOf));
      return { ...result, asOf: asOf ?? null };
    },
  );

  // --- §4.2 search (exact / fuzzy / semantic) — defined before /:code so the suffix wins ------
  // §7.7 (M38-T09): semantic mode is gated on the `ai.full` capability (Phase 2, default OFF);
  // exact/fuzzy are always available. The pgvector HNSW kNN itself lives in the Drizzle store.
  app.get(
    "/api/v1/terminology/:system/search",
    { preHandler: [READ], ...attributionHook },
    async (request) => {
      const { system } = parse(SearchParamsSchema, request.params);
      const q = parse(SearchQuerySchema, request.query);
      const mode = q.mode ?? "fuzzy";
      if (mode === "semantic") await assertSemanticEnabled(request);
      const results = await provider.searchByText(system as CodeSystemId, q.q, {
        mode,
        asOf: asOfDate(q.asOf),
        limit: q.limit ?? 10,
        billableOnly: q.billableOnly ?? false,
        inValueSet: q.inValueSet,
      });
      return { results, mode, asOf: q.asOf ?? null };
    },
  );

  // --- §4.2 deprecation successor mapping (defined before /:code so the suffix wins) ----------
  app.get(
    "/api/v1/terminology/:system/:code/deprecation",
    { preHandler: [READ], ...attributionHook },
    async (request) => {
      const { system, code } = parse(DeprecationParamsSchema, request.params);
      const mapping = await provider.getDeprecationMapping(system as CodeSystemId, code);
      return { mapping };
    },
  );

  // --- §4.2 lookup full concept (system-specific properties) ---------------------------------
  app.get(
    "/api/v1/terminology/:system/:code",
    { preHandler: [READ], ...attributionHook },
    async (request) => {
      const { system, code } = parse(LookupParamsSchema, request.params);
      const { asOf } = parse(LookupQuerySchema, request.query);
      const concept = await provider.lookup(system as CodeSystemId, code, asOfDate(asOf));
      if (!concept) throw notFound("concept");
      return concept;
    },
  );

  // --- §4.2 expanded membership at asOf (paginated; union with tenant extensions) ------------
  app.get("/api/v1/terminology/value-sets/:id/expand", { preHandler: [READ] }, async (request) => {
    const { id } = parse(ExpandParamsSchema, request.params);
    const q = parse(ExpandQuerySchema, request.query);
    const includeTenantExtensions = q.includeTenantExtensions ?? true;
    // orgId is only needed (and only meaningful) when unioning the actor's tenant extensions.
    const orgId = includeTenantExtensions ? request.context.organizationId || undefined : undefined;
    const items: ExpansionMember[] = [];
    for await (const member of provider.expand(id, {
      asOf: asOfDate(q.asOf),
      system: q.system as CodeSystemId | undefined,
      includeTenantExtensions,
      orgId,
    })) {
      items.push(member);
    }
    // The precomputed-expansion cursor lands with the Drizzle store (T07); the slice returns all.
    return { items, nextCursor: null };
  });

  // --- §4.2 (system, code, asOf) → membership with provenance ---------------------------------
  app.get(
    "/api/v1/terminology/value-sets/:id/is-member",
    { preHandler: [READ] },
    async (request) => {
      const { id } = parse(IsMemberParamsSchema, request.params);
      const q = parse(IsMemberQuerySchema, request.query);
      return provider.isMemberOf(id, q.system as CodeSystemId, q.code, {
        asOf: asOfDate(q.asOf),
        orgId: request.context.organizationId || undefined,
      });
    },
  );

  // --- §4.2 tenant adds a (system, code) to a value set (the ONLY tenant write; §7.4/§7.6) ----
  app.post(
    "/api/v1/terminology/value-sets/:id/extensions",
    { preHandler: [EXTEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ExtensionParamsSchema, request.params);
      const body = parse(ExtensionBodySchema, request.body);
      const { extensionId } = await provider.addTenantExtension(
        organizationId,
        id,
        body.system as CodeSystemId,
        body.code,
        body.reason,
        userId,
      );
      // The DB write-audit trigger on value_set_tenant_extension (M38-T03) records the mutation;
      // the never-weaken / already-extended validation (422/409) lands with the Drizzle store (T07).
      return reply
        .code(201)
        .send({ extensionId, valueSetId: id, system: body.system, code: body.code });
    },
  );

  // --- §4.2 tenant removes an extension (soft-delete; audit row written by the trigger) -------
  app.delete(
    "/api/v1/terminology/value-sets/:id/extensions/:extId",
    { preHandler: [EXTEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { extId } = parse(ExtensionDeleteParamsSchema, request.params);
      await provider.removeTenantExtension(organizationId, extId, userId);
      return reply.code(204).send();
    },
  );
}
