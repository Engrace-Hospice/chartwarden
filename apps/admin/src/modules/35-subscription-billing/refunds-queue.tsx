import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Refund queue (`/admin/refunds`, refund.read). The
// cross-tenant refund roster over GET /api/admin/refunds, filtered by state (requested/approved/executed/
// failed) client-side, with the org DISPLAY NAME (M35A-T03 seam) per row. `requested` rows link to the
// four-eyes approval screen; the header links to a new refund request. Cursor-paged.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { actionButtonStyle, bodyRow, cell, cellRight, inputStyle, LoadMore, tableStyle, theadRow } from "./ui";
import { cap, formatCents, formatDate, orgLabel, refundTone } from "./status";

interface Refund {
  id: string;
  organizationId: string;
  organizationName: string;
  invoiceId: string;
  amountCents: number;
  kind: string;
  reasonCode: string;
  status: string;
  requestedAt: string;
}

const STATE_FILTERS = ["requested", "approved", "executed_success", "executed_failed", "denied"] as const;

export function RefundsQueue(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Refund[]>([]);
  const [state, setState] = useState<string>("requested");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string> = {};
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/refunds", { params: { query } });
      if (res.error) {
        setError("Refunds unavailable.");
        setLoading(false);
        return;
      }
      const page = res.data as unknown as { items: Refund[]; nextCursor: string | null; hasMore: boolean };
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const filtered = useMemo(() => (state ? rows.filter((r) => r.status === state) : rows), [rows, state]);

  return (
    <div style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <PageHeader
        title="Refunds"
        breadcrumb="Platform Ops"
        actions={
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <select value={state} onChange={(e) => setState(e.target.value)} style={inputStyle} aria-label="Filter by state">
              <option value="">All states</option>
              {STATE_FILTERS.map((s) => (
                <option key={s} value={s}>{cap(s)}</option>
              ))}
            </select>
            <Link to="/admin/refunds/new" style={actionButtonStyle(true)}>New refund</Link>
          </div>
        }
      />
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : filtered.length === 0 ? (
        <EmptyState title="No refunds" description="No refunds in this state." />
      ) : (
        <>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Requested</th>
                <th style={cell}>Organization</th>
                <th style={cellRight}>Amount</th>
                <th style={cell}>Kind</th>
                <th style={cell}>Reason</th>
                <th style={cell}>Status</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} style={bodyRow}>
                  <td style={cell} className="tabular-nums">{formatDate(r.requestedAt)}</td>
                  <td style={cell}>{orgLabel(r.organizationName, r.organizationId)}</td>
                  <td style={cellRight} className="tabular-nums">{formatCents(r.amountCents)}</td>
                  <td style={cell}>{cap(r.kind)}</td>
                  <td style={cell}>{cap(r.reasonCode)}</td>
                  <td style={cell}><StatusPill label={cap(r.status)} tone={refundTone(r.status)} /></td>
                  <td style={cell}>
                    {r.status === "requested" ? (
                      <Link to={`/admin/refunds/${r.id}/approve`} style={actionButtonStyle(true)}>Review</Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
        </>
      )}
    </div>
  );
}
