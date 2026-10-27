import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  useApiClient,
  useOptionalToast,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — HOPE submission detail (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Documentation Workspace."
// Per-batch outcomes: status, item/accepted/rejected counts, transmit/accept timestamps. The §4.10 iQIES
// submission lifecycle is read-only here; the inline Correct/Retry write actions fill in as their write
// surfaces harden. Reads GET /api/v1/hope/submissions/:id via the typed client; the server enforces every
// scope incl. PE scope (ADR-0030 — no authz on the frontend). Leaves only (@chartwarden/ui).
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { NameLabel, patientNameOf } from "../../shell/name-display";
import { usePatientNames } from "../../shell/patient-names";
import { useSession } from "../../shell/session";
import { SUBMISSION_TONE, rfaLabel, stateLabel } from "./hope-status";
import { RecordCmsResultModal } from "./record-cms-result-modal";

const MANAGE_PERMISSION = "hope.submission.manage";
/** Statuses where the CMS result may still be recorded (the server enforces the same set). */
const RESULT_RECORDABLE = new Set(["exported", "in_flight", "submitted_pending_result"]);
/** A CMS verdict on an item is final (the server ignores later rows for it), so the dialog never asks for one. */
const SETTLED_ITEM_STATUS = new Set(["accepted", "accepted_with_warnings", "rejected"]);

const ITEM_TONE: Record<string, StatusTone> = {
  accepted: "success",
  accepted_with_warnings: "warning",
  rejected: "error",
  pending: "progress",
  blocked: "error",
  unmatched: "warning",
};
const RESOLUTION_TONE: Record<string, StatusTone> = {
  needs_correction: "error",
  correction_in_progress: "progress",
  resubmitted: "progress",
  resolved: "success",
};

interface ItemRow {
  id: string;
  assessmentId: string;
  patientId: string | null;
  rfaKind: string | null;
  assessmentStatus: string | null;
  status: string;
  iqiesRecordId: string | null;
  processedAt: string | null;
  resolution: string | null;
  correctionAssessmentId: string | null;
}
interface FindingRow {
  id: string;
  assessmentId: string | null;
  severity: "error" | "warning";
  code: string | null;
  itemCode: string | null;
  message: string | null;
}

interface SubmissionDetail {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  transportMode?: string;
  validationProfile?: string | null;
  packageFilename?: string | null;
  packageSha256?: string | null;
  packageSizeBytes?: number | null;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: string | null;
  exportedAt?: string | null;
  submittedAt?: string | null;
  acceptedAt: string | null;
  iqiesSubmissionReference?: string | null;
  resultImportedAt?: string | null;
  resultReportReference?: string | null;
  items?: ItemRow[];
  findings?: FindingRow[];
}

export function SubmissionDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Action failures (download / mark uploaded / refresh) are shown inline: they must not replace the loaded page.
  const [actionError, setActionError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // Marking uploaded is irreversible: the first click only asks, the second one writes.
  const [confirmingUpload, setConfirmingUpload] = useState(false);
  const confirmUploadRef = useRef<HTMLSpanElement>(null);
  const markUploadedRef = useRef<HTMLButtonElement>(null);
  const hadUploadConfirm = useRef(false);
  // Focus follows the step: Confirm on entry, "Mark uploaded" when the step is cancelled or dismissed.
  useEffect(() => {
    if (confirmingUpload) confirmUploadRef.current?.querySelector("button")?.focus();
    else if (hadUploadConfirm.current) markUploadedRef.current?.focus();
    hadUploadConfirm.current = confirmingUpload;
  }, [confirmingUpload]);
  const toast = useOptionalToast();
  const canManage = useSession()?.permissions?.includes(MANAGE_PERMISSION) ?? false;
  const items = row?.items ?? [];
  const findings = useMemo(
    () =>
      [...(row?.findings ?? [])].sort(
        (a, b) => Number(b.severity === "error") - Number(a.severity === "error"),
      ),
    [row?.findings],
  );
  const patientNames = usePatientNames(
    items.map((i) => i.patientId).filter((p): p is string => !!p),
  );
  const itemByAssessment = new Map(items.map((i) => [i.assessmentId, i]));
  const itemLabel = (i: ItemRow): string =>
    `${i.patientId ? (patientNames[i.patientId]?.name ?? "Patient") : "Patient"} — ${
      i.rfaKind ? rfaLabel(i.rfaKind) : "Assessment"
    }`;
  // Labels repeat (same patient + RFA): the 1-based row number keeps link names unique.
  const rowNumber = new Map(items.map((i, idx) => [i.assessmentId, idx + 1]));
  const itemAria = (i: ItemRow): string => `${itemLabel(i)}, row ${rowNumber.get(i.assessmentId)}`;

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      setRow(null);
      try {
        const { data, error: err } = await client.GET("/api/v1/hope/submissions/{id}", {
          params: { path: { id } },
        });
        if (!active) return;
        if (err) setError("Could not load the HOPE submission.");
        else setRow(data as SubmissionDetail);
      } catch {
        if (active) setError("Could not load the HOPE submission.");
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  const reload = async (): Promise<void> => {
    if (!id) return;
    try {
      const { data, error: err } = await client.GET("/api/v1/hope/submissions/{id}", {
        params: { path: { id } },
      });
      if (err) setActionError("Could not refresh the HOPE submission.");
      else setRow(data as SubmissionDetail);
    } catch {
      setActionError("Could not refresh the HOPE submission.");
    }
  };

  const downloadPackage = async (): Promise<void> => {
    if (!id || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      // fetch (not a navigation) so a 403/404/409 stays on this page instead of replacing the SPA with raw JSON.
      const res = await fetch(`/api/v1/hope/submissions/${encodeURIComponent(id)}/package`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = row?.packageFilename ?? `${id}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await reload(); // the download advances a packaged batch to exported
    } catch {
      setActionError("Could not download the package.");
    } finally {
      setBusy(false);
    }
  };

  const markUploaded = async (): Promise<void> => {
    if (!id || busy) return;
    setConfirmingUpload(false);
    setBusy(true);
    setActionError(null);
    try {
      const api = client as unknown as {
        POST: (path: string, init: unknown) => Promise<{ error?: unknown }>;
      };
      const { error: err } = await api.POST("/api/v1/hope/submissions/{id}/mark-uploaded", {
        params: { path: { id } },
        body: { submittedAt: new Date().toISOString() },
      });
      if (err) setActionError("Could not mark this package uploaded.");
      else await reload();
    } catch {
      setActionError("Could not mark this package uploaded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="HOPE Submission"
          actions={
            row ? (
              <div style={actions}>
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={SUBMISSION_TONE[row.status] ?? "neutral"}
                />
                {canManage && row.packageFilename ? (
                  <button
                    type="button"
                    style={button}
                    onClick={() => void downloadPackage()}
                    disabled={busy}
                  >
                    Download ZIP
                  </button>
                ) : null}
                {canManage && RESULT_RECORDABLE.has(row.status) ? (
                  <button
                    type="button"
                    style={button}
                    onClick={() => setRecording(true)}
                    disabled={busy}
                  >
                    Record CMS result
                  </button>
                ) : null}
                {canManage && (row.status === "packaged" || row.status === "exported") ? (
                  confirmingUpload ? (
                    <span
                      ref={confirmUploadRef}
                      style={{ display: "contents" }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && !busy) setConfirmingUpload(false);
                      }}
                    >
                      <Button tone="primary" onClick={() => void markUploaded()} disabled={busy}>
                        Confirm: mark uploaded to CMS
                      </Button>
                      <Button
                        tone="tertiary"
                        onClick={() => setConfirmingUpload(false)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <button
                      ref={markUploadedRef}
                      type="button"
                      style={button}
                      onClick={() => setConfirmingUpload(true)}
                      disabled={busy}
                    >
                      Mark uploaded
                    </button>
                  )
                ) : null}
              </div>
            ) : undefined
          }
        >
          <nav aria-label="Breadcrumb" style={meta}>
            <Link to="/hope/submissions">HOPE submissions</Link>
            {row ? ` / ${row.submissionPeriod}` : ""}
          </nav>
        </PageHeader>
      }
    >
      {actionError ? (
        <p role="alert" style={{ margin: "0 0 0.75rem", color: "var(--color-error)" }}>
          {actionError}
        </p>
      ) : null}
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "10rem 1fr",
              gap: "0.4rem 1rem",
              fontSize: "0.85rem",
            }}
          >
            <dt style={dt}>Provider entity</dt>
            <dd style={dd} className="wx-data-md">
              {row.providerEntityId}
            </dd>
            <dt style={dt}>Period</dt>
            <dd style={dd}>{row.submissionPeriod}</dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>
              <StatusPill
                label={stateLabel(row.status)}
                tone={SUBMISSION_TONE[row.status] ?? "neutral"}
              />
            </dd>
            <dt style={dt}>Items</dt>
            <dd style={dd} className="tabular-nums">
              {row.itemCount}
            </dd>
            <dt style={dt}>Accepted</dt>
            <dd style={dd} className="tabular-nums">
              {row.acceptedCount}
            </dd>
            <dt style={dt}>Rejected</dt>
            <dd
              style={{ ...dd, color: row.rejectedCount > 0 ? "var(--color-error)" : undefined }}
              className="tabular-nums"
            >
              {row.rejectedCount}
            </dd>
            <dt style={dt}>Transmitted</dt>
            <dd style={dd} className="tabular-nums">
              {row.transmittedAt ? row.transmittedAt.slice(0, 16).replace("T", " ") : "—"}
            </dd>
            <dt style={dt}>Transport</dt>
            <dd style={dd}>{row.transportMode ?? "manual_iqies_upload"}</dd>
            <dt style={dt}>Validation profile</dt>
            <dd style={dd}>{row.validationProfile ?? "Not recorded"}</dd>
            <dt style={dt}>Package</dt>
            <dd style={dd}>{row.packageFilename ?? "Not packaged"}</dd>
            <dt style={dt}>Package hash</dt>
            <dd style={dd} className="wx-data-md">
              {row.packageSha256 ?? "Not recorded"}
            </dd>
            <dt style={dt}>Manual upload</dt>
            <dd style={dd}>
              {row.submittedAt
                ? row.submittedAt.slice(0, 16).replace("T", " ")
                : "Awaiting iQIES upload"}
            </dd>
            <dt style={dt}>Accepted at</dt>
            <dd style={dd} className="tabular-nums">
              {row.acceptedAt ? row.acceptedAt.slice(0, 16).replace("T", " ") : "—"}
            </dd>
            <dt style={dt}>CMS result recorded</dt>
            <dd style={dd} className="tabular-nums">
              {row.resultImportedAt
                ? row.resultImportedAt.slice(0, 16).replace("T", " ")
                : "Awaiting CMS result"}
            </dd>
            <dt style={dt}>Report reference</dt>
            <dd style={dd}>{row.resultReportReference ?? "—"}</dd>
          </dl>
          <h2 style={h2}>Records in this batch</h2>
          {items.length === 0 ? (
            <p style={meta}>No records in this batch.</p>
          ) : (
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Timepoint</th>
                    <th scope="col">Assessment</th>
                    <th scope="col">CMS outcome</th>
                    <th scope="col">Resolution</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.patientId ? (
                          <Link to={`/patients/${i.patientId}/hope`}>
                            <NameLabel value={patientNameOf(patientNames, i.patientId)} />
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{i.rfaKind ? rfaLabel(i.rfaKind) : "—"}</td>
                      <td>
                        <Link
                          to={`/hope/assessments/${i.assessmentId}`}
                          aria-label={`View assessment, ${itemAria(i)}`}
                        >
                          View assessment
                        </Link>
                      </td>
                      <td>
                        <StatusPill
                          label={stateLabel(i.status)}
                          tone={ITEM_TONE[i.status] ?? "neutral"}
                        />
                      </td>
                      <td>
                        {i.resolution ? (
                          <StatusPill
                            label={stateLabel(i.resolution)}
                            tone={RESOLUTION_TONE[i.resolution] ?? "neutral"}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {i.correctionAssessmentId ? (
                          <Link
                            to={`/hope/assessments/${i.correctionAssessmentId}`}
                            aria-label={`Open correction, ${itemAria(i)}`}
                          >
                            Open correction
                          </Link>
                        ) : i.resolution === "needs_correction" ? (
                          <Link
                            to={`/hope/assessments/${i.assessmentId}`}
                            aria-label={`Correct this assessment, ${itemAria(i)}`}
                          >
                            Correct this assessment
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 style={h2}>Findings</h2>
          {findings.length === 0 ? (
            <p style={meta}>
              {row.resultImportedAt ? "No findings recorded." : "Awaiting CMS result."}
            </p>
          ) : (
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Record</th>
                    <th scope="col">Code</th>
                    <th scope="col">Item</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f) => {
                    const item = f.assessmentId ? itemByAssessment.get(f.assessmentId) : undefined;
                    return (
                      <tr key={f.id}>
                        <td>
                          <StatusPill
                            label={stateLabel(f.severity)}
                            tone={f.severity === "error" ? "error" : "warning"}
                          />
                        </td>
                        <td>
                          {f.assessmentId ? (
                            <Link
                              to={`/hope/assessments/${f.assessmentId}`}
                              aria-label={
                                item
                                  ? `View assessment, ${itemAria(item)}`
                                  : `View assessment ${f.assessmentId.slice(0, 8)}`
                              }
                            >
                              {item ? itemLabel(item) : "View assessment"}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{f.code ?? "—"}</td>
                        <td>{f.itemCode ?? "—"}</td>
                        <td>{f.message ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {row ? (
        <RecordCmsResultModal
          open={recording}
          submissionId={row.id}
          items={items
            .filter((i) => !SETTLED_ITEM_STATUS.has(i.status))
            .map((i) => ({ assessmentId: i.assessmentId, label: itemLabel(i) }))}
          onClose={() => setRecording(false)}
          onConflict={() => void reload()}
          onDone={() => {
            toast?.show("CMS result recorded.", { tone: "success" });
            void reload();
          }}
        />
      ) : null}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const actions = { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" } as const;
const button = {
  border: "1px solid var(--color-outline)",
  borderRadius: 8,
  padding: "0.45rem 0.7rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontWeight: 650,
  cursor: "pointer",
} as const;
const h2 = { fontSize: "1rem", fontWeight: 600, margin: "1.5rem 0 0.5rem" } as const;
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
