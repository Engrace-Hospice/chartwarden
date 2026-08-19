import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";
import { Button } from "./button";

export interface OffsetPaginationProps {
  /** One-based current page. */
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  noun?: ReactNode;
}

/** Pagination for a complete, client-side result set. */
export function OffsetPagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50],
  noun = "records",
}: OffsetPaginationProps): JSX.Element | null {
  if (totalItems === 0) return null;

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const firstItem = (currentPage - 1) * pageSize + 1;
  const lastItem = Math.min(currentPage * pageSize, totalItems);

  return (
    <nav
      aria-label="Pagination"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: t.space3,
        padding: `${t.space3} ${t.space5}`,
      }}
    >
      <span style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
        {firstItem}–{lastItem} of {totalItems} {noun}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: t.space3 }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: t.space2,
            color: t.onSurfaceVariant,
            fontSize: "0.8125rem",
          }}
        >
          Per page
          <select
            aria-label="Items per page"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", gap: t.space2 }}>
          <Button
            tone="secondary"
            size="sm"
            disabled={currentPage === 1}
            onClick={() => onPageChange(currentPage - 1)}
          >
            Previous
          </Button>
          <span
            aria-current="page"
            style={{ alignSelf: "center", color: t.onSurfaceVariant, fontSize: "0.8125rem" }}
          >
            {currentPage} / {totalPages}
          </span>
          <Button
            tone="secondary"
            size="sm"
            disabled={currentPage === totalPages}
            onClick={() => onPageChange(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </nav>
  );
}
