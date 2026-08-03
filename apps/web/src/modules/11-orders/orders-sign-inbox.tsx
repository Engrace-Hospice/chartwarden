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
// apps/web/src/modules/11-orders — physician signature inbox (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Patient Workspace + Work Queue" (signature
// inbox half). The global queue of orders awaiting a physician signature, KPI'd by kind, sorted by created.
// Priority (routine/stat/asap) is surfaced as a UX cue; the server owns the authoritative §2.2 D2 status
// (ADR-0030 — no frontend authz). Reads GET /api/v1/orders/pending-signature via the typed client. The
// sign step-up action fills in as its write surface hardens. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { COSIGN_TONE, PRIORITY_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  priority: string;
  cosignStatus: "pending" | "attached" | null;
  createdAt: string;
}

export function OrdersSignInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/pending-signature", {});
    if (err) {
      setError("Could not load the signature inbox.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: items.length,
      stat: items.filter((o) => o.priority === "stat").length,
      asap: items.filter((o) => o.priority === "asap").length,
      cosign: items.filter((o) => o.cosignStatus === "pending").length,
    }),
    [items],
  );

  const rows = useMemo(() => {
    const visible = kind ? items.filter((o) => o.kind === kind) : items;
    return [...visible].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [items, kind]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Orders Awaiting Signature" />}
      kpis={
        // UI-003 containment: during load/outage these used to read "Awaiting signature 0" — a false
        // all-clear on a clinical queue. "—" until the load actually answered.
        <KpiStrip>
          <KpiCard label="Awaiting signature" value={loading || error ? "—" : counts.total} />
          <KpiCard label="STAT" value={loading || error ? "—" : counts.stat} onSelect={() => setKind("")} />
          <KpiCard label="ASAP" value={loading || error ? "—" : counts.asap} onSelect={() => setKind("")} />
          <KpiCard label="Cosign pending" value={loading || error ? "—" : counts.cosign} />
        </KpiStrip>
      }
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => setKind("")}>
              Clear
            </button>
          }
        >
          <select aria-label="Order kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any kind</option>
            <option value="lab">lab</option>
            <option value="dme">dme</option>
            <option value="level_of_care_change">level_of_care_change</option>
            <option value="recertification">recertification</option>
            <option value="comfort_kit">comfort_kit</option>
            <option value="supply">supply</option>
            <option value="ancillary_service">ancillary_service</option>
            <option value="idg_requested">idg_requested</option>
          </select>
        </FilterBar>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No orders awaiting signature"
            description="The signature inbox is clear."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order · kind</th>
                <th>Priority</th>
                <th>Cosign</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr
                  key={o.id}
                  // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/orders/${o.id}`)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      navigate(`/orders/${o.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td>{stateLabel(o.kind)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(o.priority)}
                      tone={PRIORITY_TONE[o.priority] ?? "neutral"}
                    />
                  </td>
                  <td>
                    {o.cosignStatus ? (
                      <StatusPill
                        label={stateLabel(o.cosignStatus)}
                        tone={COSIGN_TONE[o.cosignStatus] ?? "neutral"}
                      />
                    ) : (
                      <span style={{ color: "var(--color-muted)" }}>—</span>
                    )}
                  </td>
                  <td className="tabular-nums">{o.createdAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
