import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — order detail (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Detail" (Order Detail region). Shows the
// per-order facts the §5 detail pane renders: kind/priority/status, ordering physician + drafter, signature
// posture (signed/cosign/verbal), the verbal-order deadline, the correction link, and the lab transmission /
// results lifecycle (D17) — and, since #91, the five §2.2/§2.3/§2.5/§2.6 write ceremonies: sign, cosign,
// record-verbal, discontinue and mark-reviewed, each committing to its real M11 route through
// `orders-api.ts`. Which actions are OFFERED follows the order's own status (an active order is not
// signable); which are PERMITTED is the server's alone, and a 403 renders as the refusal it is.
// Reads GET /api/v1/orders/:id via the typed client; the server enforces every scope
// incl. ABAC (ADR-0030 — no frontend authz; out-of-scope orders 404, never 403). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { type OrderAction, OrderActionModal } from "./order-action-modal";
import {
  COSIGN_TONE,
  ORDER_TONE,
  PRIORITY_TONE,
  RESULTS_TONE,
  TRANSMISSION_TONE,
  stateLabel,
} from "./orders-status";

interface OrderDetailView {
  id: string;
  patientId: string;
  admissionId: string;
  kind: string;
  status: string;
  priority: string;
  drafterDiscipline: string;
  orderingPhysicianMdmId: string;
  cosignRequired: boolean;
  cosignStatus: "pending" | "attached" | null;
  transmissionStatus: string;
  resultsStatus: string;
  verbalDeadlineAt: string | null;
  discontinuationReason: string | null;
  replacesOrderId: string | null;
  signedAt: string | null;
  signedBy: string | null;
  completedAt: string | null;
  createdAt: string;
}

const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");

export function OrderDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<OrderDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<OrderAction | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/orders/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the order.");
        setLoading(false);
        return;
      }
      setRow(data as OrderDetailView);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  const isLab = row?.kind === "lab";

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Order"
          actions={
            row ? (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={ORDER_TONE[row.status] ?? "neutral"}
                />
                {/* Offered by STATUS, never by permission — §2.2 is the server's and so is §4.7. An
                    action the caller may not take is refused with a 403 the modal renders verbatim. */}
                {row.status === "pending_signature" || row.status === "verbal_pending" ? (
                  <Button size="sm" onClick={() => setAction("sign")}>
                    Sign
                  </Button>
                ) : null}
                {row.status === "draft" || row.status === "pending_signature" ? (
                  <Button size="sm" tone="secondary" onClick={() => setAction("verbal")}>
                    Record verbal
                  </Button>
                ) : null}
                {row.cosignRequired && row.cosignStatus !== "attached" ? (
                  <Button size="sm" tone="secondary" onClick={() => setAction("cosign")}>
                    Cosign
                  </Button>
                ) : null}
                {row.status === "active" ? (
                  <>
                    <Button size="sm" tone="secondary" onClick={() => setAction("complete")}>
                      {row.kind === "lab" ? "Mark reviewed" : "Complete"}
                    </Button>
                    <Button size="sm" tone="danger" onClick={() => setAction("discontinue")}>
                      Discontinue
                    </Button>
                  </>
                ) : null}
              </div>
            ) : undefined
          }
        >
          {row ? <span style={meta}>{stateLabel(row.kind)}</span> : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "12rem 1fr",
            gap: "0.4rem 1rem",
            fontSize: "0.85rem",
          }}
        >
          <dt style={dt}>Kind</dt>
          <dd style={dd}>{stateLabel(row.kind)}</dd>
          <dt style={dt}>Priority</dt>
          <dd style={dd}>
            <StatusPill
              label={stateLabel(row.priority)}
              tone={PRIORITY_TONE[row.priority] ?? "neutral"}
            />
          </dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>
            <StatusPill label={stateLabel(row.status)} tone={ORDER_TONE[row.status] ?? "neutral"} />
          </dd>
          <dt style={dt}>Drafter discipline</dt>
          <dd style={dd}>{stateLabel(row.drafterDiscipline)}</dd>
          <dt style={dt}>Ordering physician</dt>
          <dd style={dd} className="wx-data-md">
            {row.orderingPhysicianMdmId}
          </dd>
          <dt style={dt}>Signed</dt>
          <dd style={dd} className="tabular-nums">
            {row.signedAt ? `${ts(row.signedAt)} · ${row.signedBy ?? ""}` : "—"}
          </dd>
          <dt style={dt}>Cosignature</dt>
          <dd style={dd}>
            {row.cosignRequired ? (
              <StatusPill
                label={stateLabel(row.cosignStatus ?? "pending")}
                tone={COSIGN_TONE[row.cosignStatus ?? "pending"] ?? "neutral"}
              />
            ) : (
              <span style={{ color: "var(--color-muted)" }}>Not required</span>
            )}
          </dd>
          <dt style={dt}>Verbal deadline</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.verbalDeadlineAt)}
          </dd>
          <dt style={dt}>Corrects order</dt>
          <dd style={dd} className="wx-data-md">
            {row.replacesOrderId ?? "—"}
          </dd>
          <dt style={dt}>Discontinuation</dt>
          <dd style={dd}>
            {row.discontinuationReason ? stateLabel(row.discontinuationReason) : "—"}
          </dd>
          <dt style={dt}>Completed</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.completedAt)}
          </dd>
          {isLab ? (
            <>
              <dt style={dt}>Transmission</dt>
              <dd style={dd}>
                <StatusPill
                  label={stateLabel(row.transmissionStatus)}
                  tone={TRANSMISSION_TONE[row.transmissionStatus] ?? "neutral"}
                />
              </dd>
              <dt style={dt}>Results</dt>
              <dd style={dd}>
                <StatusPill
                  label={stateLabel(row.resultsStatus)}
                  tone={RESULTS_TONE[row.resultsStatus] ?? "neutral"}
                />
              </dd>
            </>
          ) : null}
        </dl>
      )}
      {row && action ? (
        <OrderActionModal
          open
          action={action}
          orderId={row.id}
          onClose={() => setAction(null)}
          onDone={(updated) => setRow({ ...row, ...(updated as Partial<OrderDetailView>) })}
        />
      ) : null}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
