import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  nowLocalInput,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/11-orders — order detail (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ORDERS.md — "Use Detail" (Order Detail region). Shows the
// per-order facts the §5 detail pane renders: kind/priority/status, ordering physician + drafter, signature
// posture (signed/cosign/verbal), the verbal-order deadline, the correction link, and the lab transmission /
// results lifecycle (D17) — and the §2.2/§2.3/§2.5/§2.6 write ceremonies (sign, cosign, record-verbal,
// discontinue, complete / lab mark-reviewed, correction) in the "Available actions" panel. Which actions
// are OFFERED follows the server's own `allowedActions`; which are PERMITTED is the server's alone, and a
// refusal renders as the domain message it is.
// Reads GET /api/v1/orders/:id via the typed client; the server enforces every scope
// incl. ABAC (ADR-0030 — no frontend authz; out-of-scope orders 404, never 403). Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import { nameText } from "../../shell/name-display";
import { usePhysicianNames } from "../../shell/physician-names";
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
import { ResendResult, ResendTransmission } from "./resend-transmission";
import {
  type ResendOutcome,
  notSentInfoLabel,
  transmissionFailureLabel,
} from "./resend-transmission-api";

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
  /** The server's failure token, or `null` when not failed / not visible to this reader (redacted server-side). */
  transmissionFailureReason?: string | null;
  resultsStatus: string;
  verbalDeadlineAt: string | null;
  discontinuationReason: string | null;
  replacesOrderId: string | null;
  signedAt: string | null;
  signedBy: string | null;
  /** Server-resolved signer name (no email); a missing name shows the neutral "Staff member". */
  signedByDisplayName?: string | null;
  completedAt: string | null;
  createdAt: string;
  kindVersion: string;
  data: unknown;
  verbalOrder: {
    status: string;
    receivedAt: string;
    effectiveAt: string;
    deadlineAt: string;
    signedAt: string | null;
    readBackVerified: boolean;
    attestation: string;
  } | null;
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
    resend_transmission?: boolean;
  };
}

const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");

export function OrderDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<OrderDetailView | null>(null);
  const physicianNames = usePhysicianNames(
    row?.orderingPhysicianMdmId ? [row.orderingPhysicianMdmId] : [],
  );
  const physicianLabel = row?.orderingPhysicianMdmId
    ? nameText(physicianNames[row.orderingPhysicianMdmId])
    : "Not assigned";
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
  const [resendOutcome, setResendOutcome] = useState<ResendOutcome | null>(null);
  const [verbalEffectiveAt, setVerbalEffectiveAt] = useState(nowLocalInput);

  const [readBackVerified, setReadBackVerified] = useState(false);

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

  const mutate = async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
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
  const verbalPending = row?.status === "verbal_pending";

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
              {row.requirements.filter((item) => item.status !== "not_required").length ? (
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
                                ? "var(--color-success)"
                                : "var(--color-warning)",
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
                              {item.status === "satisfied" ? "Complete" : "Incomplete"}
                            </span>
                          </div>
                          {item.code === "clinical_details" && item.status === "pending" ? (
                            <>
                              <small style={muted}>
                                Complete the required clinical information before submitting this
                                order for signature.
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
                            <small style={muted}>Due {ts(item.deadlineAt)}</small>
                          ) : null}
                          {item.code === "verbal_signature" && item.status === "pending" ? (
                            <small style={muted}>
                              An eligible physician must authenticate this verbal order before the
                              deadline. Use “Authenticate verbal order” below.
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
              <p style={hint}>
                <output>Updating order…</output>
              </p>
            ) : null}
            {resendOutcome ? <ResendResult outcome={resendOutcome} /> : null}
            {row.allowedActions.resend_transmission ? (
              <ResendTransmission
                orderId={row.id}
                failureReason={row.transmissionFailureReason ?? null}
                onResent={(outcome) => {
                  setResendOutcome(outcome);
                  void load();
                }}
              />
            ) : null}
            {row.allowedActions.edit ||
            row.allowedActions.request_signature ||
            row.allowedActions.sign ? (
              <div style={actionGroup}>
                <h3 style={subheading}>
                  {verbalPending ? "Authenticate verbal order" : "Prepare and sign"}
                </h3>
                {verbalPending ? (
                  <p style={hint}>
                    This completes the physician authentication for the recorded verbal order.
                  </p>
                ) : null}
                {row.allowedActions.request_signature || row.allowedActions.sign ? (
                  <label style={field}>
                    Signer discipline
                    <select
                      value={discipline}
                      onChange={(event) => setDiscipline(event.target.value)}
                      disabled={busy}
                      style={control}
                    >
                      <option value="hospice_physician">Hospice physician</option>
                      <option value="attending_physician">Attending physician</option>
                    </select>
                  </label>
                ) : null}
                <div style={actions}>
                  {row.allowedActions.edit ? (
                    <Button tone="secondary" onClick={() => setEditOpen(true)} disabled={busy}>
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
                      {verbalPending ? "Authenticate verbal order" : "Sign order"}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {row.allowedActions.record_verbal ? (
              <div style={actionGroup}>
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ ...subheading, marginBottom: 4 }}>Verbal order</h3>

                  <p style={{ ...muted, margin: 0 }}>
                    Document the physician communication and verify the order before recording it as
                    verbal.
                  </p>
                </div>

                {/* Physician */}
                <div style={verbalInfoGrid}>
                  <div style={verbalInfoItem}>
                    <span style={verbalInfoLabel}>Physician</span>

                    <strong style={verbalInfoValue}>{physicianLabel}</strong>
                  </div>

                  <div style={verbalInfoItem}>
                    <span style={verbalInfoLabel}>Created by</span>

                    <strong style={verbalInfoValue}>Current user</strong>
                  </div>
                </div>

                {/* Physician communication */}
                <label style={field}>
                  Physician communication
                  <textarea
                    value={verbalAttestation}
                    onChange={(event) => setVerbalAttestation(event.target.value)}
                    disabled={busy}
                    style={textarea}
                    placeholder="Document the physician communication, the verbal order received, and any relevant instructions..."
                    minLength={100}
                    maxLength={2000}
                    rows={5}
                  />
                </label>

                <small style={muted}>
                  {verbalAttestation.trim().length}/100 characters minimum
                </small>

                {/* Dates */}
                <div style={verbalFieldGrid}>
                  <label style={field}>
                    Effective date
                    <input
                      type="datetime-local"
                      value={verbalEffectiveAt}
                      onChange={(event) => setVerbalEffectiveAt(event.target.value)}
                      disabled={busy}
                      style={control}
                      required
                    />
                  </label>

                  <label style={field}>
                    Received at
                    <input
                      type="text"
                      value="Recorded automatically when submitted"
                      disabled
                      style={control}
                    />
                  </label>
                </div>

                {/* Read back */}
                <label style={readBackBox}>
                  <input
                    type="checkbox"
                    checked={readBackVerified}
                    onChange={(event) => setReadBackVerified(event.target.checked)}
                    disabled={busy}
                  />

                  <span>
                    <strong>Read back and verified</strong>

                    <span style={readBackDescription}>
                      I read the order back to the physician and verified that it accurately
                      reflects the physician's instructions.
                    </span>
                  </span>
                </label>

                <div style={actions}>
                  <Button
                    tone="secondary"
                    onClick={() =>
                      void mutate("/api/v1/orders/{id}/verbal", {
                        recorderDiscipline: discipline,

                        verbalAttestation: verbalAttestation.trim(),

                        readBackVerified,

                        effectiveAt: new Date(verbalEffectiveAt).toISOString(),

                        receivedAt: new Date().toISOString(),

                        orderingPhysicianMdmId: row.orderingPhysicianMdmId,
                      })
                    }
                    disabled={
                      busy ||
                      verbalAttestation.trim().length < 100 ||
                      !readBackVerified ||
                      !verbalEffectiveAt ||
                      !row.orderingPhysicianMdmId
                    }
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
                    <option value="clinical_supervisor">Clinical supervisor</option>
                    <option value="medical_director">Medical director</option>
                  </select>
                </label>
                <label style={field}>
                  Attestation
                  <textarea
                    value={cosignAttestation}
                    onChange={(event) => setCosignAttestation(event.target.value)}
                    disabled={busy}
                    style={textarea}
                    placeholder="Document the cosignature"
                    minLength={50}
                  />
                </label>
                <small style={muted}>{cosignAttestation.trim().length}/50 characters minimum</small>
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
                      onClick={() => void mutate("/api/v1/orders/{id}/complete")}
                      disabled={busy}
                    >
                      {isLab ? "Mark reviewed" : "Mark complete"}
                    </Button>
                  ) : null}
                  {row.allowedActions.correct ? (
                    <Button tone="secondary" onClick={() => setCorrectOpen(true)} disabled={busy}>
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
                  <fieldset style={confirmBox} aria-label="Confirm discontinuation">
                    <p style={{ marginTop: 0 }}>
                      Discontinue this active order? This action is recorded in the clinical
                      history.
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
                  </fieldset>
                ) : null}
              </div>
            ) : null}
            {!Object.values(row.allowedActions).some(Boolean) ? (
              <p style={hint}>No actions are available for this order at the moment.</p>
            ) : null}
          </section>
          <h2 style={heading}>Order information</h2>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
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
            <dd style={dd}>{physicianLabel}</dd>
            <dt style={dt}>Signed</dt>
            <dd style={dd} className="tabular-nums">
              {row.signedAt
                ? `${ts(row.signedAt)} · ${row.signedBy ? row.signedByDisplayName || "Staff member" : ""}`
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
                  {row.transmissionStatus === "failed" &&
                  notSentInfoLabel(row.transmissionFailureReason) ? (
                    <StatusPill
                      label={notSentInfoLabel(row.transmissionFailureReason)}
                      tone="progress"
                    />
                  ) : (
                    <StatusPill
                      label={stateLabel(row.transmissionStatus)}
                      tone={TRANSMISSION_TONE[row.transmissionStatus] ?? "neutral"}
                    />
                  )}
                </dd>
                {row.transmissionFailureReason ? (
                  <>
                    <dt style={dt}>Failure reason</dt>
                    <dd style={dd}>{transmissionFailureLabel(row.transmissionFailureReason)}</dd>
                  </>
                ) : null}
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
          <section
            style={{ ...card, marginTop: "1rem" }}
            aria-labelledby="clinical-details-heading"
          >
            <h2 id="clinical-details-heading" style={heading}>
              Clinical details
            </h2>
            <OrderDataDetails data={row.data} />
          </section>
          {row.verbalOrder ? (
            <section
              style={{ ...card, marginTop: "1rem" }}
              aria-labelledby="verbal-details-heading"
            >
              <h2 id="verbal-details-heading" style={heading}>
                Verbal-order details
              </h2>
              <dl style={detailList}>
                <dt style={dt}>Status</dt>
                <dd style={dd}>{stateLabel(row.verbalOrder.status)}</dd>
                <dt style={dt}>Received</dt>
                <dd style={dd}>{ts(row.verbalOrder.receivedAt)}</dd>
                <dt style={dt}>Effective</dt>
                <dd style={dd}>{ts(row.verbalOrder.effectiveAt)}</dd>
                <dt style={dt}>Signature deadline</dt>
                <dd style={dd}>{ts(row.verbalOrder.deadlineAt)}</dd>
                <dt style={dt}>Signed</dt>
                <dd style={dd}>{ts(row.verbalOrder.signedAt)}</dd>
                <dt style={dt}>Read back verified</dt>
                <dd style={dd}>{row.verbalOrder.readBackVerified ? "Yes" : "No"}</dd>
              </dl>
              <h3 style={{ ...subheading, marginTop: "1rem" }}>Physician communication</h3>
              <p style={attestation}>{row.verbalOrder.attestation}</p>
            </section>
          ) : null}
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

function OrderDataDetails({ data }: { readonly data: unknown }): JSX.Element {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return <p style={hint}>No structured clinical details are available for this order.</p>;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0)
    return <p style={hint}>No structured clinical details are available.</p>;
  return (
    <dl style={detailList}>
      {entries.map(([key, value]) => (
        <div key={key} style={detailRow}>
          <dt style={dt}>{humanizeKey(key)}</dt>
          <dd style={{ ...dd, overflowWrap: "anywhere" }}>{detailValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function detailValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value))
    return (
      value
        .map((entry) => detailValue(entry))
        .filter((entry) => entry !== "—")
        .join(", ") || "—"
    );
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.display === "string") return object.display;
    if (typeof object.code === "string") return object.code;
    return JSON.stringify(value);
  }
  return String(value);
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
const detailList = {
  display: "grid",
  gridTemplateColumns: "minmax(10rem, 14rem) minmax(0, 1fr)",
  gap: "0.5rem 1rem",
  margin: 0,
  fontSize: "0.875rem",
} as const;
const detailRow = { display: "contents" } as const;
const attestation = {
  whiteSpace: "pre-wrap" as const,
  margin: 0,
  padding: "0.75rem",
  background: "var(--color-surface-container)",
  borderRadius: ".5rem",
  lineHeight: 1.5,
};

const card = {
  padding: "1.25rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
  background: "var(--color-surface)",
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
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
} as const;
const textarea = {
  ...control,
  minHeight: "6rem",
  resize: "vertical" as const,
  font: "inherit",
};
const confirmBox = {
  // A <fieldset>: pin the margin/min-width the UA would otherwise add; border/padding are set below.
  margin: "1rem 0 0",
  minWidth: 0,
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".5rem",
} as const;
const errorStyle = {
  color: "var(--color-error)",
  padding: ".75rem",
  border: "1px solid currentColor",
  borderRadius: ".5rem",
} as const;
const verbalInfoGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 12,
  marginBottom: 16,
};

const verbalInfoItem: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "12px 14px",
  border: "1px solid var(--wx-border)",
  borderRadius: 8,
};

const verbalInfoLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--wx-text-muted)",
};

const verbalInfoValue: CSSProperties = {
  fontSize: 14,
};

const verbalFieldGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 12,
};

const readBackBox: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: 14,
  marginTop: 12,
  border: "1px solid var(--wx-border)",
  borderRadius: 8,
  cursor: "pointer",
};

const readBackDescription: CSSProperties = {
  display: "block",
  marginTop: 3,
  fontSize: 12,
  lineHeight: 1.45,
  color: "var(--wx-text-muted)",
};
