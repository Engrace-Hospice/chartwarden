import {
  CountdownChip,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  MaskedIdentifier,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — DSAR queue (M34 SaaS Tenant Platform, R2 Phase-3).
// Route: /exports/dsar. The HIPAA §164.524 right-of-access queue — one row per data-subject-access
// export job, with the 30-day fulfillment SLA rendered as a CountdownChip so aging is legible at a
// glance. Backed by GET /api/v1/tenant/dsar-export-jobs (the tenant-scoped DSAR surface; there is no
// platform-wide DSAR list route — §164.524 is tenant/org-scoped, D9). Filters by patient + status.
// requiredPermission: `dsar_export.list_own`. Mirrors the M40/M36 R1 work-queue exemplars exactly:
// useApiClient + client.GET, @wardenx/ui primitives, No-Line table, primary-tint selected rows, mono
// identifiers (wx-data-md), tabular numerics, CSS-var tokens only (zero hardcoded hex).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { DSAR_TONE, cap } from "./saas-status";

// The §164.524 DSAR job view (mirrors the backend DsarExportJobViewSchema).
interface DsarExportJob {
  id: string;
  patientId: string;
  requestSource: "patient" | "caregiver" | "legal_representative" | "authorized_third_party";
  status: "requested" | "generating" | "review_pending" | "fulfilled" | "denied" | "extended";
  requestedAt: string;
  slaDueAt: string;
  extendedUntil: string | null;
  fulfilledAt: string | null;
  deniedReason: string | null;
  createdAt: string;
}
interface DsarListPage {
  items: DsarExportJob[];
  nextCursor: string | null;
  hasMore: boolean;
}

// The backend DSAR_STATUS enum (tenant-typebox) — UI owns its copy of the wire enum for the filter.
const STATUSES = [
  "requested",
  "generating",
  "review_pending",
  "fulfilled",
  "denied",
  "extended",
] as const;
type Status = (typeof STATUSES)[number];

// A job is still "open" (the SLA clock is live) until it reaches a terminal state.
const isOpen = (s: DsarExportJob["status"]): boolean => s !== "fulfilled" && s !== "denied";
// The effective deadline: a granted one-time §164.524 extension moves the clock to extendedUntil.
const effectiveDue = (j: DsarExportJob): string => j.extendedUntil ?? j.slaDueAt;

export function DsarQueue(): JSX.Element {
  const client = useApiClient();
  const [patientId, setPatientId] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [items, setItems] = useState<DsarExportJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DsarExportJob | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(null);
    const query: NonNullable<
      paths["/api/v1/tenant/dsar-export-jobs"]["get"]["parameters"]["query"]
    > = { limit: 50 };
    if (patientId.trim()) query.patientId = patientId.trim();
    if (status) query.status = status as typeof query.status;
    const { data, error: err } = await client.GET("/api/v1/tenant/dsar-export-jobs", {
      params: { query },
    });
    if (err) {
      setError("Could not load the DSAR queue.");
      setLoading(false);
      return;
    }
    setItems(((data as DsarListPage | undefined)?.items ?? []) as DsarExportJob[]);
    setLoading(false);
  }, [client, patientId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="DSAR Queue" breadcrumb="Exports · §164.524 Right of Access" />}
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => void load()}>
              Apply
            </button>
          }
        >
          <input
            aria-label="Filter by patient id"
            placeholder="Patient id"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
          />
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
        </FilterBar>
      }
      table={
        <DsarTable
          items={items}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      }
      detail={
        selected ? <DsarDetail job={selected} onClose={() => setSelected(null)} /> : undefined
      }
    />
  );
}

function DsarTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: DsarExportJob[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (j: DsarExportJob) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No requests" description="No DSAR export jobs match this filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Patient</th>
            <th>Source</th>
            <th>Status</th>
            <th>Requested</th>
            <th>30-day SLA</th>
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
              <td>
                <MaskedIdentifier value={j.patientId} label="Patient" />
              </td>
              <td>{cap(j.requestSource.replace(/_/g, " "))}</td>
              <td>
                <StatusPill label={cap(j.status)} tone={DSAR_TONE[j.status] ?? "neutral"} />
              </td>
              <td className="tabular-nums">{new Date(j.requestedAt).toLocaleDateString()}</td>
              <td>
                {isOpen(j.status) ? (
                  <CountdownChip
                    dueAt={effectiveDue(j)}
                    label="SLA"
                    warnWithinHours={7 * 24}
                    alertWithinHours={2 * 24}
                  />
                ) : (
                  <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DsarDetail({ job, onClose }: { job: DsarExportJob; onClose: () => void }): JSX.Element {
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
          <Glyph name="shield" size={16} />
          DSAR Request
        </span>
      }
      onClose={onClose}
    >
      {row("Job id", <span className="wx-data-md">{job.id}</span>)}
      {row("Patient", <MaskedIdentifier value={job.patientId} label="Patient" />)}
      {row("Request source", cap(job.requestSource.replace(/_/g, " ")))}
      {row(
        "Status",
        <StatusPill label={cap(job.status)} tone={DSAR_TONE[job.status] ?? "neutral"} />,
      )}
      {row(
        "Requested at",
        <span className="tabular-nums">{new Date(job.requestedAt).toLocaleString()}</span>,
      )}
      {row(
        "§164.524 SLA due",
        isOpen(job.status) ? (
          <CountdownChip
            dueAt={effectiveDue(job)}
            label="SLA"
            warnWithinHours={7 * 24}
            alertWithinHours={2 * 24}
          />
        ) : (
          <span style={{ color: "var(--color-on-surface-variant)" }}>
            {new Date(effectiveDue(job)).toLocaleDateString()}
          </span>
        ),
      )}
      {job.extendedUntil
        ? row(
            "Extended until",
            <span className="tabular-nums">{new Date(job.extendedUntil).toLocaleString()}</span>,
          )
        : null}
      {job.fulfilledAt
        ? row(
            "Fulfilled at",
            <span className="tabular-nums">{new Date(job.fulfilledAt).toLocaleString()}</span>,
          )
        : null}
      {job.deniedReason ? row("Denied reason", cap(job.deniedReason.replace(/_/g, " "))) : null}
    </RightDetailPanel>
  );
}
