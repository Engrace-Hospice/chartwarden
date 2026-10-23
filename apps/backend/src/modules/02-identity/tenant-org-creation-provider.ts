// apps/backend/src/modules/02-identity — M2's implementation of the `TenantOrgCreationProvider` seam
// (contract in @chartwarden/types) that M34's `tenant.provision` worker consumes at §7.1 step 3.
//
// M2 owns the `organization` table, so it is the natural producer: M34 reaches it through the published
// seam (no M34→M2-internal import; the M2 `dependsOn` edge already exists). SELECT-then-create, idempotent:
//   • Phase 1 — the platform-ops §7.1 step-1 route pre-creates the org spine, so this is an idempotent
//     CONFIRM (the row already exists → `available`).
//   • Phase 3 — self-serve signup mints the org here (the create branch), behind `m34.self_serve_signup`.
// It never fabricates an id and never fails open: a row it can neither find nor create resolves `unavailable`.
import { schema } from "@chartwarden/db";
import type { DbClient } from "@chartwarden/db";
import type {
  TenantOrgCreationIntent,
  TenantOrgCreationProvider,
  TenantOrgCreationResult,
} from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { eq } from "drizzle-orm";

/** Composition-root hooks (M2 may not import M3, so the role materializer arrives as a port). */
export interface TenantOrgCreationHooks {
  /** Runs once the org row exists, on every (idempotent) confirm. A throw resolves the confirm `unavailable`. */
  readonly onOrganizationAvailable?: (organizationId: string) => Promise<void>;
}

/** Slugify a legal name to the `organization.slug` shape (lowercase, hyphenated, bounded). */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "tenant";

/**
 * Build M2's real `TenantOrgCreationProvider` over the org-spine table. Registered into the M1 seam
 * registry by `registerIdentitySeams` when a DB client is present; the registry's fail-closed deny-stub
 * stands until then. The org table is the tenancy root (NON_ORG_SCOPED), so the write is M2's prerogative
 * and needs no `app.org_id` scope.
 */
export function createTenantOrgCreationProvider(
  db: DbClient,
  hooks: TenantOrgCreationHooks = {},
): TenantOrgCreationProvider {
  /** GAP-006: an org that resolves `available` also gets its roles (idempotent), or the confirm fails closed (`unavailable` makes M34's worker retry). */
  const confirmed = async (organizationId: string): Promise<TenantOrgCreationResult> => {
    if (!hooks.onOrganizationAvailable) return { kind: "available", organizationId };
    try {
      await hooks.onOrganizationAvailable(organizationId);
      return { kind: "available", organizationId };
    } catch {
      return { kind: "unavailable", reason: "m2_org_creation_not_yet_locked" };
    }
  };
  return {
    async createOrganizationForTenant(
      intent: TenantOrgCreationIntent,
    ): Promise<TenantOrgCreationResult> {
      const existing = await db
        .select({ id: schema.organizations.id, slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, intent.organizationId))
        .limit(1);
      if (existing[0]) {
        // A re-provision naming a different host label must not be silently ignored: the audit would name a slug the org never got.
        if (intent.slug !== undefined && intent.slug !== existing[0].slug) {
          throw new ChartWardenError("TENANT_SLUG_UNAVAILABLE", "this organization already exists with a different slug", 409);
        }
        return confirmed(existing[0].id);
      }

      // Phase-3 self-serve create path: mint the org spine with a deterministic, collision-free slug.
      const slug = intent.slug ?? `${slugify(intent.legalBusinessName)}-${intent.organizationId.slice(0, 8)}`;
      const inserted = await db
        .insert(schema.organizations)
        .values({
          id: intent.organizationId,
          slug,
          legalName: intent.legalBusinessName,
          displayName: intent.legalBusinessName,
        })
        .onConflictDoNothing({ target: schema.organizations.id })
        .returning({ id: schema.organizations.id });
      if (inserted[0]) return confirmed(inserted[0].id);

      // A concurrent provision won the insert race — re-confirm before failing closed.
      const after = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, intent.organizationId))
        .limit(1);
      return after[0]
        ? confirmed(after[0].id)
        : { kind: "unavailable", reason: "m2_org_creation_not_yet_locked" };
    },
  };
}
