import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/33-reporting/events-by-m33.ts — Module 33's outbox-event contributions
// (spec §4.10 Outbox Event Catalog). The full `m33.*` taxonomy keyed on M33's own resources, under the
// `m33.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this
// file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m33'), and valid declared consumers
// (real module ids); the canonical wire `eventName`s here ALL carry the `m33.` prefix the event-catalog
// gate enforces.
//
// M33 is OUTBOX-ONLY across module boundaries (D6 — aggregate-by-default; the dependency-cruiser blocks
// any direct import of M33 internals from M30/M34/M37). Several events are `m33`-self subscribers
// (cache invalidation / audit flush / counters) re-handled inside M33's own consumers; the cross-module
// fan-outs target M36 (alerts, §4.9), M22 (PDF/XLSX render handshake), M1 (system_status), and M4
// (destruction cert). Each entry adds the TypeBox `payloadSchema` + declared consumers the dispatcher
// validates each publish against, so "DB updated but the event never went out" is closed in the same
// transaction as the mutation (M1 §25.5/§25.6). The matching M36 alert payloads ship in
// packages/reporting/src/alerts.ts (§4.9).
import { Type } from "@sinclair/typebox";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);

export const M33_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── report-definition authoring (§4.10) ────────────────────────────────────────────────────────
  {
    eventName: "m33.report_definition.published",
    moduleOwner: "m33",
    description:
      "A draft report-definition version was published (publish route); M33 re-caches the definition's latest-version pointer (self-subscriber).",
    payloadSchema: Type.Object({
      definitionId: id,
      versionId: id,
      baseKey: id,
      organizationId: id,
      publishedByMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── saved-view sharing (§4.10) ─────────────────────────────────────────────────────────────────
  {
    eventName: "m33.report_view.shared_org",
    moduleOwner: "m33",
    description:
      "A saved view's share scope was toggled to `org` (share route); M36 raises the §4.9 `viewSharedOrg` in-app notification.",
    payloadSchema: Type.Object({
      viewId: id,
      viewName: Type.String(),
      sharedByMembershipId: id,
      organizationId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── scheduled reports (§4.10) ──────────────────────────────────────────────────────────────────
  {
    eventName: "m33.report_schedule.created",
    moduleOwner: "m33",
    description:
      "A scheduled report was created (create route); M36 routes the §4.9 info notice to the owner.",
    payloadSchema: Type.Object({
      scheduleId: id,
      viewId: id,
      ownerMembershipId: id,
      cronExpression: id,
      recipientCount: Type.Integer({ minimum: 0 }),
      organizationId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m33.scheduled_report.render_requested",
    moduleOwner: "m33",
    description:
      'A PDF/XLSX render was requested; M22 renders the snapshot and wires the document back (the §1.1 render handshake). Carries the idempotency key for at-most-once render. TWO producers share this wire name: the scheduled-run cron path (carries scheduleId+runId, aggregateType `report_schedule_run`) and the ad-hoc "export now" route path (carries exportId instead, aggregateType `report_export`) — scheduleId/runId are Optional so both validate; a consumer must not assume either is present, and `aggregateType` is the discriminator M22 resolves the template key from. The MATERIALIZED snapshot travels with the request (columns/rows/rowCount): M22 renders content, it does not execute `snapshotQuery`, which rides along only as provenance.',
    payloadSchema: Type.Object({
      scheduleId: Type.Optional(id),
      runId: Type.Optional(id),
      /** Present on the ad-hoc "export now" path (= `aggregateId`); absent on the scheduled path. */
      exportId: Type.Optional(id),
      viewId: id,
      format: Type.Union([Type.Literal("pdf"), Type.Literal("xlsx"), Type.Literal("csv")]),
      organizationId: id,
      /** PROVENANCE only — the executed SELECT. Its `$1, $2, …` markers have no params channel by design
       *  (D4), and M22 has no reporting database; the rows below are what gets rendered. */
      snapshotQuery: Type.String(),
      idempotencyKey: id,
      /** Which producer emitted — and therefore which M22 template / `document_aggregate_type` applies. */
      aggregateType: Type.Union([
        Type.Literal("report_export"),
        Type.Literal("report_schedule_run"),
      ]),
      /** The rendered document's title (the saved view's display name). */
      title: Type.String(),
      /** The materialized snapshot. Aggregate-only (D6 — no row-level PHI) and bounded by the view's own
       *  `row_limit`, compiled into the SELECT by `translateSpec`, plus the §4.8 PDF cap on that path. */
      columns: Type.Array(
        Type.Object({
          /** The output alias each row object is keyed by (a tenant alias if the spec supplied one). */
          key: id,
          /** The catalog key it derives from — stable across tenant aliasing. The translator emits no
           *  display text, so there is deliberately no `label`: a fabricated one would print on a real
           *  report as though it were the tenant's own. */
          sourceKey: id,
          kind: Type.Union([Type.Literal("dimension"), Type.Literal("measure")]),
          unit: Type.Optional(Type.String()),
        }),
      ),
      rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
      rowCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m33.scheduled_report.delivered",
    moduleOwner: "m33",
    description:
      "A scheduled report finished rendering and was fanned out to its recipients; M36 raises the §4.9 `scheduledReportDelivered` info alert.",
    payloadSchema: Type.Object({
      scheduleId: id,
      runId: id,
      documentId: id,
      recipientCount: Type.Integer({ minimum: 0 }),
      organizationId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m33.scheduled_report.failed",
    moduleOwner: "m33",
    description:
      "A scheduled-report run failed (render or fan-out); M36 raises the §4.9 `scheduledReportFailed` warn alert.",
    payloadSchema: Type.Object({
      scheduleId: id,
      runId: id,
      organizationId: id,
      reason: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── materialized-view refresh (§4.10) ──────────────────────────────────────────────────────────
  {
    eventName: "m33.mv.refresh_succeeded",
    moduleOwner: "m33",
    description:
      "An MV-refresh worker refreshed a `report_mv` materialized view; M33 invalidates the dependent tile cache (self-subscriber). `organizationId` is null for cross-tenant platform-wide refreshes. `rowsAffected` is null: `REFRESH MATERIALIZED VIEW CONCURRENTLY` reports no row count (the executor's own return type says so — this schema required a non-null integer before this event was ever actually emitted, which Value.Check would have rejected on the very first real refresh).",
    payloadSchema: Type.Object({
      mvKey: id,
      organizationId: nullableId,
      durationMs: Type.Integer({ minimum: 0 }),
      rowsAffected: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      refreshedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m33.mv.refresh_failed",
    moduleOwner: "m33",
    description:
      "An MV-refresh worker failed; M36 raises the §4.9 `mvRefreshFailed` (warn) or `mvRefreshExhausted` (critical) admin alert per attempt count.",
    payloadSchema: Type.Object({
      mvKey: id,
      organizationId: nullableId,
      attempts: Type.Integer({ minimum: 1 }),
      reason: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── replica-lag probe (§4.10) ──────────────────────────────────────────────────────────────────
  {
    eventName: "m33.lag.exceeded",
    moduleOwner: "m33",
    description:
      "The replica-lag probe sampled lag above the freshness threshold; M36 raises the §4.9 `replicaLagExceeded` admin warn, M1 records the degraded `system_status`.",
    payloadSchema: Type.Object({
      lagSeconds: Type.Number({ minimum: 0 }),
      threshold: Type.Number({ minimum: 0 }),
      sampledAt: isoInstant,
    }),
    declaredConsumers: ["m1"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m33.lag.recovered",
    moduleOwner: "m33",
    description:
      "The replica-lag probe sampled lag back below threshold; M36 raises the §4.9 `replicaLagRecovered` info, M1 clears the degraded `system_status`.",
    payloadSchema: Type.Object({
      lagSeconds: Type.Number({ minimum: 0 }),
      durationDownSeconds: Type.Number({ minimum: 0 }),
    }),
    declaredConsumers: ["m1"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── drilldown emit (§4.10) ─────────────────────────────────────────────────────────────────────
  {
    eventName: "m33.drilldown.emitted",
    moduleOwner: "m33",
    description:
      "A drilldown navigation was emitted from a tile into an owner-module surface; M33 flushes the `report_drilldown_audit` row (self-subscriber), and when consent-narrowed M36 raises the §4.9 `drilldownConsentNarrowed` compliance warn.",
    payloadSchema: Type.Object({
      drilldownTraceId: id,
      actorMembershipId: id,
      sourceTileKey: id,
      targetModule: Type.Integer({ minimum: 1 }),
      isConsentNarrowed: Type.Boolean(),
      organizationId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── CSV export counter (§4.10) ─────────────────────────────────────────────────────────────────
  {
    eventName: "m33.export.csv_streamed",
    moduleOwner: "m33",
    description:
      "A view was streamed as CSV (export route); M33 bumps the per-view export counter (self-subscriber).",
    payloadSchema: Type.Object({
      viewId: id,
      actorMembershipId: id,
      rowCount: Type.Integer({ minimum: 0 }),
      organizationId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── tenant eraser (§4.10) ──────────────────────────────────────────────────────────────────────
  {
    eventName: "m33.tenant_eraser.complete",
    moduleOwner: "m33",
    description:
      "The M33 destruction-cert eraseFn finished erasing a tenant's reporting rows; M4 records the per-table destruction counts on the destruction certificate. `complianceClassRefused` counts the insert-only `report_drilldown_audit` rows refused under retention class `compliance`.",
    payloadSchema: Type.Object({
      organizationId: id,
      tableCounts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
      complianceClassRefused: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m4"],
    isOutboxOnly: true,
  },
];
