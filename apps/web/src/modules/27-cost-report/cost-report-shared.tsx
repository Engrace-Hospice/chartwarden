// apps/web/src/modules/27-cost-report — shared scaffolding for the M27 read surfaces: the No-Line table cell
// styles (Lantern §6, CSS-var tokens only) and a small report-picker hook + control. Most M27 GET routes are
// per-report (`/cost-reports/{id}/…`), so the per-report screens pick a report from the live list and then
// fetch its detail; the server stays the only authz point (ADR-0030 — this gates nav visibility only).
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { humanize, shortDate } from "./cost-report-status";

export const cellStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  textAlign: "left",
  verticalAlign: "middle",
};
export const headStyle: CSSProperties = {
  ...cellStyle,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
export const rowStyle: CSSProperties = { borderTop: "1px solid var(--color-surface-container)" };
export const numStyle: CSSProperties = {
  ...cellStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};
export const sectionTitle: CSSProperties = {
  fontSize: "0.85rem",
  margin: "0 0 0.5rem",
  color: "var(--color-on-surface)",
};

export interface ReportRef {
  costReportId: string;
  providerEntityId: string;
  fiscalYearEndDate: string;
  state: string;
}

/** Load the org's cost reports + track a selected id. Returns the list, the selection, and load state. */
export function useReportPicker(): {
  reports: ReportRef[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  loading: boolean;
  error: boolean;
} {
  const client = useApiClient();
  const [reports, setReports] = useState<ReportRef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const res = await client.GET("/api/v1/cost-reports");
    if (res.error) {
      setError(true);
      setLoading(false);
      return;
    }
    const d = res.data as unknown as { items?: ReportRef[] };
    const list = d.items ?? (res.data as unknown as ReportRef[]) ?? [];
    setReports(list);
    setSelectedId((prev) => prev ?? list[0]?.costReportId ?? null);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return { reports, selectedId, setSelectedId, loading, error };
}

const selectStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderRadius: "0.4rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};

/** A labelled <select> over the org's cost reports (FYE + state). Renders nothing when the list is empty. */
export function ReportPicker({
  reports,
  selectedId,
  onChange,
}: {
  reports: ReportRef[];
  selectedId: string | null;
  onChange: (id: string) => void;
}): JSX.Element | null {
  if (reports.length === 0) return null;
  return (
    <label
      style={{
        display: "inline-flex",
        gap: "0.5rem",
        alignItems: "center",
        fontSize: "0.8rem",
        color: "var(--color-on-surface-variant)",
      }}
    >
      Cost report
      <select
        style={selectStyle}
        value={selectedId ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {reports.map((r) => (
          <option key={r.costReportId} value={r.costReportId}>
            FYE {shortDate(r.fiscalYearEndDate)} · {humanize(r.state)}
          </option>
        ))}
      </select>
    </label>
  );
}
