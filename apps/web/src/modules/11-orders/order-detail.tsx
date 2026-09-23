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
// results lifecycle (D17). The sign / cosign / discontinue / mark-reviewed write actions fill in as their
// write surfaces harden. Reads GET /api/v1/orders/:id via the typed client; the server enforces every scope
// incl. ABAC (ADR-0030 — no frontend authz; out-of-scope orders 404, never 403). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { OrderEditor } from "./order-editor";
import type { EditableOrder } from "./order-editor";
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
  kindVersion: string;
  data: unknown;
  requirements: Array<{ code: string; label: string; status: "not_required" | "pending" | "satisfied"; deadlineAt?: string }>;
  allowedActions: { edit: boolean; request_signature: boolean; record_verbal: boolean; sign: boolean; cosign: boolean; complete: boolean; discontinue: boolean; correct: boolean };
}

const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");

export function OrderDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<OrderDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correctOpen, setCorrectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [discipline, setDiscipline] = useState("hospice_physician");
  const [cosignerRole, setCosignerRole] = useState("rn_case_manager");
  const [attestation, setAttestation] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/{id}", {
      params: { path: { id } },
    });
    if (err) {
      setError("Could not load the order.");
      setLoading(false);
      return;
    }
    setRow(data as unknown as OrderDetailView);
    setLoading(false);
  }, [client, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    const post = client.POST as unknown as (
      route: string,
      init: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>;
    const result = await post(path, { params: { path: { id } }, body });
    setBusy(false);
    if (result.error) {
      setActionError(domainMessage(result.error));
      await load();
      return;
    }
    setRow(result.data as OrderDetailView);
    await load();
  };

  const isLab = row?.kind === "lab";

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Order"
          actions={
            row ? (
              <StatusPill
                label={stateLabel(row.status)}
                tone={ORDER_TONE[row.status] ?? "neutral"}
              />
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
        <>
          <section
            style={{
              padding: "1rem",
              marginBottom: "1.25rem",
              border: "1px solid var(--color-outline-variant)",
              borderRadius: ".5rem",
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Current status</h2>
            <p>{statusText(row)}</p>
            <h3 style={{ fontSize: ".9rem" }}>Requirements</h3>
            <ul>{row.requirements.filter((x) => x.status !== "not_required").map((x) => <li key={x.code}>{x.status === "satisfied" ? "✓" : "○"} {x.label}: {x.status}{x.deadlineAt ? ` by ${ts(x.deadlineAt)}` : ""}</li>)}</ul>
            {actionError ? <div role="alert">{actionError}</div> : null}
            {row.allowedActions.edit || row.allowedActions.request_signature ? (
              <div style={actions}>
                <Button tone="secondary" onClick={() => setEditOpen(true)} disabled={busy || !row.allowedActions.edit}>
                  Edit order
                </Button>
                <Button
                  onClick={() =>
                    void mutate("/api/v1/orders/{id}/request-signature", {
                      signerDiscipline: discipline,
                    })
                  }
                  disabled={busy || !row.allowedActions.request_signature}
                >
                  Submit for signature
                </Button>
                <label>
                  Signer discipline{" "}
                  <input
                    value={discipline}
                    onChange={(e) => setDiscipline(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>
            ) : null}
            {row.allowedActions.sign ? (
              <div style={actions}>
                <Button
                  onClick={() =>
                    void mutate("/api/v1/orders/{id}/sign", {
                      signerDiscipline: discipline,
                      signedAtClient: new Date().toISOString(),
                    })
                  }
                  disabled={busy || !row.allowedActions.sign}
                >
                  Sign order
                </Button>
                {row.cosignRequired && row.cosignStatus !== "attached" ? (
                  <span>Signing is blocked until the required cosignature is attached.</span>
                ) : null}
                <label>
                  Signer discipline{" "}
                  <input
                    value={discipline}
                    onChange={(e) => setDiscipline(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>
            ) : null}
            {row.allowedActions.record_verbal ? (
              <div style={actions}>
                <Button
                  tone="secondary"
                  onClick={() =>
                    void mutate("/api/v1/orders/{id}/verbal", {
                      recorderDiscipline: discipline,
                      verbalAttestation: attestation,
                      receivedAt: new Date().toISOString(),
                      orderingPhysicianMdmId: row.orderingPhysicianMdmId,
                    })
                  }
                  disabled={busy || attestation.length < 100}
                >
                  Record verbal order
                </Button>
                <textarea
                  aria-label="Verbal attestation"
                  value={attestation}
                  onChange={(e) => setAttestation(e.target.value)}
                  placeholder="Required attestation (100 characters minimum)"
                />
              </div>
            ) : null}
            {row.allowedActions.cosign ? (
              <div style={actions}>
                <Button
                  tone="secondary"
                  onClick={() =>
                    void mutate("/api/v1/orders/{id}/cosign", {
                      cosignerRole,
                      attestationText: attestation,
                    })
                  }
                  disabled={busy || attestation.length < 50}
                >
                  Cosign order
                </Button>
                <select value={cosignerRole} onChange={(e) => setCosignerRole(e.target.value)}>
                  <option value="rn_case_manager">RN case manager</option>
                  <option value="clinical_supervisor">Clinical supervisor</option>
                  <option value="medical_director">Medical director</option>
                </select>
                <textarea
                  aria-label="Cosign attestation"
                  value={attestation}
                  onChange={(e) => setAttestation(e.target.value)}
                  placeholder="Required attestation (50 characters minimum)"
                />
              </div>
            ) : null}
            {row.allowedActions.complete || row.allowedActions.discontinue || row.allowedActions.correct ? (
              <div style={actions}>
                <Button
                  onClick={() => void mutate("/api/v1/orders/{id}/complete", {})}
                  disabled={busy || !row.allowedActions.complete}
                >
                  Complete
                </Button>
                <Button
                  tone="secondary"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discontinue this active order? This action is recorded in the clinical history.",
                      )
                    )
                      void mutate("/api/v1/orders/{id}/discontinue", {
                        reason: "clinical_judgement",
                        effectiveAt: new Date().toISOString(),
                      });
                  }}
                  disabled={busy || !row.allowedActions.discontinue}
                >
                  Discontinue
                </Button>
                <Button tone="secondary" onClick={() => setCorrectOpen(true)} disabled={busy || !row.allowedActions.correct}>
                  Correct
                </Button>
              </div>
            ) : null}
          </section>
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
              <StatusPill
                label={stateLabel(row.status)}
                tone={ORDER_TONE[row.status] ?? "neutral"}
              />
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
          <OrderEditor
            open={correctOpen}
            onClose={() => setCorrectOpen(false)}
            patientId={row.patientId}
            replacesOrderId={row.id}
            onSaved={(newId) => {
              setCorrectOpen(false);
              window.location.assign(`/orders/${newId}`);
            }}
          />
          <OrderEditor
            open={editOpen}
            onClose={() => setEditOpen(false)}
            patientId={row.patientId}
            draft={{ ...row, kind: row.kind as EditableOrder["kind"] }}
            onSaved={() => {
              setEditOpen(false);
              void load();
            }}
          />
        </>
      )}
    </DetailPageLayout>
  );
}

function statusText(row: OrderDetailView): string {
  if (row.status === "draft") return "This order has not been submitted for signature.";
  if (row.status === "verbal_pending")
    return `Verbal order awaiting signature${row.verbalDeadlineAt ? ` before ${ts(row.verbalDeadlineAt)}` : ""}.`;
  if (row.status === "pending_signature")
    return row.cosignRequired && row.cosignStatus !== "attached"
      ? "Signature is waiting on the required cosignature."
      : "This order is awaiting an eligible signature.";
  if (row.status === "active") return "This order is active.";
  return `This order is ${stateLabel(row.status).toLowerCase()}.`;
}
function domainMessage(error: unknown): string {
  const x = error as { message?: string; detail?: string; status?: number } | undefined;
  const text = x?.detail ?? x?.message ?? "The order could not be updated.";
  return /cosign/i.test(text)
    ? "This order cannot be signed yet because its required cosignature is still pending."
    : text;
}
const actions = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: ".75rem",
  alignItems: "center",
  marginTop: ".75rem",
};

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
