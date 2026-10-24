import { Button, SelectField, TextField, nowLocalInput, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the AUDIT RESPONSE PACKET section of the audit work rail (hospice ADR/TPE/QIC
// PRD, milestone 7a-2). While the request is in assembly the specialist types the response checklist FROM THE REQUEST
// LETTER (nothing is pre-filled: what an audit asks for is not something this app knows), attaches documents under a
// claim of the request, and either records the due date or attests the letter states none; in review someone who did
// NOT prepare the packet signs off (under a step-up); then the response sent outside ChartWarden is recorded with its
// proof under a step-up. The server owns every rule (preparer/approver separation, enclosure refusals, the stale
// sign-off, the late-filing acknowledgement, the frozen manifest) and its message is shown verbatim (ADR-0030); this
// component only collects facts and offers the moves the state allows.
//
// Resilience rules: a command is guarded by a ref (a double click cannot send twice); after every command the request is
// reloaded, and when that reload FAILS nothing says "done" and every command stays disabled behind a Retry reload; a
// conflict reloads the request but keeps the person's unsaved checklist edits on screen; the step-up draft is restored
// only on a genuine return from the step-up page and never restores the late-filing acknowledgement.
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
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
import { type WriteResult, isUuid } from "./remittance-api";
import { humanize } from "./remittance-status";

export const AUDIT_DRAFT_ACTION = "m25-audit-response";
const AUDIT_DRAFT_ACTIONS: readonly string[] = [AUDIT_DRAFT_ACTION];

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

/** What survives a step-up round trip. The late-filing acknowledgement is deliberately NOT here. */
interface FilingDraft {
  readonly channel: AuditFilingInput["channel"];
  readonly confirmationRef: string;
  readonly filedAt: string;
  readonly receiptDocumentId: string;
  readonly receiptClaimId: string;
}

const CONFLICT_COPY =
  "This request changed while you were working. It was reloaded and your edit was not saved.";
/** Refusals that mean the record moved under the person: the screen reloads and says the edit was not saved. */
const MOVED_CODES = new Set(["VERSION_CONFLICT", "AUDIT_FROZEN", "AUDIT_WRONG_STATE"]);

function failureCopy(res: { status: number | null; code: string | null; message: string }): string {
  const moved = res.status === 409 && res.code !== null && MOVED_CODES.has(res.code);
  return moved ? `${CONFLICT_COPY} ${res.message}` : res.message;
}

const sameLabel = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export interface AuditResponsePanelProps {
  readonly audit: AuditRequestDetail;
  /** Reload the request (and the worklist); true when the reload succeeded. */
  readonly onChanged: () => Promise<boolean>;
  /** Tells the parent a packet command is in flight, so a state move cannot race it on the same version. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** The parent is mid-move: packet commands wait, as both use the request's one If-Match version. */
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
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, AUDIT_DRAFT_ACTIONS);
  const response = audit.response;
  const draftKey = stepUpDraftKey(owner, AUDIT_DRAFT_ACTION, audit.id);
  // Restored only on a genuine return from the step-up page (an abandoned draft is discarded by the hook).
  const [restored] = useState(() => (returning ? peekStepUpDraft<FilingDraft>(draftKey) : null));
  const claimOptions = useMemo(
    () =>
      audit.claims.map((c) => ({
        value: c.claimId,
        label: c.claimControlNumber ?? c.claimId.slice(0, 8),
      })),
    [audit.claims],
  );

  const serverItems = JSON.stringify(response.items);
  const [items, setItems] = useState<readonly AuditResponseItem[]>(response.items);
  const baseline = useRef(serverItems);
  const [serverMoved, setServerMoved] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documentClaimPick, setDocumentClaimPick] = useState(claimOptions[0]?.value ?? "");
  const [channel, setChannel] = useState<AuditFilingInput["channel"]>(restored?.channel ?? "mail");
  const [confirmationRef, setConfirmationRef] = useState(restored?.confirmationRef ?? "");
  const [filedAt, setFiledAt] = useState(restored?.filedAt ?? nowLocalInput());
  const [lateAcknowledged, setLateAcknowledged] = useState(false);
  const [receiptDocumentId, setReceiptDocumentId] = useState(restored?.receiptDocumentId ?? "");
  const [receiptClaimPick, setReceiptClaimPick] = useState(
    restored?.receiptClaimId ?? claimOptions[0]?.value ?? "",
  );
  const [ownBusy, setOwnBusy] = useState(false);
  const inFlight = useRef(false);
  /** The last reload failed: what is on screen may not be current, so nothing can be sent until it is retried. */
  const [stale, setStale] = useState(false);
  const busy = ownBusy || locked;
  const blocked = busy || stale;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const checklistHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const documentsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A reload replaces the typed checklist with the server's ONLY while there are no unsaved edits; otherwise the edits
  // stay on screen and the person is told the list moved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized server list is the change signal
  useEffect(() => {
    const local = JSON.stringify(items);
    if (local === baseline.current || local === serverItems) {
      // No unsaved edits (or the server now holds exactly what was typed): follow the server.
      setItems(response.items);
      setServerMoved(false);
    } else if (serverItems !== baseline.current) {
      setServerMoved(true);
      return;
    }
    baseline.current = serverItems;
  }, [serverItems]);

  // The selected claim must still be one of the request's claims (a reload can remove it).
  const documentClaimId = claimOptions.some((c) => c.value === documentClaimPick)
    ? documentClaimPick
    : (claimOptions[0]?.value ?? "");
  const receiptClaimId = claimOptions.some((c) => c.value === receiptClaimPick)
    ? receiptClaimPick
    : (claimOptions[0]?.value ?? "");

  const assembling = audit.state === "in_assembly";
  const iAmAssembler = session?.membershipId === response.sentToReviewByMembershipId;
  const signedOff = response.reviewedByMembershipId !== null;
  const hasDeadline = audit.deadlines.length > 0;
  const noneStated = response.deadlineNoneStatedAt !== null;
  const needsDeadline = !hasDeadline && !noneStated;
  const filedIso =
    filedAt && !Number.isNaN(Date.parse(filedAt)) ? new Date(filedAt).toISOString() : null;
  // Late only against a recorded deadline the person typed; the server decides the same way.
  const isLate =
    filedIso !== null &&
    audit.nextDueAt !== null &&
    Date.parse(filedIso) > Date.parse(audit.nextDueAt);
  const itemsDirty = JSON.stringify(items) !== baseline.current;

  const blockedWhy = locked
    ? "Another change to this request is in progress."
    : ownBusy
      ? "Working on the previous action."
      : stale
        ? "The request could not be reloaded, so what is shown may be out of date. Retry reload first."
        : null;
  const trimmedLabel = newLabel.trim();
  const addWhy =
    blockedWhy ??
    (trimmedLabel === ""
      ? "Type the item as the request letter words it."
      : items.some((i) => sameLabel(i.label, trimmedLabel))
        ? "That item is already on the list."
        : null);
  const saveWhy = blockedWhy ?? (itemsDirty ? null : "There are no unsaved checklist changes.");
  const attachWhy =
    blockedWhy ??
    (documentClaimId === ""
      ? "Link a claim to the request first."
      : isUuid(documentId.trim())
        ? null
        : "Enter the document's UUID.");
  const signOffWhy =
    blockedWhy ??
    (iAmAssembler
      ? "You sent this packet to review, so someone else with review access must sign it off."
      : needsDeadline
        ? "Record the due date, or attest the letter states none, before sign-off."
        : null);
  const fileWhy =
    blockedWhy ??
    (needsDeadline
      ? "Record the due date, or attest the letter states none, before filing."
      : confirmationRef.trim() === ""
        ? "Enter the confirmation or tracking reference."
        : filedIso === null
          ? "Enter when the response was sent."
          : isLate && !lateAcknowledged
            ? "Tick the box to confirm it was sent after a recorded due date."
            : receiptDocumentId.trim() !== "" && !isUuid(receiptDocumentId.trim())
              ? "The receipt document ID must be a UUID."
              : null);

  const setBusy = (next: boolean): void => {
    inFlight.current = next;
    setOwnBusy(next);
    onBusyChange?.(next);
  };

  /** Reload; marks the screen stale when the reload fails. */
  async function reload(): Promise<boolean> {
    const ok = await onChanged();
    if (mounted.current) setStale(!ok);
    return ok;
  }

  /** Runs one packet command; true when it succeeded AND the reload after it did. Every refusal is shown. */
  async function run(
    label: string,
    call: () => Promise<WriteResult<unknown>>,
    after?: () => void,
  ): Promise<boolean> {
    if (inFlight.current) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await call();
    if (!mounted.current) return false;
    if (!res.ok) {
      if (res.stepUp) {
        // The sign-off needs a recent step-up: go and verify, nothing to restore.
        setBusy(false);
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return false;
      }
      setError(failureCopy(res));
    }
    // Reload before re-enabling: the next command must carry the version the server holds NOW.
    const reloaded = await reload();
    if (!mounted.current) return false;
    if (res.ok && reloaded) {
      setNotice(`${label}: done.`);
      after?.();
    } else if (res.ok) {
      setError(
        `${label} was saved, but the request could not be reloaded. Retry reload before going on.`,
      );
    }
    setBusy(false);
    return res.ok && reloaded;
  }

  const addItem = (): void => {
    if (addWhy !== null) return;
    setItems((cur) => [...cur, { label: trimmedLabel, state: "pending" }]);
    setNewLabel("");
    checklistHeading.current?.focus();
  };
  const setItemState = (index: number, state: AuditResponseItem["state"]): void =>
    setItems((cur) => cur.map((it, i) => (i === index ? { ...it, state } : it)));
  const removeItem = (index: number): void => {
    setItems((cur) => cur.filter((_, i) => i !== index));
    checklistHeading.current?.focus();
  };
  const discardEdits = (): void => {
    baseline.current = serverItems;
    setItems(response.items);
    setServerMoved(false);
    checklistHeading.current?.focus();
  };

  async function attach(): Promise<void> {
    if (attachWhy !== null) return;
    const ok = await run("Attach document", () =>
      attachAuditDocument(client, audit.id, audit.version, {
        claimId: documentClaimId,
        documentId: documentId.trim(),
      }),
    );
    if (ok && mounted.current) {
      setDocumentId("");
      documentsHeading.current?.focus();
    }
  }

  async function file(): Promise<void> {
    if (inFlight.current || fileWhy !== null || filedIso === null) return;
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
    if (!res.ok && res.stepUp) {
      setBusy(false);
      // The late acknowledgement is not stashed: the person confirms it again on return.
      stashStepUpDraft(draftKey, {
        channel,
        confirmationRef,
        filedAt,
        receiptDocumentId,
        receiptClaimId,
      } satisfies FilingDraft);
      navigate(`/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return;
    }
    // Any other outcome ends the step-up round trip: a stale draft must not come back later.
    clearStepUpDraft(draftKey);
    if (!res.ok) setError(failureCopy(res));
    const reloaded = await reload();
    if (!mounted.current) return;
    if (res.ok && reloaded) setNotice("Record filing: done.");
    else if (res.ok) {
      setError(
        "The filing was recorded, but the request could not be reloaded. Retry reload before going on.",
      );
    }
    setBusy(false);
  }

  const showPacket =
    audit.state === "received" ||
    audit.state === "in_assembly" ||
    audit.state === "in_review" ||
    response.filing !== null;
  if (!showPacket) return null;
  const editingChecklist = assembling || audit.state === "received";

  return (
    <section aria-label="Response packet">
      <h3 className="wx-action-title">Response packet</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />
      {stale ? (
        <ButtonRow>
          <Button
            size="sm"
            tone="secondary"
            disabled={ownBusy}
            onClick={() => {
              void reload();
            }}
          >
            Retry reload
          </Button>
        </ButtonRow>
      ) : null}

      <h4 className="wx-action-title" ref={checklistHeading} tabIndex={-1}>
        Response checklist
      </h4>
      <Hint>
        Type what the request letter asks for. Nothing is pre-filled: the app does not know what a
        particular audit requires.
      </Hint>
      {serverMoved ? (
        <div role="alert" className="wx-action-hint is-alert">
          The checklist changed on the server while you were editing. Your unsaved edits are kept;
          saving replaces the server's list.{" "}
          <Button size="sm" tone="tertiary" onClick={discardEdits}>
            Discard my edits
          </Button>
        </div>
      ) : null}
      {items.length === 0 ? <Hint>No checklist items typed yet.</Hint> : null}
      {editingChecklist ? (
        <>
          {items.map((it, i) => (
            <div key={it.label.toLowerCase()}>
              <SelectField
                label={it.label}
                value={it.state}
                disabled={blocked}
                onChange={(e) => setItemState(i, e.target.value as AuditResponseItem["state"])}
                options={ITEM_STATES.map((s) => ({ value: s.value, label: s.label }))}
              />
              <Button
                tone="tertiary"
                size="sm"
                disabled={blocked}
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
              disabled={addWhy !== null}
              aria-describedby={addWhy ? "audit-add-why" : undefined}
              onClick={addItem}
            >
              Add item
            </Button>
            <Button
              size="sm"
              disabled={saveWhy !== null}
              aria-describedby={saveWhy ? "audit-save-why" : undefined}
              onClick={() =>
                void run(
                  "Save checklist",
                  () => saveAuditResponseItems(client, audit.id, audit.version, items),
                  () => checklistHeading.current?.focus(),
                )
              }
            >
              Save checklist
            </Button>
          </ButtonRow>
          {addWhy ? (
            <p className="wx-action-hint" id="audit-add-why">
              {addWhy}
            </p>
          ) : null}
          {saveWhy ? (
            <p className="wx-action-hint" id="audit-save-why">
              {saveWhy}
            </p>
          ) : null}
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
            attest that here; a packet cannot be signed off or filed with neither.
          </Hint>
          <ButtonRow>
            <Button
              size="sm"
              tone="secondary"
              disabled={blocked}
              onClick={() =>
                void run("Attestation", () =>
                  attestNoDeadlineStated(client, audit.id, audit.version),
                )
              }
            >
              The request letter states no due date
            </Button>
          </ButtonRow>
          {blockedWhy ? <p className="wx-action-hint">{blockedWhy}</p> : null}
        </>
      )}

      <h4 className="wx-action-title" ref={documentsHeading} tabIndex={-1}>
        Documents
      </h4>
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
                    disabled={blocked}
                    aria-label={`Remove document ${d.documentId}`}
                    onClick={() =>
                      void run(
                        "Remove document",
                        () => detachAuditDocument(client, audit.id, audit.version, d.documentId),
                        () => documentsHeading.current?.focus(),
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
        claimOptions.length === 0 ? (
          <Hint>Link a claim first: every document is attached under a claim of the request.</Hint>
        ) : (
          <>
            <SelectField
              label="Attach under claim"
              value={documentClaimId}
              onChange={(e) => setDocumentClaimPick(e.target.value)}
              options={claimOptions}
            />
            <TextField
              label="Document ID to attach"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              error={
                documentId && !isUuid(documentId.trim()) ? "Enter the document's UUID." : undefined
              }
            />
            <ButtonRow end>
              <Button
                size="sm"
                disabled={attachWhy !== null}
                aria-describedby={attachWhy ? "audit-attach-why" : undefined}
                onClick={() => void attach()}
              >
                Attach document
              </Button>
            </ButtonRow>
            {attachWhy ? (
              <p className="wx-action-hint" id="audit-attach-why">
                {attachWhy}
              </p>
            ) : null}
            <Hint>
              A document must belong to that claim's patient, be current, and not be a 42 CFR Part 2
              record. The server names the reason if it refuses one.
            </Hint>
          </>
        )
      ) : null}

      {audit.state === "in_review" ? (
        <>
          <h4 className="wx-action-title" ref={reviewHeading} tabIndex={-1}>
            Review
          </h4>
          {signedOff ? (
            <Hint>
              Signed off {response.reviewedAt ? new Date(response.reviewedAt).toLocaleString() : ""}
              . The claims, deadlines and checklist are now frozen; anything changed behind this
              screen voids the sign-off.
            </Hint>
          ) : (
            <>
              <Hint>
                Next step: someone who did not prepare this packet (did not send it to review,
                attach a document or type the checklist) signs it off. Signing off needs a recent
                step-up verification and freezes the claims and due dates.
              </Hint>
              <ButtonRow>
                <Button
                  size="sm"
                  disabled={signOffWhy !== null}
                  aria-describedby={signOffWhy ? "audit-signoff-why" : undefined}
                  onClick={() =>
                    void run(
                      "Sign off",
                      () => signOffAudit(client, audit.id, audit.version),
                      () => reviewHeading.current?.focus(),
                    )
                  }
                >
                  Sign off packet
                </Button>
              </ButtonRow>
              {signOffWhy ? (
                <p className="wx-action-hint" id="audit-signoff-why">
                  {signOffWhy}
                </p>
              ) : null}
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
            <label className="wx-action-check">
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
              onChange={(e) => setReceiptClaimPick(e.target.value)}
              options={claimOptions}
            />
          ) : null}
          <ButtonRow end>
            <Button
              disabled={fileWhy !== null}
              aria-describedby={fileWhy ? "audit-file-why" : undefined}
              onClick={() => void file()}
            >
              Record filing
            </Button>
          </ButtonRow>
          {fileWhy ? (
            <p className="wx-action-hint" id="audit-file-why">
              {fileWhy}
            </p>
          ) : null}
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
