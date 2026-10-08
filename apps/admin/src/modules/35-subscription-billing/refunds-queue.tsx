import {
  Button,
  StatusPill,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Refund queue (`/admin/refunds`, refund.read). The
// cross-tenant refund roster over GET /api/admin/refunds, filtered by state (requested/approved/executed/
// failed) client-side, with the org DISPLAY NAME (M35A-T03 seam) per row. Redesign list + right drawer: a row
// opens the refund (`?refund=<id>`); a `requested` one offers the four-eyes approval screen. The header action
// leads to a new refund request (`/admin/refunds/new`, not in the sidebar). Cursor-paged.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { cap, formatCents, formatDate, orgLabel, refundTone } from "./status";
import { DrawerHead, LoadMore, StateEmpty, StateError, StateLoading } from "./ui";

type RefundPage = operations["getApiAdminRefunds"]["responses"][200]["content"]["application/json"];
type Refund = RefundPage["items"][number];

const STATE_FILTERS = [
  "requested",
  "approved",
  "executed_success",
  "executed_failed",
  "denied",
] as const;

export function RefundsQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("refund");
  const [rows, setRows] = useState<Refund[]>([]);
  const [state, setState] = useState<string>("requested");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const guard = useRequestGuard();

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const isCurrent = guard();
      setLoading(true);
      setLoaded(false);
      setError(null);
      const query: Record<string, string> = {};
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/refunds", { params: { query } });
      if (!isCurrent()) return;
      if (res.error) {
        setError("Refunds unavailable.");
        setLoading(false);
        return;
      }
      const page = res.data;
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLoaded(true);
      setLoading(false);
    },
    [client, guard],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const filtered = useMemo(
    () => (state ? rows.filter((r) => r.status === state) : rows),
    [rows, state],
  );

  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  useStaleSelection({ param: "refund", ready: loaded, found: selected !== null });

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Refunds</h1>
            <p>Refund requests across every tenant, awaiting a distinct approver.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              aria-label="Filter by state"
            >
              <option value="">All states</option>
              {STATE_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {cap(s)}
                </option>
              ))}
            </select>
            <Button onClick={() => navigate("/admin/refunds/new")}>New refund</Button>
          </div>
        </header>
        {loading && rows.length === 0 ? (
          <StateLoading label="Loading refunds…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load(null, false)} />
        ) : filtered.length === 0 ? (
          <StateEmpty icon="rotate-ccw">No refunds in this state.</StateEmpty>
        ) : (
          <>
            <RefundsTable
              rows={filtered}
              selectedId={selectedId}
              onOpen={(id) => setParams({ refund: id })}
            />
            <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
          </>
        )}
      </div>
      {selected ? <RefundDrawer refund={selected} onClose={() => setParams({})} /> : null}
    </div>
  );
}

function RefundsTable({
  rows,
  selectedId,
  onOpen,
}: {
  rows: readonly Refund[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Refunds</caption>
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Requested</th>
            <th scope="col" className="wx-num-col">
              Amount
            </th>
            <th scope="col">Kind</th>
            <th scope="col">Reason</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={
                r.id === selectedId
                  ? "is-selected wx-data-row-interactive"
                  : "wx-data-row-interactive"
              }
              {...interactiveRowProps(() => onOpen(r.id), r.id === selectedId)}
            >
              <td>
                <span className="wx-row-title">
                  {orgLabel(r.organizationName, r.organizationId)}
                </span>
              </td>
              <td className="wx-nums">{formatDate(r.requestedAt)}</td>
              <td className="wx-num-col wx-nums">{formatCents(r.amountCents)}</td>
              <td>{cap(r.kind)}</td>
              <td>{cap(r.reasonCode)}</td>
              <td>
                <StatusPill label={cap(r.status)} tone={refundTone(r.status)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefundDrawer({ refund, onClose }: { refund: Refund; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" aria-label="Refund" {...drawer}>
      <DrawerHead
        icon="rotate-ccw"
        title={formatCents(refund.amountCents)}
        sub={orgLabel(refund.organizationName, refund.organizationId)}
        onClose={onClose}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Refund</h3>
            <StatusPill label={cap(refund.status)} tone={refundTone(refund.status)} />
          </div>
          <dl className="wx-kv">
            <dt>Requested</dt>
            <dd className="wx-nums">{formatDate(refund.requestedAt)}</dd>
            <dt>Amount</dt>
            <dd className="wx-nums">{formatCents(refund.amountCents)}</dd>
            <dt>Kind</dt>
            <dd>{cap(refund.kind)}</dd>
            <dt>Reason</dt>
            <dd>{cap(refund.reasonCode)}</dd>
          </dl>
          {refund.status === "requested" ? (
            <div className="wx-drawer-actions">
              <Button onClick={() => navigate(`/admin/refunds/${refund.id}/approve`)}>
                Review
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
