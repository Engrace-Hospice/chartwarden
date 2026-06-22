// apps/web/src/modules/18-evv — shared table + status-chip primitives the M18 §5.1 read screens render
// (Track B / ADR-0030, M18-T07). Status colors are paired with the text label (WCAG §5.4 — never color-only).
// Coordinate-free: the read screens never render lat/lng (D10 — coordinates need the separate evv.read_coords
// path). Leaves only (no @wardenx/ui import needed here — pure presentational shapes).
import type { JSX, ReactNode } from "react";

/** §2.2 capture gps-quality / geofence-decision → display color (color-blind-safe; always with the text label). */
export const EVV_QUALITY_COLOR: Record<string, string | undefined> = {
  high: "#15803d",
  acceptable: "#1d4ed8",
  degraded_attested: "#b45309",
  outside_geofence: "#b91c1c",
  suspected_spoof: "#b91c1c",
};

/** §2.2.4 D6 missing-resolution status → color. `open` is the only billing-blocking state (ADR-0008). */
export const EVV_RESOLUTION_COLOR: Record<string, string | undefined> = {
  open: "#b91c1c",
  closed_clinician_attested: "#15803d",
  closed_supervisor_override: "#b45309",
  closed_system_checkout: "#6b7280",
  closed_void: "#6b7280",
  closed_documented_at_encounter: "#15803d",
};

/** §2.2.5 D7 aggregator submission status → color. */
export const EVV_SUBMISSION_COLOR: Record<string, string | undefined> = {
  pending: "#6b7280",
  queued: "#6b7280",
  submitting: "#1d4ed8",
  submitted: "#1d4ed8",
  accepted: "#15803d",
  rejected: "#b91c1c",
  timeout: "#b91c1c",
  cancelled: "#6b7280",
};

/** EVV device status → color. */
export const EVV_DEVICE_COLOR: Record<string, string | undefined> = {
  pending_approval: "#b45309",
  approved: "#15803d",
  rejected: "#b91c1c",
  suspended: "#b91c1c",
  retired: "#6b7280",
};

export function StatusChip({
  value,
  colorMap,
}: {
  value: string;
  colorMap: Record<string, string | undefined>;
}): JSX.Element {
  return <span style={{ color: colorMap[value] ?? "#374151" }}>{value}</span>;
}

const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const th = { textAlign: "left", padding: "0.4rem 0.75rem", color: "#6b7280", fontWeight: 600 } as const;
const td = { padding: "0.4rem 0.75rem", fontFamily: "monospace" } as const;

/** A minimal accessible table: one `<th scope=col>` header row + clickable body rows (WCAG §5.1 ledger). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onSelect,
}: {
  columns: ReadonlyArray<{ header: string; cell: (row: T) => ReactNode }>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  onSelect?: (row: T) => void;
}): JSX.Element {
  return (
    <table style={table}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.header} scope="col" style={th}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={rowKey(r)}
            onClick={onSelect ? () => onSelect(r) : undefined}
            style={{ cursor: onSelect ? "pointer" : "default", borderTop: "1px solid #f3f4f6" }}
          >
            {columns.map((c) => (
              <td key={c.header} style={td}>
                {c.cell(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Trim an ISO instant to `YYYY-MM-DD HH:MM` for compact display. */
export const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");
