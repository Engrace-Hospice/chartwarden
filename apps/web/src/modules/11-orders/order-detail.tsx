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
  requirements: Array<{
    code: string;
    label: string;
    status: "not_required" | "pending" | "satisfied";
    deadlineAt?: string;
  }>;
  allowedActions: {
    edit: boolean;
    request_signature: boolean;
    record_verbal: boolean;
    sign: boolean;
    cosign: boolean;
    complete: boolean;
    discontinue: boolean;
    correct: boolean;
  };
}

const ts = (v: string | null): string =>
  v ? v.slice(0, 16).replace("T", " ") : "—";

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
  const [verbalAttestation, setVerbalAttestation] = useState("");
  const [cosignAttestation, setCosignAttestation] = useState("");
  const [confirmDiscontinue, setConfirmDiscontinue] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setRow(null);
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

  const mutate = async (
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<void> => {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    const post = client.POST as unknown as (
      route: string,
      init: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>;
    let result: { data?: unknown; error?: unknown };
    try {
      result = await post(path, { params: { path: { id } }, body });
    } catch {
      setActionError("The order could not be updated. Please try again.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (result.error) {
      setActionError(domainMessage(result.error));
      await load();
      return;
    }
    setConfirmDiscontinue(false);
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
          <div style={summaryGrid}>
            <section style={card} aria-labelledby="order-status-heading">
              <div style={sectionHeading}>
                <div>
                  <h2 id="order-status-heading" style={heading}>
                    Current status
                  </h2>
                  <p style={hint}>{statusText(row)}</p>
                </div>
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={ORDER_TONE[row.status] ?? "neutral"}
                />
              </div>
              <div style={facts}>
                <span>
                  Priority{" "}
                  <StatusPill
                    label={stateLabel(row.priority)}
                    tone={PRIORITY_TONE[row.priority] ?? "neutral"}
                  />
                </span>
                <span>
                  Created <strong>{ts(row.createdAt)}</strong>
                </span>
              </div>
            </section>
            <section style={card} aria-labelledby="requirements-heading">
              <h2 id="requirements-heading" style={heading}>
                Requirements
              </h2>
              {row.requirements.filter((item) => item.status !== "not_required")
                .length ? (
                <ul style={requirements}>
                  {row.requirements
                    .filter((item) => item.status !== "not_required")
                    .map((item) => (
                      <li key={item.code} style={requirement}>
                        <span
                          aria-hidden="true"
                          style={{
                            color:
                              item.status === "satisfied"
                                ? "var(--color-success, #15803d)"
                                : "var(--color-warning, #b45309)",
                            fontWeight: 700,
                            lineHeight: 1.5,
                          }}
                        >
                          {item.status === "satisfied" ? "✓" : "○"}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={requirementTitleRow}>
                            <strong>{item.label}</strong>
                            <span style={mutedInline}>
                              {item.status === "satisfied"
                                ? "Complete"
                                : "Incomplete"}
                            </span>
                          </div>
                          {item.code === "clinical_details" &&
                          item.status === "pending" ? (
                            <>
                              <small style={muted}>
                                Complete the required clinical information
                                before submitting this order for signature.
                              </small>
                              {row.allowedActions.edit ? (
                                <div style={{ marginTop: ".65rem" }}>
                                  <Button
                                    type="button"
                                    tone="secondary"
                                    onClick={() => setEditOpen(true)}
                                    disabled={busy}
                                  >
                                    Complete clinical details
                                  </Button>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                          {item.deadlineAt ? (
                            <small style={muted}>
                              Due {ts(item.deadlineAt)}
                            </small>
                          ) : null}
                        </div>
                      </li>
                    ))}
                </ul>
              ) : (
                <p style={hint}>No outstanding requirements.</p>
              )}
            </section>
          </div>
          <section style={card} aria-labelledby="actions-heading">
            <h2 id="actions-heading" style={heading}>
              Available actions
            </h2>
            {actionError ? (
              <p role="alert" style={errorStyle}>
                {actionError}
              </p>
            ) : null}
            {busy ? (
              <p role="status" style={hint}>
                Updating order…
              </p>
            ) : null}
            {row.allowedActions.edit ||
            row.allowedActions.request_signature ||
            row.allowedActions.sign ? (
              <div style={actionGroup}>
                <h3 style={subheading}>Prepare and sign</h3>
                {row.allowedActions.request_signature ||
                row.allowedActions.sign ? (
                  <label style={field}>
                    Signer discipline
                    <select
                      value={discipline}
                      onChange={(event) => setDiscipline(event.target.value)}
                      disabled={busy}
                      style={control}
                    >
                      <option value="hospice_physician">
                        Hospice physician
                      </option>
                      <option value="attending_physician">
                        Attending physician
                      </option>
                    </select>
                  </label>
                ) : null}
                <div style={actions}>
                  {row.allowedActions.edit ? (
                    <Button
                      tone="secondary"
                      onClick={() => setEditOpen(true)}
                      disabled={busy}
                    >
                      Edit draft
                    </Button>
                  ) : null}
                  {row.allowedActions.request_signature ? (
                    <Button
                      onClick={() =>
                        void mutate("/api/v1/orders/{id}/request-signature", {
                          signerDiscipline: discipline,
                        })
                      }
                      disabled={busy}
                    >
                      Submit for signature
                    </Button>
                  ) : null}
                  {row.allowedActions.sign ? (
                    <Button
                      onClick={() =>
                        void mutate("/api/v1/orders/{id}/sign", {
                          signerDiscipline: discipline,
                          signedAtClient: new Date().toISOString(),
                        })
                      }
                      disabled={busy}
                    >
                      Sign order
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {row.allowedActions.record_verbal ? (
              <div style={actionGroup}>
                <h3 style={subheading}>Verbal order</h3>
                <label style={field}>
                  Attestation
                  <textarea
                    value={verbalAttestation}
                    onChange={(event) =>
                      setVerbalAttestation(event.target.value)
                    }
                    disabled={busy}
                    style={textarea}
                    placeholder="Document the verbal order and how it was received"
                    minLength={100}
                  />
                </label>
                <small style={muted}>
                  {verbalAttestation.trim().length}/100 characters minimum
                </small>
                <div style={actions}>
                  <Button
                    tone="secondary"
                    onClick={() =>
                      void mutate("/api/v1/orders/{id}/verbal", {
                        recorderDiscipline: discipline,
                        verbalAttestation: verbalAttestation.trim(),
                        receivedAt: new Date().toISOString(),
                        orderingPhysicianMdmId: row.orderingPhysicianMdmId,
                      })
                    }
                    disabled={busy || verbalAttestation.trim().length < 100}
                  >
                    Record verbal order
                  </Button>
                </div>
              </div>
            ) : null}
            {row.allowedActions.cosign ? (
              <div style={actionGroup}>
                <h3 style={subheading}>Cosignature</h3>
                <label style={field}>
                  Cosigner role
                  <select
                    value={cosignerRole}
                    onChange={(event) => setCosignerRole(event.target.value)}
                    disabled={busy}
                    style={control}
                  >
                    <option value="rn_case_manager">RN case manager</option>
                    <option value="clinical_supervisor">
                      Clinical supervisor
                    </option>
                    <option value="medical_director">Medical director</option>
                  </select>
                </label>
                <label style={field}>
                  Attestation
                  <textarea
                    value={cosignAttestation}
                    onChange={(event) =>
                      setCosignAttestation(event.target.value)
                    }
                    disabled={busy}
                    style={textarea}
                    placeholder="Document the cosignature"
                    minLength={50}
                  />
                </label>
                <small style={muted}>
                  {cosignAttestation.trim().length}/50 characters minimum
                </small>
                <div style={actions}>
                  <Button
                    tone="secondary"
                    onClick={() =>
                      void mutate("/api/v1/orders/{id}/cosign", {
                        cosignerRole,
                        attestationText: cosignAttestation.trim(),
                      })
                    }
                    disabled={busy || cosignAttestation.trim().length < 50}
                  >
                    Cosign order
                  </Button>
                </div>
              </div>
            ) : null}
            {row.allowedActions.complete ||
            row.allowedActions.discontinue ||
            row.allowedActions.correct ? (
              <div style={actionGroup}>
                <h3 style={subheading}>Manage order</h3>
                <div style={actions}>
                  {row.allowedActions.complete ? (
                    <Button
                      onClick={() =>
                        void mutate("/api/v1/orders/{id}/complete")
                      }
                      disabled={busy}
                    >
                      Mark complete
                    </Button>
                  ) : null}
                  {row.allowedActions.correct ? (
                    <Button
                      tone="secondary"
                      onClick={() => setCorrectOpen(true)}
                      disabled={busy}
                    >
                      Create correction
                    </Button>
                  ) : null}
                  {row.allowedActions.discontinue ? (
                    <Button
                      tone="secondary"
                      onClick={() => setConfirmDiscontinue(true)}
                      disabled={busy}
                    >
                      Discontinue
                    </Button>
                  ) : null}
                </div>
                {confirmDiscontinue ? (
                  <div
                    style={confirmBox}
                    role="group"
                    aria-label="Confirm discontinuation"
                  >
                    <p style={{ marginTop: 0 }}>
                      Discontinue this active order? This action is recorded in
                      the clinical history.
                    </p>
                    <div style={actions}>
                      <Button
                        onClick={() =>
                          void mutate("/api/v1/orders/{id}/discontinue", {
                            reason: "clinical_judgement",
                            effectiveAt: new Date().toISOString(),
                          })
                        }
                        disabled={busy}
                      >
                        Confirm discontinuation
                      </Button>
                      <Button
                        tone="secondary"
                        onClick={() => setConfirmDiscontinue(false)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {!Object.values(row.allowedActions).some(Boolean) ? (
              <p style={hint}>
                No actions are available for this order at the moment.
              </p>
            ) : null}
          </section>
          <h2 style={heading}>Order information</h2>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
              gap: "0.4rem 1rem",
              fontSize: "0.875rem",
              padding: "1.25rem",
              border: "1px solid var(--color-outline-variant)",
              borderRadius: ".75rem",
              marginTop: ".75rem",
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
              {row.signedAt
                ? `${ts(row.signedAt)} · ${row.signedBy ?? ""}`
                : "—"}
            </dd>
            <dt style={dt}>Cosignature</dt>
            <dd style={dd}>
              {row.cosignRequired ? (
                <StatusPill
                  label={stateLabel(row.cosignStatus ?? "pending")}
                  tone={COSIGN_TONE[row.cosignStatus ?? "pending"] ?? "neutral"}
                />
              ) : (
                <span style={{ color: "var(--color-muted)" }}>
                  Not required
                </span>
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
              {row.discontinuationReason
                ? stateLabel(row.discontinuationReason)
                : "—"}
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
                    tone={
                      TRANSMISSION_TONE[row.transmissionStatus] ?? "neutral"
                    }
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
  if (row.status === "draft")
    return "This order has not been submitted for signature.";
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
  const x = error as
    | { message?: string; detail?: string; status?: number }
    | undefined;
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

const card = {
  padding: "1.25rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
  background: "var(--color-surface, #fff)",
  minWidth: 0,
} as const;
const summaryGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 21rem), 1fr))",
  gap: "1rem",
  marginBottom: "1rem",
} as const;
const sectionHeading = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  flexWrap: "wrap" as const,
  gap: ".75rem",
};
const heading = {
  fontSize: "1.05rem",
  margin: "0 0 .5rem",
  color: "var(--color-on-surface)",
} as const;
const subheading = { fontSize: ".9rem", margin: "0 0 .75rem" } as const;
const hint = {
  margin: ".25rem 0 .75rem",
  color: "var(--color-on-surface-variant)",
  lineHeight: 1.5,
} as const;
const muted = {
  display: "block",
  color: "var(--color-on-surface-variant)",
  fontSize: ".8rem",
} as const;
const facts = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "1rem",
  marginTop: ".75rem",
  fontSize: ".85rem",
  alignItems: "center",
};
const requirements = {
  listStyle: "none",
  padding: 0,
  margin: ".75rem 0 0",
} as const;
const requirement = {
  display: "flex",
  alignItems: "flex-start",
  gap: ".65rem",
  padding: ".5rem 0",
  borderTop: "1px solid var(--color-outline-variant)",
} as const;
const requirementTitleRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  flexWrap: "wrap" as const,
  gap: ".5rem",
} as const;
const mutedInline = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".8rem",
  fontWeight: 500,
} as const;
const actionGroup = {
  borderTop: "1px solid var(--color-outline-variant)",
  paddingTop: "1rem",
  marginTop: "1rem",
} as const;
const field = {
  display: "grid",
  gap: ".4rem",
  maxWidth: "35rem",
  fontSize: ".875rem",
  fontWeight: 600,
} as const;
const control = {
  width: "100%",
  minHeight: "2.5rem",
  borderRadius: ".4rem",
  border: "1px solid var(--color-outline-variant)",
  padding: ".5rem",
  background: "var(--color-surface, #fff)",
  color: "var(--color-on-surface)",
} as const;
const textarea = {
  ...control,
  minHeight: "6rem",
  resize: "vertical" as const,
  font: "inherit",
};
const confirmBox = {
  marginTop: "1rem",
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".5rem",
} as const;
const errorStyle = {
  color: "var(--color-error, #b42318)",
  padding: ".75rem",
  border: "1px solid currentColor",
  borderRadius: ".5rem",
} as const;
