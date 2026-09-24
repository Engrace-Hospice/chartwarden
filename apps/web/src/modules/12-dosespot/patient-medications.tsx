import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  MED_ORDER_TONE,
  controlledLabel,
  stateLabel,
} from "./medication-status";

interface MedRow {
  id: string;
  patientId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  doseForm: string;
  route: string;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  refillsRemaining: number;
}

type MedicationStatus =
  | "active"
  | "draft"
  | "pending_signature"
  | "verbal_pending"
  | "discontinued"
  | "completed";
const statuses: { value: MedicationStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Drafts" },
  { value: "pending_signature", label: "Pending signature" },
  { value: "verbal_pending", label: "Verbal pending" },
  { value: "discontinued", label: "Discontinued" },
  { value: "completed", label: "Completed" },
];

export function PatientMedications(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<MedRow[]>([]);
  const [status, setStatus] = useState<MedicationStatus>("active");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    setError(null);
    if (!patientId) {
      setError("Patient ID is missing.");
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void (async () => {
      try {
        if (status === "active") {
          const { data, error: requestError } = await client.GET(
            "/api/v1/patients/{patientId}/medications/active",
            { params: { path: { patientId } } },
          );
          if (!active) return;
          if (requestError) throw new Error("Request failed");
          setItems((data?.orders ?? []) as MedRow[]);
        } else {
          const { data, error: requestError } = await client.GET(
            "/api/v1/medication-orders",
            {
              params: { query: { patientId, status } },
            },
          );
          if (!active) return;
          if (requestError) throw new Error("Request failed");
          setItems((data?.orders ?? []) as MedRow[]);
        }
      } catch {
        if (active) setError("Could not load medications for this patient.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, status, retryKey]);

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return items
      .filter(
        (item) =>
          !needle ||
          `${item.drugName} ${item.strength} ${item.doseForm} ${item.route}`
            .toLocaleLowerCase()
            .includes(needle),
      )
      .sort((a, b) => a.drugName.localeCompare(b.drugName));
  }, [items, search]);
  const statusLabel =
    statuses.find((item) => item.value === status)?.label ?? stateLabel(status);

  return (
    <PatientWorkspaceLayout
      banner={<PageHeader title="Medications" />}
      contextHeader={
        <FilterBar
          actions={
            <button
              type="button"
              className="wx-medications-primary"
              onClick={() => navigate(`/patients/${patientId}/medications/new`)}
              disabled={!patientId}
            >
              New medication
            </button>
          }
        >
          <div className="wx-medications-filters">
            <label>
              <span>Status</span>
              <select
                aria-label="Medication status"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as MedicationStatus)
                }
              >
                {statuses.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Search this view</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Drug name, strength or route"
              />
            </label>
          </div>
        </FilterBar>
      }
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="medications" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <style>{styles}</style>
          <section
        className="wx-medications"
        aria-label={`${statusLabel} medications`}
        aria-busy={loading}
      >
        <div className="wx-medications-heading">
          <div>
            <h2>{statusLabel} medications</h2>
            {!loading && !error ? (
              <p role="status">
                {rows.length} {rows.length === 1 ? "medication" : "medications"}
                {search ? " matching your search" : ""}
              </p>
            ) : null}
          </div>
        </div>
        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <div className="wx-medications-state">
            <EmptyState title="Medications unavailable" description={error} />
            <button type="button" onClick={() => setRetryKey((key) => key + 1)}>
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="wx-medications-state">
            <EmptyState
              title={
                search
                  ? "No matching medications"
                  : `No ${statusLabel.toLowerCase()} medications`
              }
              description={
                search
                  ? "Try a different drug name, strength or route."
                  : "There are no medication orders in this view."
              }
            />
            {search ? (
              <button type="button" onClick={() => setSearch("")}>
                Clear search
              </button>
            ) : null}
          </div>
        ) : (
          <div className="wx-medications-table-wrap">
            <table className="wx-medications-table">
              <caption className="wx-medications-sr-only">
                {statusLabel} medications for this patient
              </caption>
              <thead>
                <tr>
                  <th scope="col">Medication</th>
                  <th scope="col">Class</th>
                  <th scope="col">Status</th>
                  <th scope="col">Controlled</th>
                  <th scope="col">Refills</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link
                        className="wx-medications-drug"
                        to={`/medication-orders/${order.id}`}
                      >
                        {order.drugName || "Unnamed medication"}
                      </Link>
                      <span className="wx-medications-subtitle">
                        {[order.strength, order.doseForm, order.route]
                          .filter(Boolean)
                          .join(" · ") || "Details not recorded"}
                      </span>
                    </td>
                    <td>{stateLabel(order.medClass)}</td>
                    <td>
                      <StatusPill
                        label={stateLabel(order.status)}
                        tone={MED_ORDER_TONE[order.status] ?? "neutral"}
                      />
                    </td>
                    <td>
                      {order.isControlledSubstance ? (
                        <StatusPill
                          label={controlledLabel(order.deaSchedule)}
                          tone="critical"
                          glyph="alert"
                        />
                      ) : (
                        <span className="wx-medications-subtitle">No</span>
                      )}
                    </td>
                    <td className="tabular-nums">{order.refillsRemaining}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </section>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

const styles = `
.wx-medications { min-width: 0; }
.wx-medications-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin: 0 0 1rem; }
.wx-medications-heading h2 { margin: 0; font-size: 1.125rem; }
.wx-medications-heading p { margin: .25rem 0 0; color: var(--color-on-surface-variant); font-size: .875rem; }
.wx-medications-filters { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; }
.wx-medications-filters label { display: grid; gap: .3rem; min-width: min(100%, 12rem); font-size: .8rem; font-weight: 600; }
.wx-medications-filters label:has(input) { flex: 1 1 13rem; }
.wx-medications-filters select, .wx-medications-filters input { min-height: 2.5rem; width: 100%; box-sizing: border-box; padding: .4rem .65rem; border: 1px solid var(--color-outline-variant); border-radius: .45rem; background: var(--color-surface); color: var(--color-on-surface); font: inherit; }
.wx-medications button { min-height: 2.5rem; padding: .45rem .8rem; border: 1px solid var(--color-outline-variant); border-radius: .45rem; background: var(--color-surface); color: var(--color-on-surface); font: inherit; cursor: pointer; }
.wx-medications-primary { min-height: 2.5rem; padding: .45rem .85rem; border: 1px solid var(--color-primary); border-radius: .45rem; background: var(--color-primary); color: var(--color-on-primary); font: inherit; font-weight: 600; cursor: pointer; }
.wx-medications-primary:disabled { opacity: .5; cursor: not-allowed; }
.wx-medications-table-wrap { overflow-x: auto; border: 1px solid var(--color-outline-variant); border-radius: .75rem; background: var(--color-surface); }
.wx-medications-table { width: 100%; border-collapse: collapse; text-align: left; font-size: .875rem; }
.wx-medications-table th { padding: .85rem 1rem; color: var(--color-on-surface-variant); background: var(--color-surface-variant, var(--color-surface)); font-weight: 600; white-space: nowrap; }
.wx-medications-table td { padding: 1rem; border-top: 1px solid var(--color-outline-variant); vertical-align: middle; }
.wx-medications-table tbody tr:hover { background: var(--color-surface-variant, var(--color-surface)); }
.wx-medications-drug { display: inline-block; font-weight: 700; color: var(--color-primary); overflow-wrap: anywhere; }
.wx-medications-subtitle { display: block; margin-top: .25rem; color: var(--color-on-surface-variant); line-height: 1.4; }
.wx-medications-state { display: grid; justify-items: center; gap: .75rem; padding: 1.5rem; }
.wx-medications-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.wx-medications a:focus-visible, .wx-medications button:focus-visible, .wx-medications-filters select:focus-visible, .wx-medications-filters input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
@media (max-width: 40rem) { .wx-medications-table th, .wx-medications-table td { padding: .75rem; } }
`;
