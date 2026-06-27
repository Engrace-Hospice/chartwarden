import {
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — tenant-export queue (M34 SaaS Tenant Platform, R2 Phase-3).
// Route: /exports/tenant. The org-scoped full-tenant-export queue (D9 — the NDJSON-per-table + PDFs +
// manifest.json archive used for migration / BAA-termination / compliance-audit / surveyor requests).
// One row per export job. Backed by GET /api/v1/tenant/tenant-export-jobs (tenant-scoped). Filters by
// status + purpose (purpose is filtered client-side; the list route filters server-side on status).
// requiredPermission: `tenant_export.list_own`. Mirrors the M40/M36 R1 work-queue exemplars exactly.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { TENANT_EXPORT_TONE, cap } from "./saas-status";

// The tenant-export job view (mirrors the backend TenantExportJobViewSchema).
interface TenantExportJob {
  id: string;
  requestedPurpose: "migration" | "baa_termination" | "compliance_audit" | "surveyor_request";
  status: "requested" | "generating" | "fulfilled" | "expired" | "cancelled";
  requestedAt: string;
  fulfilledAt: string | null;
  bundleSizeBytes: number | null;
  createdAt: string;
}
interface TenantExportListPage {
  items: TenantExportJob[];
  nextCursor: string | null;
  hasMore: boolean;
}

// The backend enums (tenant-typebox) — UI owns its copy of the wire enums for the filters.
const STATUSES = ["requested", "generating", "fulfilled", "expired", "cancelled"] as const;
const PURPOSES = ["migration", "baa_termination", "compliance_audit", "surveyor_request"] as const;
type Status = (typeof STATUSES)[number];
type Purpose = (typeof PURPOSES)[number];

// Human-readable archive size (the manifest bundle); null until generated.
function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function TenantExportQueue(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<Status | "">("");
  const [purpose, setPurpose] = useState<Purpose | "">("");
  const [items, setItems] = useState<TenantExportJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TenantExportJob | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(null);
    const query: NonNullable<
      paths["/api/v1/tenant/tenant-export-jobs"]["get"]["parameters"]["query"]
    > = { limit: 50 };
    if (status) query.status = status as typeof query.status;
    const { data, error: err } = await client.GET("/api/v1/tenant/tenant-export-jobs", {
      params: { query },
    });
    if (err) {
      setError("Could not load the tenant-export queue.");
      setLoading(false);
      return;
    }
    setItems(((data as TenantExportListPage | undefined)?.items ?? []) as TenantExportJob[]);
    setLoading(false);
  }, [client, status]);

  useEffect(() => {
    void load();
  }, [load]);

  // Purpose is a client-side filter (the list route filters server-side on status only).
  const visible = useMemo(
    () => (purpose ? items.filter((j) => j.requestedPurpose === purpose) : items),
    [items, purpose],
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Tenant Export Queue" breadcrumb="Exports · Full-tenant archives" />
      }
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => void load()}>
              Apply
            </button>
          }
        >
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status | "")}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as Purpose | "")}
          >
            <option value="">All purposes</option>
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {cap(p.replace(/_/g, " "))}
              </option>
            ))}
          </select>
        </FilterBar>
      }
      table={
        <ExportTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      }
      detail={
        selected ? <ExportDetail job={selected} onClose={() => setSelected(null)} /> : undefined
      }
    />
  );
}

function ExportTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: TenantExportJob[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (j: TenantExportJob) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No exports" description="No tenant-export jobs match this filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Purpose</th>
            <th>Status</th>
            <th>Requested</th>
            <th>Fulfilled</th>
            <th>Bundle size</th>
          </tr>
        </thead>
        <tbody>
          {items.map((j) => (
            <tr
              key={j.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={j.id === selectedId}
              onClick={() => onSelect(j)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(j);
                }
              }}
              style={{
                cursor: "pointer",
                background: j.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td>{cap(j.requestedPurpose.replace(/_/g, " "))}</td>
              <td>
                <StatusPill
                  label={cap(j.status)}
                  tone={TENANT_EXPORT_TONE[j.status] ?? "neutral"}
                />
              </td>
              <td className="tabular-nums">{new Date(j.requestedAt).toLocaleDateString()}</td>
              <td className="tabular-nums">
                {j.fulfilledAt ? new Date(j.fulfilledAt).toLocaleDateString() : "—"}
              </td>
              <td className="tabular-nums">{formatBytes(j.bundleSizeBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportDetail({
  job,
  onClose,
}: { job: TenantExportJob; onClose: () => void }): JSX.Element {
  const row = (label: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.6rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
      <div
        style={{ fontSize: "0.85rem", color: "var(--color-on-surface)", wordBreak: "break-word" }}
      >
        {value}
      </div>
    </div>
  );
  return (
    <RightDetailPanel
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <Glyph name="info" size={16} />
          Export Job
        </span>
      }
      onClose={onClose}
    >
      {row("Job id", <span className="wx-data-md">{job.id}</span>)}
      {row("Purpose", cap(job.requestedPurpose.replace(/_/g, " ")))}
      {row(
        "Status",
        <StatusPill label={cap(job.status)} tone={TENANT_EXPORT_TONE[job.status] ?? "neutral"} />,
      )}
      {row(
        "Requested at",
        <span className="tabular-nums">{new Date(job.requestedAt).toLocaleString()}</span>,
      )}
      {job.fulfilledAt
        ? row(
            "Fulfilled at",
            <span className="tabular-nums">{new Date(job.fulfilledAt).toLocaleString()}</span>,
          )
        : null}
      {row("Bundle size", <span className="tabular-nums">{formatBytes(job.bundleSizeBytes)}</span>)}
    </RightDetailPanel>
  );
}
