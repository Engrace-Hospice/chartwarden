// @wardenx/billing · repositories — `validation_rule_config` (the PER-TENANT overlay on the platform's
// billing-rule registry, §3.3, D5; retention class `operational`). The 18 default rules are CODE-side (the
// §11.A registry in `@wardenx/billing`); only the tenant overlay (enable/disable, severity, override-role,
// parameters, and any tenant-custom rule) is persisted here. Unlike the append-only validation tables this
// is a CRUD root carrying a `version` column, so it follows the `ClaimRepository` exemplar for §2.5 If-Match
// optimistic concurrency (`updateWithVersion` / `deleteWithVersion` → `VersionedUpdateResult`).
//
// D5 PLATFORM-FLOOR PROTECTION (the regulatory-required guard): a tenant can NEVER create or flip an overlay
// for a CMS-mandated rule. The DB CHECK (`regulatory_required_snapshot IS DISTINCT FROM true`) is the last
// line; this repo fails CLOSED *before* the DB with a clean `FORBIDDEN` rather than leaking a raw CHECK
// violation, and the version-checked update patch type structurally OMITS `regulatoryRequiredSnapshot` so
// the floor flag can never be raised through this port.
//
// ENUM BOUNDARY: `severity` (error/warn/info) and `override_role_required` (billing_manager/…) are DB-native
// lowercase enums identical to the domain alphabet, so rows pass through un-mapped. No PHI (D18).
import * as schema from "@wardenx/db/schema";
import { WardenXError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import {
  type BillingDb,
  type CursorPage,
  type VersionedUpdateResult,
  buildCursorPage,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
  versionConflict,
  versionOk,
} from "./db";

const G = schema.validationRuleConfig;

/** List filter for {@link ValidationRuleConfigRepository.listByOrgPage} (all optional; combined with AND). */
export interface ValidationRuleConfigListFilter {
  readonly enabled?: boolean;
  readonly isCustom?: boolean;
}

/**
 * The columns a version-checked update may set. Structurally OMITS `regulatoryRequiredSnapshot` (D5 — the
 * platform floor can never be raised through this port), plus the identity/audit columns (`id`,
 * `organizationId`, `ruleKey`, `version`, timestamps) the repo manages itself.
 */
export type ValidationRuleConfigUpdatePatch = Partial<
  Pick<
    schema.NewValidationRuleConfig,
    | "enabled"
    | "severity"
    | "overrideRoleRequired"
    | "parameters"
    | "predicateDsl"
    | "setReason"
    | "setByMembershipId"
    | "ruleVersion"
    | "isCustom"
  >
>;

/** Data port for `validation_rule_config` (CRUD overlay; §2.5 version-checked write; D5 floor guard). */
export class ValidationRuleConfigRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Insert a tenant overlay row. The service computes `regulatoryRequiredSnapshot` from the code-side
   * registry at write time; this repo fails CLOSED (D5) when that snapshot is `true` — a tenant can never
   * persist an overlay for a regulatory-required rule. Returns the inserted row.
   */
  async create(values: schema.NewValidationRuleConfig): Promise<schema.ValidationRuleConfig> {
    if (values.regulatoryRequiredSnapshot === true) {
      throw new WardenXError(
        "FORBIDDEN",
        "cannot create a tenant overlay for a regulatory-required billing rule (D5 platform floor)",
        403,
      );
    }
    const [row] = await this.db.insert(G).values(values).returning();
    if (!row) throw new Error("validation_rule_config insert returned no row");
    return row;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.ValidationRuleConfig | null> {
    const [row] = await this.db.select().from(G).where(eq(G.id, id)).limit(1);
    return row ?? null;
  }

  /** The overlay for a `(organization_id, rule_key)` (the unique `..._org_rule_uq` probe), or `null`. */
  async findByOrgRule(
    organizationId: string,
    ruleKey: string,
  ): Promise<schema.ValidationRuleConfig | null> {
    const [row] = await this.db
      .select()
      .from(G)
      .where(and(eq(G.organizationId, organizationId), eq(G.ruleKey, ruleKey)))
      .limit(1);
    return row ?? null;
  }

  /**
   * One keyset page of an org's overlay rows (optionally narrowed by enabled/custom), `(created_at DESC,
   * id DESC)`. Over-fetches `size + 1` rows so {@link buildCursorPage} can reveal `hasMore` + mint the next
   * cursor. RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listByOrgPage(
    organizationId: string,
    filter: ValidationRuleConfigListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<schema.ValidationRuleConfig>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(G.organizationId, organizationId),
      filter.enabled !== undefined ? eq(G.enabled, filter.enabled) : undefined,
      filter.isCustom !== undefined ? eq(G.isCustom, filter.isCustom) : undefined,
      keysetBefore(G.createdAt, G.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(G)
      .where(where)
      .orderBy(desc(G.createdAt), desc(G.id))
      .limit(size + 1);
    return buildCursorPage(rows, size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }

  /**
   * Version-checked update (§2.5 If-Match): applies `patch` only when the persisted `version` matches the
   * supplied `expectedVersion`, bumping `version` + `updated_at`. The `regulatoryRequiredSnapshot` floor flag
   * is NOT in {@link ValidationRuleConfigUpdatePatch}, so it can never be raised here (D5). On a version
   * mismatch returns `VERSION_CONFLICT` carrying the current persisted version (or `null` when the row
   * vanished) so the service can surface a 412.
   */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: ValidationRuleConfigUpdatePatch,
  ): Promise<VersionedUpdateResult<schema.ValidationRuleConfig>> {
    const [row] = await this.db
      .update(G)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(G.id, id), eq(G.version, expectedVersion)))
      .returning();
    if (row) return versionOk(row);
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }

  /**
   * Version-checked delete (§2.5 If-Match) — removing the overlay reverts the rule to its platform default.
   * Deletes only when the persisted `version` matches `expectedVersion`; returns the deleted row on success
   * or `VERSION_CONFLICT` (current persisted version, or `null` when already gone) on a stale If-Match.
   */
  async deleteWithVersion(
    id: string,
    expectedVersion: number,
  ): Promise<VersionedUpdateResult<schema.ValidationRuleConfig>> {
    const [row] = await this.db
      .delete(G)
      .where(and(eq(G.id, id), eq(G.version, expectedVersion)))
      .returning();
    if (row) return versionOk(row);
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }
}
