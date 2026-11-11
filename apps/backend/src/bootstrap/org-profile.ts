// apps/backend/src/bootstrap/org-profile.ts - the organisation's display name and time zone, for the onboarding wizard.
//
// `organization.display_name` and `organization.settings.org_timezone` are M1/M2's. M34's wizard edits them through a port
// (its `OrgProfilePort`, matched structurally here: bootstrap may not import a module) that the composition root binds to
// this adapter, the `org-spine-facts.ts` precedent. Every call opens the TARGET org's own `withOrgContext` on the tenant
// pool (the real NOBYPASSRLS app role, `organization_self` policy), so a platform operator editing a tenant's profile
// goes through exactly the path the tenant's own admin would, and the M4 write-audit trigger records the actor's user id.
// Validation (IANA zone, name length) is the caller's: the wizard has already normalized the patch.
import {
  DEFAULT_ORGANIZATION_TIMEZONE,
  type DbClient,
  organizationSettingsReader,
  schema,
} from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq, sql } from "drizzle-orm";

export interface OrgProfileView {
  readonly displayName: string;
  readonly orgTimezone: string;
}

export interface OrgProfilePatch {
  readonly displayName?: string;
  readonly orgTimezone?: string;
}

const ORG = schema.organizations;

export function buildDrizzleOrgProfilePort(db: DbClient): {
  read(organizationId: string): Promise<OrgProfileView | null>;
  update(
    organizationId: string,
    patch: OrgProfilePatch,
    actorUserId: string,
  ): Promise<OrgProfileView>;
} {
  const project = (row: {
    displayName: string;
    settings: unknown;
  }): OrgProfileView => ({
    displayName: row.displayName,
    orgTimezone:
      organizationSettingsReader.get<string>(
        (row.settings as Record<string, unknown> | null) ?? null,
        "org_timezone",
      ) ?? DEFAULT_ORGANIZATION_TIMEZONE,
  });
  return {
    read: (organizationId) =>
      withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await tx
          .select({ displayName: ORG.displayName, settings: ORG.settings })
          .from(ORG)
          .where(eq(ORG.id, organizationId))
          .limit(1);
        return row ? project(row) : null;
      }),
    update: (organizationId, patch, actorUserId) =>
      withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const settingsPatch =
          patch.orgTimezone === undefined
            ? null
            : JSON.stringify({ org_timezone: patch.orgTimezone });
        const [row] = await tx
          .update(ORG)
          .set({
            ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
            ...(settingsPatch !== null
              ? { settings: sql`coalesce(${ORG.settings}, '{}'::jsonb) || ${settingsPatch}::jsonb` }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(ORG.id, organizationId))
          .returning({ displayName: ORG.displayName, settings: ORG.settings });
        if (!row) throw new Error("organization not found for the profile update");
        return project(row);
      }),
  };
}
