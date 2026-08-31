import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { UnauthorizedError } from "@wardenx/types";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function limitOf(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

/**
 * Foundation lookup for service locations. Locations hang from provider entities, so callers can
 * narrow by `providerEntityId` before presenting a selectable list in clinical/revenue workflows.
 */
export function registerLocationLookupRoutes(app: FastifyInstance, db: DbClient): void {
  app.get(
    "/api/v1/locations",
    {
      config: {
        auditRead: {
          none: "location directory lookup - tenancy metadata, no patient data",
        },
      },
    },
    async (request) => {
      const organizationId = request.context.organizationId;
      if (!request.context.userId || !organizationId) throw new UnauthorizedError();
      const query = (request.query ?? {}) as {
        providerEntityId?: unknown;
        q?: unknown;
        limit?: unknown;
      };
      const providerEntityId =
        typeof query.providerEntityId === "string" && query.providerEntityId.trim()
          ? query.providerEntityId.trim()
          : "";
      const q = typeof query.q === "string" ? query.q.trim() : "";
      const limit = limitOf(query.limit);
      return withOrgContext(db, { organizationId, userId: request.context.userId }, async (tx) => {
        const predicates = [
          providerEntityId ? eq(schema.locations.providerEntityId, providerEntityId) : undefined,
          q
            ? or(
                ilike(schema.locations.name, `%${q}%`),
                ilike(schema.locations.addressLine1, `%${q}%`),
                ilike(schema.locations.city, `%${q}%`),
                ilike(schema.locations.state, `%${q}%`),
                ilike(schema.locations.postalCode, `%${q}%`),
              )
            : undefined,
        ].filter((p): p is NonNullable<typeof p> => p !== undefined);
        const rows = await tx
          .select({
            id: schema.locations.id,
            providerEntityId: schema.locations.providerEntityId,
            name: schema.locations.name,
            addressLine1: schema.locations.addressLine1,
            addressLine2: schema.locations.addressLine2,
            city: schema.locations.city,
            state: schema.locations.state,
            postalCode: schema.locations.postalCode,
            status: schema.locations.status,
          })
          .from(schema.locations)
          .where(predicates.length ? and(...predicates) : undefined)
          .orderBy(asc(schema.locations.name), asc(schema.locations.id))
          .limit(limit);
        return { items: rows };
      });
    },
  );
}
