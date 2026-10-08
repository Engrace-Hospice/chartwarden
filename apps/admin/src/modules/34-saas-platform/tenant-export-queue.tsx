import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — tenant-export queue (M34 SaaS Tenant Platform, R2 Phase-3).
// Route: /exports/tenant. The org-scoped full-tenant-export queue (D9 — the NDJSON-per-table + PDFs +
// manifest.json archive used for migration / BAA-termination / compliance-audit / surveyor requests).
// One row per export job. Backed by GET /api/v1/tenant/tenant-export-jobs (tenant-scoped). Filters by
// status + purpose (purpose is filtered client-side; the list route filters server-side on status).
// requiredPermission: `tenant_export.list_own`. Laid out as the redesign's list + right drawer (outbox
// is the reference).
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
const purposeLabel = (p: Purpose): string => cap(p.replace(/_/g, " "));
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  ...STATUSES.map((s) => ({ value: s, label: cap(s) })),
];
const PURPOSE_OPTIONS = [
  { value: "", label: "All purposes" },
  ...PURPOSES.map((p) => ({ value: p, label: purposeLabel(p) })),
];

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
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Tenant exports</h1>
            <p>Full-tenant archive jobs for migration, BAA termination, audits and surveyors.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button tone="secondary" onClick={() => void load()}>
              Apply
            </Button>
          </div>
        </header>

        <div className="wx-list-toolbar">
          <div className="grid w-full gap-3 md:grid-cols-2">
            <SelectField
              label="Status"
              value={status}
              options={STATUS_OPTIONS}
              onChange={(e) => setStatus(e.target.value as Status | "")}
            />
            <SelectField
              label="Purpose"
              value={purpose}
              options={PURPOSE_OPTIONS}
              onChange={(e) => setPurpose(e.target.value as Purpose | "")}
            />
          </div>
        </div>

        <ExportTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onRetry={() => void load()}
        />
      </div>
      {selected ? <ExportDrawer job={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function ExportTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: TenantExportJob[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (j: TenantExportJob) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading the tenant-export queue…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="package" size={24} />
        <span>No tenant-export jobs match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Tenant export jobs</caption>
        <thead>
          <tr>
            <th scope="col">Purpose</th>
            <th scope="col">Status</th>
            <th scope="col">Requested</th>
            <th scope="col">Fulfilled</th>
            <th scope="col" className="wx-num-col">
              Bundle size
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((j) => {
            const isSelected = j.id === selectedId;
            return (
              <tr
                key={j.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                tabIndex={0}
                aria-selected={isSelected}
                onClick={() => onSelect(j)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(j);
                  }
                }}
              >
                <td>
                  <span className="wx-row-title">{purposeLabel(j.requestedPurpose)}</span>
                  <span className="wx-row-sub wx-data-md">{j.id.slice(0, 8)}</span>
                </td>
                <td>
                  <StatusPill
                    label={cap(j.status)}
                    tone={TENANT_EXPORT_TONE[j.status] ?? "neutral"}
                  />
                </td>
                <td className="wx-nums">{new Date(j.requestedAt).toLocaleDateString()}</td>
                <td className="wx-nums">
                  {j.fulfilledAt ? new Date(j.fulfilledAt).toLocaleDateString() : "—"}
                </td>
                <td className="wx-num-col wx-nums">{formatBytes(j.bundleSizeBytes)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExportDrawer({
  job,
  onClose,
}: { job: TenantExportJob; onClose: () => void }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="Export job">
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="package" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>Export job</h2>
          <span className="wx-row-sub wx-data-md">{job.id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Archive</h3>
            <StatusPill
              label={cap(job.status)}
              tone={TENANT_EXPORT_TONE[job.status] ?? "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Job id</dt>
            <dd className="wx-data-md break-words">{job.id}</dd>
            <dt>Purpose</dt>
            <dd>{purposeLabel(job.requestedPurpose)}</dd>
            <dt>Requested at</dt>
            <dd className="wx-nums">{new Date(job.requestedAt).toLocaleString()}</dd>
            {job.fulfilledAt ? (
              <>
                <dt>Fulfilled at</dt>
                <dd className="wx-nums">{new Date(job.fulfilledAt).toLocaleString()}</dd>
              </>
            ) : null}
            <dt>Bundle size</dt>
            <dd className="wx-nums">{formatBytes(job.bundleSizeBytes)}</dd>
          </dl>
        </section>
      </div>
    </aside>
  );
}
