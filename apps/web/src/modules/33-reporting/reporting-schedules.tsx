import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the SCHEDULE MANAGEMENT queue (R2).
// Spec §5.1.6 (`/reports/schedules`) — the scheduled-delivery pipeline (D7): list schedules (My
// Schedules / Affecting Me tabs), then read a selected schedule's run ledger. Backed by GET
// /api/v1/reporting/schedules (cursor-paginated) + GET /api/v1/reporting/schedules/{id}/runs via the
// generated typed client; reads run under withOrgContext server-side (the M4 §164.312(b) anchor).
// Create / pause / resume / cancel / retry are command (POST) routes, deferred to the action phase.
// Lantern: No-Line tables, primary-tint selected row, mono ids (wx-data-md), tabular-nums dates,
// CSS-var tokens only. Run/schedule status pills resolve through the §6.6 tone map (reporting-status.ts).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { runTone, scheduleTone, statusLabel } from "./reporting-status";

type Tab = "mine" | "affecting";

interface ScheduleView {
  id: string;
  organizationId: string;
  reportViewId: string;
  ownerMembershipId: string;
  cronExpression: string;
  tenantTimezone: string;
  format: "pdf" | "xlsx" | "csv";
  recipientMembershipIds: string[];
  deliveryChannel: "in_app";
  nextRunAt: string | null;
  status: "active" | "paused" | "cancelled";
  createdAt: string;
  cancelledAt: string | null;
}

interface ScheduleRunView {
  id: string;
  scheduleId: string;
  organizationId: string;
  scheduledFor: string;
  status: "queued" | "running" | "rendered_pending" | "rendered_complete" | "delivered" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  documentId: string | null;
  failureReason: string | null;
  rowCount: number | null;
}

interface SchedulePage {
  items: ScheduleView[];
  nextCursor: string | null;
  hasMore: boolean;
}
interface RunPage {
  items: ScheduleRunView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function ReportingSchedules(): JSX.Element {
  const client = useApiClient();
  const [tab, setTab] = useState<Tab>("mine");
  const [statusFilter, setStatusFilter] = useState("");
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: NonNullable<paths["/api/v1/reporting/schedules"]["get"]["parameters"]["query"]> = {
      limit: 50,
    };
    if (statusFilter) query.status = statusFilter as typeof query.status;
    const { data, error: err } = await client.GET("/api/v1/reporting/schedules", {
      params: { query },
    });
    if (err) {
      setError("Schedules unavailable.");
      setLoading(false);
      return;
    }
    const page = data as unknown as SchedulePage | undefined;
    setSchedules((page?.items ?? []) as ScheduleView[]);
    setLoading(false);
  }, [client, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Scheduled Reports" breadcrumb="Reporting & Analytics" />}
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          }
        >
          <div
            role="tablist"
            aria-label="Schedule scope"
            style={{ display: "flex", gap: "0.25rem" }}
          >
            <TabButton active={tab === "mine"} onClick={() => setTab("mine")}>
              My Schedules
            </TabButton>
            <TabButton active={tab === "affecting"} onClick={() => setTab("affecting")}>
              Affecting Me
            </TabButton>
          </div>
          <select
            aria-label="Schedule status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {["active", "paused", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </FilterBar>
      }
      table={
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <ScheduleTable
            schedules={schedules}
            loading={loading}
            error={error}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          {selectedId ? <RunLedger scheduleId={selectedId} /> : null}
        </div>
      }
    />
  );
}

function TabButton({
  active,
  onClick,
  children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        fontSize: "0.8rem",
        fontWeight: active ? 600 : 400,
        color: active ? "var(--color-on-surface)" : "var(--color-on-surface-variant)",
        background: active ? "var(--color-primary-tint)" : "transparent",
        borderRadius: "var(--radius-md, 0.5rem)",
        padding: "0.25rem 0.75rem",
      }}
    >
      {children}
    </button>
  );
}

function ScheduleTable({
  schedules,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  schedules: ScheduleView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (schedules.length === 0)
    return (
      <EmptyState title="No schedules" description="No scheduled reports match this filter." />
    );
  return (
    <div style={{ padding: "0 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Schedule</th>
            <th>Cron</th>
            <th>Format</th>
            <th>Recipients</th>
            <th>Next run</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr
              key={s.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable row → reveals run ledger.
              role="button"
              tabIndex={0}
              aria-pressed={s.id === selectedId}
              onClick={() => onSelect(s.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(s.id);
                }
              }}
              style={{
                cursor: "pointer",
                background: s.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td className="wx-data-md">{s.id.slice(0, 8)}</td>
              <td className="wx-data-md">{s.cronExpression}</td>
              <td>{s.format.toUpperCase()}</td>
              <td className="tabular-nums">{s.recipientMembershipIds.length}</td>
              <td className="tabular-nums">
                {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
              </td>
              <td>
                <StatusPill label={statusLabel(s.status)} tone={scheduleTone(s.status)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── run ledger for the selected schedule (last-90-day run history) ────────────────────────────────────
function RunLedger({ scheduleId }: { scheduleId: string }): JSX.Element {
  const client = useApiClient();
  const [runs, setRuns] = useState<ScheduleRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/reporting/schedules/{id}/runs", {
      params: { path: { id: scheduleId } },
    });
    if (err) {
      setError("Run history unavailable.");
      setLoading(false);
      return;
    }
    const page = data as unknown as RunPage | undefined;
    setRuns((page?.items ?? []) as ScheduleRunView[]);
    setLoading(false);
  }, [client, scheduleId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      style={{
        padding: "0 1.5rem 1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: "0.6875rem",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-on-surface-variant)",
        }}
      >
        Run history · <span className="wx-data-md">{scheduleId.slice(0, 8)}</span>
      </h2>
      {loading ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : runs.length === 0 ? (
        <EmptyState title="No runs" description="This schedule has no run history yet." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Scheduled for</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Finished</th>
              <th>Document</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="tabular-nums">{new Date(r.scheduledFor).toLocaleString()}</td>
                <td>
                  <StatusPill label={statusLabel(r.status)} tone={runTone(r.status)} />
                </td>
                <td className="tabular-nums">{r.rowCount ?? "—"}</td>
                <td className="tabular-nums">
                  {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "—"}
                </td>
                <td className="wx-data-md">{r.documentId ? r.documentId.slice(0, 8) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
