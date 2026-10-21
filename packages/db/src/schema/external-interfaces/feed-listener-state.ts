// @chartwarden/db - `external_feed_listener_state` (M29 §4.11.5, GAP-043; migration 1052). One row per feed.
//
// The LISTENER process writes `listenerHeartbeatAt` / `listenerBound` every tick (facts); the WATCHER (worker role)
// writes `circuitState` / `outageOpenedAt` / `lastEvaluatedAt` (decisions) in the same transaction as the outbox event
// it publishes. Disjoint columns, so neither overwrites the other. Per-feed rather than per-hour because the
// `external_feed_health` key is (feed_id, hour_bucket) and a state kept there would vanish at every hour rollover.
// Tenant-scoped, RLS keyed on app.org_id; no PHI.
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { externalFeed } from "./feed";

export const externalFeedListenerState = pgTable(
  "external_feed_listener_state",
  {
    feedId: uuid("feed_id")
      .primaryKey()
      .references(() => externalFeed.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Last tick at which the listener process reported on this feed; stale => the listener is not running. */
    listenerHeartbeatAt: timestamp("listener_heartbeat_at", { withTimezone: true }),
    /** Whether the listener process had this feed's server bound at that tick. */
    listenerBound: boolean("listener_bound").notNull().default(false),
    /** §4.11.5 breaker state as last decided by the watcher (`closed` | `open` | `half_open`). */
    circuitState: text("circuit_state").notNull().default("closed"),
    /** When the current outage was opened (set on `open`, cleared on `closed`): the page's correlation key. */
    outageOpenedAt: timestamp("outage_opened_at", { withTimezone: true }),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("idx_external_feed_listener_state_org").on(t.organizationId),
  }),
);

export type ExternalFeedListenerState = typeof externalFeedListenerState.$inferSelect;
export type NewExternalFeedListenerState = typeof externalFeedListenerState.$inferInsert;
