import { Button, SelectField, TextField, nowLocalInput, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the AUDIT RESPONSE PACKET section of the audit work rail (hospice ADR/TPE/QIC
// PRD, milestone 7a-2). While the request is in assembly the specialist types the response checklist FROM THE REQUEST
// LETTER (nothing is pre-filled: what an audit asks for is not something this app knows), attaches documents under a
// claim of the request, and either records the due date or attests the letter states none; in review a DIFFERENT person
// signs off; then the response sent outside ChartWarden is recorded with its proof under a step-up. The server owns
// every rule (reviewer separation, enclosure refusals, the late-filing acknowledgement, the frozen manifest) and its
// message is shown verbatim (ADR-0030); this component only collects facts and offers the moves the state allows.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import {
  type AuditFilingInput,
  type AuditRequestDetail,
  type AuditResponseItem,
  attachAuditDocument,
  attestNoDeadlineStated,
  detachAuditDocument,
  saveAuditResponseItems,
  signOffAudit,
  submitAuditResponse,
} from "./audit-api";
import { isUuid } from "./remittance-api";
import { humanize } from "./remittance-status";

export const AUDIT_DRAFT_ACTION = "m25-audit-response";

/** Labels for how the response left the building; they imply no portal or format of any audit contractor. */
const CHANNELS: readonly { value: AuditFilingInput["channel"]; label: string }[] = [
  { value: "esmd", label: "esMD" },
  { value: "fax", label: "Fax" },
  { value: "mail", label: "Mail" },
  { value: "other", label: "Other" },
];
const ITEM_STATES: readonly { value: AuditResponseItem["state"]; label: string }[] = [
  { value: "pending", label: "Not done" },
  { value: "ready", label: "Ready" },
  { value: "not_applicable", label: "Not applicable" },
];

interface FilingDraft {
  readonly channel: AuditFilingInput["channel"];
  readonly confirmationRef: string;
  readonly filedAt: string;
  readonly lateAcknowledged: boolean;
  readonly receiptDocumentId: string;
  readonly receiptClaimId: string;
}

export interface AuditResponsePanelProps {
  readonly audit: AuditRequestDetail;
  /** Reload the request (and the worklist) after a change. */
  readonly onChanged: () => Promise<void>;
  /** Tells the parent a packet command is in flight, so a state move cannot race it on the same version. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** The parent is mid-move: packet commands wait, as both use the same If-Match version. */
  readonly locked?: boolean;
}

export function AuditResponsePanel({
  audit,
  onChanged,
  onBusyChange,
  locked = false,
}: AuditResponsePanelProps): JSX.Element | null {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const response = audit.response;
  const draftKey = stepUpDraftKey(session, AUDIT_DRAFT_ACTION, audit.id);
  const [restored] = useState(() => peekStepUpDraft<FilingDraft>(draftKey));
  const claimOptions = audit.claims.map((c) => ({
    value: c.claimId,
    label: c.claimControlNumber ?? c.claimId.slice(0, 8),
  }));
  const [items, setItems] = useState<readonly AuditResponseItem[]>(response.items);
  const [newLabel, setNewLabel] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documentClaimId, setDocumentClaimId] = useState(claimOptions[0]?.value ?? "");
  const [channel, setChannel] = useState<AuditFilingInput["channel"]>(restored?.channel ?? "mail");
  const [confirmationRef, setConfirmationRef] = useState(restored?.confirmationRef ?? "");
  const [filedAt, setFiledAt] = useState(restored?.filedAt ?? nowLocalInput());
  const [lateAcknowledged, setLateAcknowledged] = useState(restored?.lateAcknowledged ?? false);
  const [receiptDocumentId, setReceiptDocumentId] = useState(restored?.receiptDocumentId ?? "");
  const [receiptClaimId, setReceiptClaimId] = useState(
    restored?.receiptClaimId ?? claimOptions[0]?.value ?? "",
  );
  const [ownBusy, setOwnBusy] = useState(false);
  const busy = ownBusy || locked;
  const setBusy = (next: boolean): void => {
    setOwnBusy(next);
    onBusyChange?.(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A reload (a version moved elsewhere) replaces the typed checklist with the server's.
  const serverItems = JSON.stringify(response.items);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized list is the change signal
  useEffect(() => {
    setItems(response.items);
  }, [serverItems]);

  const assembling = audit.state === "in_assembly";
  const iAmAssembler = session?.membershipId === response.sentToReviewByMembershipId;
  const signedOff = response.reviewedByMembershipId !== null;
  const hasDeadline = audit.deadlines.length > 0;
  const noneStated = response.deadlineNoneStatedAt !== null;
  const filedIso =
    filedAt && !Number.isNaN(Date.parse(filedAt)) ? new Date(filedAt).toISOString() : null;
  // Late only against a recorded deadline the person typed; the server decides the same way.
  const isLate =
    filedIso !== null &&
    audit.nextDueAt !== null &&
    Date.parse(filedIso) > Date.parse(audit.nextDueAt);
  const needsDeadline = !hasDeadline && !noneStated;
  const filingBlocked =
    needsDeadline ||
    confirmationRef.trim() === "" ||
    filedIso === null ||
    (isLate && !lateAcknowledged) ||
    (receiptDocumentId.trim() !== "" && !isUuid(receiptDocumentId.trim()));

  /** Runs one packet command; true when it succeeded. Every refusal is shown verbatim. */
  async function run(
    label: string,
    call: () => Promise<{ ok: true } | { ok: false; message: string }>,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await call();
    if (!mounted.current) return false;
    if (!res.ok) setError(res.message);
    else setNotice(`${label}: done.`);
    // Reload before re-enabling: after a success or a refusal (e.g. a 409) the next command must carry the
    // version the server holds NOW, never the one this render started with.
    await onChanged();
    if (mounted.current) setBusy(false);
    return res.ok;
  }

  const setItemState = (index: number, state: AuditResponseItem["state"]): void =>
    setItems((cur) => cur.map((it, i) => (i === index ? { ...it, state } : it)));
  const removeItem = (index: number): void => setItems((cur) => cur.filter((_, i) => i !== index));
  const addItem = (): void => {
    const label = newLabel.trim();
    if (label === "") return;
    setItems((cur) => [...cur, { label, state: "pending" }]);
    setNewLabel("");
  };
  const itemsDirty = JSON.stringify(items) !== serverItems;

  async function attach(): Promise<void> {
    const ok = await run("Attach document", () =>
      attachAuditDocument(client, audit.id, audit.version, {
        claimId: documentClaimId,
        documentId: documentId.trim(),
      }),
    );
    if (ok && mounted.current) setDocumentId("");
  }

  async function file(): Promise<void> {
    if (filedIso === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await submitAuditResponse(client, audit.id, audit.version, {
      channel,
      confirmationRef: confirmationRef.trim(),
      filedAt: filedIso,
      ...(isLate ? { lateAcknowledged: true } : {}),
      ...(receiptDocumentId.trim()
        ? {
            receiptDocumentId: receiptDocumentId.trim(),
            ...(claimOptions.length > 1 ? { receiptClaimId } : {}),
          }
        : {}),
    });
    if (!mounted.current) return;
    if (!res.ok) {
      if (res.stepUp) {
        setBusy(false);
        stashStepUpDraft(draftKey, {
          channel,
          confirmationRef,
          filedAt,
          lateAcknowledged,
          receiptDocumentId,
          receiptClaimId,
        } satisfies FilingDraft);
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      setError(res.message);
      await onChanged();
      if (mounted.current) setBusy(false);
      return;
    }
    clearStepUpDraft(draftKey);
    setNotice("Record filing: done.");
    await onChanged();
    if (mounted.current) setBusy(false);
  }

  const showPacket =
    audit.state === "received" ||
    audit.state === "in_assembly" ||
    audit.state === "in_review" ||
    response.filing !== null;
  if (!showPacket) return null;

  return (
    <section aria-label="Response packet">
      <h3 className="wx-action-title">Response packet</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />

      <h4 className="wx-action-title">Response checklist</h4>
      <Hint>
        Type what the request letter asks for. Nothing is pre-filled: the app does not know what a
        particular audit requires.
      </Hint>
      {items.length === 0 ? <Hint>No checklist items typed yet.</Hint> : null}
      {assembling || audit.state === "received" ? (
        <>
          {items.map((it, i) => (
            <div key={it.label}>
              <SelectField
                label={it.label}
                value={it.state}
                disabled={busy}
                onChange={(e) => setItemState(i, e.target.value as AuditResponseItem["state"])}
                options={ITEM_STATES.map((s) => ({ value: s.value, label: s.label }))}
              />
              <Button
                tone="tertiary"
                size="sm"
                disabled={busy}
                aria-label={`Remove checklist item ${it.label}`}
                onClick={() => removeItem(i)}
              >
                Remove item
              </Button>
            </div>
          ))}
          <TextField
            label="New checklist item"
            value={newLabel}
            maxLength={200}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <ButtonRow end>
            <Button
              size="sm"
              tone="secondary"
              disabled={busy || newLabel.trim() === ""}
              onClick={addItem}
            >
              Add item
            </Button>
            <Button
              size="sm"
              disabled={busy || !itemsDirty}
              onClick={() =>
                void run("Save checklist", () =>
                  saveAuditResponseItems(client, audit.id, audit.version, items),
                )
              }
            >
              Save checklist
            </Button>
          </ButtonRow>
        </>
      ) : (
        <ul>
          {response.items.map((it) => (
            <li key={it.label}>
              {it.label} · {humanize(it.state)}
            </li>
          ))}
        </ul>
      )}

      <h4 className="wx-action-title">Due date</h4>
      {hasDeadline ? (
        <Hint>A due date is recorded above, typed from the request letter.</Hint>
      ) : noneStated ? (
        <Hint>
          Attested {new Date(response.deadlineNoneStatedAt as string).toLocaleString()}: the request
          letter states no due date.
        </Hint>
      ) : audit.state === "responded" || audit.state === "closed" ? (
        <Hint>No due date was recorded.</Hint>
      ) : (
        <>
          <Hint>
            Record the due date from the request letter above. Only if the letter states none,
            attest that here; a response cannot be filed with neither.
          </Hint>
          <ButtonRow>
            <Button
              size="sm"
              tone="secondary"
              disabled={busy}
              onClick={() =>
                void run("Attestation", () =>
                  attestNoDeadlineStated(client, audit.id, audit.version),
                )
              }
            >
              The request letter states no due date
            </Button>
          </ButtonRow>
        </>
      )}

      <h4 className="wx-action-title">Documents</h4>
      {response.documents.length === 0 ? (
        <Hint>No documents attached yet.</Hint>
      ) : (
        <ul>
          {response.documents.map((d) => (
            <li key={d.id}>
              <code>{d.documentId}</code>
              {" · claim "}
              {claimOptions.find((c) => c.value === d.claimId)?.label ?? d.claimId.slice(0, 8)}
              {assembling ? (
                <>
                  {" "}
                  <Button
                    tone="tertiary"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove document ${d.documentId}`}
                    onClick={() =>
                      void run("Remove document", () =>
                        detachAuditDocument(client, audit.id, audit.version, d.documentId),
                      )
                    }
                  >
                    Remove
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {assembling ? (
        <>
          {claimOptions.length === 0 ? (
            <Hint>
              Link a claim first: every document is attached under a claim of the request.
            </Hint>
          ) : (
            <>
              <SelectField
                label="Attach under claim"
                value={documentClaimId}
                onChange={(e) => setDocumentClaimId(e.target.value)}
                options={claimOptions}
              />
              <TextField
                label="Document ID to attach"
                value={documentId}
                onChange={(e) => setDocumentId(e.target.value)}
                error={
                  documentId && !isUuid(documentId.trim())
                    ? "Enter the document's UUID."
                    : undefined
                }
              />
              <ButtonRow end>
                <Button
                  size="sm"
                  disabled={busy || !isUuid(documentId.trim()) || documentClaimId === ""}
                  onClick={() => void attach()}
                >
                  Attach document
                </Button>
              </ButtonRow>
              <Hint>
                A document must belong to that claim's patient, be current, and not be a 42 CFR Part
                2 record. The server names the reason if it refuses one.
              </Hint>
            </>
          )}
        </>
      ) : null}

      {audit.state === "in_review" ? (
        <>
          <h4 className="wx-action-title">Review</h4>
          {signedOff ? (
            <Hint>
              Signed off {response.reviewedAt ? new Date(response.reviewedAt).toLocaleString() : ""}
              .
            </Hint>
          ) : (
            <>
              {iAmAssembler ? (
                <Hint>
                  You sent this packet to review, so someone else with review access must sign it
                  off.
                </Hint>
              ) : null}
              <ButtonRow>
                <Button
                  size="sm"
                  disabled={busy || iAmAssembler}
                  onClick={() =>
                    void run("Sign off", () => signOffAudit(client, audit.id, audit.version))
                  }
                >
                  Sign off packet
                </Button>
              </ButtonRow>
            </>
          )}
        </>
      ) : null}

      {audit.state === "in_review" && signedOff ? (
        <>
          <h4 className="wx-action-title">Record filing</h4>
          <Hint>
            Record the response you sent. ChartWarden does not send it for you. Recording it needs a
            recent step-up verification and freezes the packet.
          </Hint>
          {needsDeadline ? (
            <output className="wx-action-hint is-alert">
              Record the due date, or attest the letter states none, before filing.
            </output>
          ) : null}
          <SelectField
            label="Sent by"
            value={channel}
            onChange={(e) => setChannel(e.target.value as AuditFilingInput["channel"])}
            options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))}
          />
          <TextField
            label="Confirmation or tracking reference"
            value={confirmationRef}
            onChange={(e) => setConfirmationRef(e.target.value)}
            maxLength={200}
          />
          <TextField
            label="Sent on"
            type="datetime-local"
            value={filedAt}
            onChange={(e) => setFiledAt(e.target.value)}
          />
          {isLate ? (
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={lateAcknowledged}
                onChange={(e) => setLateAcknowledged(e.target.checked)}
              />
              <span>This response was sent after a recorded due date</span>
            </label>
          ) : null}
          <TextField
            label="Receipt document ID (optional)"
            value={receiptDocumentId}
            onChange={(e) => setReceiptDocumentId(e.target.value)}
            error={
              receiptDocumentId.trim() && !isUuid(receiptDocumentId.trim())
                ? "Enter the document's UUID."
                : undefined
            }
          />
          {receiptDocumentId.trim() && claimOptions.length > 1 ? (
            <SelectField
              label="Claim whose patient owns the receipt document"
              value={receiptClaimId}
              onChange={(e) => setReceiptClaimId(e.target.value)}
              options={claimOptions}
            />
          ) : null}
          <ButtonRow end>
            <Button disabled={busy || filingBlocked} onClick={() => void file()}>
              Record filing
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {response.filing ? (
        <>
          <h4 className="wx-action-title">Filing</h4>
          <Facts
            items={[
              ["Sent by", humanize(response.filing.channel)],
              ["Confirmation", response.filing.confirmationRef],
              ["Sent on", new Date(response.filing.filedAt).toLocaleString()],
              [
                "Timeliness",
                response.filing.filedLate ? "Filed after a recorded due date" : "On time",
              ],
            ]}
          />
          <Hint>
            A cover sheet and enclosure index are filed in the document library as the retained
            record of what was sent.
          </Hint>
        </>
      ) : null}
    </section>
  );
}
