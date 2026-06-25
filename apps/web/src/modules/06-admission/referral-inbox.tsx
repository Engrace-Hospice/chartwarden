import {
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Referral Inbox (M6 §5.2.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Work Queue."
// The queue of inbound referrals across sources, read from GET /api/v1/referrals via the generated
// typed client. A row opens the referral's admission (built later); the server enforces every scope
// (no authz on the frontend — ADR-0030). Reconciled to Lantern (R1): §6.6 status pills, mono ids,
// No-Line table. Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { REFERRAL_TONE, stateLabel } from "./admission-status";

interface ReferralRow {
  id: string;
  state: string;
  version: number;
}

export function ReferralInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState("");
  const [items, setItems] = useState<ReferralRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: { cursor?: string; limit?: number } = { limit: 50 };
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/referrals", { params: { query } });
      if (err) {
        setError("Could not load the referral inbox.");
        setLoading(false);
        return;
      }
      const page = data?.items ?? [];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Faceted state filter is applied client-side over the loaded page (server stays the source of truth).
  const filtered = state ? items.filter((r) => r.state === state) : items;
  const openCount = items.filter((r) => r.state === "received" || r.state === "triaged").length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Referral Inbox" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Open referrals" value={openCount} />
          <KpiCard label="In view" value={filtered.length} />
        </KpiStrip>
      }
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => setState("")}>
              Clear
            </button>
          }
        >
          <select
            aria-label="Referral state"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">Any state</option>
            <option value="received">Received</option>
            <option value="triaged">Triaged</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
            <option value="ineligible">Ineligible</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </FilterBar>
      }
      table={
        <ReferralTable
          items={filtered}
          loading={loading}
          error={error}
          onOpen={(id) => navigate(`/referrals/${id}`)}
          onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
        />
      }
    />
  );
}

function ReferralTable({
  items,
  loading,
  error,
  onOpen,
  onLoadMore,
}: {
  items: ReferralRow[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return (
      <EmptyState
        title="No active referrals"
        description="Referrals from HearthNote, phone, or fax appear here."
      />
    );
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Referral</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              onClick={() => onOpen(r.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onOpen(r.id);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <td className="wx-data-md">{r.id}</td>
              <td>
                <StatusPill
                  label={stateLabel(r.state)}
                  tone={REFERRAL_TONE[r.state] ?? "neutral"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onLoadMore ? (
        <div style={{ marginTop: "1rem", textAlign: "center" }}>
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
