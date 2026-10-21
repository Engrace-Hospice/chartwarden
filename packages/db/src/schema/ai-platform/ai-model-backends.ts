// @chartwarden/db — `ai_model_backend` (M32 §3.2.4). The model registry: every backend M32 may route to,
// cloud or local, pinned to an exact model version.
//
// PLATFORM-SHARED (§3.3): one row per real backend, the same answer for every tenant. Listed in
// check-tenancy.ts's NON_ORG_SCOPED set.
//
// THE TWO CHECKS ARE THE D19 CONTROL, and they are the reason this table is worth more than a config
// file. `ai_backend_cloud_baa_check`: a `cloud` backend cannot exist in the registry without a BAA
// reference AND `zdr_status = 'enabled'` — so "we sent PHI to a vendor with no BAA" is not a code review
// finding, it is an INSERT that fails. `ai_backend_local_license_check`: a `local` backend cannot exist
// without license terms and an artifact reference, so an unlicensed weight file cannot quietly become the
// fallback route. Both are written as `kind = <other> OR <requirement>` so they constrain exactly one
// side and say nothing about the other.
//
// `model_version_pin` is NEVER 'latest' (§3.2.4). A moving pin makes every `ai_invocation` row's
// provenance a lie: the ledger records which model handled a disclosure, and 'latest' records nothing.
// The rule is a convention here rather than a CHECK because the illegal value is a class ('latest',
// 'stable', an unversioned alias), not a literal — the registration route enforces it (T04).
//
// `zdr_status` stays a TEXT column with a value CHECK rather than a pgEnum: §3.1 declares twenty-one
// enums and this vocabulary is not among them, so minting a pg type here would be M32 inventing DDL the
// spec never declared. The union lives in `@chartwarden/types` as `AiZdrStatus`.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiBackendHealthStatus, aiModelBackendKind } from "../../enums";

export const aiModelBackend = pgTable(
  "ai_model_backend",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'anthropic-claude-opus-4-7'. Uniqueness is the named index below (the `ai_capability` posture). */
    backendKey: text("backend_key").notNull(),

    kind: aiModelBackendKind("kind").notNull(),
    vendor: text("vendor").notNull(),
    modelFamily: text("model_family").notNull(),
    /** EXACT version — never a moving alias (see header). */
    modelVersionPin: text("model_version_pin").notNull(),

    /** ('text'|'embedding'|'classification'|'vision')[] */
    supportedModalities: jsonb("supported_modalities").notNull(),
    contextWindowTokens: integer("context_window_tokens").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    /** { structured_output, tool_use, vision, streaming } — a verbatim vendor-capability record. */
    supportedFeatures: jsonb("supported_features").notNull(),

    /** Cloud-only; refs CHARTWARDEN_INTEGRATIONS + the signed contract. Required by the cloud CHECK. */
    baaReference: text("baa_reference"),
    zdrStatus: text("zdr_status").notNull().default("not_applicable"),

    /** Local-only; all three required by the local CHECK / the artifact-integrity path. */
    licenseTerms: text("license_terms"),
    artifactStorageRef: text("artifact_storage_ref"),
    artifactChecksum: text("artifact_checksum"),

    healthEndpoint: text("health_endpoint").notNull(),

    isActive: boolean("is_active").notNull().default(true),
    deprecationReason: text("deprecation_reason"),

    firstRegisteredAt: timestamp("first_registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    /** `unknown` is registered-but-never-probed and is DISTINCT from `unhealthy`. */
    lastHealthStatus: aiBackendHealthStatus("last_health_status").default("unknown"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    backendKeyIdx: uniqueIndex("ai_backend_key_idx").on(t.backendKey),
    activeIdx: index("ai_backend_active_idx").on(t.isActive).where(sql`is_active = true`),

    zdrStatusCheck: check(
      "ai_backend_zdr_status_check",
      sql`zdr_status IN ('enabled','not_applicable','disabled')`,
    ),
    // D19: no cloud route without a BAA and ZDR on. Enforced at the DB, not at the route.
    cloudBaaCheck: check(
      "ai_backend_cloud_baa_check",
      sql`kind = 'local' OR (baa_reference IS NOT NULL AND zdr_status = 'enabled')`,
    ),
    // D17: no local route without license terms and a stored artifact.
    localLicenseCheck: check(
      "ai_backend_local_license_check",
      sql`kind = 'cloud' OR (license_terms IS NOT NULL AND artifact_storage_ref IS NOT NULL)`,
    ),
  }),
);

export type AiModelBackendRow = typeof aiModelBackend.$inferSelect;
export type NewAiModelBackendRow = typeof aiModelBackend.$inferInsert;
