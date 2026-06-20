// apps/backend/src/modules/40-mdm/routes/mdm-routes.ts — M40-T07 the MDM route inventory
// (M40 spec §4.1–4.2; the §4.4 permission handshake; §7.6 merge approval & re-pointing).
//
// M40's consumer + admin surface: the read path (search / resolve-one / get-or-create / overlay /
// relationships) composes over the injected `MdmEntityProvider` seam (M40-T05); the write/admin
// path (BAA register, manual license, and the platform-ops merge / provisional / NPPES operations)
// goes through the injected `MdmRouteService` (M40-T07). Every route is gated by the REAL
// Authorization Contract (`requirePermission` from @wardenx/auth, M3) on the §4.4 keys M40 registers
// into M3's catalog (M40_CONTRIBUTED_PERMISSIONS).
//
// THREE keys per kind by blast radius (§4.4): read is broad, propose writes GLOBAL provisional
// state, overlay edits this-tenant's-opinion. The per-kind key is derived from the `:kind` param at
// request time (`mdm.<kind>.<action>`). The `/admin/mdm/*` routes are platform-ops only (their keys
// are never granted to a tenant role) and `…/approve` additionally STEP-UP re-auths at the route
// (§4.1, §7.6). Org binding is always server-side (`request.context`, never the body).
//
// §7.6: approve flips the duplicate to `merged` + sets `merged_into_id`; the per-consumer batched
// `mdm.repoint_*` jobs (T08) run in the background but do NOT gate correctness — service-layer
// resolves of the duplicate id keep returning the survivor via the redirect throughout (the T04
// engine over the post-merge store).
import type { MdmEntityKind, MdmEntityProvider, MdmResolved, MdmRouteService } from "@wardenx/mdm";
import { requirePermission } from "@wardenx/auth";
import { requireStepUp } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BaaBodySchema,
  GetOrCreateBodySchema,
  IdParamsSchema,
  KindIdParamsSchema,
  KindParamsSchema,
  LicenseBodySchema,
  NppesLookupBodySchema,
  OverlayBodySchema,
  RejectBodySchema,
  SearchQuerySchema,
  parse,
} from "./mdm-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The injection surface for the MDM routes. */
export interface MdmRouteDeps {
  /** The merge-aware read surface (M40-T05; in-memory in the slice, Drizzle in prod). */
  provider: MdmEntityProvider;
  /** The write/admin surface (overlay/baa/merge/provisional/nppes). */
  service: MdmRouteService;
}

/** The org-scoped actor (org binding is server-side: the context, never the body). */
function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Derive the per-kind permission guard from the `:kind` route param (`mdm.<kind>.<action>`). */
function perKind(action: "read" | "propose" | "overlay"): PreHandler {
  return async (request, reply) => {
    const kind = (request.params as { kind?: string }).kind ?? "";
    await (requirePermission(`mdm.${kind}.${action}`) as PreHandler)(request, reply);
  };
}

// Static platform/compliance keys (the per-kind keys are dynamic via perKind()).
const BAA_READ = requirePermission("mdm.baa.read") as PreHandler;
const BAA_MANAGE = requirePermission("mdm.baa.manage") as PreHandler;
const LICENSE_MANAGE = requirePermission("mdm.license.manage") as PreHandler;
const MERGE_READ = requirePermission("mdm.merge.read") as PreHandler;
const MERGE_APPROVE = requirePermission("mdm.merge.approve") as PreHandler;
const CANONICAL_WRITE = requirePermission("mdm.canonical.write") as PreHandler;
const STEP_UP = requireStepUp("mdm.merge.approve") as PreHandler;

const notFound = (what: string) => new WardenXError("NOT_FOUND", `${what} not found`, 404);

/** Resolve one entity by kind through the seam (the merge-redirect is followed inside the provider). */
function resolveByKind(
  provider: MdmEntityProvider,
  orgId: string,
  kind: MdmEntityKind,
  id: string,
): Promise<MdmResolved<MdmEntityKind> | null> {
  switch (kind) {
    case "physician":
      return provider.resolvePhysician(orgId, id);
    case "facility":
      return provider.resolveFacility(orgId, id);
    case "pharmacy":
      return provider.resolvePharmacy(orgId, id);
    case "referral_source":
      return provider.resolveReferralSource(orgId, id);
    case "payer":
      return provider.resolvePayer(orgId, id);
    case "dme_vendor":
      return provider.resolveDmeVendor(orgId, id);
    case "funeral_home":
      return provider.resolveFuneralHome(orgId, id);
  }
}

export function registerMdmRoutes(app: FastifyInstance, deps: MdmRouteDeps): void {
  const { provider, service } = deps;

  // --- §4.2 faceted search (canonical + this-tenant overlay; excludes merged) ------------------
  app.get("/api/v1/mdm/:kind/search", { preHandler: [perKind("read")] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { kind } = parse(KindParamsSchema, request.params);
    const q = parse(SearchQuerySchema, request.query);
    const results = await provider.search(organizationId, kind as MdmEntityKind, {
      text: q.q,
      identifier: q.identifier,
      limit: q.limit ?? 25,
    });
    return { results };
  });

  // --- §4.2 resolve one (follows merged_into_id transparently; resolvedFrom on redirect) -------
  app.get("/api/v1/mdm/:kind/:id", { preHandler: [perKind("read")] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { kind, id } = parse(KindIdParamsSchema, request.params);
    const resolved = await resolveByKind(provider, organizationId, kind as MdmEntityKind, id);
    if (resolved === null) throw notFound(kind);
    return resolved;
  });

  // --- §4.2 get-or-create — match by identifier; write provisional if no match -----------------
  app.post("/api/v1/mdm/:kind/get-or-create", { preHandler: [perKind("propose")] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { kind } = parse(KindParamsSchema, request.params);
    const body = parse(GetOrCreateBodySchema, request.body);
    return provider.getOrCreate(
      organizationId,
      kind as MdmEntityKind,
      { identifierType: body.identifierType, identifierValue: body.identifierValue },
      userId,
    );
  });

  // --- §4.2 upsert this tenant's overlay (Phase-1: physician overlay only) ----------------------
  app.patch("/api/v1/mdm/:kind/:id/overlay", { preHandler: [perKind("overlay")] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { kind, id } = parse(KindIdParamsSchema, request.params);
    if (kind !== "physician") {
      // Only the physician kind ships a Phase-1 overlay table (manifest §3.4); others have nowhere
      // to write an overlay yet — a clear 422 rather than a silent no-op.
      throw new WardenXError("NOT_SUPPORTED", `${kind} has no tenant overlay in Phase 1`, 422);
    }
    const b = parse(OverlayBodySchema, request.body);
    const { applied } = await service.upsertPhysicianOverlay(
      organizationId,
      id,
      {
        preferredContactPhone: b.preferredContactPhone ?? null,
        preferredContactEmail: b.preferredContactEmail ?? null,
        relationshipNotes: b.relationshipNotes ?? null,
        doNotRefer: b.doNotRefer ?? false,
        isPreferred: b.isPreferred ?? false,
        preferredRank: b.preferredRank ?? null,
      },
      userId,
    );
    return { applied };
  });

  // --- §4.2 parent/child for the entity (canonical, public — no overlay) ------------------------
  app.get(
    "/api/v1/mdm/:kind/:id/relationships",
    { preHandler: [perKind("read")] },
    async (request) => {
      const { kind, id } = parse(KindIdParamsSchema, request.params);
      const k = kind as MdmEntityKind;
      const [parent, children] = await Promise.all([provider.parentOf(k, id), provider.childrenOf(k, id)]);
      return { parent, children };
    },
  );

  // --- §4.2 tenant BAA register (read / record) ------------------------------------------------
  app.get("/api/v1/mdm/baa", { preHandler: [BAA_READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    return { entries: await service.listBaa(organizationId) };
  });

  app.post("/api/v1/mdm/baa", { preHandler: [BAA_MANAGE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(BaaBodySchema, request.body);
    const { id } = await service.recordBaa(organizationId, b, userId);
    return reply.code(201).send({ id });
  });

  // --- §4.2 manual license entry (Phase-1) -----------------------------------------------------
  app.post("/api/v1/mdm/license/manual", { preHandler: [LICENSE_MANAGE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(LicenseBodySchema, request.body);
    await service.recordLicense(organizationId, b, userId);
    return reply.code(201).send({ recorded: true });
  });

  // --- §4.2 platform-ops: pending merges -------------------------------------------------------
  app.get("/api/v1/admin/mdm/merge-requests", { preHandler: [MERGE_READ] }, async () => {
    return { mergeRequests: await service.listMergeRequests() };
  });

  // --- §4.2 platform-ops: approve a merge (step-up re-auth required, §7.6) ----------------------
  app.post(
    "/api/v1/admin/mdm/merge-requests/:id/approve",
    { preHandler: [MERGE_APPROVE, STEP_UP] },
    async (request) => {
      const { userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.approveMerge(id, userId);
    },
  );

  // --- §4.2 platform-ops: reject a merge with reason -------------------------------------------
  app.post(
    "/api/v1/admin/mdm/merge-requests/:id/reject",
    { preHandler: [MERGE_APPROVE] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const { reason } = parse(RejectBodySchema, request.body);
      await service.rejectMerge(id, reason, userId);
      return reply.code(204).send();
    },
  );

  // --- §4.2 platform-ops: promote a provisional to canonical -----------------------------------
  app.post(
    "/api/v1/admin/mdm/provisional/:id/promote",
    { preHandler: [CANONICAL_WRITE] },
    async (request) => {
      const { userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.promoteProvisional(id, userId);
    },
  );

  // --- §4.2 platform-ops: on-demand single-NPI sync (nightly path is T08) -----------------------
  app.post("/api/v1/admin/mdm/nppes/lookup", { preHandler: [CANONICAL_WRITE] }, async (request) => {
    const b = parse(NppesLookupBodySchema, request.body);
    return service.nppesLookup(b.npi);
  });

  // --- §4.2 platform-ops: recent NPPES sync outcomes -------------------------------------------
  app.get("/api/v1/admin/mdm/nppes/sync-log", { preHandler: [MERGE_READ] }, async () => {
    return { runs: await service.nppesSyncLog() };
  });
}
