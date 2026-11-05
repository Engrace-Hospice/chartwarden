// @chartwarden/portal - ADR-0107 "Documents to sign": the patient or their representative reads the document request a care team sent,
// signs it with a typed name, an attestation and a fresh authenticator code, or uploads a signed paper copy for the care team to review.
// The server decides who may sign what; this screen only shapes the conversation and says no in plain words. The typed name and the code
// live in component state for the length of one attempt and are never logged or stored.
import {
  Button,
  Glyph,
  Modal,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { formatPortalVisitDate, humanize, readError } from "./portal-format";
import { PortalPage } from "./portal-page";

type Status = "pending" | "uploaded_pending_review" | "signed";
interface SignatureItem {
  id: string;
  docKind: string;
  status: Status;
  requestedAt: string;
  signedAt: string | null;
}
type ListState =
  | { status: "loading" | "error"; items: [] }
  | { status: "ready"; items: SignatureItem[] };

export const SIGNATURE_DOC_NAMES: Readonly<Record<string, string>> = {
  election_statement: "Hospice election statement",
  notice_of_patient_rights: "Notice of patient rights",
  hipaa_npp_acknowledgement: "Notice of privacy practices acknowledgement",
  consent_to_treat: "Consent to treat",
};
const docName = (kind: string): string => SIGNATURE_DOC_NAMES[kind] ?? humanize(kind);

const STATUS_PILL: Record<Status, { label: string; tone: "warning" | "progress" | "success" }> = {
  pending: { label: "Needs your signature", tone: "warning" },
  uploaded_pending_review: { label: "Waiting for review", tone: "progress" },
  signed: { label: "Signed", tone: "success" },
};

const MAX_UPLOAD_BYTES = 52_428_800;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/tiff",
]);
const NOT_READY = "This document is not ready to sign yet. Your care team will let you know.";
const NOT_ABLE = "You are not able to sign this document for this patient.";
const TOTP = /^\d{6,8}$/;

/** What the server's refusal means to a person. Codes come from the sign / attach routes; nothing here echoes record content. */
const REFUSALS: Readonly<Record<string, string>> = {
  TEMPLATE_PENDING_LEGAL_REVIEW: NOT_READY,
  REQUEST_TARGET_MISSING: NOT_READY,
  REQUEST_NOT_OPEN: "That request is no longer open.",
  REQUEST_NOT_PENDING: "That request is no longer waiting for a signature.",
  NOT_AUTHORIZED_FOR_DOCUMENT: NOT_ABLE,
  GRANT_KIND_UNSUPPORTED: NOT_ABLE,
  DPOA_CONSENT_NOT_ACTIVE:
    "Your authority to act for this patient could not be confirmed. Please contact your care team.",
  SIGNER_NAME_REQUIRED: "Please type your full name.",
  RELATIONSHIP_REQUIRED: "Please say how you are related to the patient.",
  PATIENT_UNABLE_REASON_REQUIRED: "Please say why the patient was not able to sign.",
  UPLOAD_NOT_USABLE: "That file cannot be used as the signed copy. Please upload it again.",
};

const newKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const errorCode = (res: { error?: unknown }): string | null =>
  (res.error as { error?: { code?: string } } | undefined)?.error?.code ?? null;
const statusOf = (res: unknown): number | undefined =>
  (res as { response?: Response }).response?.status;

function refusalMessage(res: { error?: unknown }, fallbackStatus?: number): string {
  const code = errorCode(res);
  if (code && REFUSALS[code]) return REFUSALS[code];
  if (fallbackStatus === 403) return NOT_ABLE;
  return "We could not complete that right now. Please try again in a moment.";
}

/** A 4xx is a definitive answer (the attempt is over); network failures and 5xx may have landed, so a retry reuses the key. */
const isDefinitive = (status: number | undefined): boolean =>
  status !== undefined && status >= 400 && status < 500;

interface DialogProps {
  requestId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}

function SignDialog({ requestId, onClose, onDone }: DialogProps): JSX.Element {
  const client = useApiClient();
  const [detail, setDetail] = useState<{
    docKind: string;
    attestationText: string;
    documentTitle?: string;
    documentParagraphs?: readonly string[];
  } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState("");
  const [attested, setAttested] = useState(false);
  const [code, setCode] = useState("");
  const [relationship, setRelationship] = useState("");
  const [unableReason, setUnableReason] = useState("");
  const [behalfOpen, setBehalfOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploadStep, setUploadStep] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);
  const attachKey = useRef<string | null>(null);
  const resumeUpload = useRef<string | null>(null);
  /** The upload id whose `upload-complete` succeeded; a retry resumes from the first step that has not. */
  const completedUpload = useRef<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      const res = await client.GET("/api/v1/portal/signature-requests/{requestId}", {
        params: { path: { requestId } },
      });
      if (!current) return;
      if (res.error || !res.data) setLoadFailed(true);
      else setDetail(res.data);
    })().catch(() => current && setLoadFailed(true));
    return () => {
      current = false;
    };
  }, [client, requestId]);

  // A document is only signed in the portal when its wording is shown here; without it (the election statement and the notice of
  // rights today) the server refuses too, and the paper-copy path stays open.
  const hasText = (detail?.documentParagraphs?.length ?? 0) > 0;
  const canSubmit =
    hasText && name.trim().length >= 2 && attested && TOTP.test(code.trim()) && !busy;

  const sign = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    attemptKey.current ??= newKey();
    try {
      const step = await client.POST("/api/v1/portal/sessions/step-up", {
        body: { totpCode: code.trim() },
      });
      if (step.error) {
        setMessage(
          isDefinitive(statusOf(step)) && statusOf(step) !== 429
            ? "We could not verify that code. Check the code and try again."
            : "We could not verify your code right now. Wait a moment and try again.",
        );
        return;
      }
      const res = await client.POST("/api/v1/portal/signature-requests/{requestId}/sign", {
        params: { path: { requestId } },
        headers: { "Idempotency-Key": attemptKey.current },
        body: {
          signedTypedName: name.trim(),
          ...(relationship.trim() ? { signerRelationshipText: relationship.trim() } : {}),
          ...(unableReason.trim() ? { patientUnableReason: unableReason.trim() } : {}),
          attested: true,
        },
      } as never);
      if (!live.current) return;
      if ("error" in res && res.error) {
        const refusedCode = errorCode(res);
        if (
          refusedCode === "RELATIONSHIP_REQUIRED" ||
          refusedCode === "PATIENT_UNABLE_REASON_REQUIRED"
        )
          setBehalfOpen(true);
        if (isDefinitive(statusOf(res))) attemptKey.current = null;
        setMessage(refusalMessage(res, statusOf(res)));
        return;
      }
      attemptKey.current = null;
      onDone("Thank you. Your signature was recorded.");
    } catch {
      if (live.current) setMessage("We could not complete that right now. Please try again.");
    } finally {
      if (live.current) {
        setCode("");
        setBusy(false);
      }
    }
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";
    resumeUpload.current = null;
    completedUpload.current = null;
    attachKey.current = null;
    setMessage(null);
    if (!selected) return;
    if (
      selected.size === 0 ||
      selected.size > MAX_UPLOAD_BYTES ||
      !ALLOWED_MIME.has(selected.type)
    ) {
      setFile(null);
      setMessage("Choose a PDF, JPEG, PNG, HEIC or TIFF file under 50 MB.");
      return;
    }
    setFile(selected);
  };

  const attach = async (uploadId: string): Promise<boolean> => {
    attachKey.current ??= newKey();
    setUploadStep("Attaching your copy…");
    const res = await client.POST("/api/v1/portal/signature-requests/{requestId}/signed-copy", {
      params: { path: { requestId } },
      headers: { "Idempotency-Key": attachKey.current },
      body: { uploadId },
    } as never);
    if (!live.current) return false;
    if ("error" in res && res.error) {
      if (isDefinitive(statusOf(res))) {
        attachKey.current = null;
        resumeUpload.current = null;
        completedUpload.current = null;
      }
      setMessage(refusalMessage(res, statusOf(res)));
      return false;
    }
    attachKey.current = null;
    resumeUpload.current = null;
    completedUpload.current = null;
    return true;
  };

  const sendCopy = async (): Promise<void> => {
    if (busy || !file || !TOTP.test(code.trim())) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!resumeUpload.current) {
        completedUpload.current = null;
        setUploadStep("Preparing secure upload…");
        const init = await client.POST("/api/v1/portal/documents/upload-init", {
          body: {
            purpose: "signed_admission_document",
            mimeType: file.type,
            expectedByteSize: file.size,
          },
        });
        if (init.error || !init.data?.uploadId) {
          setMessage(readError(init.response?.status));
          return;
        }
        const uploadId = init.data.uploadId;
        setUploadStep("Sending file securely…");
        const put = await client.PUT("/api/v1/portal/documents/uploads/{uploadId}/content", {
          params: { path: { uploadId } },
          body: file as never,
          bodySerializer: (body: unknown) => body as BodyInit,
          headers: { "content-type": file.type },
        } as never);
        if (put.error) {
          setMessage("The file could not be sent. Check your connection and try again.");
          return;
        }
        resumeUpload.current = uploadId;
      }
      const uploadId = resumeUpload.current as string;
      if (completedUpload.current !== uploadId) {
        setUploadStep("Submitting for processing…");
        const done = await client.POST("/api/v1/portal/documents/upload-complete/{uploadId}", {
          params: { path: { uploadId } },
        });
        if (done.error) {
          setMessage("The file was sent, but could not be submitted. Try again.");
          return;
        }
        completedUpload.current = uploadId;
      }
      // Attaching needs the same fresh step-up as signing, right before the call.
      const step = await client.POST("/api/v1/portal/sessions/step-up", {
        body: { totpCode: code.trim() },
      });
      if (step.error) {
        setMessage(
          "We could not verify your code. Check it and try again; your file is already sent.",
        );
        return;
      }
      if (await attach(uploadId)) {
        onDone("Your signed copy was sent. Your care team will review it.");
      }
    } catch {
      if (live.current) setMessage("The copy could not be sent. Please try again.");
    } finally {
      if (live.current) {
        setUploadStep(null);
        setCode("");
        setBusy(false);
      }
    }
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      dismissOnScrim={false}
      ariaLabel="Sign this document"
      width="40rem"
    >
      <div className="wx-signatures-dialog">
        <header>
          <h2>{detail ? docName(detail.docKind) : "Document to sign"}</h2>
        </header>
        {loadFailed ? (
          <p role="alert">{readError(undefined)}</p>
        ) : !detail ? (
          <output>Loading…</output>
        ) : (
          <>
            <form className="wx-signatures-form" onSubmit={(event) => void sign(event)}>
              {hasText ? (
                <>
                  <section className="wx-signatures-document" aria-label={detail.documentTitle}>
                    {detail.documentTitle ? <h3>{detail.documentTitle}</h3> : null}
                    {detail.documentParagraphs?.map((paragraph, index) => (
                      <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
                    ))}
                  </section>
                  <p className="wx-signatures-attestation">{detail.attestationText}</p>
                  <TextField
                    label="Your full name"
                    value={name}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => {
                      attemptKey.current = null;
                      setName(event.target.value);
                    }}
                  />
                  <details
                    className="wx-signatures-behalf"
                    open={behalfOpen}
                    onToggle={(event) => setBehalfOpen(event.currentTarget.open)}
                  >
                    <summary>Signing for someone else?</summary>
                    <TextField
                      label="How are you related to the patient?"
                      value={relationship}
                      disabled={busy}
                      onChange={(event) => {
                        attemptKey.current = null;
                        setRelationship(event.target.value);
                      }}
                    />
                    <TextAreaField
                      label="Why is the patient not able to sign?"
                      value={unableReason}
                      disabled={busy}
                      onChange={(event) => setUnableReason(event.target.value)}
                    />
                  </details>
                  <label className="wx-signatures-check">
                    <input
                      type="checkbox"
                      checked={attested}
                      disabled={busy}
                      onChange={(event) => setAttested(event.target.checked)}
                    />
                    <span>I agree to the statement above.</span>
                  </label>
                </>
              ) : (
                <p className="wx-signatures-attestation">
                  This document can't be signed here yet. Your care team will help you sign it. If
                  you signed a paper copy, you can upload it below.
                </p>
              )}
              <TextField
                label="6-digit code from your authenticator app"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
              {message ? (
                <p className="wx-signatures-message" role="alert">
                  {message}
                </p>
              ) : null}
              {hasText ? (
                <Button type="submit" loading={busy && !uploadStep} disabled={!canSubmit}>
                  Sign
                </Button>
              ) : null}
            </form>
            <section className="wx-signatures-copy" aria-labelledby="signatures-copy-title">
              <h3 id="signatures-copy-title">Upload a signed paper copy</h3>
              <p>
                Signed on paper instead? Upload a photo or scan. Your care team will review it.
                Enter your authenticator code above first: it confirms it is you.
              </p>
              <label htmlFor="signatures-copy-file">Choose a file</label>
              <input
                id="signatures-copy-file"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.heic,.tif,.tiff,application/pdf,image/jpeg,image/png,image/heic,image/tiff"
                disabled={busy}
                onChange={chooseFile}
              />
              {file ? <p>{file.name}</p> : null}
              {uploadStep ? <output>{uploadStep}</output> : null}
              <Button
                tone="secondary"
                disabled={!file || busy || !TOTP.test(code.trim())}
                loading={busy && uploadStep !== null}
                onClick={() => void sendCopy()}
              >
                {resumeUpload.current ? "Retry sending" : "Send signed copy"}
              </Button>
            </section>
          </>
        )}
        <footer>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

function SignaturesForPatient(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<ListState>({ status: "loading", items: [] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await client.GET("/api/v1/portal/signature-requests", {});
    if (res.error || !res.data) setState({ status: "error", items: [] });
    else setState({ status: "ready", items: res.data.items as SignatureItem[] });
  }, [client]);

  useEffect(() => {
    void load().catch(() => setState({ status: "error", items: [] }));
  }, [load]);

  const finished = (message: string): void => {
    setOpenId(null);
    setNotice(message);
    void load().catch(() => setState({ status: "error", items: [] }));
  };

  return (
    <PortalPage title="Documents to sign" subtitle="Forms your care team has asked you to sign.">
      {notice ? (
        <output className="wx-signatures-notice">
          <Glyph name="check-circle" size={20} aria-hidden="true" /> {notice}
        </output>
      ) : null}
      {state.status === "loading" ? <output>Loading…</output> : null}
      {state.status === "error" ? (
        <p role="alert">
          {readError(undefined)}{" "}
          <Button
            tone="secondary"
            size="sm"
            onClick={() => void load().catch(() => setState({ status: "error", items: [] }))}
          >
            Try again
          </Button>
        </p>
      ) : null}
      {state.status === "ready" && state.items.length === 0 ? (
        <p>You have nothing to sign right now.</p>
      ) : null}
      {state.status === "ready" && state.items.length > 0 ? (
        <ul className="wx-signatures-list">
          {state.items.map((item) => {
            const pill = STATUS_PILL[item.status];
            return (
              <li key={item.id}>
                <div>
                  <h2>{docName(item.docKind)}</h2>
                  <p>
                    {item.status === "signed"
                      ? `Signed ${formatPortalVisitDate(item.signedAt) ?? ""}`.trim()
                      : item.status === "uploaded_pending_review"
                        ? "Waiting for your care team to review"
                        : `Sent ${formatPortalVisitDate(item.requestedAt) ?? ""}`.trim()}
                  </p>
                </div>
                <StatusPill label={pill.label} tone={pill.tone} />
                {item.status === "pending" ? (
                  <Button
                    aria-label={`Review and sign: ${docName(item.docKind)}`}
                    onClick={() => setOpenId(item.id)}
                  >
                    Review and sign
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {openId ? (
        <SignDialog requestId={openId} onClose={() => setOpenId(null)} onDone={finished} />
      ) : null}
    </PortalPage>
  );
}

export function PortalSignatures(): JSX.Element {
  const { patientId } = usePortalPatient();
  return <SignaturesForPatient key={patientId ?? "no-patient"} />;
}
