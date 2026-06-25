import {
  CountdownChip,
  DashboardLayout,
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/10-hope — HOPE timepoint dashboard (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Dashboard."
// The operational hub: four counters (Open, Closing 48h, Late, Expired) over the org's open HOPE
// schedules, each clickable to filter, above the schedule worklist sorted by window-close. Window state
// (green/amber/red/grey) is derived client-side as a UX cue only — the SERVER is authoritative for status
// (ADR-0030, no frontend authz). Reads GET /api/v1/hope/schedules via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { BUCKET_TONE, rfaLabel, stateLabel } from "./hope-status";

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
    const { data, error: err } = await client.GET("/api/v1/hope/schedules", {
      params: { query: {} },
    });
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
          <KpiCard
            label="Closing 48h"
            value={counts.closing}
            onSelect={() => setFilter("closing")}
          />
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
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            {filter ? `Filtered: ${stateLabel(filter)}` : "All open schedules"}
          </span>
        </FilterBar>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No HOPE schedules"
            description="No timepoint windows match the current filter."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>RFA</th>
                <th>Window closes</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, bucket }) => (
                <tr
                  key={row.id}
                  // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/patients/${row.patientId}/hope`)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      navigate(`/patients/${row.patientId}/hope`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td>{rfaLabel(row.rfaKind)}</td>
                  <td>
                    {/* §2.2.1 window — count down to close; warning at 48h, alert at 12h, overdue when late. */}
                    <CountdownChip dueAt={row.windowClosesAt} warnWithinHours={48} label="Closes" />
                  </td>
                  <td>
                    <StatusPill
                      label={stateLabel(bucket)}
                      tone={BUCKET_TONE[bucket] ?? "neutral"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
