import { sql } from "drizzle-orm";
// @chartwarden/db - `message_template` and `tenant_message_template_overlay` (M36 WP 2.8, migration 1086).
//
// One table, three scopes: 'platform' (organization_id NULL, seeded, carries the required phrases that form the floor),
// 'org' (a tenant-authored shared template) and 'personal' (one user's saved reply). A CHECK pins the columns each scope
// may set. The overlay re-words or disables a PLATFORM template for one tenant; its composite FK
// (target_scope = 'platform', template_id) -> message_template(scope, id) cannot point at anything else. Plain text, no
// merge fields, no PHI by policy (a deterministic lint on save; see packages/messaging templates/phi-lint.ts).
import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";

export const MESSAGE_TEMPLATE_SCOPES = ["platform", "org", "personal"] as const;
export type MessageTemplateScope = (typeof MESSAGE_TEMPLATE_SCOPES)[number];

/** Non-clinical categories only; a clinical handoff category (SBAR) is Phase 3. Mirrors the migration CHECK. */
export const MESSAGE_TEMPLATE_CATEGORIES = [
  "scheduling",
  "administrative",
  "logistics",
  "confirmation",
  "general",
] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];

export const messageTemplates = pgTable(
  "message_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }), // null only on the platform scope
    scope: text("scope").$type<MessageTemplateScope>().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    templateKey: text("template_key"),
    category: text("category").$type<MessageTemplateCategory>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    requiredPhrases: text("required_phrases").array().notNull().default(sql`'{}'::text[]`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdUnique: unique("message_template_scope_id_unique").on(t.scope, t.id),
    platformKeyUk: uniqueIndex("message_template_platform_key_uk")
      .on(t.templateKey)
      .where(sql`${t.scope} = 'platform'`),
    orgTitleUk: uniqueIndex("message_template_org_title_uk")
      .on(t.organizationId, sql`lower(${t.title})`)
      .where(sql`${t.scope} = 'org'`),
    personalTitleUk: uniqueIndex("message_template_personal_title_uk")
      .on(t.organizationId, t.ownerUserId, sql`lower(${t.title})`)
      .where(sql`${t.scope} = 'personal'`),
    orgScopeIdx: index("message_template_org_scope_idx").on(t.organizationId, t.scope),
    ownerIdx: index("message_template_owner_idx")
      .on(t.ownerUserId)
      .where(sql`${t.ownerUserId} IS NOT NULL`),
    createdByIdx: index("message_template_created_by_idx")
      .on(t.createdByUserId)
      .where(sql`${t.createdByUserId} IS NOT NULL`),
  }),
);

export const tenantMessageTemplateOverlays = pgTable(
  "tenant_message_template_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    targetScope: text("target_scope").$type<"platform">().notNull().default("platform"),
    templateId: uuid("template_id").notNull(),
    title: text("title"), // null = keep the platform title
    body: text("body"), // null = keep the platform body
    isEnabled: boolean("is_enabled").notNull().default(true),
    configuredByUserId: uuid("configured_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    templateFk: foreignKey({
      name: "tenant_message_template_overlay_template_fk",
      columns: [t.targetScope, t.templateId],
      foreignColumns: [messageTemplates.scope, messageTemplates.id],
    }).onDelete("cascade"),
    orgTemplateUnique: unique("tenant_message_template_overlay_org_template_unique").on(
      t.organizationId,
      t.templateId,
    ),
    templateIdx: index("tenant_message_template_overlay_template_idx").on(
      t.targetScope,
      t.templateId,
    ),
    configuredByIdx: index("tenant_message_template_overlay_configured_by_idx").on(
      t.configuredByUserId,
    ),
  }),
);

export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type NewMessageTemplateRow = typeof messageTemplates.$inferInsert;
export type TenantMessageTemplateOverlayRow = typeof tenantMessageTemplateOverlays.$inferSelect;
export type NewTenantMessageTemplateOverlayRow = typeof tenantMessageTemplateOverlays.$inferInsert;
