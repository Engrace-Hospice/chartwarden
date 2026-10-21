// apps/backend/src/modules/33-reporting/routes/export-drilldown-service.ts — the M33 export + drilldown
// route service (§4.1 #32–#36) + an in-memory slice and a Drizzle-backed, port-injected backend.
//
// The five surfaces the export/drilldown routes compose over:
//   #32 CSV export   — direct chunked stream off the read replica (NO M22 hop; aggregate-only, D6). The route
//                      owns the HTTP sink (reply.raw); the service supplies the translated snapshot + cursor.
//   #33/#34 PDF/XLSX — the §1.1 render handshake to M22 (`m33.scheduled_report.render_requested`); returns the
//                      export job ref (the document id wires back later on `m22.document.rendered`).
//   #35 drilldown    — resolve a tile's `drilldown_url_template` → M39 consent-narrow (fail-closed) → the
//                      envelope-encrypted `report_drilldown_audit` write (D16/W-R-05).
//   #36 bulk export  — Compliance bulk drilldown → a CSV of the patient-identifiable navigation trail.
//
// The in-memory slice is deterministic (route/acceptance tests). PRODUCTION injects the Drizzle backend, which
// reads under `withReportSession` (export tier) and is DENY-STUB-SAFE: unbound translator/executor/consent/DEK
// ports degrade to the forward-seam empty stream or the fail-closed drilldown deny — never fail open (D6/D13).
import { type DbClient, schema } from "@wardenx/db";
import {
  CSV_EXPORT_ROW_CAP,
  type CsvExportOutboxPort,
  type CsvExportResult,
  type CsvWritableSinkPort,
  type DrilldownAuditOutboxPort,
  DrilldownDekUnavailable,
  type DrilldownFilterEncryptionPort,
  DrilldownTemplateError,
  EMPTY_SNAPSHOT,
  type ExportRenderOutboxPort,
  PdfRowLimitExceeded,
  type ReadReplicaSessionPort,
  type RenderSnapshot,
  type ReplicaLagGatePort,
  ReportCatalogRepository,
  ReportDefinitionRepository,
  ReportDrilldownAuditRepository,
  ReportViewRepository,
  type ReportableScopeEnvelope,
  type ReportingConsentConsumer,
  type ReportingDb,
  type SqlRow,
  type Translation,
  type TranslatorBaseCatalog,
  handleCsvExport,
  narrowDrilldownForConsent,
  requestPdfRender,
  requestXlsxRender,
  resolveDrilldownUrl,
  translateSpec,
  withReportSession,
  writeDrilldownAudit,
} from "@wardenx/reporting";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, ChartWardenError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type { M33WriteActor } from "./actor";
import { type ReportScopeResolverPort, narrowScope } from "./read-service-drizzle";

// ── shared DTOs ─────────────────────────────────────────────────────────────────────────────────────────

/** The writable CSV sink the route binds over the HTTP response (the package's {@link CsvWritableSinkPort}). */
export type CsvSinkPort = CsvWritableSinkPort;

/** The pinned filters + requested scope an export materializes the saved view under. */
export interface ExportQuery {
  readonly filters?: readonly Record<string, unknown>[];
  readonly scopeOverride?: "self" | "team" | "location" | "org";
}

/** What a CSV pre-flight reported: the row estimate (drives the §4.8 413 cap) + the deny-stub flag. */
export interface CsvExportEstimate {
  readonly estimatedRowCount: number;
  readonly isDenyStub: boolean;
}

/** The accepted PDF/XLSX render-request (#33/#34) — the export job ref M22 keys its reply back by. */
export interface ExportAcceptedResult {
  readonly exportId: string;
  readonly viewId: string;
  readonly format: "pdf" | "xlsx";
  readonly status: "render_requested";
}

/** #35 drilldown emit input (the tile's dimension context + the consent cohort). */
export interface DrilldownEmitInput {
  readonly tileKey: string;
  readonly reportViewId?: string | null;
  readonly dimensionContext: Record<string, string>;
  readonly queryFilters?: unknown;
  readonly patientIds?: readonly string[];
}

/** What a drilldown emit reported (the consent-narrowed URL + the audit trace + the outcome). */
export interface DrilldownEmitResult {
  readonly targetUrl: string;
  readonly drilldownTraceId: string;
  readonly isConsentNarrowed: boolean;
  readonly consentNarrowingReason: string | null;
  readonly outcome: "emitted" | "denied" | "target_unavailable";
}

/** #36 bulk drilldown export input. */
export interface DrilldownBulkExportInput {
  readonly targetModule?: number;
  readonly dimensionContext?: Record<string, string>;
}

/** Raised when a render handshake is requested but the M22 render outbox is not yet bound (fail-closed). */
export class ExportRenderUnbound extends ChartWardenError {
  constructor() {
    super("EXPORT_RENDER_UNBOUND", "the M22 render-request outbox is not yet bound", 503);
    this.name = "ExportRenderUnbound";
  }
}

/** The route service the export/drilldown handlers compose over (§4.1 #32–#36). */
export interface M33ExportDrilldownRouteService {
  /** #32 pre-flight — the row estimate (over the §4.8 cap ⇒ the route 413s before any byte streams). */
  estimateCsvExport(
    actor: M33WriteActor,
    viewId: string,
    query: ExportQuery,
  ): Promise<CsvExportEstimate>;
  /** #32 — stream the saved view's resolved snapshot as chunked CSV to the route-supplied sink. */
  streamCsvExport(
    actor: M33WriteActor,
    viewId: string,
    query: ExportQuery,
    sink: CsvSinkPort,
  ): Promise<CsvExportResult>;
  /** #33/#34 — request a PDF/XLSX render of the saved view (the §1.1 M22 handshake; idempotent on exportId). */
  requestExport(
    actor: M33WriteActor,
    viewId: string,
    format: "pdf" | "xlsx",
    idempotencyKey: string,
  ): Promise<ExportAcceptedResult>;
  /** #35 — resolve + consent-narrow a drilldown URL and write the envelope-encrypted audit row. */
  emitDrilldown(actor: M33WriteActor, input: DrilldownEmitInput): Promise<DrilldownEmitResult>;
  /** #36 — stream the Compliance bulk drilldown trail (patient-identifiable links) as CSV to the sink. */
  bulkExportDrilldown(
    actor: M33WriteActor,
    input: DrilldownBulkExportInput,
    sink: CsvSinkPort,
  ): Promise<{ rowCount: number }>;
}

// ── in-memory slice ─────────────────────────────────────────────────────────────────────────────────────

/** Deterministic seed for the in-memory export/drilldown backend (slice + acceptance tests). */
export interface M33ExportDrilldownSeed {
  /** The row estimate the CSV pre-flight returns (default 3; set over the cap to assert the 413 path). */
  readonly csvRowEstimate?: number;
  /** The saved-view's resolved row limit (drives the PDF §4.8 ≤5000 gate; default 100). */
  readonly viewRowLimit?: number;
}

const csvHeader = "metric,value\r\n";

/**
 * A deterministic, I/O-free {@link M33ExportDrilldownRouteService}. The CSV streams a fixed 3-row aggregate;
 * PDF/XLSX returns a deterministic export ref (PDF still applies the §4.8 row-limit gate); drilldown synthesizes
 * a consent-clean URL + a deterministic trace id; the bulk export streams one trail row. No real translator /
 * consent / DEK — those are the Drizzle backend's concern.
 */
export function createInMemoryM33ExportDrilldownBackend(seed: M33ExportDrilldownSeed = {}): {
  service: M33ExportDrilldownRouteService;
} {
  const estimate = seed.csvRowEstimate ?? 3;
  const rowLimit = seed.viewRowLimit ?? 100;
  let seq = 0;
  const id = (p: string) => `${p}0000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;

  const service: M33ExportDrilldownRouteService = {
    async estimateCsvExport() {
      return { estimatedRowCount: estimate, isDenyStub: false };
    },
    async streamCsvExport(_actor, _viewId, _query, sink) {
      await sink.write(csvHeader);
      for (let i = 0; i < 3; i += 1) await sink.write(`row_${i},${i}\r\n`);
      await sink.end();
      return { kind: "streamed", rowCount: 3 };
    },
    async requestExport(_actor, viewId, format) {
      // §4.8 PDF gate (the in-memory rowLimit is under 5000 by default; raise the seed to assert the 413).
      if (format === "pdf" && rowLimit > 5000) throw new PdfRowLimitExceeded(rowLimit);
      return { exportId: id("e"), viewId, format, status: "render_requested" };
    },
    async emitDrilldown(_actor, input) {
      const narrowed = (input.patientIds?.length ?? 0) > 0;
      const base = `/reporting/drilldown/${encodeURIComponent(input.tileKey)}`;
      const targetUrl = narrowed ? `${base}?consentNarrowed=true` : base;
      return {
        targetUrl,
        drilldownTraceId: id("d"),
        isConsentNarrowed: narrowed,
        consentNarrowingReason: narrowed ? "consent_narrowed" : null,
        outcome: "emitted",
      };
    },
    async bulkExportDrilldown(_actor, _input, sink) {
      await sink.write(
        "drilldown_trace_id,source_tile_key,target_module,target_surface,accessed_at\r\n",
      );
      await sink.write(`${id("d")},census_daily,8,/m8/late-entry,2026-06-21T12:00:00.000Z\r\n`);
      await sink.end();
      return { rowCount: 1 };
    },
  };

  return { service };
}

// ── Drizzle backend (port-injected, deny-stub-safe) ─────────────────────────────────────────────────────

/** Executes a translated, parameterized export SELECT on the read replica (bound at P2C; deny-stub-safe).
 *  Takes the ACTIVE `ReportingDb` (the caller's open `withReportSession` tx) as its first argument — see
 *  `TileSqlExecutor`'s doc comment (read-service-drizzle.ts) for why a statically-captured connection would
 *  run outside the RLS-scoped session. */
export interface ExportSqlExecutor {
  execute(
    db: ReportingDb,
    input: { sql: string; params: readonly unknown[] },
  ): Promise<{ rows: readonly SqlRow[]; rowCount: number }>;
}

/** Composition deps the Drizzle export/drilldown backend binds at boot (P2C). */
export interface M33ExportDrilldownDrizzleDeps {
  /** The PRIMARY Drizzle client (the drilldown audit append runs under `withOrgContext` on this). */
  readonly db: DbClient;
  /** The M1 `read_replica_session` port each read opens under (§8.1.2). */
  readonly replica: ReadReplicaSessionPort;
  /** The D14 replica-lag breaker gate. */
  readonly lag?: ReplicaLagGatePort;
  /** The M22 render-request outbox (#33/#34). UNBOUND ⇒ {@link ExportRenderUnbound} (503, fail-closed). */
  readonly exportOutbox?: ExportRenderOutboxPort;
  /** The §4.10 CSV-export telemetry outbox (best-effort; a no-op default). */
  readonly csvOutbox?: CsvExportOutboxPort;
  /** Executes the export SELECT on the replica (#32). UNBOUND ⇒ a header-only empty CSV (forward-seam). */
  readonly tiles?: ExportSqlExecutor;
  /** The M39 consent evaluator (#35). UNBOUND ⇒ the fail-closed maximal-narrow path (D16). */
  readonly consent?: Pick<ReportingConsentConsumer, "evaluateForReporting">;
  /** Envelope-encrypts the drilldown filter context (#35). UNBOUND ⇒ {@link DrilldownDekUnavailable} (deny). */
  readonly drilldownEncryption?: DrilldownFilterEncryptionPort;
  /** The §4.10 drilldown-audit outbox (#35; a no-op default). */
  readonly drilldownOutbox?: DrilldownAuditOutboxPort;
  /** Id minting (deterministic ids in tests). */
  readonly newId?: () => string;
  /** Injected clock. */
  readonly now?: () => Date;
  /**
   * Resolves the caller's §4.7.1 `reportable_scope` envelope (D8). REQUIRED for the same reason as on the
   * read service: this file's `scopeEnvelope` used to read `query.scopeOverride ?? "org"` off the request,
   * so the CSV/PDF/XLSX export — the widest data surface M33 has — ran org-wide for every caller (F-059).
   */
  readonly scope: ReportScopeResolverPort;
}

/** A no-op CSV-export telemetry outbox (the best-effort default until the §4.10 dispatcher binds). */
const NOOP_CSV_OUTBOX: CsvExportOutboxPort = { async emitCsvStreamed() {} };
/** A no-op drilldown-audit outbox (best-effort default). */
const NOOP_DRILLDOWN_OUTBOX: DrilldownAuditOutboxPort = { async emitDrilldown() {} };

/** The actor's RESOLVED scope, narrowed by an explicit `scopeOverride` (never widened by one). */
async function scopeEnvelope(
  deps: M33ExportDrilldownDrizzleDeps,
  actor: M33WriteActor,
  query: ExportQuery,
): Promise<ReportableScopeEnvelope> {
  return narrowScope(await deps.scope.resolve(actor), query.scopeOverride, actor.membershipId)
    .scope;
}

let idCounter = 0;
const defaultNewId = (): string =>
  `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, "0")}`;

export function createDrizzleM33ExportDrilldownBackend(deps: M33ExportDrilldownDrizzleDeps): {
  service: M33ExportDrilldownRouteService;
} {
  const newId = deps.newId ?? defaultNewId;
  const now = deps.now ?? (() => new Date());

  const read = <T>(orgId: string, fn: (db: ReportingDb) => Promise<T>): Promise<T> =>
    withReportSession<T>({ orgId, tier: "export" }, { replica: deps.replica, lag: deps.lag }, fn);

  /**
   * Resolve a saved view → its spec + the translator base catalog + the translated snapshot, given an
   * ALREADY-OPEN session `db`. Split out from `translateView` below so `streamCsvExport` can keep ONE
   * `read()` session open across translate → execute → stream (the actual `tiles.execute` call must run on
   * the SAME tx that carries the RLS/read-only/statement_timeout GUCs `read()` sets — running it after that
   * session already closed, as a two-step translate-then-execute would, means FORCE RLS sees no scope at
   * all).
   */
  const translateViewOn = async (
    db: ReportingDb,
    actor: M33WriteActor,
    viewId: string,
    query: ExportQuery,
  ): Promise<{ translation: Translation; rowLimit: number; viewName: string }> => {
    const view = await new ReportViewRepository(db).findById(viewId);
    if (!view || view.organizationId !== actor.organizationId)
      throw new NotFoundError("report view");
    const defRepo = new ReportDefinitionRepository(db);
    const version = await defRepo.findVersionById(view.definitionVersionId);
    if (!version) throw new NotFoundError("report definition version");
    const spec = version.spec as schema.ReportDefinitionSpec;
    const definition = await defRepo.findDefinitionById(version.definitionId);
    if (!definition) throw new NotFoundError("report definition");
    const catalog = new ReportCatalogRepository(db);
    const base = await catalog.findBaseByKey(definition.baseKey);
    if (!base) throw new NotFoundError("report base");
    const mv = await catalog.findMvByKey(base.mvKey);
    const rowLimit = spec.rowLimit ?? base.maxRowLimit;
    const filters = (query.filters as schema.ReportFilter[] | undefined) ?? spec.filters ?? [];
    const translatorBase: TranslatorBaseCatalog = {
      baseKey: base.baseKey,
      status: base.status,
      mvKey: base.mvKey,
      mvSchemaName: mv?.schemaName ?? base.mvKey,
      mvStatus: mv?.status ?? "registered",
      dimensions: base.dimensions,
      measures: base.measures,
      maxRowLimit: base.maxRowLimit,
      drilldownUrlTemplate: base.drilldownUrlTemplate,
      scopeMembershipColumn: base.scopeMembershipColumn,
      scopeLocationColumn: base.scopeLocationColumn,
    };
    const translation = translateSpec(
      { ...spec, filters },
      translatorBase,
      await scopeEnvelope(deps, actor, query),
    );
    return { translation, rowLimit, viewName: view.displayName };
  };

  /** `translateViewOn` over its own freshly-opened read session (used where the session need not stay open
   *  past the translation itself — `estimateCsvExport` never executes the translated SQL). */
  const translateView = (
    actor: M33WriteActor,
    viewId: string,
    query: ExportQuery,
  ): Promise<{ translation: Translation; rowLimit: number; viewName: string }> =>
    read(actor.organizationId, (db) => translateViewOn(db, actor, viewId, query));

  const service: M33ExportDrilldownRouteService = {
    async estimateCsvExport(actor, viewId, query) {
      const { translation } = await translateView(actor, viewId, query);
      // No COUNT(*) executor in scaffold → 0 (under the cap, streams). A deny-stub base streams empty.
      return { estimatedRowCount: 0, isDenyStub: translation.kind === "deny_stub" };
    },

    streamCsvExport(actor, viewId, query, sink) {
      const tiles = deps.tiles;
      // ONE read() session spans translate → execute → stream (see translateViewOn's doc comment) — the
      // cursor source's `fetchChunks` closes over the SAME `db` the translation ran on. UNBOUND executor (or
      // a deny-stub base) → no rows (handleCsvExport streams a header-only/empty CSV, never fabricated rows).
      return read(actor.organizationId, async (db) => {
        const { translation } = await translateViewOn(db, actor, viewId, query);
        const source = {
          async *fetchChunks(): AsyncIterable<readonly SqlRow[]> {
            if (translation.kind !== "sql" || !tiles) return;
            const { rows } = await tiles.execute(db, {
              sql: translation.sql,
              params: translation.params,
            });
            yield rows;
          },
        };
        return handleCsvExport(
          {
            translation,
            viewId,
            organizationId: actor.organizationId,
            actorMembershipId: actor.membershipId,
          },
          { source, sink, outbox: deps.csvOutbox ?? NOOP_CSV_OUTBOX },
        );
      });
    },

    async requestExport(actor, viewId, format, idempotencyKey) {
      if (!deps.exportOutbox) throw new ExportRenderUnbound();
      // GAP-051 — ONE read session spans translate → EXECUTE, exactly as `streamCsvExport` does and for
      // the same reason: the executor must run on the tx carrying the RLS/read-only/statement_timeout
      // GUCs. This path used to translate only and ship the query TEXT to M22, which could never have
      // rendered from it (no reporting database, and the `$1, $2, …` markers have no params attached).
      const { translation, rowLimit, viewName, snapshot } = await read(
        actor.organizationId,
        async (db) => {
          const resolved = await translateViewOn(db, actor, viewId, {});
          // A deny-stub base (an unmaterialized MV, D6) renders an EMPTY report rather than fabricating
          // rows — the same forward-seam choice the tile and CSV paths make.
          if (resolved.translation.kind !== "sql" || !deps.tiles) {
            return { ...resolved, snapshot: EMPTY_SNAPSHOT };
          }
          const { rows, rowCount } = await deps.tiles.execute(db, {
            sql: resolved.translation.sql,
            params: resolved.translation.params,
          });
          return {
            ...resolved,
            snapshot: {
              columns: resolved.translation.columns.map((c) => ({
                key: c.outputKey,
                sourceKey: c.sourceKey,
                kind: c.kind,
                ...(c.unit ? { unit: c.unit } : {}),
              })),
              rows: rows as Record<string, unknown>[],
              rowCount,
            } satisfies RenderSnapshot,
          };
        },
      );
      const exportId = idempotencyKey || newId();
      const snapshotQuery = translation.kind === "sql" ? translation.sql : "";
      const input = {
        exportId,
        viewId,
        organizationId: actor.organizationId,
        snapshotQuery,
        rowLimit,
        title: viewName,
        snapshot,
      };
      // §4.8 PDF gate is inside requestPdfRender (throws PdfRowLimitExceeded → the route 413s). XLSX: no gate.
      if (format === "pdf") {
        await requestPdfRender(input, { outbox: deps.exportOutbox });
      } else {
        await requestXlsxRender(input, { outbox: deps.exportOutbox });
      }
      return { exportId, viewId, format, status: "render_requested" };
    },

    async emitDrilldown(actor, input) {
      // Step 1 — resolve the candidate URL from the base's whitelisted drilldown template (read session).
      let candidate: { url: string; targetModule: number; targetSurface: string };
      let outcome: DrilldownEmitResult["outcome"] = "emitted";
      try {
        candidate = await read(actor.organizationId, async (db) => {
          const base = await new ReportCatalogRepository(db).findBaseByKey(input.tileKey);
          if (!base) throw new NotFoundError("tile");
          const allowed = new Set(base.dimensions.map((d) => d.dimensionKey));
          const { targetUrl } = resolveDrilldownUrl({
            template: base.drilldownUrlTemplate,
            dimensionContext: input.dimensionContext,
            allowedDimensionKeys: allowed,
          });
          const moduleMatch = /\/m(\d+)\b/.exec(targetUrl);
          return {
            url: targetUrl,
            targetModule: moduleMatch ? Number(moduleMatch[1]) : 0,
            targetSurface: targetUrl.split("?")[0] ?? targetUrl,
          };
        });
      } catch (err) {
        if (err instanceof DrilldownTemplateError) {
          candidate = { url: "", targetModule: 0, targetSurface: "" };
          outcome = "target_unavailable";
        } else {
          throw err;
        }
      }

      // Step 2 — M39 consent narrowing (fail-closed to maximal narrowing when the evaluator is unavailable).
      const narrowed = await narrowDrilldownForConsent(
        {
          organizationId: actor.organizationId,
          actorMembershipId: actor.membershipId,
          patientIds: input.patientIds ?? [],
          url: candidate.url,
        },
        {
          consent: deps.consent ?? {
            async evaluateForReporting() {
              throw new Error("M39 unbound");
            },
          },
        },
      );

      // Step 3 — envelope-encrypt + append the insert-only audit row under withOrgContext (fail-closed on DEK).
      const encryption =
        deps.drilldownEncryption ??
        ({
          async encryptFilters() {
            throw new DrilldownDekUnavailable("per-tenant DEK port not bound");
          },
        } satisfies DrilldownFilterEncryptionPort);

      const { drilldownTraceId } = await withOrgContext<DbClient, { drilldownTraceId: string }>(
        deps.db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const repo = new ReportDrilldownAuditRepository(tx);
          return writeDrilldownAudit(
            {
              organizationId: actor.organizationId,
              actorMembershipId: actor.membershipId,
              reportViewId: input.reportViewId ?? null,
              sourceTileKey: input.tileKey,
              drilldownTargetModule: candidate.targetModule,
              drilldownTargetSurface: candidate.targetSurface,
              queryFilters: input.queryFilters,
              isConsentNarrowed: narrowed.isConsentNarrowed,
              consentNarrowingReason: narrowed.reason,
              outcome,
            },
            {
              encryption,
              audit: { append: async (row) => void (await repo.append(row)) },
              outbox: deps.drilldownOutbox ?? NOOP_DRILLDOWN_OUTBOX,
              newRowId: newId,
              newTraceId: newId,
              now,
            },
          );
        },
      );

      return {
        targetUrl: narrowed.url,
        drilldownTraceId,
        isConsentNarrowed: narrowed.isConsentNarrowed,
        consentNarrowingReason: narrowed.reason,
        outcome,
      };
    },

    async bulkExportDrilldown(actor, input, sink) {
      const A = schema.reportDrilldownAudit;
      const rows = await read(actor.organizationId, async (db) => {
        const where =
          input.targetModule !== undefined
            ? and(
                eq(A.organizationId, actor.organizationId),
                eq(A.drilldownTargetModule, input.targetModule),
              )
            : eq(A.organizationId, actor.organizationId);
        return db.select().from(A).where(where).orderBy(desc(A.accessedAt)).limit(50_000);
      });
      await sink.write(
        "drilldown_trace_id,source_tile_key,target_module,target_surface,accessed_at\r\n",
      );
      for (const r of rows) {
        await sink.write(
          `${r.drilldownTraceId},${r.sourceTileKey},${r.drilldownTargetModule},${r.drilldownTargetSurface},${r.accessedAt.toISOString()}\r\n`,
        );
      }
      await sink.end();
      return { rowCount: rows.length };
    },
  };

  return { service };
}
