// apps/backend/src/bootstrap/provider-entity-resolver.ts — the server-side primary-provider-entity resolver
// (#107 item 3; binds M30's ProviderEntityPort so the provider-scoped compliance inserts stop 503ing).
//
// `provider_entity` is an M1 FOUNDATION table (the tenancy spine's Medicare-certified provider under an org),
// NOT an M40/MDM concern — so resolving the org's provider entity is a plain foundation lookup, no
// MdmEntityProvider kind-resolution. M30's PHI tables carry provider_entity_id NOT NULL (ARCH-011 three-column
// rule); the write service stamps it server-side via the injected ProviderEntityPort. This helper reads it
// inside the SAME org-context tx the mutation runs in (RLS already scopes provider_entity to app.org_id), so
// no platform context is needed — a tenant resolving its own provider entity.
//
// "Primary" = prefer the org's `active` provider entity (the certified one); fall back to its earliest-created
// entity if none is active yet (so seed/dev data — a freshly-created 'created' provider — still resolves).
// Only an org with ZERO provider entities is genuinely unresolvable → fail-closed 503 (the prior deny-stub's
// contract, unchanged).
import { type DbClient, schema } from "@wardenx/db";
import { WardenXError } from "@wardenx/types";
import { asc, eq } from "drizzle-orm";

/** The structural ProviderEntityPort M30's write service binds (tx is its org-context WriteTx = DbClient). */
export interface PrimaryProviderEntityResolver {
  primaryProviderEntityId(tx: DbClient, organizationId: string): Promise<string>;
}

/**
 * Build the resolver. Reads the org's provider entities (RLS-scoped by the caller's tx), prefers the `active`
 * one, else the earliest-created, and throws PROVIDER_ENTITY_UNRESOLVED (503) only when the org has none.
 */
export function buildPrimaryProviderEntityResolver(): PrimaryProviderEntityResolver {
  return {
    async primaryProviderEntityId(tx, organizationId) {
      const rows = await tx
        .select({ id: schema.providerEntities.id, status: schema.providerEntities.status })
        .from(schema.providerEntities)
        .where(eq(schema.providerEntities.organizationId, organizationId))
        .orderBy(asc(schema.providerEntities.createdAt));
      const chosen = rows.find((r) => r.status === "active") ?? rows[0];
      if (!chosen) {
        throw new WardenXError(
          "PROVIDER_ENTITY_UNRESOLVED",
          `no provider entity exists for organization ${organizationId}; cannot stamp provider_entity_id`,
          503,
        );
      }
      return chosen.id;
    },
  };
}
