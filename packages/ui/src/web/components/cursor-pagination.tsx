import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";
import { Button } from "./button";

export interface CursorPaginationProps {
  /** Number of records already rendered, not a fabricated total. */
  loadedCount: number;
  hasNextPage: boolean;
  hasPreviousPage?: boolean;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
  loading?: boolean;
  noun?: ReactNode;
}

/** Pagination for cursor APIs. It exposes only information the server actually supplies. */
export function CursorPagination({
  loadedCount,
  hasNextPage,
  hasPreviousPage = false,
  onNextPage,
  onPreviousPage,
  loading = false,
  noun = "records",
}: CursorPaginationProps): JSX.Element | null {
  if (!hasNextPage && !hasPreviousPage) return null;
  return (
    <nav
      className="wx-cursor-pagination"
      aria-label="Pagination"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: t.space3,
        padding: `${t.space3} ${t.space5}`,
      }}
    >
      <span style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
        {loadedCount} {noun} loaded
      </span>
      <div style={{ display: "flex", gap: t.space2 }}>
        {hasPreviousPage ? (
          <Button tone="secondary" size="sm" disabled={loading} onClick={onPreviousPage}>
            Previous
          </Button>
        ) : null}
        {hasNextPage ? (
          <Button tone="secondary" size="sm" loading={loading} onClick={onNextPage}>
            Load more
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
