// apps/web/src/modules/22-documents — shared table + status-chip primitives the M22 §5.1 read screens render
// (Track B / ADR-0030, M22-T10). Status colors are paired with the text label (WCAG §5.6 — never color-only).
// The read screens never fetch the binary itself — content opens through a short-TTL signed URL on demand (§4.12);
// these are pure presentational shapes (no @wardenx/ui import needed here). Leaves only.
import type { JSX, ReactNode } from "react";

/** §2.2.1 document lifecycle status → display color (color-blind-safe; always rendered with the text label). */
export const DOC_STATUS_COLOR: Record<string, string | undefined> = {
  active: "#15803d",
  superseded: "#6b7280",
  legal_hold: "#b45309",
  destroyed_tombstone: "#b91c1c",
};

/** §2.3 retention class → color. `compliance_42cfr_part2` (SUD, D23) is flagged distinctly. */
export const DOC_RETENTION_COLOR: Record<string, string | undefined> = {
  compliance: "#1d4ed8",
  clinical_record: "#15803d",
  bereavement: "#7c3aed",
  operational: "#6b7280",
  intake_artifact: "#b45309",
  compliance_42cfr_part2: "#b91c1c",
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

/** A minimal accessible table: one `<th scope=col>` header row + clickable body rows (WCAG §5.6). */
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

/** A label / value pair for the detail `<dl>` surfaces. */
export function DetailRow({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "1rem", padding: "0.4rem 0", borderBottom: "1px solid #f3f4f6" }}>
      <dt style={{ width: "11rem", color: "#6b7280", fontSize: "0.8rem" }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: "0.85rem", fontFamily: "monospace" }}>{value}</dd>
    </div>
  );
}

/** Trim an ISO instant to `YYYY-MM-DD HH:MM` for compact display. */
export const ts = (v: string | null | undefined): string => (v ? v.slice(0, 16).replace("T", " ") : "—");
