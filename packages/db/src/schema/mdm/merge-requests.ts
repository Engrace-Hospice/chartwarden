// @wardenx/db — `merge_request` (M40 MDM §3.5). The dedup workflow record: a proposal that
// `duplicate_id` is the same real-world entity as `canonical_id` (kind-switched FK app-side),
// with `evidence` (npiMatch/nameScore/addressScore/…) and a §2.4.2 lifecycle (pending →
// approved → executed | rejected). On `executed` the duplicate flips to `merged` and FK
// re-pointing is enqueued (§7.6). The partial unique index forbids a second open proposal for
// the same pair. Operates on canonical (org-less) entities → org-less itself (NON_ORG_SCOPED
// allowlist). RLS/audit triggers land in M40-T03 (§3.6). Not PHI.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mdmMergeProposer, mdmMergeStatus, mdmEntityKind } from "../../enums";
import { users } from "../users";

export const mergeRequests = pgTable(
  "merge_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityKind: mdmEntityKind("entity_kind").notNull(),
    canonicalId: uuid("canonical_id").notNull(), // kind-switched FK app-side
    duplicateId: uuid("duplicate_id").notNull(),
    proposedBy: mdmMergeProposer("proposed_by").notNull(),
    evidence: jsonb("evidence").notNull(), // {npiMatch?, nameScore?, addressScore?, ...}
    status: mdmMergeStatus("status").notNull().default("pending"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("merge_request_status_idx").on(t.status),
    pairIdx: uniqueIndex("merge_request_unique_pair")
      .on(t.entityKind, t.canonicalId, t.duplicateId)
      .where(sql`status IN ('pending','approved')`),
    notSelf: check("merge_request_not_self", sql`canonical_id <> duplicate_id`),
  }),
);

export type MergeRequest = typeof mergeRequests.$inferSelect;
export type NewMergeRequest = typeof mergeRequests.$inferInsert;
