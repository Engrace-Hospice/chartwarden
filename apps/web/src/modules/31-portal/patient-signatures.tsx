import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  InlineAlert,
  LoadingSpinner,
  Modal,
  Panel,
  PatientWorkspaceLayout,
  SelectField,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import type { DataTableColumn } from "@chartwarden/ui";
// apps/web/src/modules/31-portal — the patient chart's Signatures tab (ADR-0107). Staff send a patient or their representative an
// admission document to sign in the portal, see where each request stands, withdraw an open one, and accept or reject a signed
// paper copy the patient uploaded. The signer's typed name and reasons are never read or shown here (the API does not return them).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import {
  DOC_LABEL,
  SIGNER_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type SendOption,
  type SignatureRequestRow,
  VOID_REASONS,
  VOID_REASON_LABEL,
  type VoidReason,
  refusalMessage,
  sendOptions,
} from "./signatures-model";

const BASE = "/api/v1/admin/portal-signature-requests";
const idemKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sig-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("en-US") : "—";

interface KnownRecords {
  draftedElectionStatementId: string | null;
  admissionId: string | null;
}
const NONE_KNOWN: KnownRecords = { draftedElectionStatementId: null, admissionId: null };

/** Keyed by patient: a chart switch gets a fresh screen, so one patient's rows and drafted records never show under another's name. */
export function PatientSignatures(): JSX.Element {
  const { patientId } = useParams<{ patientId: string }>();
  return <PatientSignaturesInner key={patientId} />;
}

const NETWORK_REFUSAL = "We could not reach the server. Please try again.";

function PatientSignaturesInner(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const permissions = useSession()?.permissions ?? [];
  const canSend = permissions.includes("portal.signature_request.create");
  const canReview = permissions.includes("portal.signature_request.review");
  const canVoid = permissions.includes("portal.signature_request.void");
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);

  const [rows, setRows] = useState<SignatureRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [known, setKnown] = useState<KnownRecords>(NONE_KNOWN);
  const [sendOpen, setSendOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState<SignatureRequestRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await client.GET(BASE as never, { params: { query: { patientId } } } as never);
      const r = res as { error?: unknown; data?: { items?: SignatureRequestRow[] } };
      if (r.error) setLoadError(true);
      else setRows(r.data?.items ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The election and the notice of rights sign INTO an M06 record, so the send dialog reads which ones exist from the chart's own
  // election aggregate. A patient the viewer cannot read it for simply gets the two documents that need no record.
  useEffect(() => {
    if (!patientId || !canSend) return;
    let live = true;
    void (async () => {
      const res = await client.GET("/api/v1/patients/{patientId}/election-certification", {
        params: { path: { patientId } },
      });
      if (!live || res.error || !res.data) return;
      const bundle = res.data as unknown as {
        admission: { id: string } | null;
        periods: { electionStatement: { id: string; status: string } | null }[];
      };
      const drafted = bundle.periods.find((p) => p.electionStatement?.status === "drafted");
      setKnown({
        draftedElectionStatementId: drafted?.electionStatement?.id ?? null,
        admissionId: bundle.admission?.id ?? null,
      });
    })().catch(() => undefined); // the dialog then offers only the two documents that need no record
    return () => {
      live = false;
    };
  }, [client, patientId, canSend]);

  const send = async (option: SendOption): Promise<string | null> => {
    try {
      return await sendOnce(option);
    } catch {
      return NETWORK_REFUSAL;
    }
  };

  const sendOnce = async (option: SendOption): Promise<string | null> => {
    const res = await client.POST(
      BASE as never,
      {
        headers: { "Idempotency-Key": idemKey() },
        body: {
          patientId,
          docKind: option.kind,
          ...(option.targetRef ? { targetRef: option.targetRef } : {}),
        },
      } as never,
    );
    const r = res as { error?: unknown };
    if (r.error) return refusalMessage(r.error, "The request could not be sent.");
    setNotice({ tone: "success", text: `${DOC_LABEL[option.kind]} sent for signature.` });
    await load();
    return null;
  };

  const withdraw = async (row: SignatureRequestRow, reason: VoidReason): Promise<string | null> => {
    try {
      return await withdrawOnce(row, reason);
    } catch {
      return NETWORK_REFUSAL;
    }
  };

  const withdrawOnce = async (
    row: SignatureRequestRow,
    reason: VoidReason,
  ): Promise<string | null> => {
    const res = await client.POST(
      `${BASE}/{requestId}/void` as never,
      {
        params: { path: { requestId: row.id } },
        headers: { "Idempotency-Key": idemKey() },
        body: { reason },
      } as never,
    );
    const r = res as { error?: unknown };
    if (r.error) return refusalMessage(r.error, "The request could not be withdrawn.");
    setNotice({ tone: "success", text: "Request withdrawn." });
    await load();
    return null;
  };

  const review = async (row: SignatureRequestRow, decision: "accepted" | "rejected") => {
    setBusyId(row.id);
    setNotice(null);
    try {
      await reviewOnce(row, decision);
    } catch {
      setNotice({ tone: "error", text: NETWORK_REFUSAL });
    } finally {
      setBusyId(null);
    }
  };

  const reviewOnce = async (row: SignatureRequestRow, decision: "accepted" | "rejected") => {
    const res = await client.POST(
      `${BASE}/{requestId}/review` as never,
      {
        params: { path: { requestId: row.id } },
        headers: { "Idempotency-Key": idemKey() },
        body: { decision },
      } as never,
    );
    const r = res as { error?: unknown };
    if (r.error) {
      // Accepting signs a consent, so the server may ask for a fresh step-up first; come back here after it.
      const stepUp = stepUpRedirectFor(r.error, `${location.pathname}${location.search}`);
      if (stepUp) {
        navigate(stepUp);
        return;
      }
      setNotice({ tone: "error", text: refusalMessage(r.error, "The review could not be saved.") });
    } else {
      setNotice({
        tone: "success",
        text:
          decision === "accepted"
            ? "Signed copy accepted."
            : "Signed copy rejected; the request is open again.",
      });
      await load();
    }
  };

  const columns: DataTableColumn<SignatureRequestRow>[] = [
    {
      id: "doc",
      header: "Document",
      priority: "primary",
      cell: (row) => DOC_LABEL[row.docKind],
    },
    {
      id: "status",
      header: "Status",
      priority: "primary",
      cell: (row) => (
        <span>
          <StatusPill label={STATUS_LABEL[row.status]} tone={STATUS_TONE[row.status]} />
          {row.status === "voided" && row.voidReason ? (
            <span className="wx-row-sub" style={{ display: "block" }}>
              {VOID_REASON_LABEL[row.voidReason as VoidReason] ?? "Withdrawn"}
            </span>
          ) : null}
          {row.status === "signed" && row.signerRole ? (
            <span className="wx-row-sub" style={{ display: "block" }}>
              Signed by: {SIGNER_LABEL[row.signerRole]}
            </span>
          ) : null}
        </span>
      ),
    },
    { id: "sent", header: "Sent", priority: "secondary", cell: (row) => when(row.requestedAt) },
    {
      id: "reminders",
      header: "Reminders",
      priority: "tertiary",
      cell: (row) =>
        row.reminderCount === 0
          ? "None yet"
          : `${row.reminderCount} sent, last ${when(row.lastRemindedAt)}`,
    },
    {
      id: "actions",
      header: <span className="wx-visually-hidden">Actions</span>,
      priority: "primary",
      cell: (row) => (
        <RowActions
          row={row}
          busy={busyId === row.id}
          canReview={canReview}
          canVoid={canVoid}
          onReview={(d) => void review(row, d)}
          onWithdraw={() => setWithdrawing(row)}
        />
      ),
    },
  ];

  const options = sendOptions(known);
  return (
    <PatientWorkspaceLayout
      banner={<ChartPatientBanner patientId={patientId} identity={identity} />}
      rail={patientId ? <PatientSummaryPanel identity={identity} /> : undefined}
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="signatures" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "0.5rem 1.5rem 1.5rem", minWidth: 0 }}>
          <Panel
            title="Signatures"
            icon="clipboard-check"
            description="Documents sent to the patient or their representative to sign in the portal."
            flush
            action={
              canSend ? (
                <Button onClick={() => setSendOpen(true)}>Send for signature</Button>
              ) : undefined
            }
          >
            {notice ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
            {loadError ? (
              <ErrorState
                title="Signatures unavailable"
                description="The signature requests could not be loaded."
                onRetry={() => void load()}
              />
            ) : loading && rows.length === 0 ? (
              <LoadingSpinner />
            ) : (
              <DataTable
                ariaLabel="Signature requests"
                rows={rows}
                columns={columns}
                getRowId={(row) => row.id}
                empty={
                  <EmptyState
                    title="Nothing sent yet"
                    description="Send the privacy notice, consent or admission documents for signature."
                  />
                }
              />
            )}
          </Panel>
        </div>
      </div>

      <SendDialog
        open={sendOpen}
        options={options}
        onClose={() => setSendOpen(false)}
        onSend={send}
      />
      <WithdrawDialog
        row={withdrawing}
        onClose={() => setWithdrawing(null)}
        onWithdraw={withdraw}
      />
    </PatientWorkspaceLayout>
  );
}

function RowActions({
  row,
  busy,
  canReview,
  canVoid,
  onReview,
  onWithdraw,
}: {
  row: SignatureRequestRow;
  busy: boolean;
  canReview: boolean;
  canVoid: boolean;
  onReview: (decision: "accepted" | "rejected") => void;
  onWithdraw: () => void;
}): JSX.Element | null {
  const open = row.status === "pending" || row.status === "uploaded_pending_review";
  if (!open) return null;
  const parked = row.status === "uploaded_pending_review";
  const docName = DOC_LABEL[row.docKind] ?? "this document";
  return (
    <span style={{ display: "inline-flex", gap: "0.5rem", flexWrap: "wrap" }}>
      {parked && row.uploadedDocumentId ? (
        <Link
          to={`/documents/${row.uploadedDocumentId}/versions`}
          className="wx-btn-secondary"
          aria-label={`Open the uploaded copy of ${docName}`}
        >
          Open uploaded copy
        </Link>
      ) : null}
      {parked && canReview ? (
        <>
          <Button
            size="sm"
            loading={busy}
            aria-label={`Accept the signed copy of ${docName}`}
            onClick={() => onReview("accepted")}
          >
            Accept
          </Button>
          <Button
            size="sm"
            tone="secondary"
            disabled={busy}
            aria-label={`Reject the signed copy of ${docName}`}
            onClick={() => onReview("rejected")}
          >
            Reject
          </Button>
        </>
      ) : null}
      {canVoid ? (
        <Button
          size="sm"
          tone="tertiary"
          disabled={busy}
          aria-label={`Withdraw the request for ${docName}`}
          onClick={onWithdraw}
        >
          Withdraw
        </Button>
      ) : null}
    </span>
  );
}

function SendDialog({
  open,
  options,
  onClose,
  onSend,
}: {
  open: boolean;
  options: SendOption[];
  onClose: () => void;
  onSend: (option: SendOption) => Promise<string | null>;
}): JSX.Element | null {
  const [kind, setKind] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setKind("");
      setError(null);
    }
  }, [open]);
  if (!open) return null;
  const chosen = options.find((o) => o.kind === (kind || options[0]?.kind));
  const submit = async (): Promise<void> => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const refusal = await onSend(chosen);
    setBusy(false);
    if (refusal) setError(refusal);
    else onClose();
  };
  return (
    <Modal open={open} onClose={busy ? undefined : onClose} ariaLabel="Send for signature">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        style={{ display: "grid", gap: "1rem" }}
      >
        <h2 style={{ margin: 0 }}>Send for signature</h2>
        <SelectField
          label="Document"
          value={chosen?.kind ?? ""}
          onChange={(event) => setKind(event.target.value)}
          options={options.map((o) => ({ value: o.kind, label: o.label }))}
          hint={chosen?.hint}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!chosen}>
            Send
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function WithdrawDialog({
  row,
  onClose,
  onWithdraw,
}: {
  row: SignatureRequestRow | null;
  onClose: () => void;
  onWithdraw: (row: SignatureRequestRow, reason: VoidReason) => Promise<string | null>;
}): JSX.Element | null {
  const [reason, setReason] = useState<VoidReason>("sent_in_error");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowId = row?.id;
  // Each withdrawal starts from the default reason with no stale error: a destructive choice never carries over from another row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the row id on purpose
  useEffect(() => {
    setReason("sent_in_error");
    setError(null);
  }, [rowId]);
  if (!row) return null;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const refusal = await onWithdraw(row, reason);
    setBusy(false);
    if (refusal) setError(refusal);
    else onClose();
  };
  return (
    <Modal open onClose={busy ? undefined : onClose} ariaLabel="Withdraw request">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        style={{ display: "grid", gap: "1rem" }}
      >
        <h2 style={{ margin: 0 }}>Withdraw request</h2>
        <p style={{ margin: 0 }}>
          {DOC_LABEL[row.docKind]} will no longer be waiting for a signature. This cannot be undone;
          send a new request to ask again.
        </p>
        <SelectField
          label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value as VoidReason)}
          options={VOID_REASONS.map((r) => ({ value: r, label: VOID_REASON_LABEL[r] }))}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Keep request
          </Button>
          <Button type="submit" tone="danger" loading={busy}>
            Withdraw
          </Button>
        </div>
      </form>
    </Modal>
  );
}
