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
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { and, asc, eq } from "drizzle-orm";

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

/**
 * List ALL of an org's provider-entity ids — the per-PE AGGREGATION GRAIN M30's published seams fold
 * their measure/CoP rollups across (§4.3). Distinct from `primaryProviderEntityId` above, which picks the
 * ONE entity a write stamps: a rollup that silently used only the primary would under-count a multi-PE
 * agency's numbers, which is worse than reporting none.
 *
 * Opens its OWN `withOrgContext` transaction because the published seams are called OUTSIDE M30's request
 * pipeline (M22 / M28 / M33 / M34 consume them through `getSeam`), so there is no ambient tx to borrow.
 * An org with zero provider entities resolves to `[]` — the impls then produce empty aggregates rather
 * than a fabricated number, which is the same fail-closed shape as an unbound resolver (D6 / D13).
 */
export function buildOrgProviderEntityLister(
  db: DbClient,
): (organizationId: string) => Promise<readonly string[]> {
  return async (organizationId) =>
    withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
      const rows = await tx
        .select({ id: schema.providerEntities.id })
        .from(schema.providerEntities)
        .where(eq(schema.providerEntities.organizationId, organizationId))
        .orderBy(asc(schema.providerEntities.createdAt));
      return rows.map((r) => r.id);
    });
}

/**
 * Confirms a provider entity belongs to an org (#44) — the M6 election-statement draft's guard.
 *
 * Lives here, not in M6, for the same reason `primaryProviderEntityId` does: `provider_entity` is an
 * M1 FOUNDATION table that M6 neither owns nor may import (`arch:tables` — cross-module reads go
 * through the owner, never its schema). M6 declares the shape it needs
 * (`ProviderEntityOrgCheckPort`) and the composition root binds this.
 *
 * It exists because the FKs on `election_statement.provider_entity_id` and
 * `admission.provider_entity_id` are plain single-column references that carry no organization —
 * a foreign key is checked as a system operation and does not consult RLS, so nothing below the
 * application stops one tenant from electing another tenant's hospice. While the elected id was
 * being discarded that was moot; persisting it makes this check load-bearing.
 *
 * Opens its own org-context transaction so RLS scopes the read, and the `organization_id` predicate
 * is stated explicitly anyway — the same belt-and-braces posture the seam stores use.
 */
export function buildProviderEntityOrgCheck(db: DbClient): {
  belongsToOrg(organizationId: string, providerEntityId: string): Promise<boolean>;
} {
  return {
    async belongsToOrg(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ id: schema.providerEntities.id })
          .from(schema.providerEntities)
          .where(
            and(
              eq(schema.providerEntities.id, providerEntityId),
              eq(schema.providerEntities.organizationId, organizationId),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },
  };
}
