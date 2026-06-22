// apps/web/src/modules/10-hope — HOPE timepoint dashboard (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Dashboard."
// The operational hub: four counters (Open, Closing 48h, Late, Expired) over the org's open HOPE
// schedules, each clickable to filter, above the schedule worklist sorted by window-close. Window state
// (green/amber/red/grey) is derived client-side as a UX cue only — the SERVER is authoritative for status
// (ADR-0030, no frontend authz). Reads GET /api/v1/hope/schedules via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  DashboardLayout,
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface ScheduleRow {
  id: string;
  patientId: string;
  admissionId: string;
  rfaKind: string;
  status: string;
  windowOpensAt: string;
  windowClosesAt: string;
  lateDeadlineAt: string;
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
type Bucket = "" | "open" | "closing" | "late" | "expired";

// Pure window-state derivation — a UX cue only; the server owns the authoritative status.
function bucketOf(row: ScheduleRow, nowMs: number): Exclude<Bucket, ""> {
  if (row.status === "expired") return "expired";
  if (row.status !== "open") return "open"; // completed/skipped fall out of the open worklist filters
  const closes = Date.parse(row.windowClosesAt);
  if (nowMs > closes) return "late";
  if (closes - nowMs <= FORTY_EIGHT_HOURS_MS) return "closing";
  return "open";
}

const bucketColor: Record<Exclude<Bucket, "">, string | undefined> = {
  open: "#15803d",
  closing: "#b45309",
  late: "#b91c1c",
  expired: "#6b7280",
};

export function HopeDashboard(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<ScheduleRow[]>([]);
  const [filter, setFilter] = useState<Bucket>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/hope/schedules", { params: { query: {} } });
    if (err) {
      setError("Could not load HOPE schedules.");
      setLoading(false);
      return;
    }
    setItems((data?.schedules ?? []) as ScheduleRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const nowMs = Date.now();
  const tagged = useMemo(
    () => items.map((r) => ({ row: r, bucket: bucketOf(r, nowMs) })),
    [items, nowMs],
  );
  const counts = useMemo(
    () => ({
      open: tagged.filter((t) => t.bucket === "open").length,
      closing: tagged.filter((t) => t.bucket === "closing").length,
      late: tagged.filter((t) => t.bucket === "late").length,
      expired: tagged.filter((t) => t.bucket === "expired").length,
    }),
    [tagged],
  );

  const rows = useMemo(() => {
    const visible = filter ? tagged.filter((t) => t.bucket === filter) : tagged;
    return [...visible].sort(
      (a, b) => Date.parse(a.row.windowClosesAt) - Date.parse(b.row.windowClosesAt),
    );
  }, [tagged, filter]);

  return (
    <DashboardLayout
      header={<PageHeader title="HOPE Timepoints" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Open" value={counts.open} onSelect={() => setFilter("open")} />
          <KpiCard label="Closing 48h" value={counts.closing} onSelect={() => setFilter("closing")} />
          <KpiCard label="Late" value={counts.late} onSelect={() => setFilter("late")} />
          <KpiCard label="Expired" value={counts.expired} onSelect={() => setFilter("expired")} />
        </KpiStrip>
      }
      charts={
        <FilterBar
          actions={
            <button type="button" onClick={() => setFilter("")}>
              Clear
            </button>
          }
        >
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
            {filter ? `Filtered: ${filter}` : "All open schedules"}
          </span>
        </FilterBar>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No HOPE schedules" description="No timepoint windows match the current filter." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>RFA</th>
                <th style={th}>Window closes</th>
                <th style={th}>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, bucket }) => (
                <tr
                  key={row.id}
                  onClick={() => navigate(`/patients/${row.patientId}/hope`)}
                  style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                >
                  <td style={td}>{row.rfaKind}</td>
                  <td style={td}>{row.windowClosesAt.slice(0, 16).replace("T", " ")}</td>
                  <td style={{ ...td, color: bucketColor[bucket] }}>{bucket}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
