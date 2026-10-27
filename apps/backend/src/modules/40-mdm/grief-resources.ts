import { requirePermission } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ExternalGriefResource,
  type ExternalGriefResourceReader,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@chartwarden/types";
// apps/backend/src/modules/40-mdm/grief-resources.ts - M40 `external_grief_resource` catalog (GAP-158).
//
// The grief-counseling referral catalog M16 references and M31's bereaved portal lists. TENANT-CURATED reference
// data (no PHI): Compliance / Quality staff maintain the list their bereaved families see. Three pieces:
//   - `createGriefResourceStore(db)`   the org-scoped Drizzle store (every method under `withOrgContext`);
//   - `buildGriefResourceReader(db)`   the `ExternalGriefResourceReader` SEAM impl (active rows only, stable order);
//   - `registerGriefResourceRoutes`    GET/POST/PATCH + deactivate under `mdm.grief_resource.{read,manage}`.
// A resource retires with `is_active = false` and is never deleted (M16 referral history points at it). Every UPDATE
// asserts its row count: a write that matched nothing is a 404/409, never a silent success.
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const G = schema.externalGriefResources;
const EXTERNAL_GRIEF_RESOURCE_KINDS = schema.EXTERNAL_GRIEF_RESOURCE_KINDS;

export interface GriefResourceView extends ExternalGriefResource {
  readonly resourceKind: (typeof EXTERNAL_GRIEF_RESOURCE_KINDS)[number];
  readonly phone: string | null;
  readonly audience: string | null;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

export interface GriefResourceInput {
  readonly name: string;
  readonly resourceKind: (typeof EXTERNAL_GRIEF_RESOURCE_KINDS)[number];
  readonly url?: string | null;
  readonly phone?: string | null;
  readonly description?: string | null;
  readonly audience?: string | null;
}

export interface GriefResourceStore {
  list(
    organizationId: string,
    opts?: { includeInactive?: boolean },
  ): Promise<readonly GriefResourceView[]>;
  create(
    organizationId: string,
    actorMembershipId: string | null,
    input: GriefResourceInput,
  ): Promise<GriefResourceView>;
  update(
    organizationId: string,
    id: string,
    patch: Partial<GriefResourceInput>,
  ): Promise<GriefResourceView>;
  setActive(organizationId: string, id: string, isActive: boolean): Promise<GriefResourceView>;
}

type Row = typeof G.$inferSelect;
const toView = (r: Row): GriefResourceView => ({
  id: r.id as ExternalGriefResource["id"],
  name: r.name,
  url: r.url,
  description: r.description,
  resourceKind: r.resourceKind,
  phone: r.phone,
  audience: r.audience,
  isActive: r.isActive,
  updatedAt: r.updatedAt.toISOString(),
});

export function createGriefResourceStore(db: DbClient): GriefResourceStore {
  const scoped = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as unknown as DbClient));
  return {
    list: (organizationId, opts) =>
      scoped(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(G)
          .where(
            opts?.includeInactive
              ? eq(G.organizationId, organizationId)
              : and(eq(G.organizationId, organizationId), eq(G.isActive, true)),
          )
          .orderBy(desc(G.isActive), asc(G.name), asc(G.id));
        return rows.map(toView);
      }),

    create: (organizationId, actorMembershipId, input) =>
      scoped(organizationId, async (tx) => {
        const [row] = await tx
          .insert(G)
          .values({
            organizationId,
            name: input.name.trim(),
            resourceKind: input.resourceKind,
            url: input.url ?? null,
            phone: input.phone ?? null,
            description: input.description ?? null,
            audience: input.audience ?? null,
            createdByMembershipId: actorMembershipId,
          })
          .returning();
        if (!row) throw new Error("external_grief_resource insert returned no row");
        return toView(row);
      }),

    update: (organizationId, id, patch) =>
      scoped(organizationId, async (tx) => {
        const updated = await tx
          .update(G)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
            ...(patch.resourceKind === undefined ? {} : { resourceKind: patch.resourceKind }),
            ...(patch.url === undefined ? {} : { url: patch.url }),
            ...(patch.phone === undefined ? {} : { phone: patch.phone }),
            ...(patch.description === undefined ? {} : { description: patch.description }),
            ...(patch.audience === undefined ? {} : { audience: patch.audience }),
            updatedAt: new Date(),
          })
          .where(and(eq(G.id, id), eq(G.organizationId, organizationId)))
          .returning();
        const row = updated[0];
        if (!row) throw new NotFoundError("external_grief_resource", id);
        return toView(row);
      }),

    setActive: (organizationId, id, isActive) =>
      scoped(organizationId, async (tx) => {
        const updated = await tx
          .update(G)
          .set({ isActive, updatedAt: new Date() })
          .where(and(eq(G.id, id), eq(G.organizationId, organizationId)))
          .returning();
        const row = updated[0];
        if (!row) throw new NotFoundError("external_grief_resource", id);
        return toView(row);
      }),
  };
}

/** The `ExternalGriefResourceReader` seam: the org's ACTIVE resources (the portal never lists a retired one). */
export function buildGriefResourceReader(db: DbClient): ExternalGriefResourceReader {
  const store = createGriefResourceStore(db);
  return {
    async resourcesForOrg(organizationId) {
      return (await store.list(organizationId)).map(
        ({ id, name, url, description }): ExternalGriefResource => ({ id, name, url, description }),
      );
    },
  };
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────

const Kind = Type.Union(EXTERNAL_GRIEF_RESOURCE_KINDS.map((k) => Type.Literal(k)));
const OptText = (max: number) =>
  Type.Optional(Type.Union([Type.String({ maxLength: max }), Type.Null()]));
const HttpUrl = Type.Optional(
  Type.Union([Type.String({ pattern: "^https?://\\S+$", maxLength: 2048 }), Type.Null()]),
);
export const GriefResourceBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  resourceKind: Kind,
  url: HttpUrl,
  phone: OptText(64),
  description: OptText(2000),
  audience: OptText(200),
});
export const GriefResourcePatchSchema = Type.Partial(GriefResourceBodySchema);
export const GriefResourceIdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
export const GriefResourceListQuery = Type.Object({
  includeInactive: Type.Optional(Type.Boolean()),
});

export function parseOrThrow<T extends import("@sinclair/typebox").TSchema>(
  schemaOf: T,
  raw: unknown,
): import("@sinclair/typebox").Static<T> {
  const converted = Value.Convert(schemaOf, raw ?? {});
  if (!Value.Check(schemaOf, converted)) {
    const first = [...Value.Errors(schemaOf, converted)][0];
    throw new ValidationError("request validation failed", [
      {
        field: first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)",
        code: "INVALID",
        message: first?.message ?? "invalid request",
      },
    ]);
  }
  return converted as import("@sinclair/typebox").Static<T>;
}

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function actorOf(request: FastifyRequest): {
  organizationId: string;
  membershipId: string | null;
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  return {
    organizationId: ctx.organizationId,
    membershipId: typeof membershipId === "string" && membershipId.length > 0 ? membershipId : null,
  };
}

export function registerGriefResourceRoutes(
  app: FastifyInstance,
  deps: { readonly store: GriefResourceStore },
): void {
  const { store } = deps;
  const READ = requirePermission("mdm.grief_resource.read") as PreHandler;
  const MANAGE = requirePermission("mdm.grief_resource.manage") as PreHandler;

  app.get("/api/v1/mdm/grief-resources", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parseOrThrow(GriefResourceListQuery, request.query);
    return { items: await store.list(organizationId, { includeInactive: q.includeInactive }) };
  });

  app.post("/api/v1/mdm/grief-resources", { preHandler: [MANAGE] }, async (request, reply) => {
    const { organizationId, membershipId } = actorOf(request);
    const body = parseOrThrow(GriefResourceBodySchema, request.body);
    return reply.code(201).send(await store.create(organizationId, membershipId, body));
  });

  app.patch("/api/v1/mdm/grief-resources/:id", { preHandler: [MANAGE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parseOrThrow(GriefResourceIdParams, request.params);
    return store.update(organizationId, id, parseOrThrow(GriefResourcePatchSchema, request.body));
  });

  app.post(
    "/api/v1/mdm/grief-resources/:id/deactivate",
    { preHandler: [MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parseOrThrow(GriefResourceIdParams, request.params);
      return store.setActive(organizationId, id, false);
    },
  );

  app.post(
    "/api/v1/mdm/grief-resources/:id/reactivate",
    { preHandler: [MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parseOrThrow(GriefResourceIdParams, request.params);
      return store.setActive(organizationId, id, true);
    },
  );
}
