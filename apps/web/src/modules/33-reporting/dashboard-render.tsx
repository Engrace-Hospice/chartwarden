import {
  DerivedBadge,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the DASHBOARD RENDER (R2).
// Spec §5.1.3 (`/reports/dashboards/:dashboardId`) — read one dashboard, then render its tile grid:
// each <TileFrame> reads GET /api/v1/reporting/tiles/{tileKey} (aggregate-only result, D6 — NEVER
// row-level PHI) + GET /api/v1/reporting/tiles/{tileKey}/freshness (the "Data as of" badge). A tile's
// drilldown affordance POSTs /api/v1/reporting/drilldown/emit and NAVIGATES to the consent-narrowed
// owner-module URL the server returns — the navigation is the disclosure (the owner module re-applies
// its own RLS + ABAC + M39 consent narrowing); the tile itself never inlines PHI.
// Lantern: No-Line cards, mono tile keys (wx-data-md), tabular-nums figures, per-tile freshness pill,
// DerivedBadge provenance, CSS-var tokens only. Tones resolve through reporting-status.ts (§6.6).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  asOfLabel,
  freshnessSecondsLabel,
  freshnessSecondsTone,
  statusLabel,
} from "./reporting-status";

interface TileDescriptor {
  tileKey: string;
  displayName: string;
  kind: string;
}

interface DashboardDetail {
  dashboardId: string;
  displayName: string;
  authorship: "system" | "tenant";
  tileCount: number;
  shareScope: "private" | "role" | "org";
  isOrgDefault: boolean;
  // F-044 — the tile manifest. This used to be optional with the note "Production projects the tile
  // manifest"; no backend projected one, in production or in the slice, and no DTO or OpenAPI response
  // declared the field — so it was permanently undefined and the "not available in this context" branch
  // below was the ONLY branch this screen could take. It is now part of the published contract.
  tiles: TileDescriptor[];
}

interface TileReadResult {
  tileKey: string;
  result: unknown[];
  rowCount: number;
  dataFreshnessSeconds: number;
  asOf: string;
  drilldownUrlTemplate?: string;
  scopeApplied: { scopeKind: string; narrowedFromRequested: boolean };
}

// The screen reads :dashboardId from the route; until routing is wired, fall back to the last path
// segment so the live-wired component renders against the real path it is mounted at (M34 precedent).
function dashboardIdFromPath(): string {
  const segs = window.location.pathname.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

export function DashboardRender(): JSX.Element {
  const client = useApiClient();
  const [dashboardId] = useState(dashboardIdFromPath);
  const [detail, setDetail] = useState<DashboardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/reporting/dashboards/{dashboardId}", {
      params: { path: { dashboardId } },
    });
    if (err) {
      setError("Dashboard not found, or you lack scope to view it.");
      setLoading(false);
      return;
    }
    setDetail(data as unknown as DashboardDetail);
    setLoading(false);
  }, [client, dashboardId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !detail)
    return <EmptyState title="Unavailable" description={error ?? "No dashboard."} />;

  const tiles = detail.tiles;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={detail.displayName}
          breadcrumb={
            <>
              <span className="wx-data-md">{detail.dashboardId}</span> ·{" "}
              {statusLabel(detail.shareScope)}
            </>
          }
          actions={
            <StatusPill
              label={detail.authorship === "system" ? "System" : "Tenant"}
              tone={detail.authorship === "system" ? "neutral" : "progress"}
            />
          }
        />
      }
    >
      {tiles.length === 0 ? (
        <EmptyState
          title="No tiles"
          description="This dashboard's report definition resolves to no report base, so it has no tile to read."
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
            gap: "1rem",
          }}
        >
          {tiles.map((tile) => (
            <TileFrame key={tile.tileKey} tile={tile} />
          ))}
        </div>
      )}
    </DetailPageLayout>
  );
}

// ── tile frame — reads its own aggregate + freshness, renders the §6.6 freshness pill + drilldown ─────
/**
 * The tile's FIGURES — the aggregate the tile was read for.
 *
 * This card used to render `result.rowCount` under the label "aggregate rows", and a KPI spec has no
 * dimensions, so that number is 1 for every tile that returns anything at all. The measures the tile
 * actually computed sat unread in `result.result[0]`. "A reporting module that cannot return a number is
 * not a reporting module" was the finding; returning the number and then rendering the row count instead
 * is the same outcome by a shorter route.
 *
 * A tile WITH dimensions returns one row per group, and a single card cannot show a table — those keep the
 * row count, which is the honest summary of a grouped result, with the drilldown as the way in.
 */
function TileFigures({ result }: { result: TileReadResult | null }): JSX.Element {
  const rows = result?.result ?? [];
  const single = rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
  const figures = single
    ? Object.entries(single).filter(([, v]) => v !== null && Number.isFinite(Number(v)))
    : [];

  if (figures.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <span
          className="tabular-nums"
          style={{ fontFamily: "var(--font-sans)", fontSize: "1.75rem", fontWeight: 600 }}
        >
          {result?.rowCount ?? 0}
        </span>
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          aggregate rows
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "1.5rem" }}>
      {figures.map(([key, value]) => (
        <div key={key} style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-sans)", fontSize: "1.75rem", fontWeight: 600 }}
          >
            {Number(value).toLocaleString()}
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
            {key.replace(/_/g, " ")}
          </span>
        </div>
      ))}
    </div>
  );
}

function TileFrame({ tile }: { tile: TileDescriptor }): JSX.Element {
  const client = useApiClient();
  const [result, setResult] = useState<TileReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [drillBusy, setDrillBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const { data, error: err } = await client.GET("/api/v1/reporting/tiles/{tileKey}", {
      params: { path: { tileKey: tile.tileKey } },
    });
    if (err) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setResult(data as unknown as TileReadResult);
    setLoading(false);
  }, [client, tile.tileKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // The drilldown is a NAVIGATION, not a data read: emit returns a consent-narrowed owner-module URL
  // (the owner re-applies RLS + ABAC + M39 consent). We never inline PHI into the tile (D6/D16).
  const drilldown = useCallback(async () => {
    setDrillBusy(true);
    const { data, error: err } = await client.POST("/api/v1/reporting/drilldown/emit", {
      body: { tileKey: tile.tileKey, dimensionContext: {} },
    });
    setDrillBusy(false);
    if (err) return;
    const res = data as unknown as { targetUrl?: string; outcome?: string };
    if (res?.targetUrl && res.outcome === "emitted") window.location.assign(res.targetUrl);
  }, [client, tile.tileKey]);

  const hasDrilldown = Boolean(result?.drilldownUrlTemplate);
  const breaker = false;

  return (
    <section
      style={{
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl, 1rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "1rem",
              fontWeight: 500,
            }}
          >
            {tile.displayName ?? tile.tileKey}
          </h2>
          <span
            className="wx-data-md"
            style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}
          >
            {tile.tileKey}
          </span>
        </div>
        {result ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "0.25rem",
            }}
          >
            <StatusPill
              label={freshnessSecondsLabel(result.dataFreshnessSeconds, breaker)}
              tone={freshnessSecondsTone(result.dataFreshnessSeconds, breaker)}
            />
            <span
              className="tabular-nums"
              style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}
            >
              {asOfLabel(result.asOf)}
            </span>
          </div>
        ) : null}
      </header>

      {loading ? (
        <LoadingSpinner />
      ) : failed ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--color-on-surface-variant)",
          }}
        >
          <Glyph name="alert" size={16} label="Tile unavailable" />
          <span style={{ fontSize: "0.85rem" }}>Tile unavailable.</span>
        </div>
      ) : (
        <>
          <TileFigures result={result} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem",
            }}
          >
            <DerivedBadge
              source={`${statusLabel(result?.scopeApplied.scopeKind ?? "org")} scope`}
              verb="computed from"
            />
            {hasDrilldown ? (
              <button
                type="button"
                onClick={() => void drilldown()}
                disabled={drillBusy}
                style={{ fontSize: "0.75rem" }}
              >
                {drillBusy ? "Resolving…" : "Drill into source →"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
