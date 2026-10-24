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
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, DegradedError } from "@chartwarden/types";
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
        throw new ChartWardenError(
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
 * The ACTIVE service locations under one of an org's provider entities (#50) — how M6 sites an
 * admission at activation.
 *
 * Lives here for the same reason `buildProviderEntityOrgCheck` does: `location` is an M1 FOUNDATION
 * table M6 neither owns nor may import (`arch:tables` — cross-module reads go through the owner, never
 * its schema). M6 declares the shape it needs and the composition root binds this.
 *
 * `location` is NON_ORG_SCOPED — it carries no `organization_id` and hangs off `provider_entity` — so
 * the tenant wall is the INNER JOIN plus its explicit `organization_id` predicate, not a location-level
 * RLS policy. A provider entity in another org therefore yields `[]`, which reads to the caller exactly
 * like a provider entity with no locations: absent and cross-tenant are indistinguishable by design.
 *
 * Only `active` locations count. A `created` site has not opened, a `suspended` or `closed` one is not
 * accepting patients, and siting a federal capture window at one would be wrong in a way nothing
 * downstream could detect.
 */
export function buildProviderEntityLocationLister(
  db: DbClient,
): (organizationId: string, providerEntityId: string) => Promise<readonly string[]> {
  return async (organizationId, providerEntityId) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .innerJoin(
          schema.providerEntities,
          eq(schema.providerEntities.id, schema.locations.providerEntityId),
        )
        .where(
          and(
            eq(schema.locations.providerEntityId, providerEntityId),
            eq(schema.providerEntities.organizationId, organizationId),
            eq(schema.locations.status, "active"),
          ),
        )
        .orderBy(asc(schema.locations.name), asc(schema.locations.id));
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

/**
 * One provider entity's CMS Certification Number, org-scoped (F-072 / #177).
 *
 * Lives here for the same reason `buildPrimaryProviderEntityResolver` does: `provider_entity` is an M1
 * FOUNDATION table M10 neither owns nor may import (`arch:tables` — cross-module reads go through the
 * owner, never its Drizzle schema). M10's `iqies-submit-worker` declares the shape it needs
 * (`ProviderEntityCcnPort`) and the composition root binds this.
 *
 * The CCN is what the whole submission envelope is keyed on — CMS matches the submitter credential and
 * `ccn_at_election` against it — so it is resolved rather than assumed. `null` when the provider entity
 * is absent OR belongs to another org: the worker then skips the batch and logs, and those two cases
 * are deliberately indistinguishable to the caller (the same posture as
 * `buildProviderEntityLocationLister`).
 *
 * Opens its own org-context transaction because the cron calls it outside any ambient tx; the explicit
 * `organization_id` predicate sits on top of RLS, belt and braces, as the seam stores do.
 */
export function buildProviderEntityCcnResolver(db: DbClient): {
  ccnFor(organizationId: string, providerEntityId: string): Promise<string | null>;
} {
  return {
    async ccnFor(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ ccn: schema.providerEntities.ccn })
          .from(schema.providerEntities)
          .where(
            and(
              eq(schema.providerEntities.id, providerEntityId),
              eq(schema.providerEntities.organizationId, organizationId),
            ),
          )
          .limit(1);
        return rows[0]?.ccn ?? null;
      });
    },
  };
}

/**
 * The CCN of a provider entity that MUST exist — the `resolveCcn` the M23 NOE/NOTR draft consumers bind.
 * Those consumers run on a relay tick, outside any request, so the read has to open its own org context:
 * they used to issue a bare `db.select(...)` on the pool, which ran `provider_entity`'s RLS policy
 * (`organization_id = current_setting('app.org_id', true)::uuid`) with no `app.org_id` set. On a pooled
 * connection a previous transaction's `set_config(..., true)` leaves the GUC as `''`, and `''::uuid` is
 * 22P02 — the `select "ccn" from "provider_entity"` failure that stranded `m6.transfer.created` (and,
 * on a fresh connection, a silent zero-row "provider CCN unavailable"). Same fix as F-072's M24 reader.
 */
export function buildRequiredProviderEntityCcnResolver(
  db: DbClient,
): (organizationId: string, providerEntityId: string) => Promise<string> {
  const resolver = buildProviderEntityCcnResolver(db);
  return async (organizationId, providerEntityId) => {
    const ccn = await resolver.ccnFor(organizationId, providerEntityId);
    if (ccn === null) throw new DegradedError("provider-entity", "provider CCN unavailable");
    return ccn;
  };
}

/**
 * The provider identity a HETS 270's 2100B loop needs — the hospice's NPI + legal name (M23 §4.4). Lives here
 * because `provider_entity` is M1-owned; M23's HETS port consumes it as its `HetsProviderPort`. Opens its own
 * org-context transaction (a worker has no ambient tx) and returns null for an id outside the org.
 */
export function buildProviderEligibilityIdentityReader(db: DbClient): {
  providerForEligibility(
    organizationId: string,
    providerEntityId: string,
  ): Promise<{ readonly npi: string; readonly organizationName: string } | null>;
} {
  return {
    async providerForEligibility(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await tx
          .select({
            npi: schema.providerEntities.npi,
            legalName: schema.providerEntities.legalName,
          })
          .from(schema.providerEntities)
          .where(
            and(
              eq(schema.providerEntities.id, providerEntityId),
              eq(schema.providerEntities.organizationId, organizationId),
            ),
          )
          .limit(1);
        return row ? { npi: row.npi, organizationName: row.legalName } : null;
      });
    },
  };
}
