// apps/backend/src/modules/33-reporting/routes/write-typebox.ts — M33 (§4.2 MUTATING surface).
//
// TypeBox request / path / query schemas for the M33 MUTATING surface (routes #8–#31): report
// definitions + the immutable version chain (D9), saved views + the sharing model (D17), and the
// scheduled-delivery pipeline (D7). The two canonical §4.2 builder shapes — `ReportDefinitionSpec`
// (the whitelisted dimensions/measures/filters spec a tenant authors, D4) and `ScheduledReportCreate`
// (the cron + recipients + format create payload) — are OWNED by the @wardenx/reporting package
// (packages/reporting/src/schemas); we re-export them so the route plugins + the OpenAPI enrichment
// table reference ONE symbol, then wrap them in the per-route request envelopes here.
//
// Named `write-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a
// TypeBox import for a Drizzle one (the M22 `documents-typebox` / M34 `platform-typebox` precedent).
// Validation runs through the shared `parse(...)` in `./reporting-typebox` (TypeBox `Value` → M1's
// VALIDATION_FAILED envelope). Org/actor/owner binding is ALWAYS server-side (request.context) — the
// body never carries an organization_id or an owner membership id.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import {
  FilterTypeBox,
  ReportDefinitionSpec,
  ScheduledReportCreate,
} from "@wardenx/reporting";

// Defence-in-depth format registration (idempotent) — `./reporting-typebox` registers these on load
// too, but a route file may import this module first.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// Re-export the package-owned §4.2 builder shapes so callers import them from the route barrel.
export { ReportDefinitionSpec, ScheduledReportCreate, FilterTypeBox };

// Vocab mirrors (canonical enums live in @wardenx/db).
const DEFINITION_STATUS = ["draft", "published", "archived"] as const;
const DEFINITION_AUTHORSHIP = ["system", "tenant"] as const;
const SHARE_SCOPE = ["private", "role", "org"] as const;
const SCHEDULE_STATUS = ["active", "paused", "cancelled"] as const;

// ── pagination (the keyset/cursor envelope every M33 list route paginates on, ./concurrency) ──────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

// ── report definitions (#8–#14) ───────────────────────────────────────────────────────────────────────

/** #8 POST /definitions — create a tenant definition bound to a base + its initial draft (v1) spec. */
export const CreateDefinitionRequest = Type.Object({
  baseKey: Type.String({ minLength: 1, maxLength: 128 }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  spec: ReportDefinitionSpec,
});

/** #12 POST /definitions/:id/versions — append a NEW immutable version (D9: editing = new version). */
export const CreateVersionRequest = Type.Object({
  spec: ReportDefinitionSpec,
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const DefinitionIdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
export const DefinitionVersionParams = Type.Object({
  id: Type.String({ format: "uuid" }),
  vid: Type.String({ format: "uuid" }),
});
export const DefinitionListQuery = Type.Object({
  status: Type.Optional(lit(DEFINITION_STATUS)),
  authorship: Type.Optional(lit(DEFINITION_AUTHORSHIP)),
  ...PageQuery,
});

// ── saved views + sharing (#15–#21) ────────────────────────────────────────────────────────────────────

/** #16 POST /views — save a view over a published definition version. */
export const CreateViewRequest = Type.Object({
  definitionVersionId: Type.String({ format: "uuid" }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  pinnedFilters: Type.Optional(Type.Array(FilterTypeBox, { maxItems: 24 })),
  shareScope: Type.Optional(lit(SHARE_SCOPE)),
  shareRoleKeys: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 50 })),
});

/** #18 PATCH /views/:id — edit a view's display/pinned-filters/share scope. */
export const UpdateViewRequest = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  pinnedFilters: Type.Optional(Type.Array(FilterTypeBox, { maxItems: 24 })),
  shareScope: Type.Optional(lit(SHARE_SCOPE)),
  shareRoleKeys: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 50 })),
});

/** #19 POST /views/:id/share — set a view's share scope (D17). `org` additionally needs report.share.org. */
export const ShareViewRequest = Type.Object({
  shareScope: lit(SHARE_SCOPE),
  shareRoleKeys: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 50 })),
  /** Optional explicit-membership grant (rare; role/org sharing is the norm). */
  sharedWithMembershipId: Type.Optional(Type.String({ format: "uuid" })),
});

export const ViewIdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
export const ViewListQuery = Type.Object({
  /** `mine` = the actor's own views; `org` = org-shared views. Defaults to `mine`. */
  scope: Type.Optional(lit(["mine", "org"] as const)),
  ...PageQuery,
});

// ── scheduled reports (#22–#31) ─────────────────────────────────────────────────────────────────────────

/** #25 PATCH /schedules/:id — edit a schedule's cron/timezone/format/recipients. */
export const UpdateScheduleRequest = Type.Object({
  cronExpression: Type.Optional(Type.String({ pattern: "^[0-9*/,\\- ]+$" })),
  tenantTimezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  format: Type.Optional(lit(["pdf", "xlsx", "csv"] as const)),
  recipientMembershipIds: Type.Optional(
    Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 50 }),
  ),
});

export const ScheduleIdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
export const ScheduleRunIdParams = Type.Object({ runId: Type.String({ format: "uuid" }) });
export const ScheduleListQuery = Type.Object({
  status: Type.Optional(lit(SCHEDULE_STATUS)),
  ...PageQuery,
});
export const ScheduleRunListQuery = Type.Object(PageQuery);

// ── exports (#32–#34) + drilldown (#35–#36) ───────────────────────────────────────────────────────────────

/** A reporting scope the actor may request a tile/export resolve at (narrowed against `reportable_scope`). */
const REQUESTED_SCOPE = ["self", "team", "location", "org"] as const;

/** #32/#33/#34 body — the pinned filters + requested scope the export materializes the saved view under. */
export const ExportRequest = Type.Object({
  filters: Type.Optional(Type.Array(FilterTypeBox, { maxItems: 24 })),
  scopeOverride: Type.Optional(lit(REQUESTED_SCOPE)),
});

/** #35 POST /drilldown/emit — resolve + consent-narrow a drilldown URL from a tile's dimension context. */
export const DrilldownEmitRequest = Type.Object({
  tileKey: Type.String({ minLength: 1, maxLength: 128 }),
  /** The saved view the drilldown originated from (null for an ad-hoc tile drilldown). */
  reportViewId: Type.Optional(Type.String({ format: "uuid" })),
  /** The tile's resolved dimension context (dimension key → string value) substituted into the template. */
  dimensionContext: Type.Record(Type.String(), Type.String()),
  /** The navigation filter context recorded (envelope-encrypted) in the audit row. */
  queryFilters: Type.Optional(Type.Unknown()),
  /** The candidate patient cohort the navigation resolves to (consent-narrowed; never widened). */
  patientIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 5000 })),
});

/** #36 POST /drilldown/bulk_export — Compliance bulk drilldown export (CSV of patient-identifiable links). */
export const DrilldownBulkExportRequest = Type.Object({
  /** Narrow the bulk export to a single owner module's drilldowns (omit for all modules). */
  targetModule: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
  /** The tile/cohort dimension context the bulk links resolve over. */
  dimensionContext: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type ExportRequestT = Static<typeof ExportRequest>;
export type DrilldownEmitRequestT = Static<typeof DrilldownEmitRequest>;
export type DrilldownBulkExportRequestT = Static<typeof DrilldownBulkExportRequest>;

// Convenience static types for the route handlers.
export type CreateDefinitionRequestT = Static<typeof CreateDefinitionRequest>;
export type CreateVersionRequestT = Static<typeof CreateVersionRequest>;
export type CreateViewRequestT = Static<typeof CreateViewRequest>;
export type UpdateViewRequestT = Static<typeof UpdateViewRequest>;
export type ShareViewRequestT = Static<typeof ShareViewRequest>;
export type UpdateScheduleRequestT = Static<typeof UpdateScheduleRequest>;

/** Local re-export so a route file imports a single `parse` from this module if it prefers. */
export type { TSchema };

// ── §4.2 RESPONSE DTOs (F0 enrichment) ──────────────────────────────────────────────────────────────
// The MUTATING + export/drilldown routes returned typed service views (`DefinitionView` / `ViewView` /
// `ScheduleView` / `ScheduleRunView` / `ExportAcceptedResult` / `DrilldownEmitResult`) but published NO
// response contract, so the generated client typed every write/read body as `never`. These DTOs mirror the
// service views 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a view field
// added or renamed breaks `bun run build` rather than silently drifting from the client. (The READ-surface
// DTOs — dashboards / bases / metrics / MV-admin / lag / drilldown-audit / metric-seam — live in
// `./reporting-typebox`; this module owns only the mutating + export/drilldown responses.)
import type {
  DrilldownEmitResult as ServiceDrilldownEmitResult,
  ExportAcceptedResult as ServiceExportAcceptedResult,
} from "./export-drilldown-service";
import type {
  DefinitionVersionView as ServiceDefinitionVersionView,
  DefinitionView as ServiceDefinitionView,
  ReportSpec as ServiceReportSpec,
  ScheduleRunView as ServiceScheduleRunView,
  ScheduleView as ServiceScheduleView,
  ShareView as ServiceShareView,
  ViewView as ServiceViewView,
} from "./write-service";

/** The keyset/cursor page envelope every M33 list route paginates on (`./concurrency` `CursorPage`). */
const CursorPageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

// The jsonb-stored §4.2 builder spec a definition version carries (mirrors `ReportSpec`).
const ReportSpecViewSchema = Type.Object({
  dimensions: Type.Array(
    Type.Object({ dimensionKey: Type.String(), alias: Type.Optional(Type.String()) }),
  ),
  measures: Type.Array(
    Type.Object({ measureKey: Type.String(), alias: Type.Optional(Type.String()) }),
  ),
  filters: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  sort: Type.Optional(
    Type.Array(Type.Object({ by: Type.String(), direction: lit(["asc", "desc"] as const) })),
  ),
  rowLimit: Type.Optional(Type.Integer()),
  chartHint: Type.Optional(Type.String()),
});

// ── report definitions (#8–#14) ──────────────────────────────────────────────────────────────────────
export const DefinitionViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  authorship: lit(DEFINITION_AUTHORSHIP),
  baseKey: Type.String(),
  ownerMembershipId: Nullable(Type.String()),
  displayName: Type.String(),
  description: Nullable(Type.String()),
  latestVersionId: Nullable(Type.String()),
  versionSeq: Type.Integer(),
  status: lit(DEFINITION_STATUS),
  createdAt: Type.String({ format: "date-time" }),
  archivedAt: Nullable(Type.String({ format: "date-time" })),
});
export const DefinitionListResponseSchema = CursorPageOf(DefinitionViewSchema);

export const DefinitionVersionViewSchema = Type.Object({
  id: Type.String(),
  definitionId: Type.String(),
  organizationId: Type.String(),
  versionNumber: Type.Integer(),
  spec: ReportSpecViewSchema,
  status: lit(["draft", "published", "superseded"] as const),
  publishedAt: Nullable(Type.String({ format: "date-time" })),
  supersededAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
});
export const DefinitionVersionListResponseSchema = CursorPageOf(DefinitionVersionViewSchema);

/** #13 publish — returns the promoted definition + the now-published version (D9). */
export const PublishVersionResponseSchema = Type.Object({
  definition: DefinitionViewSchema,
  version: DefinitionVersionViewSchema,
});

// ── saved views + sharing (#15–#21) ──────────────────────────────────────────────────────────────────
export const ViewViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  definitionVersionId: Type.String(),
  ownerMembershipId: Type.String(),
  displayName: Type.String(),
  pinnedFilters: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  shareScope: lit(SHARE_SCOPE),
  shareRoleKeys: Nullable(Type.Array(Type.String())),
  isOrgDefault: Type.Boolean(),
  status: lit(["active", "archived"] as const),
  createdAt: Type.String({ format: "date-time" }),
});
export const ViewListResponseSchema = CursorPageOf(ViewViewSchema);

const ShareRowViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  reportViewId: Type.String(),
  sharedWithMembershipId: Nullable(Type.String()),
  sharedWithRoleKey: Nullable(Type.String()),
  status: lit(["active", "revoked"] as const),
  createdAt: Type.String({ format: "date-time" }),
  revokedAt: Nullable(Type.String({ format: "date-time" })),
});

/** #19 share — returns the updated view + the share row (null unless a role/membership grant was written). */
export const ShareViewResponseSchema = Type.Object({
  view: ViewViewSchema,
  share: Nullable(ShareRowViewSchema),
});

// ── scheduled reports (#22–#31) ───────────────────────────────────────────────────────────────────────
export const ScheduleViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  reportViewId: Type.String(),
  ownerMembershipId: Type.String(),
  cronExpression: Type.String(),
  tenantTimezone: Type.String(),
  format: lit(["pdf", "xlsx", "csv"] as const),
  recipientMembershipIds: Type.Array(Type.String()),
  deliveryChannel: Type.Literal("in_app"),
  nextRunAt: Nullable(Type.String({ format: "date-time" })),
  status: lit(SCHEDULE_STATUS),
  createdAt: Type.String({ format: "date-time" }),
  cancelledAt: Nullable(Type.String({ format: "date-time" })),
});
export const ScheduleListResponseSchema = CursorPageOf(ScheduleViewSchema);

export const ScheduleRunViewSchema = Type.Object({
  id: Type.String(),
  scheduleId: Type.String(),
  organizationId: Type.String(),
  scheduledFor: Type.String({ format: "date-time" }),
  status: lit([
    "queued",
    "running",
    "rendered_pending",
    "rendered_complete",
    "delivered",
    "failed",
  ] as const),
  startedAt: Nullable(Type.String({ format: "date-time" })),
  finishedAt: Nullable(Type.String({ format: "date-time" })),
  documentId: Nullable(Type.String()),
  failureReason: Nullable(Type.String()),
  rowCount: Nullable(Type.Integer()),
});
export const ScheduleRunListResponseSchema = CursorPageOf(ScheduleRunViewSchema);

/** #29 delete_all_runs — the bulk run-history cleanup count. */
export const DeleteAllRunsResponseSchema = Type.Object({
  scheduleId: Type.String(),
  deleted: Type.Integer(),
});

// ── exports (#33/#34) + drilldown (#35) — JSON-bodied surfaces (CSV #32/#36 hijack the stream) ─────────
export const ExportAcceptedResponseSchema = Type.Object({
  exportId: Type.String(),
  viewId: Type.String(),
  format: lit(["pdf", "xlsx"] as const),
  status: Type.Literal("render_requested"),
});

export const DrilldownEmitResponseSchema = Type.Object({
  targetUrl: Type.String(),
  drilldownTraceId: Type.String(),
  isConsentNarrowed: Type.Boolean(),
  consentNarrowingReason: Nullable(Type.String()),
  outcome: lit(["emitted", "denied", "target_unavailable"] as const),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _ReportSpec = Conforms<Static<typeof ReportSpecViewSchema>, ServiceReportSpec>;
type _DefinitionView = Conforms<Static<typeof DefinitionViewSchema>, ServiceDefinitionView>;
type _DefinitionVersionView = Conforms<
  Static<typeof DefinitionVersionViewSchema>,
  ServiceDefinitionVersionView
>;
type _ViewView = Conforms<Static<typeof ViewViewSchema>, ServiceViewView>;
type _ShareView = Conforms<Static<typeof ShareRowViewSchema>, ServiceShareView>;
type _ScheduleView = Conforms<Static<typeof ScheduleViewSchema>, ServiceScheduleView>;
type _ScheduleRunView = Conforms<Static<typeof ScheduleRunViewSchema>, ServiceScheduleRunView>;
type _ExportAccepted = Conforms<
  Static<typeof ExportAcceptedResponseSchema>,
  ServiceExportAcceptedResult
>;
type _DrilldownEmit = Conforms<Static<typeof DrilldownEmitResponseSchema>, ServiceDrilldownEmitResult>;
