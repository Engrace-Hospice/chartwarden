import { Button, SelectField, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the ADR RESPONSE PACKET section of the ADR work panel (hospice ADR/TPE/QIC
// PRD, milestone 2b). While the case is in assembly the specialist attaches the documents the MAC asked for and
// ticks the checklist; in review a DIFFERENT person signs off; then the filing made outside WardenX is recorded
// with its proof (channel, confirmation reference, when) under a step-up. The server owns every rule (reviewer
// separation, enclosure refusals, the late-filing acknowledgement, the frozen manifest) and its message is shown
// verbatim (ADR-0030); this component only collects facts and offers the moves the case state allows.
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
  type AdrAttachInput,
  type AdrChecklistState,
  type AdrDetail,
  type AdrFilingInput,
  attachAdrDocument,
  detachAdrDocument,
  isUuid,
  setAdrChecklist,
  signOffAdr,
  submitAdr,
} from "./remittance-api";
import { humanize } from "./remittance-status";

export const ADR_DRAFT_ACTION = "m25-adr";

const CHANNELS: readonly { value: AdrFilingInput["channel"]; label: string }[] = [
  { value: "mac_portal", label: "MAC portal" },
  { value: "fax", label: "Fax" },
  { value: "mail", label: "Mail" },
  { value: "esmd", label: "esMD" },
  { value: "other", label: "Other" },
];
const CHECKLIST_STATES: readonly { value: AdrChecklistState; label: string }[] = [
  { value: "pending", label: "Not done" },
  { value: "ready", label: "Ready" },
  { value: "not_applicable", label: "Not applicable" },
];

interface FilingDraft {
  readonly channel: AdrFilingInput["channel"];
  readonly confirmationRef: string;
  readonly filedAt: string;
  readonly lateAcknowledged: boolean;
  readonly receiptDocumentId: string;
}

/** Local `YYYY-MM-DDTHH:mm` for a datetime-local input. */
const nowLocal = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface AdrPacketPanelProps {
  readonly adr: AdrDetail;
  /** Reload the case (and the worklist) after a change. */
  readonly onChanged: () => Promise<void>;
  /** Tells the parent a packet command is in flight, so a case move cannot race it on the same version. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** The parent is mid-move: packet commands wait, as both use the same If-Match version. */
  readonly locked?: boolean;
}

export function AdrPacketPanel({
  adr,
  onChanged,
  onBusyChange,
  locked = false,
}: AdrPacketPanelProps): JSX.Element | null {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const packet = adr.packet;
  const draftKey = stepUpDraftKey(session, ADR_DRAFT_ACTION, adr.id);
  const [restored] = useState(() => peekStepUpDraft<FilingDraft>(draftKey));
  const [documentId, setDocumentId] = useState("");
  const [answers, setAnswers] = useState("");
  const [channel, setChannel] = useState<AdrFilingInput["channel"]>(
    restored?.channel ?? "mac_portal",
  );
  const [confirmationRef, setConfirmationRef] = useState(restored?.confirmationRef ?? "");
  const [filedAt, setFiledAt] = useState(restored?.filedAt ?? nowLocal());
  const [lateAcknowledged, setLateAcknowledged] = useState(restored?.lateAcknowledged ?? false);
  const [receiptDocumentId, setReceiptDocumentId] = useState(restored?.receiptDocumentId ?? "");
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

  const iAmAssembler = session?.membershipId === packet.sentToReviewByMembershipId;
  const signedOff = packet.reviewedByMembershipId !== null;
  const filedIso =
    filedAt && !Number.isNaN(Date.parse(filedAt)) ? new Date(filedAt).toISOString() : null;
  const isLate = filedIso !== null && Date.parse(filedIso) > Date.parse(adr.responseDueAt);
  const filingBlocked =
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

  async function attach(): Promise<void> {
    const ok = await run("Attach document", () =>
      attachAdrDocument(client, adr.id, adr.version, {
        documentId: documentId.trim(),
        ...(answers ? { checklistKey: answers as AdrAttachInput["checklistKey"] } : {}),
      }),
    );
    if (ok && mounted.current) {
      setDocumentId("");
      setAnswers("");
    }
  }

  async function file(): Promise<void> {
    if (filedIso === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await submitAdr(client, adr.id, adr.version, {
      channel,
      confirmationRef: confirmationRef.trim(),
      filedAt: filedIso,
      ...(isLate ? { lateAcknowledged: true } : {}),
      ...(receiptDocumentId.trim() ? { receiptDocumentId: receiptDocumentId.trim() } : {}),
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

  const showPacket = adr.state === "in_assembly" || adr.state === "in_review" || packet.filing;
  if (!showPacket) return null;

  return (
    <>
      <h3 className="wx-action-title">Response packet</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />

      <h4 className="wx-action-title">Documents</h4>
      {packet.documents.length === 0 ? (
        <Hint>No documents attached yet.</Hint>
      ) : (
        <ul>
          {packet.documents.map((d) => (
            <li key={d.id}>
              <code>{d.documentId}</code>
              {d.checklistKey ? ` · answers ${humanize(d.checklistKey)}` : ""}
              {adr.state === "in_assembly" ? (
                <>
                  {" "}
                  <Button
                    tone="tertiary"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove document ${d.documentId}`}
                    onClick={() =>
                      void run("Remove document", () =>
                        detachAdrDocument(client, adr.id, adr.version, d.documentId),
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
      {adr.state === "in_assembly" ? (
        <>
          <TextField
            label="Document ID to attach"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            error={
              documentId && !isUuid(documentId.trim()) ? "Enter the document's UUID." : undefined
            }
          />
          <SelectField
            label="Answers checklist item (optional)"
            value={answers}
            onChange={(e) => setAnswers(e.target.value)}
            options={[
              { value: "", label: "None" },
              ...packet.checklist.map((c) => ({ value: c.key, label: humanize(c.key) })),
            ]}
          />
          <ButtonRow end>
            <Button
              size="sm"
              disabled={busy || !isUuid(documentId.trim())}
              onClick={() => void attach()}
            >
              Attach document
            </Button>
          </ButtonRow>
          <Hint>
            A document must belong to this claim's patient, be current, and not be a 42 CFR Part 2
            record. The server names the reason if it refuses one.
          </Hint>
        </>
      ) : null}

      <h4 className="wx-action-title">Documentation checklist</h4>
      {adr.state === "in_assembly" ? (
        packet.checklist.map((c) => (
          <SelectField
            key={c.key}
            label={humanize(c.key)}
            value={c.state}
            disabled={busy}
            onChange={(e) =>
              void run(`${humanize(c.key)}`, () =>
                setAdrChecklist(
                  client,
                  adr.id,
                  adr.version,
                  c.key,
                  e.target.value as AdrChecklistState,
                ),
              )
            }
            options={CHECKLIST_STATES.map((s) => ({ value: s.value, label: s.label }))}
          />
        ))
      ) : (
        <ul>
          {packet.checklist.map((c) => (
            <li key={c.key}>
              {humanize(c.key)} · {humanize(c.state)}
            </li>
          ))}
        </ul>
      )}

      {adr.state === "in_review" ? (
        <>
          <h4 className="wx-action-title">Review</h4>
          {signedOff ? (
            <Hint>
              Signed off {packet.reviewedAt ? new Date(packet.reviewedAt).toLocaleString() : ""}.
              Sending the packet back to assembly voids the sign-off.
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
                    void run("Sign off", () => signOffAdr(client, adr.id, adr.version))
                  }
                >
                  Sign off packet
                </Button>
              </ButtonRow>
            </>
          )}
        </>
      ) : null}

      {adr.state === "in_review" && signedOff ? (
        <>
          <h4 className="wx-action-title">Record filing</h4>
          <Hint>
            Record the response you sent to the MAC. ChartWarden does not send it for you yet. Recording
            it needs a recent step-up verification and freezes the packet.
          </Hint>
          <SelectField
            label="Sent by"
            value={channel}
            onChange={(e) => setChannel(e.target.value as AdrFilingInput["channel"])}
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
              <span>This response was sent after the due date</span>
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
          <ButtonRow end>
            <Button disabled={busy || filingBlocked} onClick={() => void file()}>
              Record filing
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {packet.filing ? (
        <>
          <h4 className="wx-action-title">Filing</h4>
          <Facts
            items={[
              ["Sent by", humanize(packet.filing.channel)],
              ["Confirmation", packet.filing.confirmationRef],
              ["Sent on", new Date(packet.filing.filedAt).toLocaleString()],
              ["Timeliness", packet.filing.filedLate ? "Filed after the due date" : "On time"],
              ["Receipt document", packet.filing.receiptDocumentId ?? "None"],
            ]}
          />
          <Hint>
            A cover sheet and enclosure index are filed in the document library as the retained
            record of what was sent.
          </Hint>
        </>
      ) : null}
    </>
  );
}
