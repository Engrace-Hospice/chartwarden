import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { UnauthorizedError } from "@chartwarden/types";
import { asc, ilike, or } from "drizzle-orm";
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
 * Foundation lookup for ProviderEntity selectors. It returns only non-PHI tenancy-directory fields and
 * scopes through `withOrgContext`; consumers still use their module routes for the actual writes.
 */
export function registerProviderEntityLookupRoutes(app: FastifyInstance, db: DbClient): void {
  app.get(
    "/api/v1/provider-entities",
    {
      config: {
        auditRead: {
          none: "provider-entity directory lookup — tenancy metadata, no patient data",
        },
      },
    },
    async (request) => {
      const organizationId = request.context.organizationId;
      if (!request.context.userId || !organizationId) throw new UnauthorizedError();
      const query = (request.query ?? {}) as { q?: unknown; cursor?: unknown; limit?: unknown };
      const limit = limitOf(query.limit);
      const offset = cursorOf(query.cursor);
      const q = typeof query.q === "string" ? query.q.trim() : "";
      return withOrgContext(db, { organizationId, userId: request.context.userId }, async (tx) => {
        const rows = await tx
          .select({
            id: schema.providerEntities.id,
            legalName: schema.providerEntities.legalName,
            doingBusinessAs: schema.providerEntities.doingBusinessAs,
            ccn: schema.providerEntities.ccn,
            npi: schema.providerEntities.npi,
            status: schema.providerEntities.status,
          })
          .from(schema.providerEntities)
          .where(
            q
              ? or(
                  ilike(schema.providerEntities.legalName, `%${q}%`),
                  ilike(schema.providerEntities.doingBusinessAs, `%${q}%`),
                  ilike(schema.providerEntities.ccn, `%${q}%`),
                  ilike(schema.providerEntities.npi, `%${q}%`),
                )
              : undefined,
          )
          .orderBy(asc(schema.providerEntities.legalName), asc(schema.providerEntities.id))
          .limit(limit + 1)
          .offset(offset);
        const page = rows.slice(0, limit);
        return {
          items: page,
          nextCursor: rows.length > limit ? String(offset + limit) : null,
        };
      });
    },
  );
}
