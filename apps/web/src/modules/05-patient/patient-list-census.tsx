import {
  Button,
  ConsentBadge,
  CursorPagination,
  DataTable,
  EmptyState,
  FilterBar,
  KpiStrip,
  LoadingSpinner,
  MetricCard,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { DataTableColumn } from "@wardenx/ui";
// apps/web/src/modules/05-patient — Patient List / Census (M5, Track A).
// Spec: docs/design/screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md — "Use Work Queue."
// Filterable, cursor-paginated census over GET /api/v1/patients via the generated typed client.
// Reconciled to Lantern (R1): status taxonomy pills (§6.6), mono MRN identifiers (§3.1), and a
// Right Quick Summary panel that lazily fetches MBI last-4 + consent-gated privacy flags (§8) on
// row-select, with Open Chart deep-linking to /patients/:id. No hardcoded colors — the global
// table styles (index.css) carry the Lantern tokens.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
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
}

const ADMIT_BTN = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.45rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
} as const;

// §4.2 census KPI strip (frame: wardenx-P0-foundation.pen `DNqXm`). Census is the real active count;
// the cross-module KPIs show "—" with the owning module noted — honest, never fabricated numbers.
function CensusKpis({
  metrics,
  status,
  onStatusSelect,
}: {
  metrics: CensusMetrics | null;
  status: string;
  onStatusSelect: (status: string) => void;
}): JSX.Element {
  const active = metrics?.byStatus?.active ?? 0;
  const total = metrics?.total ?? 0;
  return (
    <KpiStrip>
      <MetricCard
        label="Active census"
        value={metrics ? active : "…"}
        detail={metrics ? `${total} total in organization` : "Loading metrics"}
        tone="success"
        selected={status === "active"}
        onSelect={() => onStatusSelect(status === "active" ? "" : "active")}
      />
      <MetricCard label="Admissions" value="—" detail="Today · M6 Admission" />
      <MetricCard label="Discharges" value="—" detail="Today · M6 Admission" />
      <MetricCard label="GIP" value="—" detail="Billing source pending" />
      <MetricCard label="Recerts due" value="—" detail="M6 Certification" />
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
          actions={
            <Link to="/referrals" style={ADMIT_BTN}>
              Admit patient
            </Link>
          }
        />
      }
      kpis={<CensusKpis metrics={metrics} status={status} onStatusSelect={setStatus} />}
      filters={
        <FilterBar
          activeFilterCount={Number(Boolean(q.trim())) + Number(Boolean(status))}
          onClear={() => {
            setQ("");
            setStatus("");
          }}
        >
          <input
            aria-label="Search name or MRN"
            placeholder="Name or MRN"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="prospective">Prospective</option>
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="discharged">Discharged</option>
            <option value="deceased">Deceased</option>
          </select>
        </FilterBar>
      }
      table={
        <CensusTable
          items={items}
          loading={loading}
          error={error}
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
  selectedId,
  onSelect,
  onLoadMore,
}: {
  items: PatientSummary[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (p: PatientSummary) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No patients" description="No patients match the current filters." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
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

const CENSUS_COLUMNS: readonly DataTableColumn<PatientSummary>[] = [
  {
    id: "name",
    header: "Name",
    cell: (patient) => (
      <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
        {patient.lastName}, {patient.firstName}
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
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--color-on-surface-variant)",
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--color-on-surface)" }}>{children}</span>
    </div>
  );
}
