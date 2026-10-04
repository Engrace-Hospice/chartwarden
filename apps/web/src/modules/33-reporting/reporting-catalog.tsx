import {
  EmptyState,
  Glyph,
  type GlyphName,
  KpiCard,
  LoadingSpinner,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/33-reporting — Reports & Analytics landing (M33 §5.1.2 `/reports`, Track B /
// ADR-0030; 2026-09-25 redesign, mockup "Reports"). Headline cards, category tabs, and one catalog table of
// what can be reported on: the report datasets (GET /reporting/bases — name, domain, description) and the
// dashboards in scope (GET /reporting/dashboards). A dataset's "last run" is its materialized view's last
// refresh (GET /reporting/admin/mvs, admin-only), and "Run" refreshes that view; a dashboard opens.
// The per-metric reporting seam still returns deny-stubs, so the cards read the operational rollups
// directly (census, admissions, A/R, paid claims), each gated by its own permission. No history is kept,
// so there are no sparklines or period trends. Catalog reads are metadata only (no PHI, D6); the server
// is the only authz point (ADR-0030).
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import { lagLabel, lagTone } from "./reporting-status";

interface DashboardSummary {
  dashboardId: string;
  displayName: string;
  authorship: "system" | "tenant";
  tileCount: number;
  shareScope: "private" | "role" | "org";
  isOrgDefault: boolean;
}
interface ReportBase {
  baseKey: string;
  displayName: string;
  domain: string;
  description: string;
  mvKey: string;
  status: string;
}
interface MvMetadata {
  mvKey: string;
  lastRefreshedAt: string | null;
  refreshFailureCount: number;
  status: string;
}
interface ReplicaLag {
  lagSeconds: number;
  breakerOpen: boolean;
}
type Load<T> = T | null | "error";

type Category = "clinical" | "operational" | "financial" | "quality" | "compliance";
const CATEGORIES: { key: "" | Category; label: string }[] = [
  { key: "", label: "All" },
  { key: "operational", label: "Operational" },
  { key: "clinical", label: "Clinical" },
  { key: "financial", label: "Financial" },
  { key: "quality", label: "Quality" },
  { key: "compliance", label: "Compliance" },
];
const DOMAIN_CATEGORY: Record<string, Category> = {
  census: "operational",
  productivity: "operational",
  admissions: "operational",
  scheduling: "operational",
  evv: "compliance",
  compliance: "compliance",
  hope: "quality",
  quality: "quality",
  hqrp: "quality",
  cahps: "quality",
  clinical: "clinical",
  care_plan: "clinical",
  encounters: "clinical",
  bereavement: "clinical",
  billing: "financial",
  claims: "financial",
  cap: "financial",
  cost_report: "financial",
  remittance: "financial",
};
const categoryOf = (domain: string): Category => DOMAIN_CATEGORY[domain] ?? "operational";
const CATEGORY_LABEL: Record<Category, string> = {
  clinical: "Clinical",
  operational: "Operational",
  financial: "Financial",
  quality: "Quality",
  compliance: "Compliance",
};

interface CatalogRow {
  id: string;
  kind: "dataset" | "dashboard";
  name: string;
  description: string;
  category: Category | null;
  mvKey?: string;
  dashboardId?: string;
}

const wholeDollars = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
const lastRun = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export function ReportingCatalog(): JSX.Element {
  const client = useApiClient();
  const permissions = useSession()?.permissions ?? [];
  const can = (key: string): boolean => permissions.includes(key);
  const canAdmin = can("report.admin.mv_list");
  const canRefresh = can("report.admin.mv_refresh");
  const permKey = permissions.join(",");

  const [dashboards, setDashboards] = useState<Load<DashboardSummary[]>>(null);
  const [bases, setBases] = useState<Load<ReportBase[]>>(null);
  const [mvs, setMvs] = useState<Map<string, MvMetadata> | null>(null);
  const [lag, setLag] = useState<ReplicaLag | null>(null);
  const [census, setCensus] =
    useState<Load<{ total: number; byStatus: Record<string, number> }>>(null);
  const [admissions, setAdmissions] = useState<Load<number>>(null);
  const [aging, setAging] = useState<Load<number>>(null);
  const [paid, setPaid] = useState<Load<{ count: number; cents: number }>>(null);
  const [tab, setTab] = useState<"" | Category>("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mvKey, setMvKey] = useState(0);

  useEffect(() => {
    const has = (k: string): boolean => permKey.split(",").includes(k);
    let active = true;
    const run = <T,>(
      p: Promise<{ data?: unknown; error?: unknown }>,
      set: (v: Load<T>) => void,
      pick: (d: unknown) => T,
    ) =>
      p
        .then((r) => active && set(r.error ? "error" : pick(r.data)))
        .catch(() => active && set("error"));
    void run<DashboardSummary[]>(
      client.GET("/api/v1/reporting/dashboards", { params: { query: { limit: 100 } } }),
      setDashboards,
      (d) => ((d as { items?: DashboardSummary[] })?.items ?? []) as DashboardSummary[],
    );
    void run<ReportBase[]>(
      client.GET("/api/v1/reporting/bases" as never, {} as never),
      setBases,
      (d) => ((d as { items?: ReportBase[] })?.items ?? []).filter((b) => b.status === "active"),
    );
    void client
      .GET("/api/v1/reporting/admin/lag")
      .then((r) => active && !r.error && setLag(r.data as unknown as ReplicaLag))
      .catch(() => undefined);
    if (has("patient.read"))
      void run(
        client.GET("/api/v1/patients/census-metrics" as never, {} as never),
        setCensus,
        (d) => d as { total: number; byStatus: Record<string, number> },
      );
    else setCensus("error");
    if (has("admission.read"))
      void run<number>(
        client.GET("/api/v1/admissions", { params: { query: { limit: 50 } } } as never),
        setAdmissions,
        (d) =>
          (((d as { items?: { state: string }[] })?.items ?? []) as { state: string }[]).filter(
            (a) =>
              ![
                "active",
                "on_hold",
                "discharged",
                "revoked",
                "transferred",
                "deceased",
                "closed",
              ].includes(a.state),
          ).length,
      );
    else setAdmissions("error");
    if (has("billing.claim.read_ar_dashboard")) {
      void run<number>(client.GET("/api/v1/billing/ar-dashboard"), setAging, (d) => {
        const a = d as Record<string, number>;
        return (
          (a.bucket0to30Cents ?? 0) +
          (a.bucket31to60Cents ?? 0) +
          (a.bucket61to90Cents ?? 0) +
          (a.bucket90PlusCents ?? 0)
        );
      });
      void run<{ count: number; cents: number }>(
        client.GET("/api/v1/billing/metrics"),
        setPaid,
        (d) => {
          const b = (
            (d as { buckets?: { key: string; count: number; amountCents: number }[] })?.buckets ??
            []
          ).filter((x) => x.key === "paid" || x.key === "partial_paid");
          return {
            count: b.reduce((n, x) => n + x.count, 0),
            cents: b.reduce((n, x) => n + x.amountCents, 0),
          };
        },
      );
    } else {
      setAging("error");
      setPaid("error");
    }
    return () => {
      active = false;
    };
  }, [client, permKey]);

  // Refresh telemetry for the datasets (admin read; re-read after a Run).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mvKey re-reads after a refresh.
  useEffect(() => {
    if (!canAdmin) return;
    let active = true;
    void client
      .GET("/api/v1/reporting/admin/mvs" as never, {} as never)
      .then((r) => {
        if (!active || r.error) return;
        const items = ((r.data as { items?: MvMetadata[] })?.items ?? []) as MvMetadata[];
        setMvs(new Map(items.map((m) => [m.mvKey, m])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, canAdmin, mvKey]);

  const rows = useMemo<CatalogRow[]>(() => {
    const out: CatalogRow[] = [];
    for (const b of Array.isArray(bases) ? bases : [])
      out.push({
        id: `b:${b.baseKey}`,
        kind: "dataset",
        name: b.displayName,
        description: b.description,
        category: categoryOf(b.domain),
        mvKey: b.mvKey,
      });
    for (const d of Array.isArray(dashboards) ? dashboards : [])
      out.push({
        id: `d:${d.dashboardId}`,
        kind: "dashboard",
        name: d.displayName,
        description: `${d.authorship === "system" ? "Standard" : "Custom"} dashboard · ${d.tileCount} tiles · shared with ${
          d.shareScope === "org"
            ? "the organization"
            : d.shareScope === "role"
              ? "a role"
              : "you only"
        }${d.isOrgDefault ? " · org default" : ""}`,
        category: null,
        dashboardId: d.dashboardId,
      });
    return out;
  }, [bases, dashboards]);

  const q = search.trim().toLowerCase();
  const inTab = (r: CatalogRow, key: "" | Category) => !key || r.category === key;
  const visible = rows.filter(
    (r) =>
      inTab(r, tab) &&
      (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)),
  );
  const loading = bases === null || dashboards === null;
  const failed = bases === "error" && dashboards === "error";

  async function refresh(key: string): Promise<void> {
    setBusy(key);
    setNotice(null);
    const r = await client
      .POST("/api/v1/reporting/admin/mvs/{mvKey}/refresh", { params: { path: { mvKey: key } } })
      .catch(() => ({ error: true }));
    setBusy(null);
    setNotice(
      r.error
        ? "The refresh could not be started."
        : "Refresh queued. Last Run updates once the reporting worker finishes it.",
    );
    setMvKey((k) => k + 1);
  }

  const activeCensus =
    census && census !== "error" ? (census.byStatus.active ?? census.total) : null;

  return (
    <div className="wx-reports">
      <header className="wx-page-head">
        <div>
          <h1 style={{ fontSize: "1.875rem" }}>Reports &amp; Analytics</h1>
          <p>Operational, clinical, and financial insights.</p>
        </div>
        <div style={{ display: "flex", gap: "0.625rem" }}>
          {can("report.schedule.list") ? (
            <Link to="/reports/schedules" className="wx-btn-secondary">
              <Glyph name="calendar" size={16} /> Schedules
            </Link>
          ) : null}
          {canAdmin ? (
            <Link to="/reports/admin" className="wx-btn-secondary">
              <Glyph name="settings" size={16} /> Reporting Admin
            </Link>
          ) : null}
        </div>
      </header>

      <div className="wx-stat-grid" aria-label="Headline figures">
        <Kpi
          icon="users"
          label="Census"
          value={census === null ? null : (activeCensus ?? "—")}
          hint={
            census === "error"
              ? "Not in your access"
              : census
                ? `${census.byStatus.prospective ?? 0} prospective · ${census.total} total`
                : ""
          }
        />
        <Kpi
          icon="user-plus"
          label="Admissions in Progress"
          value={admissions === null ? null : admissions === "error" ? "—" : admissions}
          hint={admissions === "error" ? "Not in your access" : "Not yet active"}
          color="var(--color-viz-violet)"
        />
        <Kpi
          icon="receipt"
          label="Open A/R"
          value={aging === null ? null : aging === "error" ? "—" : wholeDollars(aging)}
          hint={aging === "error" ? "Not in your access" : "All aging buckets"}
          color="var(--color-viz-teal)"
        />
        <Kpi
          icon="dollar"
          label="Paid Claims"
          value={paid === null ? null : paid === "error" ? "—" : wholeDollars(paid.cents)}
          hint={paid === "error" ? "Not in your access" : paid ? `${paid.count} claims` : ""}
          color={t.success}
        />
      </div>

      <div className="wx-reports-toolbar">
        <fieldset className="wx-seg">
          <legend className="wx-sr-only">Report category</legend>
          {CATEGORIES.map((c) => (
            <button
              key={c.key || "all"}
              type="button"
              aria-pressed={tab === c.key}
              className={tab === c.key ? "is-selected" : undefined}
              onClick={() => setTab(c.key)}
            >
              {c.label}
              <span className="wx-seg-count wx-nums">
                {rows.filter((r) => inTab(r, c.key)).length}
              </span>
            </button>
          ))}
        </fieldset>
        <label className="wx-search-field">
          <Glyph name="search" size={16} />
          <input
            type="search"
            aria-label="Search reports"
            placeholder="Search reports…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      {notice ? (
        <output className="wx-home-degraded" style={{ display: "block" }}>
          {notice}
        </output>
      ) : null}

      {loading ? (
        <div className="wx-list-state">
          <LoadingSpinner />
        </div>
      ) : failed ? (
        <div className="wx-list-state">
          <EmptyState
            title="Reports unavailable"
            description="The report catalog could not be loaded."
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="wx-list-state">
          <EmptyState
            title={rows.length === 0 ? "No reports yet" : "No matching reports"}
            description={
              rows.length === 0
                ? "No report datasets or dashboards are available in your scope."
                : "Try another category or search."
            }
          />
        </div>
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Reports</caption>
            <thead>
              <tr>
                <th>Report Name</th>
                <th>Description</th>
                <th>Category</th>
                <th>Last Run</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const mv = r.mvKey ? mvs?.get(r.mvKey) : undefined;
                return (
                  <tr key={r.id}>
                    <td>
                      <div className="wx-row-title">{r.name}</div>
                      <div className="wx-row-sub">
                        {r.kind === "dataset" ? "Dataset" : "Dashboard"}
                      </div>
                    </td>
                    <td>
                      <div
                        className="wx-row-sub"
                        style={{ fontSize: "0.8125rem", maxWidth: "30rem" }}
                      >
                        {r.description}
                      </div>
                    </td>
                    <td>{r.category ? CATEGORY_LABEL[r.category] : "Dashboard"}</td>
                    <td className="wx-nums">
                      {r.kind === "dashboard" ? (
                        "Live"
                      ) : !canAdmin ? (
                        <span title="Refresh times are visible to reporting admins">—</span>
                      ) : mv === undefined ? (
                        "…"
                      ) : mv.lastRefreshedAt ? (
                        <>
                          {lastRun(mv.lastRefreshedAt)}
                          {mv.refreshFailureCount > 0 ? (
                            <>
                              {" "}
                              <StatusPill label={`${mv.refreshFailureCount} failed`} tone="error" />
                            </>
                          ) : null}
                        </>
                      ) : (
                        "Never"
                      )}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {r.kind === "dashboard" ? (
                        <Link
                          to={`/reports/dashboards/${r.dashboardId}`}
                          className="wx-action-link"
                        >
                          <Glyph name="arrow-right" size={15} /> Open
                        </Link>
                      ) : canRefresh && r.mvKey ? (
                        <button
                          type="button"
                          className="wx-action-link"
                          disabled={busy === r.mvKey}
                          onClick={() => void refresh(r.mvKey!)}
                        >
                          <Glyph name="play" size={15} /> {busy === r.mvKey ? "Running…" : "Run"}
                        </button>
                      ) : (
                        <span className="wx-row-sub">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="wx-table-footer">
            <span className="wx-nums">
              {visible.length} {visible.length === 1 ? "report" : "reports"}
            </span>
            {lag ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                Reporting data
                <StatusPill
                  label={lagLabel(lag.lagSeconds, lag.breakerOpen)}
                  tone={lagTone(lag.lagSeconds, lag.breakerOpen)}
                />
              </span>
            ) : null}
          </div>
        </div>
      )}
      <p className="wx-row-sub" style={{ margin: 0, fontSize: "0.75rem" }}>
        Run refreshes a dataset from the live record. Headline figures are current totals; no
        history is kept, so there are no trends.
      </p>
    </div>
  );
}

// The shared stat card (label · value · detail), like every other summary row in the app.
function Kpi({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: GlyphName;
  label: string;
  value: string | number | null;
  hint: string;
  color?: string;
}): JSX.Element {
  return (
    <KpiCard icon={icon} accentColor={color} label={label} value={value ?? "…"} detail={hint} />
  );
}
