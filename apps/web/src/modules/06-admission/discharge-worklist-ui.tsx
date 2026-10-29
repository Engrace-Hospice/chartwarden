import { EmptyState, LoadingSpinner, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/06-admission — the end-of-episode worklist pieces shared by the "Discharge / transfer" hub
// (discharges-hub.tsx) and the Readmit list (readmit-list.tsx): the paged bucket read (GET /api/v1/discharges/worklist),
// the patient names for the rows on screen, the list states, and the "recently discharged" table. Display only — the
// server narrows every bucket to the caller's scope and enforces every key on the workflows linked from here.
import { type JSX, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDate } from "../../shell/patient-context";
import { Avatar } from "./admissions-chrome";
import {
  HUB_PAGE_SIZE,
  type HubPatient,
  type WorklistBucket,
  type WorklistItem,
  daysSince,
  embeddedPatients,
  endLabel,
  patientName,
  unresolvedPatientIds,
} from "./discharges-hub-model";

export interface WorklistState {
  items: WorklistItem[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  retry: () => void;
}

export function useWorklist(bucket: WorklistBucket, enabled: boolean): WorklistState {
  const client = useApiClient();
  const [items, setItems] = useState<WorklistItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Try again".
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const query: { bucket: WorklistBucket; limit: number; cursor?: string } = {
        bucket,
        limit: HUB_PAGE_SIZE,
      };
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/discharges/worklist", {
        params: { query },
      });
      if (!active) return;
      if (err || !data) {
        setError("This list could not be loaded.");
        setLoading(false);
        return;
      }
      const rows = data.items as WorklistItem[];
      setItems((prev) => (cursor ? [...prev, ...rows] : rows));
      setNextCursor(data.nextCursor ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, bucket, cursor, enabled, retryKey]);

  return {
    items,
    nextCursor,
    loading,
    error,
    loadMore: () => {
      if (nextCursor) setCursor(nextCursor);
    },
    retry: () => {
      setCursor(undefined);
      setRetryKey((k) => k + 1);
    },
  };
}

/**
 * Names/MRNs for the rows on screen: the ones the server named on the row (readmission candidates), plus one patient
 * read per row it did not name.
 */
export function usePatients(rows: readonly WorklistItem[]): Record<string, HubPatient | null> {
  const client = useApiClient();
  const [fetched, setFetched] = useState<Record<string, HubPatient | null>>({});
  const missing = unresolvedPatientIds(rows, fetched).join(",");
  useEffect(() => {
    if (!missing) return;
    let active = true;
    const ids = missing.split(",");
    void Promise.all(
      ids.map((id) =>
        client
          .GET("/api/v1/patients/{id}", { params: { path: { id } } })
          .then((r) => [id, (r.data as HubPatient | undefined) ?? null] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((pairs) => {
      if (!active) return;
      setFetched((prev) => {
        const next = { ...prev };
        for (const [id, p] of pairs) next[id] = p;
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [client, missing]);
  return { ...fetched, ...embeddedPatients(rows) };
}

export function ListState({
  list,
  emptyTitle,
  emptyText,
  children,
}: {
  list: WorklistState;
  emptyTitle: string;
  emptyText: string;
  children: JSX.Element;
}): JSX.Element {
  if (list.error)
    return (
      <div className="wx-list-state" role="alert">
        <EmptyState title="Unavailable" description={list.error} />
        <button type="button" className="wx-btn-secondary" onClick={list.retry}>
          Try again
        </button>
      </div>
    );
  if (list.loading && list.items.length === 0) return <LoadingSpinner />;
  if (list.items.length === 0)
    return (
      <div className="wx-list-state">
        <EmptyState title={emptyTitle} description={emptyText} />
      </div>
    );
  return (
    <>
      {children}
      {list.nextCursor ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "0 1rem 1rem" }}>
          <button
            type="button"
            className="wx-btn-secondary"
            onClick={list.loadMore}
            disabled={list.loading}
          >
            Load more
          </button>
        </div>
      ) : null}
    </>
  );
}

export function PatientCell({
  row,
  patients,
  link = true,
}: {
  row: WorklistItem;
  patients: Record<string, HubPatient | null>;
  /** Link the name to the chart (off for readmission candidates — their chart is usually off the caller's caseload). */
  link?: boolean;
}): JSX.Element {
  const patient = patients[row.patientId] ?? undefined;
  const known = row.patientId in patients;
  const label = known ? patientName(patient, "Unresolved patient") : "…";
  return (
    <td>
      <span className="wx-patient-cell">
        <Avatar name={label} />
        {link ? (
          <Link to={`/patients/${row.patientId}`} className="wx-row-title">
            {label}
          </Link>
        ) : (
          <span className="wx-row-title">{label}</span>
        )}
      </span>
    </td>
  );
}

export const mrnOf = (patients: Record<string, HubPatient | null>, id: string): string =>
  patients[id]?.mrn ?? (id in patients ? "—" : "…");

/** The `recently_discharged` rows — live discharges, revocations, transfers out — with a Readmit… action. */
export function RecentlyDischargedTable({
  rows,
  patients,
  canReadmit,
  today,
  caption,
  linkPatients = true,
}: {
  rows: readonly WorklistItem[];
  patients: Record<string, HubPatient | null>;
  canReadmit: boolean;
  today: string;
  caption: string;
  linkPatients?: boolean;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Patient</th>
            <th scope="col">MRN</th>
            <th scope="col">Ended</th>
            <th scope="col">Date</th>
            <th scope="col">Days since</th>
            <th scope="col">
              <span className="wx-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = patientName(patients[r.patientId] ?? undefined, "this patient");
            const since = daysSince(r.effectiveDate ?? r.dischargedAt, today);
            return (
              <tr key={r.admissionId}>
                <PatientCell row={r} patients={patients} link={linkPatients} />
                <td className="wx-nums">{mrnOf(patients, r.patientId)}</td>
                <td>{endLabel(r.dischargeType)}</td>
                <td className="wx-nums">{fmtDate(r.effectiveDate ?? r.dischargedAt)}</td>
                <td className="wx-nums">{since === null ? "—" : since}</td>
                <td style={{ textAlign: "right" }}>
                  {canReadmit ? (
                    <Link
                      to={`/admissions/${r.admissionId}/readmit`}
                      className="wx-action-link"
                      aria-label={`Readmit ${name}`}
                    >
                      Readmit…
                    </Link>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
