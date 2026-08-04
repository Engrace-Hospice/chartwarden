// apps/web/src/modules/21-supplies — S21.5 RETURN RECONCILIATION (`/supplies/returns/:id`, §5.6,
// Track B / ADR-0030). Spec: docs/design/screens/clinical — "Use Record Detail."
//
// The physical count that closes a controlled-substance chain of custody. Behind the §4.4
// `comfort_kit_return_reconciler_eligible` predicate (whose FIRST clause is separation of duties — the
// membership that dispatched the kit may not be the one that counts it back in) AND a step-up gate.
//
// WHERE THE EXPECTED QUANTITIES COME FROM. Before reconciliation there are no `comfort_kit_returned_content`
// rows at all — they are written BY the reconcile call. So the worksheet is seeded from the DISPATCH's
// outbound manifest (row 22), which is the only place the dispatched quantities exist. That costs a second
// read and needs `comfort_kit.dispatch.read`; the alternative — asking the reconciler to type what was sent
// out — would let a mis-remembered figure become the denominator of a DEA discrepancy calculation.
//
// THE DISCREPANCY IS COMPUTED BY THE SERVER, AND WHAT THIS SCREEN SHOWS IS A PREVIEW. §3.1's
// `m21_compute_return_discrepancy()` derives `dispatched − returned − disposedAtHome` and sets the flag; a
// flag the reconciler could set is one they could clear, and §7.3 is explicit that only an M30 investigation
// closure marks a discrepancy explained. The preview exists so a reconciler sees the consequence of a count
// BEFORE committing it — it is never sent back.
//
// §4.2.2's `consumedQuantity` is NOT collected. There is no column to write it to, and accepting it would
// let a reconciler believe they had EXPLAINED a shortfall they had only described.
//
// §5.6 asks for a witness section that "pulls in the witness from the dispatch or allows selecting a new
// one". The dispatch carries no witness (see S21.3's note), and the schema's witness is the DISPOSAL witness
// — required only for at-home witnessed destruction, and required by §3.1.10's CHECK to be distinct from
// both the reconciler and the retriever. The form arms it on exactly that method and says why.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type DispatchedContentView,
  type ReturnDetail,
  type ReturnDisposalMethod,
  assignRetriever,
  declareUnreturnable,
  errorMessage,
  getDispatch,
  getReturn,
  reconcileReturn,
} from "./supplies-api";
import {
  DEFAULT_DISPOSAL_METHOD,
  DISCREPANCY_THRESHOLD_PCT,
  DISPOSAL_METHODS,
  OPEN_RETURN_STATES,
  RETURN_STATE_TONE,
  WITNESS_REQUIRED_DISPOSAL_METHOD,
  crossesDiscrepancyThreshold,
  dateTime,
  dueLabel,
  fractionAsPct,
  humanize,
  shortDate,
  shortId,
  toneOf,
  unaccountedPreview,
} from "./supplies-status";
import {
  Card,
  Field,
  Modal,
  Notice,
  SchedulePill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  Timeline,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  inputNarrowStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdQty,
  th,
  thNum,
} from "./supplies-ui";

type Ceremony = "assign-retriever" | "unreturnable" | null;

/** One editable worksheet row: the dispatched line plus what the reconciler is counting back in. */
interface CountDraft {
  dispatchedContentId: string;
  drugName: string;
  lotNumber: string | null;
  isControlledSubstance: boolean;
  controlledSubstanceSchedule: string | null;
  dispatchedQuantity: string;
  dispatchedUnit: string;
  quantityReturned: string;
  quantityDisposedAtHome: string;
  discrepancyExplanation: string;
}

export function ComfortKitReturnReconciliation(): JSX.Element {
  const client = useApiClient();
  const { returnId } = useParams<{ returnId: string }>();
  const [ret, setRet] = useState<ReturnDetail | null>(null);
  const [contents, setContents] = useState<DispatchedContentView[]>([]);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ceremony, setCeremony] = useState<Ceremony>(null);

  const [disposalMethod, setDisposalMethod] = useState(DEFAULT_DISPOSAL_METHOD);
  const [witnessMembershipId, setWitnessMembershipId] = useState("");
  const [disposalNotes, setDisposalNotes] = useState("");
  const [discrepancyNotes, setDiscrepancyNotes] = useState("");
  const [retrieverMembershipId, setRetrieverMembershipId] = useState("");
  const [unreturnableReason, setUnreturnableReason] = useState("");

  const load = useCallback(async () => {
    if (!returnId) return;
    setLoading(true);
    setError(null);
    setManifestError(null);
    const { ret: r, error: err } = await getReturn(client, returnId);
    if (err || !r) {
      setError(errorMessage(err, "This comfort-kit return could not be loaded."));
      setLoading(false);
      return;
    }
    setRet(r);
    // Seed the worksheet from the dispatch manifest — the only place the dispatched quantities live before
    // reconciliation writes the returned-content rows.
    const { dispatch, error: dErr } = await getDispatch(client, r.dispatchId);
    if (dErr || !dispatch) {
      setManifestError(
        errorMessage(
          dErr,
          "The dispatch manifest could not be read, so no count can be entered here.",
        ),
      );
      setContents([]);
      setCounts([]);
      setLoading(false);
      return;
    }
    setContents(dispatch.contents);
    setCounts(
      dispatch.contents.map((c) => ({
        dispatchedContentId: c.dispatchedContentId,
        drugName: c.drugName,
        lotNumber: c.lotNumber,
        isControlledSubstance: c.isControlledSubstance,
        controlledSubstanceSchedule: c.controlledSubstanceSchedule,
        dispatchedQuantity: c.dispatchedQuantity,
        dispatchedUnit: c.dispatchedUnit,
        // Deliberately BLANK rather than pre-filled with the dispatched amount: a worksheet that opens
        // pre-balanced invites a reconciler to submit a count they never made.
        quantityReturned: "",
        quantityDisposedAtHome: "0",
        discrepancyExplanation: "",
      })),
    );
    setLoading(false);
  }, [client, returnId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!ret || !returnId)
    return (
      <EmptyState
        title="Not found"
        description="This comfort-kit return does not exist, or is outside your organization."
      />
    );

  const patch = (index: number, p: Partial<CountDraft>) =>
    setCounts((prev) => prev.map((c, i) => (i === index ? { ...c, ...p } : c)));

  const previews = counts.map((c) =>
    unaccountedPreview(
      c.dispatchedQuantity,
      c.quantityReturned || "0",
      c.quantityDisposedAtHome || "0",
    ),
  );
  const flagged = counts.map((c, i) =>
    crossesDiscrepancyThreshold(c.isControlledSubstance, previews[i] ?? null),
  );
  const anyFlagged = flagged.some(Boolean);

  const open = OPEN_RETURN_STATES.includes(ret.state);
  const witnessRequired = disposalMethod === WITNESS_REQUIRED_DISPOSAL_METHOD;
  const explanationsPresent = counts.every(
    (c, i) => !flagged[i] || c.discrepancyExplanation.trim() !== "",
  );
  const countsEntered = counts.length > 0 && counts.every((c) => c.quantityReturned.trim() !== "");
  const canReconcile =
    open &&
    countsEntered &&
    explanationsPresent &&
    (!witnessRequired || witnessMembershipId.trim() !== "");

  const close = () => {
    setCeremony(null);
    setActionError(null);
  };

  const timeline = [
    { label: "Return required", at: dateTime(ret.returnRequiredAt) },
    ret.retrievingAt ? { label: "Retrieval started", at: dateTime(ret.retrievingAt) } : null,
    ret.retrievedAt ? { label: "Retrieved from the patient", at: dateTime(ret.retrievedAt) } : null,
    ret.returnedToHubAt
      ? { label: "Returned to the hub", at: dateTime(ret.returnedToHubAt) }
      : null,
    ret.reconciledAt
      ? {
          label: "Reconciled",
          at: dateTime(ret.reconciledAt),
          by: shortId(ret.reconciledByMembershipId),
        }
      : null,
  ].filter((e): e is { label: string; at: string; by?: string } => e !== null);

  const submitReconcile = async () => {
    setBusy(true);
    setActionError(null);
    const { error: err } = await reconcileReturn(client, returnId, ret.updatedAt, {
      // `disposalMethod` is always one of DISPOSAL_METHODS — the SelectField below offers no other value.
      disposalMethod: disposalMethod as ReturnDisposalMethod,
      ...(witnessMembershipId.trim()
        ? { disposalWitnessMembershipId: witnessMembershipId.trim() }
        : {}),
      perMedicationReconciliation: counts.map((c) => ({
        dispatchedContentId: c.dispatchedContentId,
        quantityReturned: c.quantityReturned.trim(),
        quantityDisposedAtHome: (c.quantityDisposedAtHome || "0").trim(),
        ...(c.discrepancyExplanation.trim()
          ? { discrepancyExplanation: c.discrepancyExplanation.trim() }
          : {}),
      })),
      ...(disposalNotes.trim() ? { disposalNotes: disposalNotes.trim() } : {}),
      ...(discrepancyNotes.trim() ? { discrepancyNotes: discrepancyNotes.trim() } : {}),
    });
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The reconciliation could not be recorded."));
      return;
    }
    void load();
  };

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Comfort-kit return {shortId(ret.returnId)}</span>}
        breadcrumb="Supplies — return reconciliation (DEA 21 CFR §1304 / §1317)"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to={`/supplies/dispatches/${ret.dispatchId}`} style={ghostButtonStyle}>
              Dispatch
            </Link>
            <Link
              to={`/supplies/dispatches/${ret.dispatchId}/perpetual-log`}
              style={ghostButtonStyle}
            >
              Perpetual log
            </Link>
          </div>
        }
      />

      {/* §5.6's non-dismissible banner: this fires on the RECORDED result, not the preview. */}
      {ret.discrepancyDetected ? (
        <Notice tone="error" assertive>
          This reconciliation closed with a controlled-substance discrepancy. An M30 survey
          investigation has been opened and an M36 high-severity alert published. Nothing on this
          screen marks it explained — only closing that investigation does.
        </Notice>
      ) : null}

      {ret.state === "unreturnable" ? (
        <Notice tone="error">
          This kit was written off as unreturnable under the 90-day assumption of loss, on an
          attested reason from a named person. It is a survey-reportable disposition, not a
          retrieval still in progress.
        </Notice>
      ) : null}

      {ret.daysOverdue > 0 && open ? (
        <Notice tone="warning">
          This return is {ret.daysOverdue} day{ret.daysOverdue === 1 ? "" : "s"} past its 30-day
          boundary.
        </Notice>
      ) : null}

      {manifestError ? <Notice tone="error">{manifestError}</Notice> : null}
      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card
        title="Return"
        actions={
          <StatusPill label={humanize(ret.state)} tone={toneOf(RETURN_STATE_TONE, ret.state)} />
        }
      >
        <SummaryGrid>
          <Field label="Patient" value={shortId(ret.patientId)} mono />
          <Field label="Admission" value={shortId(ret.admissionId)} mono />
          <Field label="Dispatch" value={shortId(ret.dispatchId)} mono />
          <Field label="M13 deployment" value={shortId(ret.m13DeploymentId)} mono />
          <Field label="Required at" value={dateTime(ret.returnRequiredAt)} />
          <Field
            label="Due"
            value={`${shortDate(ret.returnDueAt)} · ${dueLabel(ret.returnDueAt)}`}
          />
          <Field label="Retriever" value={shortId(ret.assignedRetrievingMembershipId)} mono />
          <Field label="Reconciled by" value={shortId(ret.reconciledByMembershipId)} mono />
          <Field label="Disposal witness" value={shortId(ret.disposalWitnessMembershipId)} mono />
          <Field label="Disposal method" value={humanize(ret.disposalMethod)} />
          <Field label="Receipt document (M22)" value={shortId(ret.receiptDocumentId)} mono />
          <Field label="Version stamp" value={dateTime(ret.updatedAt)} />
        </SummaryGrid>
        <span style={mutedStyle}>
          The reason this return was opened is captured on the transition, not republished on the
          read surface — the M4 audit record owns it.
        </span>
        {ret.disposalNotes ? (
          <div>
            <span style={mutedStyle}>Disposal notes (audit-denylisted free text)</span>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
              {ret.disposalNotes}
            </p>
          </div>
        ) : null}
        {ret.discrepancyNotes ? (
          <div>
            <span style={mutedStyle}>Discrepancy notes</span>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
              {ret.discrepancyNotes}
            </p>
          </div>
        ) : null}
        {ret.unreturnableReason ? (
          <div>
            <span style={mutedStyle}>
              Unreturnable — attested by {shortId(ret.unreturnableAttestedByMembershipId)}
            </span>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
              {ret.unreturnableReason}
            </p>
          </div>
        ) : null}
      </Card>

      <Card title="Chain of custody">
        <Timeline entries={timeline} />
      </Card>

      {/* Once reconciled, the STORED accounting replaces the worksheet: those numbers are the record. */}
      {ret.lines.length > 0 ? (
        <Card title="Recorded accounting">
          <span style={mutedStyle}>
            As stored. The unaccounted quantity and its share were computed by the database from
            dispatched − returned − disposed-at-home, and the flag is the server's, not a
            reconciler's. `discrepancy_pct` is stored as a FRACTION (the trigger compares against
            0.05) and is converted to a percentage here — printing the raw 0.05 under a "%" heading
            would understate a controlled-substance shortfall a hundredfold.
          </span>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Medication</th>
                <th style={th}>Schedule</th>
                <th style={th}>Lot</th>
                <th style={thNum}>Dispatched</th>
                <th style={thNum}>Returned</th>
                <th style={thNum}>Disposed at home</th>
                <th style={thNum}>Unaccounted</th>
                <th style={thNum}>Discrepancy %</th>
                <th style={th}>Flag</th>
              </tr>
            </thead>
            <tbody>
              {ret.lines.map((l) => (
                <tr key={l.returnedContentId} style={rowLine}>
                  <td style={td}>{l.drugName}</td>
                  <td style={td}>
                    <SchedulePill
                      schedule={l.controlledSubstanceSchedule}
                      isControlled={l.isControlledSubstance}
                    />
                  </td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{l.lotNumber ?? "—"}</td>
                  <td style={tdQty}>{l.dispatchedQuantity}</td>
                  <td style={tdQty}>{l.quantityReturned}</td>
                  <td style={tdQty}>{l.quantityDisposedAtHome}</td>
                  <td style={tdQty}>{l.quantityUnaccounted}</td>
                  <td style={tdQty}>{fractionAsPct(l.discrepancyPct)}</td>
                  <td style={td}>
                    {l.discrepancyFlagged ? (
                      <StatusPill label="Flagged" tone="error" />
                    ) : (
                      <StatusPill label="Balanced" tone="success" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {open && contents.length > 0 ? (
        <Card
          title="Reconciliation worksheet"
          actions={
            anyFlagged ? (
              <StatusPill
                label={`≥${DISCREPANCY_THRESHOLD_PCT}% on a controlled line`}
                tone="error"
              />
            ) : undefined
          }
        >
          <Notice tone="info">
            Enter what physically came back and what was destroyed at the bedside under witness.
            Quantity disposed at home is ACCOUNTED FOR, not missing — leaving it at zero when a
            family destroyed the remaining morphine turns a legal disposal into a diversion alert.
          </Notice>
          {anyFlagged ? (
            <Notice tone="warning" live>
              A controlled line is at or above {DISCREPANCY_THRESHOLD_PCT}% unaccounted. Each
              flagged line needs an explanation before this can be submitted. The figures below are
              a preview — the database computes and stores the authoritative discrepancy.
            </Notice>
          ) : null}
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Medication</th>
                <th style={th}>Schedule</th>
                <th style={th}>Lot</th>
                <th style={thNum}>Dispatched</th>
                <th style={thNum}>Returned</th>
                <th style={thNum}>Disposed at home</th>
                <th style={thNum}>Unaccounted (preview)</th>
                <th style={th}>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c, i) => {
                const preview = previews[i];
                return (
                  <tr key={c.dispatchedContentId} style={rowLine}>
                    <td style={td}>{c.drugName}</td>
                    <td style={td}>
                      <SchedulePill
                        schedule={c.controlledSubstanceSchedule}
                        isControlled={c.isControlledSubstance}
                      />
                    </td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{c.lotNumber ?? "—"}</td>
                    <td style={tdQty}>
                      {c.dispatchedQuantity} {c.dispatchedUnit}
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Quantity returned for ${c.drugName}`}
                        value={c.quantityReturned}
                        onChange={(e) => patch(i, { quantityReturned: e.target.value })}
                        style={inputNarrowStyle}
                      />
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Quantity disposed at home for ${c.drugName}`}
                        value={c.quantityDisposedAtHome}
                        onChange={(e) => patch(i, { quantityDisposedAtHome: e.target.value })}
                        style={inputNarrowStyle}
                      />
                    </td>
                    <td style={tdQty}>
                      {preview
                        ? `${preview.unaccounted.toFixed(3)} (${preview.pct.toFixed(1)}%)`
                        : "—"}
                      {flagged[i] ? (
                        <div style={{ ...mutedStyle, color: t.error }}>
                          at or above the {DISCREPANCY_THRESHOLD_PCT}% threshold
                        </div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Discrepancy explanation for ${c.drugName}`}
                        value={c.discrepancyExplanation}
                        onChange={(e) => patch(i, { discrepancyExplanation: e.target.value })}
                        placeholder={flagged[i] ? "required for this line" : "optional"}
                        style={{
                          ...inputNarrowStyle,
                          width: "14rem",
                          textAlign: "left",
                          fontFamily: "inherit",
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <SelectField
            label="Disposal method"
            value={disposalMethod}
            options={enumOptions(DISPOSAL_METHODS)}
            onChange={setDisposalMethod}
          />
          {witnessRequired ? (
            <>
              <Notice tone="warning">
                At-home witnessed destruction requires a second person, and the schema refuses a
                witness who is also the reconciler or the retriever — one person attesting to their
                own count is not a witness.
              </Notice>
              <TextField
                label="Disposal witness membership id"
                value={witnessMembershipId}
                onChange={setWitnessMembershipId}
                mono
              />
            </>
          ) : null}
          <TextAreaField
            label="Disposal notes"
            value={disposalNotes}
            onChange={setDisposalNotes}
            rows={3}
            hint="Audit-denylisted free text (D13)."
          />
          <TextAreaField
            label="Discrepancy notes"
            value={discrepancyNotes}
            onChange={setDiscrepancyNotes}
            rows={3}
          />

          <div style={{ display: "flex", gap: t.space2, justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={!canReconcile || busy}
              title={
                canReconcile
                  ? undefined
                  : "Every line needs a returned quantity, every flagged line an explanation, and at-home destruction a witness."
              }
              style={!canReconcile || busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() => void submitReconcile()}
            >
              Reconcile
            </button>
          </div>
        </Card>
      ) : null}

      <Card title="Actions">
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={!open}
            title={open ? undefined : "This return has reached a terminal state."}
            aria-disabled={!open}
            style={open ? ghostButtonStyle : disabledButtonStyle}
            onClick={open ? () => setCeremony("assign-retriever") : undefined}
          >
            Assign retriever
          </button>
          <button
            type="button"
            disabled={!open}
            title={open ? undefined : "This return has reached a terminal state."}
            aria-disabled={!open}
            style={open ? ghostButtonStyle : disabledButtonStyle}
            onClick={open ? () => setCeremony("unreturnable") : undefined}
          >
            Declare unreturnable
          </button>
        </div>
        <span style={mutedStyle}>
          Writing off a kit that held a CII solution is a different authority from counting one that
          came back, which is why it is a separate action rather than an option inside reconcile.
        </span>
      </Card>

      {ceremony === "assign-retriever" ? (
        <Modal
          title="Assign the retrieving staff member"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy || retrieverMembershipId.trim() === ""}
              style={
                busy || retrieverMembershipId.trim() === ""
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                const { error: err } = await assignRetriever(client, returnId, ret.updatedAt, {
                  retrievingMembershipId: retrieverMembershipId.trim(),
                });
                setBusy(false);
                if (err) {
                  setActionError(errorMessage(err, "The retriever could not be assigned."));
                  return;
                }
                close();
                void load();
              }}
            >
              Assign
            </button>
          }
        >
          <Notice tone="info">
            The separation-of-duties check compares this person against the disposal witness, so the
            two cannot be the same membership.
          </Notice>
          <TextField
            label="Retrieving membership id"
            value={retrieverMembershipId}
            onChange={setRetrieverMembershipId}
            mono
          />
        </Modal>
      ) : null}

      {ceremony === "unreturnable" ? (
        <Modal
          title="Declare this kit unreturnable"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy || unreturnableReason.trim() === ""}
              style={
                busy || unreturnableReason.trim() === "" ? disabledButtonStyle : primaryButtonStyle
              }
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                const { error: err } = await declareUnreturnable(client, returnId, ret.updatedAt, {
                  reason: unreturnableReason.trim(),
                });
                setBusy(false);
                if (err) {
                  setActionError(errorMessage(err, "The write-off could not be recorded."));
                  return;
                }
                close();
                void load();
              }}
            >
              Declare unreturnable
            </button>
          }
        >
          <Notice tone="error">
            This is the 90-day assumption of loss. It records, under your name, that a controlled
            substance did not come back — a survey-reportable disposition, and one the server asks
            for a second factor before writing.
          </Notice>
          <TextAreaField
            label="Attested reason"
            value={unreturnableReason}
            onChange={setUnreturnableReason}
            rows={4}
          />
        </Modal>
      ) : null}
    </div>
  );
}
