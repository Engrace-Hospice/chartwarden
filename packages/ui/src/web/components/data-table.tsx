import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";

export type DataTableColumnPriority = "primary" | "secondary" | "tertiary";

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  numeric?: boolean;
  /** Columns progressively hide on narrow screens; primary columns always remain visible. */
  priority?: DataTableColumnPriority;
}

export interface DataTableProps<Row> {
  rows: readonly Row[];
  columns: readonly DataTableColumn<Row>[];
  getRowId: (row: Row) => string;
  selectedRowId?: string | null;
  onRowSelect?: (row: Row) => void;
  ariaLabel: string;
  empty?: ReactNode;
  caption?: ReactNode;
}

/**
 * Typed, keyboard-operable data grid for queues and registers. Sorting and paging intentionally
 * remain outside this component: those are API-specific concerns owned by the calling screen.
 */
export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  selectedRowId,
  onRowSelect,
  ariaLabel,
  empty,
  caption,
}: DataTableProps<Row>): JSX.Element {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="wx-data-table-scroll">
      <table className="wx-data-table" aria-label={ariaLabel}>
        {caption ? <caption className="wx-visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={columnClass(column.priority)}
                style={{ textAlign: column.numeric ? "right" : "left" }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = getRowId(row);
            const selected = id === selectedRowId;
            const interactive = Boolean(onRowSelect);
            return (
              <tr
                key={id}
                className={interactive ? "wx-data-row wx-data-row-interactive" : "wx-data-row"}
                aria-selected={interactive ? selected : undefined}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? () => onRowSelect?.(row) : undefined}
                onKeyDown={
                  interactive
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowSelect?.(row);
                        }
                      }
                    : undefined
                }
                style={{ background: selected ? t.primaryTint : undefined }}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={columnClass(column.priority)}
                    style={{
                      textAlign: column.numeric ? "right" : "left",
                      fontVariantNumeric: column.numeric ? "tabular-nums" : undefined,
                    }}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function columnClass(priority: DataTableColumnPriority | undefined): string | undefined {
  return priority && priority !== "primary" ? `wx-data-col-${priority}` : undefined;
}
