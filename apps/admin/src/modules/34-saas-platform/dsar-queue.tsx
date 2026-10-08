import {
  Button,
  CountdownChip,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  MaskedIdentifier,
  SelectField,
  StatusPill,
  TextField,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — DSAR queue (M34 SaaS Tenant Platform, R2 Phase-3).
// Route: /exports/dsar. The HIPAA §164.524 right-of-access queue — one row per data-subject-access
// export job, with the 30-day fulfillment SLA rendered as a CountdownChip so aging is legible at a
// glance. Backed by GET /api/v1/tenant/dsar-export-jobs (the tenant-scoped DSAR surface; there is no
// platform-wide DSAR list route — §164.524 is tenant/org-scoped, D9). Filters by patient + status.
// requiredPermission: `dsar_export.list_own`. Mirrors the M40/M36 R1 work-queue exemplars exactly:
// useApiClient + client.GET, @wardenx/ui primitives, mono identifiers (wx-data-md), tabular numerics,
// laid out as the redesign's list + right drawer (outbox is the reference).
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
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  ...STATUSES.map((s) => ({ value: s, label: cap(s) })),
];
// §164.524 SLA chip thresholds: amber inside a week, red inside two days.
const SLA_WARN_HOURS = 7 * 24;
const SLA_ALERT_HOURS = 2 * 24;

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
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>DSAR exports</h1>
            <p>§164.524 right-of-access export jobs, with the 30-day fulfilment clock.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button tone="secondary" onClick={() => void load()}>
              Apply
            </Button>
          </div>
        </header>

        <div className="wx-list-toolbar">
          <div className="grid w-full gap-3 md:grid-cols-2">
            <TextField
              label="Patient id"
              placeholder="Patient id"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
            />
            <SelectField
              label="Status"
              value={status}
              options={STATUS_OPTIONS}
              onChange={(e) => setStatus(e.target.value as Status | "")}
            />
          </div>
        </div>

        <DsarTable
          items={items}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onRetry={() => void load()}
        />
      </div>
      {selected ? <DsarDrawer job={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function SlaChip({ job }: { job: DsarExportJob }): JSX.Element {
  return (
    <CountdownChip
      dueAt={effectiveDue(job)}
      label="SLA"
      warnWithinHours={SLA_WARN_HOURS}
      alertWithinHours={SLA_ALERT_HOURS}
    />
  );
}

function DsarTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: DsarExportJob[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (j: DsarExportJob) => void;
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
        <LoadingSpinner label="Loading the DSAR queue…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="check-circle" size={24} />
        <span>No DSAR export jobs match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">DSAR export jobs</caption>
        <thead>
          <tr>
            <th scope="col">Patient</th>
            <th scope="col">Status</th>
            <th scope="col">Requested</th>
            <th scope="col">30-day SLA</th>
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
                  <span className="wx-row-title">
                    <MaskedIdentifier value={j.patientId} label="Patient" />
                  </span>
                  <span className="wx-row-sub">{cap(j.requestSource.replace(/_/g, " "))}</span>
                </td>
                <td>
                  <StatusPill label={cap(j.status)} tone={DSAR_TONE[j.status] ?? "neutral"} />
                </td>
                <td className="wx-nums">{new Date(j.requestedAt).toLocaleDateString()}</td>
                <td>
                  {isOpen(j.status) ? (
                    <SlaChip job={j} />
                  ) : (
                    <span className="text-[var(--color-on-surface-variant)]">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DsarDrawer({ job, onClose }: { job: DsarExportJob; onClose: () => void }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="DSAR request">
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="shield" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>DSAR request</h2>
          <span className="wx-row-sub wx-data-md">{job.id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Request</h3>
            <StatusPill label={cap(job.status)} tone={DSAR_TONE[job.status] ?? "neutral"} />
          </div>
          <dl className="wx-kv">
            <dt>Job id</dt>
            <dd className="wx-data-md break-words">{job.id}</dd>
            <dt>Patient</dt>
            <dd>
              <MaskedIdentifier value={job.patientId} label="Patient" />
            </dd>
            <dt>Request source</dt>
            <dd>{cap(job.requestSource.replace(/_/g, " "))}</dd>
            <dt>Requested at</dt>
            <dd className="wx-nums">{new Date(job.requestedAt).toLocaleString()}</dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>§164.524 SLA</h3>
          <dl className="wx-kv">
            <dt>SLA due</dt>
            <dd>
              {isOpen(job.status) ? (
                <SlaChip job={job} />
              ) : (
                <span className="wx-nums text-[var(--color-on-surface-variant)]">
                  {new Date(effectiveDue(job)).toLocaleDateString()}
                </span>
              )}
            </dd>
            {job.extendedUntil ? (
              <>
                <dt>Extended until</dt>
                <dd className="wx-nums">{new Date(job.extendedUntil).toLocaleString()}</dd>
              </>
            ) : null}
            {job.fulfilledAt ? (
              <>
                <dt>Fulfilled at</dt>
                <dd className="wx-nums">{new Date(job.fulfilledAt).toLocaleString()}</dd>
              </>
            ) : null}
            {job.deniedReason ? (
              <>
                <dt>Denied reason</dt>
                <dd>{cap(job.deniedReason.replace(/_/g, " "))}</dd>
              </>
            ) : null}
          </dl>
        </section>
      </div>
    </aside>
  );
}
