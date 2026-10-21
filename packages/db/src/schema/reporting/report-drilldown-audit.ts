// @chartwarden/db — `report_drilldown_audit` (M33 §3.3). The insert-only audit trail of drilldown
// navigations from a tile into an owner-module surface: actor, source tile, target module/surface,
// the envelope-encrypted filter context (may carry patient identifiers under the per-tenant DEK),
// the cross-module trace id, and the consent-narrowing posture. ORG-SCOPED: carries organization_id
// NOT NULL → standard app.org_id RLS; insert-only, no UPDATE/DELETE even with org_admin, and M4
// treats it as destruction_blocked (retention class `compliance`, §3.5/§3.7). PARTITION BY RANGE
// (accessed_at) monthly: the Drizzle definition here is the LOGICAL shape — composite PK
// (id, accessed_at) including the partition key (check-ddl-legality Rule 1); the PARTITION BY +
// monthly children + DEFAULT catch-all land in the M33 RLS migration (the EVV `0047` precedent).
// `query_filters_cipher` is DENYLISTED in the M4 write-audit trigger (§3.6 — emit <changed> marker
// only, never plaintext). All cross-module refs (actor membership, report_view) are plain uuid
// app-validated. RLS + grants + the (denylisted) M4 write-audit trigger also land in that migration.
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const reportDrilldownAudit = pgTable(
  "report_drilldown_audit",
  {
    id: uuid("id").notNull(), // composite PK with accessed_at (the partition key)
    organizationId: uuid("organization_id").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    reportViewId: uuid("report_view_id"), // nullable for ad-hoc drilldown
    sourceTileKey: text("source_tile_key").notNull(), // identifies the originating tile
    drilldownTargetModule: integer("drilldown_target_module").notNull(), // e.g., 8 for M8 late-entry register
    drilldownTargetSurface: text("drilldown_target_surface").notNull(),
    queryFiltersCipher: text("query_filters_cipher").notNull(), // envelope-encrypted filter context; DENYLISTED (§3.6)
    drilldownTraceId: uuid("drilldown_trace_id").notNull(), // join key to downstream owner-module audit
    isConsentNarrowed: boolean("is_consent_narrowed").notNull().default(false),
    consentNarrowingReason: text("consent_narrowing_reason"), // populated when isConsentNarrowed=true
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.accessedAt] }), // partition key must be in the PK
    // §3.4: per-partition (actor_membership_id, accessed_at desc).
    actorAccessed: index("report_drilldown_audit_actor_accessed_idx").on(
      t.actorMembershipId,
      t.accessedAt,
    ),
    // §3.4: per-partition (organization_id, drilldown_target_module, accessed_at desc).
    orgModuleAccessed: index("report_drilldown_audit_org_module_accessed_idx").on(
      t.organizationId,
      t.drilldownTargetModule,
      t.accessedAt,
    ),
    // §3.4: (drilldown_trace_id) UNIQUE for the cross-module-audit join — declared plain here,
    // re-added as per-LEAF UNIQUE in the migration (the EVV per-leaf precedent).
    traceId: index("report_drilldown_audit_trace_id_idx").on(t.drilldownTraceId),
  }),
);

export type ReportDrilldownAudit = typeof reportDrilldownAudit.$inferSelect;
export type NewReportDrilldownAudit = typeof reportDrilldownAudit.$inferInsert;
