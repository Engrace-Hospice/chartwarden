import {
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — DOC.Explorer (M22 §5.1, Track B / ADR-0030).
// Spec: docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md §5.1 "DOC.Explorer" — tenant-wide document
// browse + filter (by patient, type, retention class). Built to the Lantern look (docs/design/DESIGN.md):
// Work Queue pattern, KPI strip (§6.3), the §6.6 status-pill taxonomy, mono identifiers (§3.1), No-Line
// tables (§6.7), warm-paper surfaces. The SERVER is the only authz point (ADR-0030): out-of-scope rows are
// non-leaking 404s, SUD content is redacted server-side, legal-hold blocks live in the response — never a
// frontend hide. Reads GET /api/v1/documents (cursor-paginated) via the typed client. Leaves only
// (@wardenx/ui). The upload dialog / tag editor / signed-URL preview write+modal surfaces fill in as their
// write paths harden (the §164.528 access-purpose capture rides the signed-URL request).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Mono, StatusPill, lifecycleTone, ts } from "./lantern";

interface DocumentRow {
  id: string;
  patientId: string | null;
  retentionClass: string;
  aggregateType: string;
  title: string;
  status: string;
  version: number;
  updatedAt: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  compliance: "Compliance",
  clinical_record: "Clinical",
  bereavement: "Bereavement",
  operational: "Operational",
  intake_artifact: "Intake",
  compliance_42cfr_part2: "Part 2 / SUD",
};

export function DocumentExplorer(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [retentionFilter, setRetentionFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/documents", {
      params: { query: retentionFilter ? { retentionClass: retentionFilter } : {} },
    });
    if (err) {
      setError("Could not load documents. Try widening the filters.");
      setLoading(false);
      return;
    }
    setRows((data?.items ?? []) as DocumentRow[]);
    setLoading(false);
  }, [client, retentionFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: rows.length,
      part2: rows.filter((r) => r.retentionClass === "compliance_42cfr_part2").length,
      intake: rows.filter((r) => r.retentionClass === "intake_artifact").length,
    }),
    [rows],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Documents" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Documents" value={counts.total} />
          <KpiCard label="Part 2 / SUD" value={counts.part2} />
          <KpiCard label="From intake" value={counts.intake} />
        </KpiStrip>
      }
      filters={
        <FilterBar>
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}
          >
            <span style={{ color: "var(--color-on-surface-variant)" }}>Retention class</span>
            <select value={retentionFilter} onChange={(e) => setRetentionFilter(e.target.value)}>
              <option value="">All</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </FilterBar>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No documents"
            description="No documents for the selected filters. Try widening the date range or clear the patient filter."
          />
        ) : (
          <table className="tabular-nums">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Patient</th>
                <th>Ver</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td style={{ maxWidth: "22rem" }}>{d.title}</td>
                  <td>{CATEGORY_LABEL[d.retentionClass] ?? d.retentionClass}</td>
                  <td>{d.patientId ? <Mono>{d.patientId.slice(0, 8)}</Mono> : "—"}</td>
                  <td>{d.version}</td>
                  <td>
                    <StatusPill tone={lifecycleTone(d.status)}>{d.status}</StatusPill>
                  </td>
                  <td>{ts(d.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
