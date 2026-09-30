// unmapped_taxonomy_occurrence — M23's §11.A D13 unmapped-CARC occurrence tracker (the m23
// `handlers-unbound` group's last remaining pair, #248 — `m25.taxonomy.unmapped_code_observed`).
// M25's D13 spec text: "the first occurrence of a CARC not present in
// M38's catalog … generates `m25.taxonomy.unmapped_code_observed` outbox to M23 (suggesting a new
// pre-submission validation rule per architecture §11.A) … M23 §11.A subscribes to this event; if
// `occurrenceCount` exceeds 50 within 30 days, M23 surfaces an `unmapped_taxonomy_alert` to the
// platform-admin queue (D13)." No table, route, or consumer anywhere in M23 ever existed for this — the
// prior six/seven `m23` `handlers-unbound` events all reuse the already-running `revalidate.consumer`
// BullMQ worker (`m23-revalidate-triggers.ts`'s own header: "that path re-validates EXISTING claims;
// this is a raw observation with no claim to revalidate yet"), so this event genuinely needs its own,
// smaller mechanism rather than a seventh trigger onto that queue.
//
// ONE ROW PER DELIVERED OCCURRENCE (not a maintained rolling counter): the `measure_recompute_queue` /
// `dosespot_sync_queue` precedent for a THRESHOLD/debounce concern is a maintained state row, but here
// the thing being counted (a rolling 30-day occurrence total per (org, CARC code)) needs its own history
// to age individual occurrences OUT of the window as time passes — a single counter row cannot express
// "this occurrence is now more than 30 days old, so it no longer counts." A plain per-row INSERT plus a
// windowed `COUNT(*) WHERE observed_at >= now() - interval '30 days'` at read time is the simplest
// mechanism that is actually correct for a ROLLING window (never a maintained counter that would need
// its own decrement-on-expiry job this codebase has no precedent for).
//
// IDEMPOTENCY: a unique index on (organization_id, source_event_id) — the delivered outbox event's own
// id — is the idempotency key (the `remittance_adjustment.taxonomy_status`-adjacent
// `denial_case_source_idempotency_key` / migration 0249 precedent), never a pre-read. A redelivery of
// the same `m25.taxonomy.unmapped_code_observed` event inserts nothing a second time and therefore
// cannot double-count toward the 30-day threshold.
//
// `provider_entity_id` (M40) and `denial_case_id` (M25) are PLAIN uuid with NO cross-module FK — the
// `dosespot_sync_queue.patient_id` / `medication_order.patient_id` precedent ("M5 (app-validated; no
// cross-module FK)") applied to this table's two cross-module facts. `carc_code`/`rarc_code` are the
// X12 CAS-segment reason/remark codes verbatim off the wire (never validated against M38's catalog here
// — the whole POINT of this table is that the code is NOT in M38's catalog).
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const unmappedTaxonomyOccurrence = pgTable(
  "unmapped_taxonomy_occurrence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    carcCode: text("carc_code").notNull(),
    rarcCode: text("rarc_code"),
    providerEntityId: uuid("provider_entity_id").notNull(), // M40 (app-validated; no cross-module FK)
    denialCaseId: uuid("denial_case_id").notNull(), // M25 (app-validated; no cross-module FK)

    // The delivered `m25.taxonomy.unmapped_code_observed` outbox event's own id — the idempotency key.
    sourceEventId: uuid("source_event_id").notNull(),

    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency: a redelivery of the same outbox event inserts nothing a second time.
    uniqSourceEvent: uniqueIndex("unmapped_taxonomy_occurrence_source_event_uq").on(
      t.organizationId,
      t.sourceEventId,
    ),
    // The windowed-COUNT read path's index: "how many times has this org seen this CARC in the last
    // 30 days".
    windowScanIdx: index("unmapped_taxonomy_occurrence_org_carc_observed_idx").on(
      t.organizationId,
      t.carcCode,
      t.observedAt,
    ),
  }),
);

export type UnmappedTaxonomyOccurrence = typeof unmappedTaxonomyOccurrence.$inferSelect;
export type NewUnmappedTaxonomyOccurrence = typeof unmappedTaxonomyOccurrence.$inferInsert;
