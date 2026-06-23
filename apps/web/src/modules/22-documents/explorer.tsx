// apps/web/src/modules/22-documents — Document Explorer (M22 §5.1 `DOC.Explorer` `/documents` +
// `DOC.PatientChart.DocumentsTab` `/patients/:patientId/documents`, Track B / ADR-0030, M22-T10).
// Spec: docs/ui/screens — "Use Work Queue". Tenant-wide document browse with patient / aggregate-type /
// retention-class filters and opaque-cursor pagination (SD-052 — `nextCursor` + `hasMore`, never an offset).
// Row click opens the document detail. The SERVER owns the §4.7 `document_owner_or_caseload` ABAC + RLS narrowing
// (ADR-0030 — no frontend authz; an out-of-scope document is simply absent from the list, never a 403). Reads
// GET /api/v1/documents via the typed client. Leaves only (@wardenx/ui + the local shared primitives).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, WorkQueueLayout, useApiClient } from "@wardenx/ui";
import { DOC_RETENTION_COLOR, DOC_STATUS_COLOR, DataTable, StatusChip, ts } from "./documents-shared";

interface DocumentRow {
  id: string;
  patientId: string | null;
  title: string;
  aggregateType: string;
  retentionClass: string;
  status: string;
  versionsCount: number;
  updatedAt: string;
}

interface DocumentPage {
  items: DocumentRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** The Explorer body; `patientId` (when present, from the chart-tab route) pre-filters the list to one patient. */
function DocumentExplorer({ title, patientId }: { title: string; patientId?: string }): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const aggregateType = params.get("aggregateType") ?? undefined;
  const retentionClass = params.get("retentionClass") ?? undefined;

  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursorArg: string | undefined) => {
      const { data, error: err } = await client.GET("/api/v1/documents", {
        params: {
          query: {
            ...(patientId ? { patientId } : {}),
            ...(aggregateType ? { aggregateType } : {}),
            ...(retentionClass ? { retentionClass } : {}),
            ...(cursorArg ? { cursor: cursorArg } : {}),
          },
        },
      });
      if (err) return null;
      return (data ?? null) as DocumentPage | null;
    },
    [client, patientId, aggregateType, retentionClass],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const page = await fetchPage(undefined);
    if (!page) {
      setError("Could not load documents.");
      setLoading(false);
      return;
    }
    setRows(page.items);
    setCursor(page.nextCursor);
    setHasMore(page.hasMore);
    setLoading(false);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const page = await fetchPage(cursor);
    if (!page) return;
    setRows((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [cursor, fetchPage]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title={title} />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No documents"
            description="No documents for the selected filters. Try widening the filters or clearing the patient filter."
          />
        ) : (
          <div>
            <DataTable<DocumentRow>
              rows={rows}
              rowKey={(d) => d.id}
              onSelect={(d) => navigate(`/documents/${d.id}`)}
              columns={[
                { header: "Title", cell: (d) => d.title },
                { header: "Type", cell: (d) => d.aggregateType },
                { header: "Retention", cell: (d) => <StatusChip value={d.retentionClass} colorMap={DOC_RETENTION_COLOR} /> },
                { header: "Status", cell: (d) => <StatusChip value={d.status} colorMap={DOC_STATUS_COLOR} /> },
                { header: "Versions", cell: (d) => String(d.versionsCount) },
                { header: "Updated", cell: (d) => ts(d.updatedAt) },
              ]}
            />
            {hasMore ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                style={{ margin: "0.75rem", padding: "0.4rem 0.9rem", cursor: "pointer" }}
              >
                Load more
              </button>
            ) : null}
          </div>
        )
      }
    />
  );
}

/** `DOC.Explorer` — tenant-wide document browse + filter. */
export function DocumentsExplorer(): JSX.Element {
  return <DocumentExplorer title="Documents" />;
}

/** `DOC.PatientChart.DocumentsTab` — the same browse pre-filtered to one patient's chart. */
export function PatientDocuments(): JSX.Element {
  const { patientId } = useParams<{ patientId: string }>();
  return <DocumentExplorer title="Patient Documents" patientId={patientId} />;
}
