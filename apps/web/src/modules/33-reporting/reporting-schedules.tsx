import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import type { paths } from "@chartwarden/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the SCHEDULE MANAGEMENT queue (R2).
// Spec §5.1.6 (`/reports/schedules`) — the scheduled-delivery pipeline (D7): list schedules (My
// Schedules / Affecting Me tabs), then read a selected schedule's run ledger. Backed by GET
// /api/v1/reporting/schedules (cursor-paginated) + GET /api/v1/reporting/schedules/{id}/runs via the
// generated typed client; reads run under withOrgContext server-side (the M4 §164.312(b) anchor).
// Create / pause / resume / cancel / retry are command (POST) routes, deferred to the action phase.
// Lantern: No-Line tables, primary-tint selected row, mono ids (wx-data-md), tabular-nums dates,
// CSS-var tokens only. Run/schedule status pills resolve through the §6.6 tone map (reporting-status.ts).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
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
      header={
        <PageHeader title="Scheduled Reports">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Manage report delivery schedules and inspect the run ledger for a selected schedule.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              {error}
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div role="tablist" aria-label="Schedule scope" style={tabListStyle}>
              <TabButton active={tab === "mine"} onClick={() => setTab("mine")}>
                My Schedules
              </TabButton>
              <TabButton active={tab === "affecting"} onClick={() => setTab("affecting")}>
                Affecting Me
              </TabButton>
            </div>
            <label className="wx-filter-field">
              <span>Status</span>
              <select
                className="wx-select"
                aria-label="Schedule status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={selectStyle}
              >
                <option value="">All</option>
                {["active", "paused", "cancelled"].map((s) => (
                  <option key={s} value={s}>
                    Status: {statusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void load()} style={buttonStyle}>
              Refresh
            </button>
          </div>
        </div>
      }
      table={
        <div style={contentShellStyle}>
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
      fullPageScroll
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
        borderRadius: "var(--radius-md)",
        border: "none",
        padding: "0.45rem 0.75rem",
        cursor: "pointer",
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
    <div style={tableShellStyle}>
      <table style={tableStyle}>
        <thead>
          <tr style={tableHeadRowStyle}>
            <th style={thStyle}>Schedule</th>
            <th style={thStyle}>Cron</th>
            <th style={thStyle}>Format</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Recipients</th>
            <th style={thStyle}>Next run</th>
            <th style={thStyle}>Status</th>
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
                borderTop: "1px solid var(--color-surface-container)",
              }}
            >
              <td className="wx-data-md" style={tdStyle}>
                {s.id.slice(0, 8)}
              </td>
              <td className="wx-data-md" style={tdStyle}>
                {s.cronExpression}
              </td>
              <td style={tdStyle}>{s.format.toUpperCase()}</td>
              <td className="tabular-nums" style={{ ...tdStyle, textAlign: "right" }}>
                {s.recipientMembershipIds.length}
              </td>
              <td className="tabular-nums" style={tdStyle}>
                {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
              </td>
              <td style={tdStyle}>
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
    <section style={ledgerShellStyle}>
      <h2 style={sectionTitleStyle}>
        Run history · <span className="wx-data-md">{scheduleId.slice(0, 8)}</span>
      </h2>
      {loading ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : runs.length === 0 ? (
        <EmptyState title="No runs" description="This schedule has no run history yet." />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={tableHeadRowStyle}>
              <th style={thStyle}>Scheduled for</th>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Rows</th>
              <th style={thStyle}>Finished</th>
              <th style={thStyle}>Document</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--color-surface-container)" }}>
                <td className="tabular-nums" style={tdStyle}>
                  {new Date(r.scheduledFor).toLocaleString()}
                </td>
                <td style={tdStyle}>
                  <StatusPill label={statusLabel(r.status)} tone={runTone(r.status)} />
                </td>
                <td className="tabular-nums" style={{ ...tdStyle, textAlign: "right" }}>
                  {r.rowCount ?? "—"}
                </td>
                <td className="tabular-nums" style={tdStyle}>
                  {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "—"}
                </td>
                <td className="wx-data-md" style={tdStyle}>
                  {r.documentId ? r.documentId.slice(0, 8) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.5rem",
};

const tabListStyle: CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  background: "var(--color-surface-container)",
  padding: "0.2rem",
  borderRadius: "var(--radius-md)",
};

const selectStyle: CSSProperties = {
  minHeight: "2.25rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  cursor: "pointer",
  fontSize: "0.85rem",
  padding: "0.35rem 0.65rem",
};

const buttonStyle: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.82rem",
  fontWeight: 600,
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};

const contentShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1.5rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const thStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  verticalAlign: "top",
  color: "var(--color-on-surface)",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const ledgerShellStyle: CSSProperties = {
  padding: "0 1.5rem 1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
