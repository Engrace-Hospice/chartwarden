// @wardenx/db — `triage_protocol_question` (M19 §3.3). One row per question of a protocol's ordered
// question set. D5 lives here: `red_flag_match` is the SERVER-side predicate the answer is evaluated
// against — the client never asserts a red flag, it answers a question and the server decides.
//
// DEVIATION FROM §3.3 (documented, and the same one M21's `comfort_kit_template_medication` carries):
// §3.3 gives this table no tenancy column at all and §3.5 scopes it "inherits readability from its parent
// protocol". ADR-0010 D2 requires a row's OWN visibility to key on app.org_id — an EXISTS-subquery policy
// makes tenancy a JOIN, so a mis-scoped parent silently widens the child, and the predicate runs per row
// on every catalog read. `organization_id` and the floor discriminator are therefore denormalized here
// with the same CHECK pair the parent carries, making the policy a flat predicate. Parent/child agreement
// is a write-boundary invariant (a CHECK cannot reach the parent row); the CHECK pair makes the dangerous
// half — an org-less TENANT question, readable by every other tenant — impossible.
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
import { triageProtocolAnswerType } from "../../enums";
import { organizations } from "../organizations";
import { triageProtocol } from "./triage-protocols";

export const triageProtocolQuestion = pgTable(
  "triage_protocol_question",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    triageProtocolId: uuid("triage_protocol_id")
      .notNull()
      .references(() => triageProtocol.id, { onDelete: "restrict" }),
    /** Denormalized from the parent; NULL ⇔ platform-floor row (see the CHECK pair). */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),

    questionOrder: integer("question_order").notNull(),
    prompt: text("prompt").notNull(),
    answerType: triageProtocolAnswerType("answer_type").notNull(),
    /** Only for `answer_type = 'enum'` — see the bidirectional CHECK. */
    answerEnumValues: jsonb("answer_enum_values"),
    required: boolean("required").notNull().default(false),

    /** D5 — a red-flag question's answer forces an escalation row in the same transaction. */
    isRedFlagQuestion: boolean("is_red_flag_question").notNull().default(false),
    /** The server-evaluated match predicate; never a client-supplied flag. */
    redFlagMatch: jsonb("red_flag_match"),

    /** TRUE ⇔ platform-floor row (see the CHECK pair). */
    isSystemLocked: boolean("is_system_locked").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderUq: uniqueIndex("triage_protocol_question_order_uq").on(
      t.triageProtocolId,
      t.questionOrder,
    ),
    byProtocolIdx: index("triage_protocol_question_protocol_idx").on(
      t.triageProtocolId,
      t.questionOrder,
    ),
    // D5 — a red-flag question with no match predicate can never fire, which is a silently disabled
    // mandatory escalation.
    redFlagIntegrity: check(
      "m19_triage_protocol_question_red_flag",
      sql`"is_red_flag_question" = false OR "red_flag_match" IS NOT NULL`,
    ),
    // Bidirectional on purpose: an `enum` question with no value list cannot be rendered, and a boolean
    // question carrying a value list means two sources disagree about what may be answered.
    enumValuesPair: check(
      "m19_triage_protocol_question_enum_values",
      sql`("answer_type" = 'enum') = ("answer_enum_values" IS NOT NULL)`,
    ),
    floorIsOrgless: check(
      "m19_triage_protocol_question_floor_orgless",
      sql`"is_system_locked" = false OR "organization_id" IS NULL`,
    ),
    tenantHasOrg: check(
      "m19_triage_protocol_question_tenant_has_org",
      sql`"is_system_locked" = true OR "organization_id" IS NOT NULL`,
    ),
  }),
);

export type TriageProtocolQuestionRow = typeof triageProtocolQuestion.$inferSelect;
export type NewTriageProtocolQuestionRow = typeof triageProtocolQuestion.$inferInsert;
