import {
  Button,
  ConfirmDialog,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — reconciliation worksheet (M13 §4.1/§6.1 #6, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail" (reconciliation worksheet).
// Per-line view of an admission/transfer/discharge/recert worksheet: the trigger, the line count, and the
// per-line decisions (carry_forward / discontinue / hold / new_order / document_only).
//
// F-031 — the decision picker, the caregiver-reported-line form, Finalize and Void are live. Four honest
// notes about what this screen can and cannot know, all of them server facts:
//
//   • There is no line INVENTORY. `WorksheetView` carries a `lineCount` and the decisions RECORDED so far,
//     not the set of lines awaiting one — M13 stores no expected-line set (compromise (7) in
//     `emar-route-service-db.ts`). So a decision is recorded by naming its `lineKind` + `sourceId`, and
//     the progress read is "n decided of lineCount", never a checklist of what is left. Rendering an
//     invented list of undecided lines would be a screen asserting a fact the server does not hold.
//   • Finalize is therefore NOT gated here on every line being decided. The server's own rule is ≥1
//     recorded decision, and it answers 422 RECONCILIATION_INCOMPLETE when that is unmet; this screen
//     surfaces that refusal rather than pre-empting it with a different rule.
//   • "Send to prescriber" mints an M12 DRAFT from the line and links it back onto the decision
//     (`resulting_medication_order_id`, a column that existed since M13-T02 and that nothing wrote). The
//     draft is created against M12's own route from the browser, not through a new M13 route — see
//     send-to-prescriber-modal.tsx for why, and for why it is a draft and never a signed order.
//   • Every write is refused server-side by `reconciliation_authoring_eligible` unless the caller's
//     discipline may author for this worksheet's trigger kind. A 403 is surfaced verbatim.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type ActiveMedicationOrder,
  type ReconciliationDecisionKind,
  type ReconciliationLineKind,
  type WorksheetView,
  addCaregiverReportedLine,
  errorMessage,
  finalizeReconciliation,
  getWorksheet,
  listPatientMedicationOrders,
  recordDecision,
  updateDecision,
  voidWorksheet,
} from "./emar-api";
import { DECISION_TONE, WORKSHEET_TONE, stateLabel } from "./emar-status";
import { SendToPrescriberModal } from "./send-to-prescriber-modal";

const DECISIONS: readonly { value: ReconciliationDecisionKind; label: string }[] = [
  { value: "carry_forward", label: "Carry forward" },
  { value: "discontinue", label: "Discontinue" },
  { value: "hold", label: "Hold" },
  { value: "new_order", label: "New order" },
  { value: "document_only", label: "Document only" },
];

/** §2.8 D17 — the closed line-kind vocabulary a decision may name. */
const LINE_KINDS: readonly { value: ReconciliationLineKind; label: string }[] = [
  { value: "m12_active", label: "M12 active order" },
  { value: "m12_medhx", label: "M12 MedHx pull" },
  { value: "caregiver_reported", label: "Caregiver-reported medication" },
];

/** `FinalizeReconciliationRequest.attestation` — minLength 1 on the server; a signature needs more. */
const ATTESTATION_MIN = 10;

export function ReconciliationWorksheet(): JSX.Element {
  const client = useApiClient();
  const { worksheetId } = useParams<{ worksheetId: string }>();
  const [row, setRow] = useState<WorksheetView | null>(null);
  const [orders, setOrders] = useState<ActiveMedicationOrder[]>([]);
  const [sendLineId, setSendLineId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [lineKind, setLineKind] = useState<ReconciliationLineKind>("m12_active");
  const [sourceId, setSourceId] = useState("");
  const [decision, setDecision] = useState<ReconciliationDecisionKind>("carry_forward");
  const [drugName, setDrugName] = useState("");
  const [attestation, setAttestation] = useState("");
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!worksheetId) return;
    setLoading(true);
    setError(null);
    const { worksheet, error: err } = await getWorksheet(client, worksheetId);
    if (err) {
      setError("Could not load the reconciliation worksheet.");
      setLoading(false);
      return;
    }
    setRow(worksheet);
    setLoading(false);
    // The patient's orders, so a line sourced from one can prefill the draft rather than making a nurse
    // retype a drug that is already on the chart. A caller without `prescribing.read` just gets an empty
    // form — degraded, never fabricated.
    if (worksheet) {
      const { orders: loaded } = await listPatientMedicationOrders(client, worksheet.patientId);
      setOrders(loaded);
    }
  }, [client, worksheetId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one write, surface its refusal, reload on success. The server is the only arbiter of legality. */
  const run = useCallback(
    async (
      fn: () => Promise<{ worksheet: WorksheetView | null; error: unknown }>,
      fallback: string,
      onDone?: () => void,
    ) => {
      setBusy(true);
      setActionError(null);
      const { error: err } = await fn();
      setBusy(false);
      if (err) {
        setActionError(errorMessage(err, fallback));
        return;
      }
      onDone?.();
      void load();
    },
    [load],
  );

  const open = row !== null && row.status !== "finalized" && row.status !== "voided";
  const decided = row?.decisions.length ?? 0;
  const sendLine = row?.decisions.find((d) => d.lineId === sendLineId) ?? null;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Medication Reconciliation"
          actions={
            row ? (
              <StatusPill
                label={stateLabel(row.status)}
                tone={WORKSHEET_TONE[row.status] ?? "neutral"}
              />
            ) : undefined
          }
        >
          {row ? (
            <span style={meta}>
              {stateLabel(row.triggerKind)} ·{" "}
              <span className="tabular-nums">
                {decided}/{row.lineCount}
              </span>{" "}
              decided
            </span>
          ) : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <>
          {row.decisions.length === 0 ? (
            <EmptyState
              title="No decisions recorded"
              description="Record a decision for each medication line below."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Source kind</th>
                  <th>Decision</th>
                  <th>Change</th>
                  <th>Order</th>
                </tr>
              </thead>
              <tbody>
                {row.decisions.map((d) => (
                  <tr key={d.lineId}>
                    <td className="wx-data-md">{d.sourceId.slice(0, 8)}</td>
                    <td>{stateLabel(d.lineKind)}</td>
                    <td>
                      <StatusPill
                        label={stateLabel(d.decision)}
                        tone={DECISION_TONE[d.decision] ?? "neutral"}
                      />
                    </td>
                    <td>
                      {open ? (
                        // A bare <select> rather than SelectField: the column header IS the label, and a
                        // second visible one per row would be noise. aria-label keeps it named for a
                        // screen reader, which is what the axe scan (and a nurse using one) needs.
                        <select
                          aria-label={`Decision for line ${d.sourceId.slice(0, 8)}`}
                          value={d.decision}
                          disabled={busy}
                          onChange={(e) =>
                            void run(
                              () =>
                                updateDecision(client, row.id, d.lineId, {
                                  decision: e.target.value as ReconciliationDecisionKind,
                                }),
                              "The decision could not be updated.",
                            )
                          }
                        >
                          {DECISIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </td>
                    <td>
                      {d.resultingMedicationOrderId ? (
                        <span className="wx-data-md" style={{ color: "var(--color-on-surface)" }}>
                          {d.resultingMedicationOrderId.slice(0, 8)}
                        </span>
                      ) : open && (d.decision === "new_order" || d.decision === "carry_forward") ? (
                        <Button
                          size="sm"
                          tone="secondary"
                          disabled={busy}
                          onClick={() => setSendLineId(d.lineId)}
                        >
                          Send to prescriber
                        </Button>
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {actionError ? (
            <p role="alert" style={{ ...meta, color: "var(--color-error)" }}>
              {actionError}
            </p>
          ) : null}

          {open ? (
            <div style={panels}>
              <section style={panel}>
                <h2 style={sectionTitle}>Record a decision</h2>
                <SelectField
                  label="Line kind"
                  value={lineKind}
                  options={LINE_KINDS}
                  hint="The kind of line this decision covers."
                  onChange={(e) => setLineKind(e.target.value as ReconciliationLineKind)}
                />
                <TextField
                  label="Source id"
                  value={sourceId}
                  hint="The medication order or history record this line came from."
                  onChange={(e) => setSourceId(e.target.value)}
                />
                <SelectField
                  label="Decision"
                  value={decision}
                  options={DECISIONS}
                  onChange={(e) => setDecision(e.target.value as ReconciliationDecisionKind)}
                />
                <Button
                  tone="primary"
                  loading={busy}
                  disabled={busy || sourceId.trim().length === 0}
                  onClick={() =>
                    void run(
                      () =>
                        recordDecision(client, row.id, {
                          lineKind,
                          sourceId: sourceId.trim(),
                          decision,
                        }),
                      "The decision could not be recorded.",
                      () => setSourceId(""),
                    )
                  }
                >
                  Record decision
                </Button>
              </section>

              <section style={panel}>
                <h2 style={sectionTitle}>Add a caregiver-reported medication</h2>
                <p style={meta}>
                  A home medication the family reported that no order covers. It becomes a line on
                  this worksheet like any other.
                </p>
                <TextField
                  label="Drug name"
                  value={drugName}
                  onChange={(e) => setDrugName(e.target.value)}
                />
                <Button
                  tone="secondary"
                  loading={busy}
                  disabled={busy || drugName.trim().length === 0}
                  onClick={() =>
                    void run(
                      () => addCaregiverReportedLine(client, row.id, { drugName: drugName.trim() }),
                      "The line could not be added.",
                      () => setDrugName(""),
                    )
                  }
                >
                  Add line
                </Button>
              </section>

              <section style={panel}>
                <h2 style={sectionTitle}>Finalize</h2>
                <TextAreaField
                  label="Attestation"
                  value={attestation}
                  hint="Your statement that this reconciliation is complete and accurate."
                  onChange={(e) => setAttestation(e.target.value)}
                />
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <Button
                    tone="primary"
                    loading={busy}
                    disabled={busy || attestation.trim().length < ATTESTATION_MIN}
                    onClick={() =>
                      void run(
                        () =>
                          finalizeReconciliation(client, row.id, {
                            attestation: attestation.trim(),
                          }),
                        "The worksheet could not be finalized.",
                        () => setAttestation(""),
                      )
                    }
                  >
                    Finalize worksheet
                  </Button>
                  <Button tone="danger" disabled={busy} onClick={() => setVoidOpen(true)}>
                    Void
                  </Button>
                </div>
              </section>
            </div>
          ) : null}

          {sendLine ? (
            <SendToPrescriberModal
              open
              patientId={row.patientId}
              admissionId={row.admissionId}
              sourceOrder={orders.find((o) => o.id === sendLine.sourceId) ?? null}
              onClose={() => setSendLineId(null)}
              onDrafted={(medicationOrderId) => {
                const line = sendLine;
                setSendLineId(null);
                void run(
                  () =>
                    updateDecision(client, row.id, line.lineId, {
                      decision: line.decision,
                      resultingMedicationOrderId: medicationOrderId,
                    }),
                  "The draft was created but could not be linked to this line.",
                );
              }}
            />
          ) : null}

          <ConfirmDialog
            open={voidOpen}
            tone="danger"
            title="Void this worksheet?"
            description={
              <TextAreaField
                label="Reason"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
              />
            }
            confirmLabel="Void worksheet"
            pending={busy}
            onConfirm={() =>
              void run(
                () => voidWorksheet(client, row.id, { voidReason: voidReason.trim() }),
                "The worksheet could not be voided.",
                () => {
                  setVoidOpen(false);
                  setVoidReason("");
                },
              )
            }
            onCancel={() => setVoidOpen(false)}
          />
        </>
      )}
    </DetailPageLayout>
  );
}

const meta: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
};
const panels: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1.25rem",
  marginTop: "1.5rem",
};
const panel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
  minWidth: "18rem",
  flex: 1,
};
const sectionTitle: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--color-muted)",
  margin: 0,
};
