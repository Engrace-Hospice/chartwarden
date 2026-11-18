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
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { FormDrawer } from "../../shell/form-drawer";
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
  Field,
  Notice,
  SchedulePill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  Timeline,
  enumOptions,
  ghostButtonStyle,
  inputNarrowStyle,
  pageTitleStyle,
  tdQty,
  thNum,
} from "./supplies-ui";
import { useLatestRead } from "./use-latest-read";
import { useWrite } from "./use-write";

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

/** A fresh worksheet row for one dispatched line. */
function seedCount(c: DispatchedContentView): CountDraft {
  return {
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
  };
}

const LOAD_FAILURE = "This comfort-kit return could not be loaded.";

/** The route's screen. Keyed by the return, so moving to another return starts a fresh worksheet: return A (its
 *  record, drafts and open drawer) never shows under B's URL. */
export function ComfortKitReturnReconciliation(): JSX.Element {
  const { returnId } = useParams<{ returnId: string }>();
  return <ReturnReconciliation key={returnId} returnId={returnId} />;
}

function ReturnReconciliation({ returnId }: { returnId: string | undefined }): JSX.Element {
  const client = useApiClient();
  const [ret, setRet] = useState<ReturnDetail | null>(null);
  const [contents, setContents] = useState<DispatchedContentView[]>([]);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A refusal of the retriever / write-off drawer shows in that drawer; the worksheet's own refusal has no drawer. The
  // two writes keep separate busy flags: Reconcile must not mark an open drawer busy (inert page, no Cancel), though
  // the drawer's own Save waits for it.
  const [actionError, setActionError] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const { busy, run: runWrite } = useWrite();
  const { busy: inlineBusy, run: runInline } = useWrite();
  const startRead = useLatestRead();
  const [ceremony, setCeremony] = useState<Ceremony>(null);

  const [disposalMethod, setDisposalMethod] = useState(DEFAULT_DISPOSAL_METHOD);
  const [witnessMembershipId, setWitnessMembershipId] = useState("");
  const [disposalNotes, setDisposalNotes] = useState("");
  const [discrepancyNotes, setDiscrepancyNotes] = useState("");
  const [retrieverMembershipId, setRetrieverMembershipId] = useState("");
  const [unreturnableReason, setUnreturnableReason] = useState("");

  const load = useCallback(async () => {
    const isLatest = startRead();
    if (!returnId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setManifestError(null);
    try {
      const { ret: r, error: err } = await getReturn(client, returnId);
      if (!isLatest()) return;
      if (err || !r) {
        setError(errorMessage(err, LOAD_FAILURE));
        return;
      }
      setRet(r);
      // Seed the worksheet from the dispatch manifest — the only place the dispatched quantities live before
      // reconciliation writes the returned-content rows.
      const { dispatch, error: dErr } = await getDispatch(client, r.dispatchId);
      if (!isLatest()) return;
      if (dErr || !dispatch) {
        setManifestError(
          errorMessage(
            dErr,
            "The dispatch manifest could not be read, so no count can be entered here.",
          ),
        );
        setContents([]);
        setCounts([]);
        return;
      }
      setContents(dispatch.contents);
      // Merge, never re-seed: a reload after a step (assigning a retriever leaves the return open) must not wipe the
      // quantities and explanations already typed in the worksheet.
      setCounts((prev) =>
        dispatch.contents.map((c) => {
          const typed = prev.find((p) => p.dispatchedContentId === c.dispatchedContentId);
          if (!typed) return seedCount(c);
          return {
            ...seedCount(c),
            quantityReturned: typed.quantityReturned,
            quantityDisposedAtHome: typed.quantityDisposedAtHome,
            discrepancyExplanation: typed.discrepancyExplanation,
          };
        }),
      );
    } catch {
      // A rejected read (no reply) must not leave `loading` set: that disables every stamped write for good.
      if (isLatest()) setError(LOAD_FAILURE);
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [client, returnId, startRead]);

  useEffect(() => {
    void load();
  }, [load]);

  // The spinner is for the first load only. A reload after a write keeps the page (and any open drawer) mounted, so an
  // open form is not torn down and remounted under the responder.
  if (loading && !ret) return <LoadingSpinner />;
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
  // While a reload is in flight the page still shows the previous read; its version stamp is about to change, so no
  // stamped write is offered from it.
  const writable = open && !loading;
  const witnessRequired = disposalMethod === WITNESS_REQUIRED_DISPOSAL_METHOD;
  const explanationsPresent = counts.every(
    (c, i) => !flagged[i] || c.discrepancyExplanation.trim() !== "",
  );
  const countsEntered = counts.length > 0 && counts.every((c) => c.quantityReturned.trim() !== "");
  const canReconcile =
    writable &&
    countsEntered &&
    explanationsPresent &&
    (!witnessRequired || witnessMembershipId.trim() !== "");

  const close = () => {
    setCeremony(null);
    setActionError(null);
  };

  const openCeremony = (next: Exclude<Ceremony, null>) => {
    setActionError(null);
    setCeremony(next);
  };

  /** Run a drawer's write, then reload. A refusal (or a rejected request) stays in the drawer, beside Save. */
  const run = async (fn: () => Promise<{ error: unknown }>, failure: string) => {
    setActionError(null);
    const failed = await runWrite(fn, failure);
    if (failed) {
      setActionError(failed);
      return;
    }
    close();
    void load();
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
    setReconcileError(null);
    const failed = await runInline(
      () =>
        reconcileReturn(client, returnId, ret.updatedAt, {
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
        }),
      "The reconciliation could not be recorded.",
    );
    if (failed) {
      setReconcileError(failed);
      return;
    }
    void load();
  };

  return (
    <div
      className={`wx-list-drawer${ceremony === "assign-retriever" || ceremony === "unreturnable" ? " has-drawer" : ""}`}
    >
      <div className="wx-list-drawer-main wx-kit-column">
        <PageHeader
          title={<span style={pageTitleStyle}>Comfort-kit return {shortId(ret.returnId)}</span>}
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

        <Panel
          stack
          headingLevel={3}
          title="Return"
          action={
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
          <span className="wx-text-muted">
            The reason this return was opened is captured on the transition, not republished on the
            read surface — the M4 audit record owns it.
          </span>
          {ret.disposalNotes ? (
            <div>
              <span className="wx-text-muted">Disposal notes (audit-denylisted free text)</span>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
                {ret.disposalNotes}
              </p>
            </div>
          ) : null}
          {ret.discrepancyNotes ? (
            <div>
              <span className="wx-text-muted">Discrepancy notes</span>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
                {ret.discrepancyNotes}
              </p>
            </div>
          ) : null}
          {ret.unreturnableReason ? (
            <div>
              <span className="wx-text-muted">
                Unreturnable — attested by {shortId(ret.unreturnableAttestedByMembershipId)}
              </span>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
                {ret.unreturnableReason}
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel stack headingLevel={3} title="Chain of custody">
          <Timeline entries={timeline} />
        </Panel>

        {/* Once reconciled, the STORED accounting replaces the worksheet: those numbers are the record. */}
        {ret.lines.length > 0 ? (
          <Panel stack headingLevel={3} title="Recorded accounting">
            <span className="wx-text-muted">
              As stored. The unaccounted quantity and its share were computed by the database from
              dispatched − returned − disposed-at-home, and the flag is the server's, not a
              reconciler's. `discrepancy_pct` is stored as a FRACTION (the trigger compares against
              0.05) and is converted to a percentage here — printing the raw 0.05 under a "%"
              heading would understate a controlled-substance shortfall a hundredfold.
            </span>
            <table>
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Schedule</th>
                  <th>Lot</th>
                  <th style={thNum}>Dispatched</th>
                  <th style={thNum}>Returned</th>
                  <th style={thNum}>Disposed at home</th>
                  <th style={thNum}>Unaccounted</th>
                  <th style={thNum}>Discrepancy %</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {ret.lines.map((l) => (
                  <tr key={l.returnedContentId}>
                    <td>{l.drugName}</td>
                    <td>
                      <SchedulePill
                        schedule={l.controlledSubstanceSchedule}
                        isControlled={l.isControlledSubstance}
                      />
                    </td>
                    <td className="wx-data-md">{l.lotNumber ?? "—"}</td>
                    <td style={tdQty}>{l.dispatchedQuantity}</td>
                    <td style={tdQty}>{l.quantityReturned}</td>
                    <td style={tdQty}>{l.quantityDisposedAtHome}</td>
                    <td style={tdQty}>{l.quantityUnaccounted}</td>
                    <td style={tdQty}>{fractionAsPct(l.discrepancyPct)}</td>
                    <td>
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
          </Panel>
        ) : null}

        {open && contents.length > 0 ? (
          <Panel
            stack
            headingLevel={3}
            title="Reconciliation worksheet"
            action={
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
                flagged line needs an explanation before this can be submitted. The figures below
                are a preview — the database computes and stores the authoritative discrepancy.
              </Notice>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Schedule</th>
                  <th>Lot</th>
                  <th style={thNum}>Dispatched</th>
                  <th style={thNum}>Returned</th>
                  <th style={thNum}>Disposed at home</th>
                  <th style={thNum}>Unaccounted (preview)</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {counts.map((c, i) => {
                  const preview = previews[i];
                  return (
                    <tr key={c.dispatchedContentId}>
                      <td>{c.drugName}</td>
                      <td>
                        <SchedulePill
                          schedule={c.controlledSubstanceSchedule}
                          isControlled={c.isControlledSubstance}
                        />
                      </td>
                      <td className="wx-data-md">{c.lotNumber ?? "—"}</td>
                      <td style={tdQty}>
                        {c.dispatchedQuantity} {c.dispatchedUnit}
                      </td>
                      <td>
                        <input
                          aria-label={`Quantity returned for ${c.drugName}`}
                          value={c.quantityReturned}
                          onChange={(e) => patch(i, { quantityReturned: e.target.value })}
                          style={inputNarrowStyle}
                        />
                      </td>
                      <td>
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
                          <div className="wx-text-error" style={{ fontSize: "0.8rem" }}>
                            at or above the {DISCREPANCY_THRESHOLD_PCT}% threshold
                          </div>
                        ) : null}
                      </td>
                      <td>
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
                  witness who is also the reconciler or the retriever — one person attesting to
                  their own count is not a witness.
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

            {reconcileError ? (
              <p className="wx-text-error" role="alert">
                {reconcileError}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: t.space2, justifyContent: "flex-end" }}>
              <Button
                tone="primary"
                type="button"
                disabled={!canReconcile || inlineBusy || busy}
                title={
                  canReconcile
                    ? undefined
                    : "Every line needs a returned quantity, every flagged line an explanation, and at-home destruction a witness."
                }
                onClick={() => void submitReconcile()}
              >
                Reconcile
              </Button>
            </div>
          </Panel>
        ) : null}

        <Panel stack headingLevel={3} title="Actions">
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Button
              tone="secondary"
              type="button"
              disabled={!writable}
              title={open ? undefined : "This return has reached a terminal state."}
              aria-disabled={!writable}
              onClick={writable ? () => openCeremony("assign-retriever") : undefined}
            >
              Assign retriever
            </Button>
            <Button
              tone="secondary"
              type="button"
              disabled={!writable}
              title={open ? undefined : "This return has reached a terminal state."}
              aria-disabled={!writable}
              onClick={writable ? () => openCeremony("unreturnable") : undefined}
            >
              {/* The ellipsis marks the opener: the open drawer's save button carries the plain name. */}
              Declare unreturnable…
            </Button>
          </div>
          <span className="wx-text-muted">
            Writing off a kit that held a CII solution is a different authority from counting one
            that came back, which is why it is a separate action rather than an option inside
            reconcile.
          </span>
        </Panel>
      </div>

      {ceremony === "assign-retriever" ? (
        <FormDrawer
          title="Assign the retrieving staff member"
          busy={busy}
          error={actionError}
          onClose={close}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy || inlineBusy || loading || retrieverMembershipId.trim() === ""}
              onClick={() =>
                void run(
                  () =>
                    assignRetriever(client, returnId, ret.updatedAt, {
                      retrievingMembershipId: retrieverMembershipId.trim(),
                    }),
                  "The retriever could not be assigned.",
                )
              }
            >
              Assign
            </Button>
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
        </FormDrawer>
      ) : null}
      {ceremony === "unreturnable" ? (
        <FormDrawer
          title="Declare this kit unreturnable"
          busy={busy}
          error={actionError}
          onClose={close}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy || inlineBusy || loading || unreturnableReason.trim() === ""}
              onClick={() =>
                void run(
                  () =>
                    declareUnreturnable(client, returnId, ret.updatedAt, {
                      reason: unreturnableReason.trim(),
                    }),
                  "The write-off could not be recorded.",
                )
              }
            >
              Declare unreturnable
            </Button>
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
        </FormDrawer>
      ) : null}
    </div>
  );
}
