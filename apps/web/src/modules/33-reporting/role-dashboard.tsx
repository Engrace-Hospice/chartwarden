import {
  DetailPageLayout,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the ROLE DASHBOARD (R2).
// Spec §5.1.5 (`/reports/role/:roleKey`) — a role's seeded operational dashboard. Reads the role's
// dashboard definition via GET /api/v1/reporting/dashboards/{dashboardId}, then each KPI card reads its
// backing tile via GET /api/v1/reporting/tiles/{tileKey} (+ /freshness). Tiles are aggregate-only (D6);
// clicking a KPI deep-links to the owner module's queue (the drill-through re-applies the owner's
// RLS + ABAC + M39 consent narrowing — handled by the dashboard-render drilldown path, not inlined here).
// Lantern: KpiStrip (Fraunces eyebrow + Inter tabular-nums figure), per-card freshness pill, No-Line
// cards, CSS-var tokens only. Freshness/tone resolve through reporting-status.ts (§6.6 / §5.1.2).
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
  displayName?: string;
}

interface DashboardDetail {
  dashboardId: string;
  displayName: string;
  authorship: "system" | "tenant";
  tileCount: number;
  shareScope: "private" | "role" | "org";
  isOrgDefault: boolean;
  tiles?: TileDescriptor[];
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

// The screen reads :roleKey (or the role's dashboard id) from the route; until routing is wired, fall
// back to the last path segment so the live-wired component renders against the path it is mounted at.
function dashboardIdFromPath(): string {
  const segs = window.location.pathname.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

export function RoleDashboard(): JSX.Element {
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
      setError("Role dashboard not found, or you lack scope to view it.");
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

  const tiles = detail.tiles ?? [];

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={detail.displayName}
          breadcrumb={
            <>
              Role dashboard · <span className="wx-data-md">{detail.dashboardId}</span>
            </>
          }
        />
      }
    >
      {tiles.length === 0 ? (
        <EmptyState
          title="No KPIs"
          description={`This role dashboard declares ${detail.tileCount} tile(s); the tile manifest is not available in this context.`}
        />
      ) : (
        <KpiStrip>
          {tiles.map((tile) => (
            <KpiTile key={tile.tileKey} tile={tile} />
          ))}
        </KpiStrip>
      )}
    </DetailPageLayout>
  );
}

// ── one KPI card — reads its backing tile aggregate + freshness; deep-links into the owner queue ──────
function KpiTile({ tile }: { tile: TileDescriptor }): JSX.Element {
  const client = useApiClient();
  const [result, setResult] = useState<TileReadResult | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const { data, error: err } = await client.GET("/api/v1/reporting/tiles/{tileKey}", {
      params: { path: { tileKey: tile.tileKey } },
    });
    if (err) {
      setFailed(true);
      return;
    }
    setResult(data as unknown as TileReadResult);
  }, [client, tile.tileKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // The KPI deep-links to the owner module via the drilldown emit (consent-narrowed navigation, D6/D16).
  const onSelect = useCallback(async () => {
    if (!result?.drilldownUrlTemplate) return;
    const { data, error: err } = await client.POST("/api/v1/reporting/drilldown/emit", {
      body: { tileKey: tile.tileKey, dimensionContext: {} } as never,
    });
    if (err) return;
    const res = data as unknown as { targetUrl?: string; outcome?: string };
    if (res?.targetUrl && res.outcome === "emitted") window.location.assign(res.targetUrl);
  }, [client, result, tile.tileKey]);

  const value = failed ? "—" : (result?.rowCount ?? "…");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minWidth: "12rem" }}>
      <KpiCard
        label={tile.displayName ?? tile.tileKey}
        value={value}
        onSelect={result?.drilldownUrlTemplate ? () => void onSelect() : undefined}
      />
      {result ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", paddingLeft: "0.25rem" }}>
          <StatusPill
            label={freshnessSecondsLabel(result.dataFreshnessSeconds)}
            tone={freshnessSecondsTone(result.dataFreshnessSeconds)}
          />
          <span className="tabular-nums" style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
            {asOfLabel(result.asOf)} · {statusLabel(result.scopeApplied.scopeKind)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
