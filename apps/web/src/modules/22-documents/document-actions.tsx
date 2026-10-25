import {
  Button,
  Modal,
  SelectField,
  TextField,
  stepUpPath,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/22-documents — the two small §4.1/§4.2 document ceremonies (#91).
//
// EDIT is `PATCH /api/v1/documents/:id` — title and portal visibility. The route returns the patched
// document and its contract declared no response schema until this change, so `client:gen` typed the
// body `never`: an edit could be sent and there was no typed way to read back what the server made of
// it. Legal hold is refused by `ABAC_LEGAL_HOLD` server-side, not previewed here.
//
// PREVIEW is `GET .../versions/:versionId/content`, which is a GET that WRITES: it mints a short-lived
// signed URL and records a §164.528 disclosure-accounting entry against the stated purpose. That is why
// the purpose is asked for rather than defaulted — "treatment" is the common case, but recording every
// look as treatment would make the accounting log a fiction, and the log is the point. The URL is
// opened in a new tab rather than embedded: it points at object storage, and the artifact viewer that
// would render it inline (DOC.SignedUrlPreview) is a screen this slice does not build.
import { useEffect, useId, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import {
  type StepUpDraftOwner,
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import {
  type AccessPurpose,
  type DisclosureRecipient,
  type DocumentView,
  mintContentUrl,
  patchDocument,
} from "./documents-api";

/** The §4.2 §164.528 access purposes the route accepts, in the order a clinician meets them. */
const PURPOSES: readonly AccessPurpose[] = [
  "treatment",
  "operations",
  "payment",
  "disclosure",
  "patient_access",
  "amendment_review",
  "survey_export",
];

const PURPOSE_LABEL: Record<string, string> = {
  treatment: "Treatment — caring for this patient",
  operations: "Operations — quality, training, administration",
  payment: "Payment — billing or claim support",
  disclosure: "Disclosure — releasing to a third party",
  patient_access: "Patient access — §164.524 request",
  amendment_review: "Amendment review",
  survey_export: "Survey export",
};

/** Purposes that release the document to a partner outside the org, so the server needs the recipient (§4.12). */
const EXTERNAL_PURPOSES: readonly AccessPurpose[] = ["disclosure", "survey_export"];

const RECIPIENT_KIND_LABEL: Record<DisclosureRecipient["kind"], string> = {
  facility: "Facility",
  payer: "Payer",
};

export interface DocumentEditDialogProps {
  readonly open: boolean;
  readonly document: DocumentView;
  readonly onClose: () => void;
  readonly onDone: (updated: DocumentView) => void;
}

export function DocumentEditDialog({
  open,
  document: doc,
  onClose,
  onDone,
}: DocumentEditDialogProps): JSX.Element | null {
  const client = useApiClient();
  const [title, setTitle] = useState(doc.title);
  const [patientFacing, setPatientFacing] = useState(Boolean(doc.patientFacing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(doc.title);
    setPatientFacing(Boolean(doc.patientFacing));
    setBusy(false);
    setError(null);
  }, [open, doc]);

  if (!open) return null;

  const unchanged = title.trim() === doc.title && patientFacing === Boolean(doc.patientFacing);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await patchDocument(client, doc.id, {
      ...(title.trim() !== doc.title ? { title: title.trim() } : {}),
      ...(patientFacing !== Boolean(doc.patientFacing) ? { patientFacing } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Edit document"
      width="28rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={heading}>Edit document</h2>
        <TextField
          label="Title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={patientFacing}
            disabled={busy}
            onChange={(e) => setPatientFacing(e.target.checked)}
          />
          <span>Visible to the patient and family in the portal</span>
        </label>
        <p style={meta}>
          A document under legal hold cannot be edited; the server refuses the change rather than
          this dialog hiding it.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || unchanged || title.trim() === ""}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The step-up draft action for an external open — also the operation key the server steps up on. */
export const DISCLOSE_ACTION = "documents.disclose_external";
export const DISCLOSE_ACTIONS: readonly string[] = [DISCLOSE_ACTION];

/** What the dialog stashes across the /step-up round trip: the choices, never the document or the URL. */
interface DisclosureDraft {
  readonly purpose: AccessPurpose;
  readonly recipientKind: DisclosureRecipient["kind"];
  readonly recipientId: string;
}

export const disclosureDraftKey = (owner: StepUpDraftOwner | null, versionId: string) =>
  stepUpDraftKey(owner, DISCLOSE_ACTION, versionId);

function readDisclosureDraft(key: string | null): DisclosureDraft | null {
  const d = peekStepUpDraft<Record<string, unknown>>(key);
  if (!d) return null;
  const { purpose, recipientKind, recipientId } = d;
  if (typeof purpose !== "string" || !EXTERNAL_PURPOSES.includes(purpose as AccessPurpose))
    return null;
  if (typeof recipientKind !== "string" || !(recipientKind in RECIPIENT_KIND_LABEL)) return null;
  if (typeof recipientId !== "string") return null;
  return {
    purpose: purpose as AccessPurpose,
    recipientKind: recipientKind as DisclosureRecipient["kind"],
    recipientId,
  };
}

export interface DocumentPreviewDialogProps {
  readonly open: boolean;
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly onClose: () => void;
}

export function DocumentPreviewDialog({
  open,
  documentId,
  versionId,
  versionNumber,
  onClose,
}: DocumentPreviewDialogProps): JSX.Element | null {
  const client = useApiClient();
  const owner = useStepUpOwner();
  const draftKey = disclosureDraftKey(owner, versionId);
  // Back from /step-up the parent remounts this dialog; the choices made before the refusal come back with it.
  const [resume] = useState(() => readDisclosureDraft(draftKey));
  const [purpose, setPurpose] = useState<AccessPurpose>(resume?.purpose ?? "treatment");
  const [recipientKind, setRecipientKind] = useState<DisclosureRecipient["kind"]>(
    resume?.recipientKind ?? "facility",
  );
  const [recipientId, setRecipientId] = useState(resume?.recipientId ?? "");
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const external = EXTERNAL_PURPOSES.includes(purpose);

  useEffect(() => {
    if (open) return;
    setPurpose("treatment");
    setRecipientKind("facility");
    setRecipientId("");
    setBusy(false);
    setError(null);
    setNeedsStepUp(false);
  }, [open]);

  if (!open) return null;

  // A failure describes the selection that produced it; once the user changes it, the message is stale.
  function clearFailure(): void {
    setError(null);
    setNeedsStepUp(false);
  }

  function close(): void {
    clearStepUpDraft(draftKey);
    onClose();
  }

  async function submit(): Promise<void> {
    setBusy(true);
    clearFailure();
    const res = await mintContentUrl(
      client,
      documentId,
      versionId,
      purpose,
      external ? { kind: recipientKind, entityId: recipientId } : undefined,
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      setNeedsStepUp(res.stepUp === true);
      if (res.stepUp === true && external) {
        stashStepUpDraft(draftKey, { purpose, recipientKind, recipientId });
      }
      return;
    }
    clearStepUpDraft(draftKey);
    // `noopener` because the target is object storage, not this origin.
    globalThis.open(res.value.url, "_blank", "noopener,noreferrer");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : close}
      ariaLabel="Open document content"
      width="28rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={heading}>Open version {versionNumber}</h2>
        <SelectField
          label="Reason for access"
          value={purpose}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as AccessPurpose;
            clearFailure();
            setPurpose(next);
            // A partner picked for one external reason must not survive a detour through an internal one:
            // the remounted lookup would show a bare id for a recipient the user can no longer read.
            if (!EXTERNAL_PURPOSES.includes(next)) setRecipientId("");
          }}
          options={PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABEL[p] ?? p }))}
        />
        {external ? (
          <>
            <SelectField
              label="Recipient type"
              value={recipientKind}
              disabled={busy}
              onChange={(e) => {
                clearFailure();
                setRecipientKind(e.target.value as DisclosureRecipient["kind"]);
                setRecipientId("");
              }}
              options={Object.entries(RECIPIENT_KIND_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <MdmEntityLookupField
              key={recipientKind}
              kind={recipientKind}
              label="Recipient"
              value={recipientId}
              onChange={(id) => {
                clearFailure();
                setRecipientId(id);
              }}
              disabled={busy}
              required
              appearance="modal"
              hint="The partner receiving this document. A signed business associate agreement must be on file."
            />
          </>
        ) : null}
        {external && recipientId === "" ? (
          <p id={hintId} style={meta}>
            Choose a recipient to continue.
          </p>
        ) : null}
        <p style={meta}>
          Opening this document is recorded in the patient's disclosure accounting (§164.528)
          against the reason chosen here. The link is short-lived and opens in a new tab.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
            {needsStepUp ? (
              <>
                {" "}
                <a href={stepUpPath(`${location.pathname}${location.search}`)}>Verify now</a>
              </>
            ) : null}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || (external && recipientId === "")}
            aria-describedby={external && recipientId === "" ? hintId : undefined}
          >
            {busy ? "Opening…" : "Open"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const heading: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
