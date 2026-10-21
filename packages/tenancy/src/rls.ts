// @chartwarden/tenancy — RLS policy generator (M1-T05; spec §3.13).
//
// Emits the canonical per-table tenant-isolation DDL used inside migrations when a
// new module's PHI-bearing table lands. Every generated policy keys ONLY on the
// canonical session variable `app.org_id` (set by withOrgContext(), §3.14) — the
// single source of tenant truth enforced by check-tenancy.ts (ADR-0010 D2).
//
// Relocated here from the M1 spec's `packages/db/src/rls.ts` per the manifest
// (`packages/tenancy — withOrgContext() + RLS policy generator`) and ADR-0005 D3
// (`packages/foundation` is banned). Pure string generation — no DB/runtime deps,
// so it never reaches across a module boundary.

export type RlsPolicyOptions = {
  tableName: string;
  /** Tenant-key column. Default 'organization_id' (the three-column rule's anchor). */
  orgIdColumn?: string;
  /** Role the policy applies to. Default 'wardenx_app' (the tenant-scoped app role). */
  appRole?: string;
  /** Policy name. Default '<tableName>_org_isolation'. */
  policyName?: string;
  /**
   * Permit rows with a NULL tenant key to be visible (read-only / global-reference
   * tables read under a non-tenant role ONLY). Default false. Leaving this false is
   * what keeps the policy clear of the null-org disjunction that check-tenancy.ts
   * bans on tenant-writable tables (ADR-0010 D3); never enable it for a PHI-bearing,
   * tenant-writable table.
   */
  allowNullOrgId?: boolean;
};

/**
 * Generates the SQL to enable RLS and create a tenant-isolation policy for a
 * PHI-bearing table. Used in migrations for new modules. The USING and WITH CHECK
 * clauses are symmetric so a tenant can neither read nor write outside its org.
 */
export function generateRlsPolicy(opts: RlsPolicyOptions): string {
  const {
    tableName,
    orgIdColumn = "organization_id",
    appRole = "wardenx_app",
    policyName = `${tableName}_org_isolation`,
    allowNullOrgId = false,
  } = opts;

  const nullClause = allowNullOrgId ? ` OR ${orgIdColumn} IS NULL` : "";

  return `
ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;

CREATE POLICY ${policyName} ON ${tableName}
  FOR ALL TO ${appRole}
  USING (${orgIdColumn} = current_setting('app.org_id', true)::uuid${nullClause})
  WITH CHECK (${orgIdColumn} = current_setting('app.org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableName} TO ${appRole};
  `.trim();
}

/**
 * For tables whose tenant scope is reached through a parent row (e.g. a child table
 * scoped via its provider_entity_id/parent FK rather than a direct organization_id).
 * The membership subquery is still anchored on the canonical `app.org_id` variable.
 */
export function generateRlsPolicyViaJoin(opts: {
  tableName: string;
  joinTable: string;
  joinFkColumn: string;
  joinPkColumn?: string;
  joinOrgIdColumn?: string;
  appRole?: string;
  policyName?: string;
}): string {
  const {
    tableName,
    joinTable,
    joinFkColumn,
    joinPkColumn = "id",
    joinOrgIdColumn = "organization_id",
    appRole = "wardenx_app",
    policyName = `${tableName}_org_isolation`,
  } = opts;

  return `
ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;

CREATE POLICY ${policyName} ON ${tableName}
  FOR ALL TO ${appRole}
  USING (
    ${joinFkColumn} IN (
      SELECT ${joinPkColumn} FROM ${joinTable}
      WHERE ${joinOrgIdColumn} = current_setting('app.org_id', true)::uuid
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableName} TO ${appRole};
  `.trim();
}
