// @wardenx/db — `ai_prompt_template` (M32 §3.2.5). The versioned prompt registry `AIPromptRegistry`
// (§4.5) resolves against, and the D18 AI-prohibited-zone key: `output_entity_target_prefix` is what a
// downstream module's boot validator asks about to prove no active prompt targets its prohibited entity.
//
// PLATFORM-SHARED (§3.3). Listed in check-tenancy.ts's NON_ORG_SCOPED set.
//
// THE CONTENT IS NOT IN THE ROW. `template_filesystem_ref` + `template_content_hash` (SHA-256, the
// `length = 64` CHECK) point at a file in the repo; the row is the GOVERNANCE record. That split is the
// point: the prompt text is reviewed, diffed and signed off in version control like any other code, and
// the hash is what makes "the row and the file agree" checkable at boot instead of assumed. A prompt
// pasted into a database column is a prompt nobody reviewed.
//
// IMMUTABLE POST-APPROVAL (§3.5): every content field is frozen by the 0116 trigger, and status may only
// walk active → deprecated → archived. Deprecated and archived rows stay READABLE forever — a 2031 audit
// of a 2026 invocation must be able to reconstruct the exact template that ran, and `AIPromptRegistry`
// resolving only `active` is what keeps them out of the live path.
//
// The two prefix columns are OPEN vocabularies on TEXT, deliberately un-CHECKed: a new capability
// introduces a new target, and a value list here would mean a prohibited-zone key could not be added
// without a migration. `@wardenx/types` names the known values (`AiKnownOutputEntityTargetPrefix` /
// `AiKnownOutputTypePrefix`) without closing the set.
//
// `capability_key` is a KEY not an FK (the `ai_capability` posture): the template is authored against a
// capability key before the capability row necessarily exists in a given environment.
import { sql } from "drizzle-orm";
import {
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
import { aiPromptTemplateStatus } from "../../enums";

export const aiPromptTemplate = pgTable(
  "ai_prompt_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'hearthnote_enhancement_v1'. Uniqueness is the named index below. */
    templateKey: text("template_key").notNull(),
    /** FK-LIKE → `ai_capability.capability_key` (see header). */
    capabilityKey: text("capability_key").notNull(),
    version: integer("version").notNull(),

    /** Repo path of the reviewed prompt file + the SHA-256 that pins it (see header). */
    templateFilesystemRef: text("template_filesystem_ref").notNull(),
    templateContentHash: text("template_content_hash").notNull(),

    /** string[] — the backends this template is known to behave on. */
    compatibleBackendKeys: jsonb("compatible_backend_keys").notNull(),
    inputSchemaRef: text("input_schema_ref").notNull(),
    outputSchemaRef: text("output_schema_ref").notNull(),

    /** D18 prohibited-zone key — `getActivePromptsTargeting()`. Open vocabulary (see header). */
    outputEntityTargetPrefix: text("output_entity_target_prefix").notNull(),
    /** `getActivePromptsWithOutputType()`. Open vocabulary. */
    outputTypePrefix: text("output_type_prefix").notNull(),

    status: aiPromptTemplateStatus("status").notNull().default("active"),

    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    /** The reviewer's own attestation text. §3.4-denylisted out of the audit capture. */
    clinicalReviewerAttestation: text("clinical_reviewer_attestation"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    templateKeyIdx: uniqueIndex("ai_prompt_template_key_idx").on(t.templateKey),
    capabilityVersionIdx: uniqueIndex("ai_prompt_template_cap_version_idx").on(
      t.capabilityKey,
      t.version,
    ),
    activeIdx: index("ai_prompt_template_active_idx")
      .on(t.capabilityKey, t.status)
      .where(sql`status = 'active'`),
    // The two D18 boot-validator lookups. Partial on `active` because a prohibited-zone question is
    // only ever about what can RUN — an archived template targeting the zone is history, not a breach.
    targetingIdx: index("ai_prompt_template_targeting_idx")
      .on(t.outputEntityTargetPrefix, t.status)
      .where(sql`status = 'active'`),
    outputTypeIdx: index("ai_prompt_template_output_type_idx")
      .on(t.outputTypePrefix, t.status)
      .where(sql`status = 'active'`),

    contentHashCheck: check(
      "ai_prompt_template_content_hash_check",
      sql`length(template_content_hash) = 64`,
    ),
  }),
);

export type AiPromptTemplateRow = typeof aiPromptTemplate.$inferSelect;
export type NewAiPromptTemplateRow = typeof aiPromptTemplate.$inferInsert;
