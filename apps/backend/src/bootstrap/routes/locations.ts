// apps/backend/src/bootstrap/routes/locations.ts — the Foundation LOCATION directory lookup (#50).
//
// `location` is an M1 table (the tenancy spine's service site under a `provider_entity`) that until now
// NO route exposed: `grep '/locations' docs/api/openapi.json` returned nothing but EVV's
// clinician-current-location and the M20 SOS stream. So there was no way for a human to name the
// location an admission is served from, which is half of why `admission.location_id` was never written.
//
// TENANCY. `location` is NON_ORG_SCOPED (check-tenancy.ts) — it carries no `organization_id` and hangs
// off `provider_entity`, which does. So the tenant wall here is the INNER JOIN onto `provider_entity`
// plus its explicit `organization_id` predicate, inside `withOrgContext`; there is no location-level RLS
// policy to lean on. A `providerEntityId` filter is applied on top for the caller's own narrowing, never
// as the scope.
//
// Non-PHI tenancy metadata only (name / address / timezone / status), so the read is audited as `none`
// like its `provider-entities.ts` sibling, whose shape this mirrors deliberately.
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

function cursorOf(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

/**
 * Foundation lookup for service locations. Locations hang from provider entities, so callers can
 * narrow by `providerEntityId` before presenting a selectable list in clinical/revenue workflows
 * (including the admission activation ceremony's service-location picker, #50). The tenant wall is the
 * INNER JOIN onto `provider_entity` + its `organization_id` predicate — `location` itself carries no
 * organization_id and has no location-level RLS policy, so `providerEntityId` is only the caller's own
 * narrowing, never the scope.
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
        status?: unknown;
        cursor?: unknown;
        limit?: unknown;
      };
      const providerEntityId =
        typeof query.providerEntityId === "string" && query.providerEntityId.trim()
          ? query.providerEntityId.trim()
          : "";
      const q = typeof query.q === "string" ? query.q.trim() : "";
      const limit = limitOf(query.limit);
      const offset = cursorOf(query.cursor);
      const status =
        typeof query.status === "string" && query.status.length > 0 ? query.status : null;
      return withOrgContext(db, { organizationId, userId: request.context.userId }, async (tx) => {
        const predicates = [
          // The tenant wall — `location` has no organization_id of its own.
          eq(schema.providerEntities.organizationId, organizationId),
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
          status ? eq(schema.locations.status, status as "active") : undefined,
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
            timezone: schema.locations.timezone,
            status: schema.locations.status,
          })
          .from(schema.locations)
          .innerJoin(
            schema.providerEntities,
            eq(schema.providerEntities.id, schema.locations.providerEntityId),
          )
          .where(and(...predicates))
          .orderBy(asc(schema.locations.name), asc(schema.locations.id))
          .limit(limit + 1)
          .offset(offset);
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? String(offset + limit) : null,
        };
      });
    },
  );
}
