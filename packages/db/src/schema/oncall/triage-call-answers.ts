// @chartwarden/db — `triage_call_answer` (M19 §3.3 / §2.2.3). APPEND-ONLY: one row per answered protocol
// question. A correction is a NEW row carrying `correction_of_answer_id` (the M9 D9 / M5 §164.526
// correction-of-record pattern) — the original is never overwritten, which is what lets a surveyor see
// that an answer changed and when.
//
// D5 — `red_flag_hit` is computed SERVER-SIDE in `record-answer.ts` by evaluating the question's
// `red_flag_match` against the typed value columns. It is deliberately NOT in the §3.6 audit denylist:
// it is the tamper-evidence a mandatory-escalation-suppression investigation reads, and scrubbing it
// would erase the only record that the server did evaluate the flag.
//
// §3.6 DENYLIST READ: `answer_value_text` is denylisted UNCONDITIONALLY, where §3.6 qualifies it "when
// the parent question has answer_type='free_text'". A write-audit trigger fires on THIS row and has no
// cheap, non-racing way to read the parent question mid-write, and the conditional would fail OPEN —
// capturing free-text cleartext whenever the lookup could not be resolved. The typed enum/boolean/integer
// answers stay fully reconstructible from `answer_value_int` / `answer_value_bool`, neither denylisted.
// (Recorded in `M19_AUDIT_DENYLIST`, @chartwarden/types, at M19-T01.)
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable — denormalized from the
// call so the row's OWN visibility is a flat app.org_id predicate (ADR-0010 D2), never a join.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { triageCall } from "./triage-calls";
import { triageProtocolQuestion } from "./triage-protocol-questions";

export const triageCallAnswer = pgTable(
  "triage_call_answer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    triageCallId: uuid("triage_call_id")
      .notNull()
      .references(() => triageCall.id, { onDelete: "restrict" }),
    triageProtocolQuestionId: uuid("triage_protocol_question_id")
      .notNull()
      .references(() => triageProtocolQuestion.id, { onDelete: "restrict" }),
    /** Self-FK — this row corrects an earlier answer (§2.2.3 amend-by-append). */
    correctionOfAnswerId: uuid("correction_of_answer_id"),

    /** DENYLISTED (§3.6) — see the header. */
    answerValueText: text("answer_value_text"),
    answerValueInt: integer("answer_value_int"),
    answerValueBool: boolean("answer_value_bool"),

    /** D5 — server-computed; never accepted from the client. */
    redFlagHit: boolean("red_flag_hit").notNull().default(false),

    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    answeredByMembershipId: uuid("answered_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCallIdx: index("triage_call_answer_call_idx").on(t.triageCallId, t.answeredAt),
    correctionIdx: index("triage_call_answer_correction_idx")
      .on(t.correctionOfAnswerId)
      .where(sql`correction_of_answer_id IS NOT NULL`),
    // One ORIGINAL answer per question per call; corrections are additional rows and are excluded.
    perQuestionOriginalUq: uniqueIndex("triage_call_answer_latest_per_q_uq")
      .on(t.triageCallId, t.triageProtocolQuestionId)
      .where(sql`correction_of_answer_id IS NULL`),

    // Exactly one typed value. An all-NULL answer row would satisfy §2.3's "every required question has an
    // answer row" while answering nothing — the cheapest way to walk a red-flag question past
    // `completeProtocol`. "Unable to answer" is a recorded value (text or an enum member), not an absence.
    exactlyOneValue: check(
      "m19_triage_call_answer_one_value",
      sql`num_nonnulls("answer_value_text", "answer_value_int", "answer_value_bool") = 1`,
    ),
    correctionIsNotSelf: check(
      "m19_triage_call_answer_correction_self",
      sql`"correction_of_answer_id" IS NULL OR "correction_of_answer_id" <> "id"`,
    ),
  }),
);

export type TriageCallAnswerRow = typeof triageCallAnswer.$inferSelect;
export type NewTriageCallAnswerRow = typeof triageCallAnswer.$inferInsert;
