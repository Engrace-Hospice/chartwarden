import {
  cardSurface,
  ConsentBadge,
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/05-patient — Patient List / Census (M5, Track A).
// Spec: docs/design/screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md — "Use Work Queue."
// Filterable, cursor-paginated census over GET /api/v1/patients via the generated typed client.
// Reconciled to Lantern (R1): status taxonomy pills (§6.6), mono MRN identifiers (§3.1), and a
// Right Quick Summary panel that lazily fetches MBI last-4 + consent-gated privacy flags (§8) on
// row-select, with Open Chart deep-linking to /patients/:id. No hardcoded colors — the global
// table styles (index.css) carry the Lantern tokens.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
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
function CensusKpis({ metrics }: { metrics: CensusMetrics | null }): JSX.Element {
  const active = metrics?.byStatus?.active ?? 0;
  const total = metrics?.total ?? 0;
  return (
    <div
      style={{ display: "flex", gap: "1rem", flexWrap: "wrap", padding: "0 1.5rem 0.5rem" }}
      aria-label="Census metrics"
    >
      <KpiCard
        label="Census"
        value={metrics ? active : "…"}
        sub={metrics ? `${total} total in org` : undefined}
      />
      <KpiCard label="Admissions" value="—" sub="today · M6 Admission" muted />
      <KpiCard label="Discharges" value="—" sub="today · M6 Admission" muted />
      <KpiCard label="GIP" value="—" sub="billing" muted />
      <KpiCard label="Recerts due" value="—" sub="M6 Certification" muted />
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  muted?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        ...cardSurface,
        flex: "1 1 8rem",
        minWidth: 0,
        padding: "0.875rem 1.125rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.3rem",
      }}
    >
      <span
        style={{
          fontSize: "0.6875rem",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--color-on-surface-variant)",
        }}
      >
        {label}
      </span>
      {/* KPI numerals are Inter tabular-nums, not Fraunces (DESIGN.md §3 / review remediation F1). */}
      <span
        className="tabular-nums"
        style={{
          fontSize: "1.75rem",
          fontWeight: 600,
          lineHeight: 1,
          color: muted ? "var(--color-muted)" : "var(--color-on-surface)",
        }}
      >
        {value}
      </span>
      {sub ? (
        <span style={{ fontSize: "0.72rem", color: "var(--color-on-surface-variant)" }}>{sub}</span>
      ) : null}
    </div>
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
      kpis={<CensusKpis metrics={metrics} />}
      filters={
        <FilterBar
          actions={
            <button
              type="button"
              onClick={() => {
                setQ("");
                setStatus("");
              }}
            >
              Clear
            </button>
          }
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
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>MRN</th>
            <th>DOB / Age</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const age = ageFromDob(p.dob);
            const isSelected = p.id === selectedId;
            return (
              <tr
                key={p.id}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => onSelect(p)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(p);
                  }
                }}
                style={{
                  cursor: "pointer",
                  background: isSelected ? "var(--color-primary-tint)" : undefined,
                }}
              >
                <td style={{ fontWeight: 500, color: "var(--color-on-surface)" }}>
                  {p.lastName}, {p.firstName}
                </td>
                <td className="wx-data-md">{p.mrn}</td>
                <td className="tabular-nums">
                  {p.dob}
                  {age !== null ? ` · ${age}y` : ""}
                </td>
                <td>
                  <StatusPill
                    label={statusLabel(p.status)}
                    tone={STATUS_TONE[p.status] ?? "neutral"}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {onLoadMore ? (
        <div style={{ marginTop: "1rem", textAlign: "center" }}>
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

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

        <button
          type="button"
          onClick={onOpenChart}
          style={{
            marginTop: "0.5rem",
            padding: "0.5rem 1rem",
            border: "none",
            borderRadius: "9999px",
            background: "var(--color-primary)",
            color: "var(--color-on-primary)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Open chart
        </button>
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
