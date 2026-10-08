// @wardenx/db — `external_feed_health` (M29 §3.3). The rolling per-hour rollup the §4.11.5 listener-down
// detector (D17) and the operator health dashboard read.
//
// TENANT-SCOPED, UNPARTITIONED: `organization_id` NOT NULL with a REAL FK to `organization`, canonical
// app.org_id RLS (§3.5). Composite primary key `(feed_id, hour_bucket)` — one row per feed per hour — so it
// has NO synthetic `id` column; the M1 baseline audit trigger records a NULL resource_id for it, which is
// the honest answer (the (feed_id, hour_bucket) pair is the identity). Operational metric counts only (no
// PHI, empty §3.6 denylist) so it audits through the baseline `wardenx_audit_trigger()`; the ROW ages at 90
// days (§3.7) while its audit trail files `compliance` — retention of the row vs. its audit event are
// distinct. `feed_id` carries a REAL intra-M29 FK to `external_feed`.
import { bigint, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { externalFeed } from "./feed";

export const externalFeedHealth = pgTable(
  "external_feed_health",
  {
    feedId: uuid("feed_id")
      .notNull()
      .references(() => externalFeed.id, { onDelete: "cascade" }),
    hourBucket: timestamp("hour_bucket", { withTimezone: true }).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    listenerUpSeconds: integer("listener_up_seconds").notNull().default(0),
    listenerDownSeconds: integer("listener_down_seconds").notNull().default(0),
    inboundMessageCount: integer("inbound_message_count").notNull().default(0),
    outboundMessageCount: integer("outbound_message_count").notNull().default(0),
    ackAaCount: integer("ack_aa_count").notNull().default(0),
    ackAeCount: integer("ack_ae_count").notNull().default(0),
    ackArCount: integer("ack_ar_count").notNull().default(0),
    ackTimeoutCount: integer("ack_timeout_count").notNull().default(0),
    inboundBytes: bigint("inbound_bytes", { mode: "number" }).notNull().default(0),
    outboundBytes: bigint("outbound_bytes", { mode: "number" }).notNull().default(0),
    parseErrorCount: integer("parse_error_count").notNull().default(0),
    senderRejectedCount: integer("sender_rejected_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** §4.11.5 breaker state at the last health tick (`closed` | `open` | `half_open`; migration 0700). */
    listenerCircuitState: text("listener_circuit_state").notNull().default("closed"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.feedId, t.hourBucket] }),
  }),
);

export type ExternalFeedHealthRow = typeof externalFeedHealth.$inferSelect;
export type NewExternalFeedHealthRow = typeof externalFeedHealth.$inferInsert;
