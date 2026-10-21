// M36 WP 3.3 - a tenant's tighten-only SBAR policy: longer minimums, a patient-channel requirement, re-worded hints.
// The CHECK bounds mirror SBAR_PLATFORM_FLOOR (1) and the 500 ceiling in @chartwarden/types (pinned by a test).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";

const minChars = (name: string) => integer(name).notNull().default(1);

export const tenantSbarPolicies = pgTable(
  "tenant_sbar_policy",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    situationMinChars: minChars("situation_min_chars"),
    backgroundMinChars: minChars("background_min_chars"),
    assessmentMinChars: minChars("assessment_min_chars"),
    recommendationMinChars: minChars("recommendation_min_chars"),
    requirePatientChannel: boolean("require_patient_channel").notNull().default(false),
    situationHint: text("situation_hint"),
    backgroundHint: text("background_hint"),
    assessmentHint: text("assessment_hint"),
    recommendationHint: text("recommendation_hint"),
    configuredByUserId: uuid("configured_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    configuredByIdx: index("tenant_sbar_policy_configured_by_idx").on(t.configuredByUserId),
    situationMin: check(
      "tenant_sbar_policy_situation_min",
      sql`${t.situationMinChars} BETWEEN 1 AND 500`,
    ),
    backgroundMin: check(
      "tenant_sbar_policy_background_min",
      sql`${t.backgroundMinChars} BETWEEN 1 AND 500`,
    ),
    assessmentMin: check(
      "tenant_sbar_policy_assessment_min",
      sql`${t.assessmentMinChars} BETWEEN 1 AND 500`,
    ),
    recommendationMin: check(
      "tenant_sbar_policy_recommendation_min",
      sql`${t.recommendationMinChars} BETWEEN 1 AND 500`,
    ),
  }),
);

export type TenantSbarPolicyRow = typeof tenantSbarPolicies.$inferSelect;
