import {
  Button,
  ConsentBadge,
  CursorPagination,
  DataTable,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import type { DataTableColumn } from "@chartwarden/ui";
// apps/web/src/modules/05-patient — Patient List / Census (M5, Track A).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_PATIENT_LIST_CENSUS.md — "Use Work Queue."
// Filterable, cursor-paginated census over GET /api/v1/patients via the generated typed client.
// Reconciled to Lantern (R1): status taxonomy pills (§6.6), mono MRN identifiers (§3.1), and a
// Right Quick Summary panel that lazily fetches MBI last-4 + consent-gated privacy flags (§8) on
// row-select, with Open Chart deep-linking to /patients/:id. No hardcoded colors — the global
// table styles (index.css) carry the Lantern tokens.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { STATUS_TONE, ageFromDob, statusLabel } from "./patient-status";

interface PatientSummary {
  id: string;
  organizationId: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

interface CensusMetrics {
  total: number;
  byStatus: Record<string, number>;
  /** GAP-119 — M6's published admission summary; null when that read is unavailable. */
  admissions?: {
    admissionsToday: number;
    dischargesToday: number;
    gipActive: number;
    recertsDue: number;
  } | null;
}

// §4.2 census KPI strip (frame: wardenx-P0-foundation.pen `DNqXm`). Census is the real active count. GAP-119 —
// the other four used to say they were waiting on modules that have long shipped (M6 Admission, billing). The
// figures are M6's: it publishes an org-explicit summary that the backend injects into the census-metrics
// response (`admissions`), so M5 reads no M6 table. Each card also opens the owning screen. When M6's read is
// unavailable the card shows "—", never a made-up number.
function CensusKpis({
  metrics,
  status,
  onStatusSelect,
  onOpen,
}: {
  metrics: CensusMetrics | null;
  status: string;
  onStatusSelect: (status: string) => void;
  onOpen: (path: string) => void;
}): JSX.Element {
  const active = metrics?.byStatus?.active ?? 0;
  const total = metrics?.total ?? 0;
  // A figure is shown only when M6 answered; otherwise "—" (never a made-up zero).
  const adm = metrics?.admissions ?? null;
  const figure = (n: number | undefined): number | string => (adm && n !== undefined ? n : "—");
  return (
    <KpiStrip>
      <KpiCard
        label="Active census"
        value={metrics ? active : "—"}
        detail={metrics ? `${total} total in organization` : "Loading metrics"}
        tone="success"
        icon="users"
        selected={status === "active"}
        onSelect={() => onStatusSelect(status === "active" ? "" : "active")}
      />
      <KpiCard
        label="Admissions"
        value={figure(adm?.admissionsToday)}
        detail="Today · open Admissions"
        icon="user-plus"
        onSelect={() => onOpen("/admissions")}
      />
      <KpiCard
        label="Discharges"
        value={figure(adm?.dischargesToday)}
        detail="Today · open the discharge worklist"
        icon="arrow-right"
        accentColor="var(--color-viz-violet)"
        onSelect={() => onOpen("/admissions/discharges")}
      />
      <KpiCard
        label="GIP"
        value={figure(adm?.gipActive)}
        detail="In general inpatient care · open IPU"
        icon="bed"
        tone="warning"
        onSelect={() => onOpen("/ipu")}
      />
      <KpiCard
        label="Recerts due"
        value={figure(adm?.recertsDue)}
        detail="Within 14 days · open compliance"
        icon="calendar-check"
        accentColor="var(--color-viz-teal)"
        onSelect={() => onOpen("/compliance/admissions")}
      />
    </KpiStrip>
  );
}

export function PatientListCensus(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<PatientSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PatientSummary | null>(null);
  const [metrics, setMetrics] = useState<CensusMetrics | null>(null);
  const hasActiveFilters = q.trim() !== "" || status !== "";

  // §4.2 census KPIs — the active count is real (GET /patients/census-metrics); the cross-module KPIs
  // (admissions/discharges/GIP/recerts) render as honest placeholders until M6/billing reads land.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await client.GET("/api/v1/patients/census-metrics");
      if (alive && data) setMetrics(data as CensusMetrics);
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: 50 };
      if (q.trim()) query.q = q.trim();
      if (status) query.status = status;
      if (cursor) query.cursor = cursor;

      const { data, error: err } = await client.GET("/api/v1/patients", { params: { query } });
      if (err) {
        setError("Could not load the patient census.");
        setLoading(false);
        return;
      }
      const page = (data?.items ?? []) as PatientSummary[];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, q, status],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Patients · Census"
          breadcrumb="Clinical — patient list"
          actions={
            <Link to="/referrals" className="wx-btn-primary">
              <Glyph name="plus" size={16} /> Admit patient
            </Link>
          }
        >
          <div
            style={{
              color: "var(--color-on-surface-variant)",
              fontSize: "0.875rem",
              maxWidth: "48rem",
            }}
          >
            Search the organization census, review patient status, and open the chart quick summary
            from a selected row.
          </div>
        </PageHeader>
      }
      kpis={
        <CensusKpis
          metrics={metrics}
          status={status}
          onStatusSelect={setStatus}
          onOpen={(path) => navigate(path)}
        />
      }
      filters={
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="wx-filter-panel">
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                aria-label="Search name or MRN"
                placeholder="Search name or MRN…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label className="wx-filter-field">
              <span>Status</span>
              <select
                className="wx-select"
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All</option>
                <option value="prospective">Prospective</option>
                <option value="active">Active</option>
                <option value="on_hold">On hold</option>
                <option value="discharged">Discharged</option>
                <option value="deceased">Deceased</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <button
                type="button"
                className="wx-btn-secondary"
                onClick={() => {
                  setQ("");
                  setStatus("");
                }}
              >
                <Glyph name="filter" size={15} /> Clear
              </button>
            ) : null}
            <span style={{ ...mutedStyle, lineHeight: "2.5rem", marginLeft: "auto" }}>
              {items.length} loaded{nextCursor ? " · more available" : ""}
            </span>
          </div>
        </div>
      }
      table={
        <CensusTable
          items={items}
          loading={loading}
          error={error}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={() => {
            setQ("");
            setStatus("");
          }}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
        />
      }
      detail={
        selected ? (
          <PatientQuickSummary
            patient={selected}
            onClose={() => setSelected(null)}
            onOpenChart={() => navigate(`/patients/${selected.id}`)}
          />
        ) : undefined
      }
    />
  );
}

function CensusTable({
  items,
  loading,
  error,
  hasActiveFilters,
  onClearFilters,
  selectedId,
  onSelect,
  onLoadMore,
}: {
  items: PatientSummary[];
  loading: boolean;
  error: string | null;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  selectedId: string | null;
  onSelect: (p: PatientSummary) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="Unavailable" description={error} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  if (items.length === 0)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="No patients"
          description={
            hasActiveFilters
              ? "No patients match the current filters."
              : "No patients are visible in the current census."
          }
          action={
            hasActiveFilters ? (
              <Button tone="secondary" size="sm" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
      <DataTable
        ariaLabel="Patient census"
        caption="Patients visible in the current census filters"
        rows={items}
        columns={CENSUS_COLUMNS}
        getRowId={(patient) => patient.id}
        selectedRowId={selectedId}
        onRowSelect={onSelect}
      />
      <CursorPagination
        loadedCount={items.length}
        hasNextPage={Boolean(onLoadMore)}
        loading={loading}
        onNextPage={onLoadMore}
        noun="patients"
      />
    </div>
  );
}

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};

const CENSUS_COLUMNS: readonly DataTableColumn<PatientSummary>[] = [
  {
    id: "name",
    header: "Name",
    cell: (patient) => (
      <span style={{ display: "grid", gap: "0.2rem" }}>
        <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
          {patient.lastName}, {patient.firstName}
        </span>
        <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
          Patient {patient.id.slice(0, 8)}
        </span>
      </span>
    ),
  },
  {
    id: "mrn",
    header: "MRN",
    priority: "secondary",
    cell: (patient) => <span className="wx-data-md">{patient.mrn}</span>,
  },
  {
    id: "dob",
    header: "DOB / Age",
    priority: "tertiary",
    cell: (patient) => {
      const age = ageFromDob(patient.dob);
      return (
        <span className="tabular-nums">
          {patient.dob}
          {age !== null ? ` · ${age}y` : ""}
        </span>
      );
    },
  },
  {
    id: "status",
    header: "Status",
    cell: (patient) => (
      <StatusPill
        label={statusLabel(patient.status)}
        tone={STATUS_TONE[patient.status] ?? "neutral"}
      />
    ),
  },
];

// Right: Patient Quick Summary (spec §"Right Panel"). Lazily fetches the per-patient identifiers
// (MBI last-4 only — SSN is never listed, §8) + consent-gated privacy flags for the selected row.
function PatientQuickSummary({
  patient,
  onClose,
  onOpenChart,
}: {
  patient: PatientSummary;
  onClose: () => void;
  onOpenChart: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [mbiLast4, setMbiLast4] = useState<string | null>(null);
  const [flags, setFlags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMbiLast4(null);
    setFlags([]);
    void (async () => {
      const [ids, priv] = await Promise.all([
        client.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patient.id } } }),
        client.GET("/api/v1/patients/{id}/privacy-flags", { params: { path: { id: patient.id } } }),
      ]);
      if (!alive) return;
      const mbi = (ids.data?.identifiers ?? []).find((i) => i.kind === "mbi");
      setMbiLast4(mbi?.last4 ?? null);
      setFlags(priv.data?.flags ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [client, patient.id]);

  const age = ageFromDob(patient.dob);
  return (
    <RightDetailPanel title={`${patient.lastName}, ${patient.firstName}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        <StatusPill
          label={statusLabel(patient.status)}
          tone={STATUS_TONE[patient.status] ?? "neutral"}
        />

        <Field label="DOB / Age">
          <span className="tabular-nums">
            {patient.dob}
            {age !== null ? ` · ${age}y` : ""}
          </span>
        </Field>
        <Field label="MRN">
          <span className="wx-data-md">{patient.mrn}</span>
        </Field>
        <Field label="MBI">
          {loading ? (
            <span style={{ color: "var(--color-muted)" }}>…</span>
          ) : mbiLast4 ? (
            <span className="wx-data-md">••••-{mbiLast4}</span>
          ) : (
            <span style={{ color: "var(--color-muted)" }}>—</span>
          )}
        </Field>

        {flags.length > 0 ? (
          <Field label="Privacy">
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {flags.map((f) => (
                <ConsentBadge
                  key={f}
                  label={statusLabel(f)}
                  authority="Disclosure consent on file"
                />
              ))}
            </div>
          </Field>
        ) : null}

        <Button type="button" onClick={onOpenChart} style={{ marginTop: "0.5rem" }}>
          Open chart
        </Button>
      </div>
    </RightDetailPanel>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span
        style={{
          fontSize: "0.6875rem",
          fontWeight: 600,
          color: "var(--color-on-surface-variant)",
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--color-on-surface)" }}>{children}</span>
    </div>
  );
}
