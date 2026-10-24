// @chartwarden/db - M25 milestone 9a-1 (migration 1250): the denial-reason PLAYBOOK library. denial_playbook (the key: code
// kind + code + optional MAC; immutable), denial_playbook_version (draft -> published -> retired; content frozen once
// published; a published row carries a reviewer who is not its author) and denial_playbook_case_step (an advisory per-denial
// tick, no free text). NOTHING is seeded: a fresh tenant has zero rows. States are text + CHECK (closed sets mirrored in
// domain/playbook.ts), so there is no new pgEnum. source_document_id is a LOGICAL FK to an M22 document. The version's
// summary, steps and source note are audit-scrubbed free text.
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { denialCase } from "./denial";

export const denialPlaybook = pgTable(
  "denial_playbook",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    macName: text("mac_name"), // null = every MAC
    codeKind: text("code_kind").notNull(), // mac_reason | rarc | carc (CHECK)
    code: varchar("code", { length: 16 }).notNull(),
    title: text("title").notNull(), // denylisted
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("denial_playbook_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export interface PlaybookStepJson {
  readonly key: string;
  readonly text: string;
}

export const denialPlaybookVersion = pgTable(
  "denial_playbook_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    playbookId: uuid("playbook_id")
      .notNull()
      .references(() => denialPlaybook.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    status: text("status").notNull().default("draft"), // draft | published | retired (CHECK)
    summary: text("summary").notNull(), // denylisted
    steps: jsonb("steps").$type<PlaybookStepJson[]>().notNull(), // denylisted
    sourceNote: text("source_note").notNull(), // denylisted
    sourceDocumentId: uuid("source_document_id"), // logical FK -> M22 document
    authoredByMembershipId: uuid("authored_by_membership_id").notNull(),
    lastEditedByMembershipId: uuid("last_edited_by_membership_id").notNull(),
    reviewedByMembershipId: uuid("reviewed_by_membership_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    effectiveFrom: date("effective_from"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("denial_playbook_version_org_ix").on(t.organizationId, t.createdAt),
    byNo: uniqueIndex("denial_playbook_version_no_key").on(t.playbookId, t.versionNo),
  }),
);

export const denialPlaybookCaseStep = pgTable(
  "denial_playbook_case_step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    denialCaseId: uuid("denial_case_id")
      .notNull()
      .references(() => denialCase.id, { onDelete: "restrict" }),
    playbookVersionId: uuid("playbook_version_id")
      .notNull()
      .references(() => denialPlaybookVersion.id, { onDelete: "restrict" }),
    stepKey: text("step_key").notNull(),
    status: text("status").notNull(), // open | done | not_applicable (CHECK)
    markedByMembershipId: uuid("marked_by_membership_id").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byVersion: index("denial_playbook_case_step_version_ix").on(t.playbookVersionId),
    byOrg: index("denial_playbook_case_step_org_ix").on(t.organizationId, t.markedAt),
    byKey: uniqueIndex("denial_playbook_case_step_key").on(
      t.denialCaseId,
      t.playbookVersionId,
      t.stepKey,
    ),
  }),
);
