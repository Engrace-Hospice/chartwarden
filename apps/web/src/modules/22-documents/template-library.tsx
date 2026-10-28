import {
  Button,
  CursorPagination,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/22-documents — FORM.TemplateLibrary (M22 §5.1, Track B / ADR-0030).
// Spec: §5.1 "FORM.TemplateLibrary" — browse the platform-floor form templates with version metadata; the
// per-template overlay editor (§5.1 FORM.TemplateOverlayEditor, D16 loosen-block) + render preview are admin
// write surfaces that fill in as those paths harden. Built to the Lantern look: Work Queue pattern, §6.6
// status pills, §3.1 mono identifiers (template key), No-Line table (§6.7), warm-paper surfaces. Nav-grouped
// under Admin and gated by `documents.read_templates` — but the SERVER stays the only authz point (ADR-0030).
// Reads GET /api/v1/form-templates (cursor-paginated) via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Mono, ts } from "./lantern";

interface TemplateRow {
  id: string;
  key: string;
  createdAt: string;
}

interface TemplatePage {
  items: TemplateRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

const PAGE_SIZE = 25;

export function TemplateLibrary(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<(string | null)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/form-templates", {
      params: { query: { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE } },
    } as never);
    if (err) {
      setError("Could not load the form-template library.");
      setLoading(false);
      return;
    }
    const page = data as unknown as TemplatePage | null;
    setRows(page?.items ?? []);
    setNextCursor(page?.nextCursor ?? null);
    setHasMore(Boolean(page?.hasMore));
    setLoading(false);
  }, [client, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  function nextPage(): void {
    if (!nextCursor) return;
    setPreviousCursors((stack) => [...stack, cursor]);
    setCursor(nextCursor);
  }

  function previousPage(): void {
    setPreviousCursors((stack) => {
      const nextStack = [...stack];
      const previous = nextStack.pop() ?? null;
      setCursor(previous);
      return nextStack;
    });
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Form Templates"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Browse published platform-floor form templates and their catalog metadata.
          </div>
        </PageHeader>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && rows.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No templates"
              description="No form templates are published for this tenant yet."
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Template key</th>
                  <th style={thStyle}>Id</th>
                  <th style={thStyle}>Scope</th>
                  <th style={thStyle}>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <Mono>{t.key}</Mono>
                    </td>
                    <td style={tdStyle}>
                      <Mono>{t.id.slice(0, 8)}</Mono>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill label="Platform floor" tone="neutral" />
                    </td>
                    <td className="tabular-nums" style={tdStyle}>
                      {ts(t.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <CursorPagination
              loadedCount={rows.length}
              hasNextPage={hasMore}
              hasPreviousPage={previousCursors.length > 0}
              onNextPage={nextPage}
              onPreviousPage={previousPage}
              loading={loading}
              noun="form templates"
            />
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Catalog</h3>
            <p style={railTextStyle}>
              Form templates are platform reference data. Tenant overlay editing and render preview
              remain absent here until those write surfaces are hardened.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

const tableWrapStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minWidth: 0,
} as const;

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
} as const;

const thStyle = {
  padding: "0.75rem 1rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
} as const;

const tdStyle = {
  padding: "0.75rem 1rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
} as const;

const rowStyle = {
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
} as const;

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
} as const;

const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
} as const;

const railTextStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
