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
