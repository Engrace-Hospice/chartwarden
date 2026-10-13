import { SelectField, StatusPill, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Document library (`/p/:patientId/documents`). Outbound: the documents shared TO the
// caregiver (GET /portal/documents via M22 PortalDocumentReader); download mints a short-lived watermarked
// URL (GET .../download-url). Inbound: the M31-T06 upload path — init (signed URL + 50 MB / MIME allowlist
// enforced server-side) → PUT the bytes → complete, which hands the file to the M22 intake + virus-scan
// pipeline. M31 never stores the blob; it brokers the signed URL and records the intent.
import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent, JSX } from "react";
import { day, humanize, readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface PortalDoc {
  documentId: string;
  title?: string;
  documentType?: string;
  sharedAt?: string;
}
type UploadPurpose =
  | "insurance_card"
  | "prior_records"
  | "wound_photo"
  | "advance_directive_copy"
  | "other";

const PURPOSE_OPTIONS = [
  { value: "insurance_card", label: "Insurance card" },
  { value: "prior_records", label: "Prior records" },
  { value: "wound_photo", label: "Wound photo" },
  { value: "advance_directive_copy", label: "Advance directive" },
  { value: "other", label: "Other" },
] as const;

export function PortalDocumentList(): JSX.Element {
  const client = useApiClient();
  const [docs, setDocs] = useState<PortalDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<UploadPurpose>("prior_records");
  const [uploadMsg, setUploadMsg] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/portal/documents", {});
    if (res.error) setError(readError(res.response?.status));
    else setDocs((res.data?.items ?? []) as unknown as PortalDoc[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function download(documentId: string): Promise<void> {
    const res = await client.GET("/api/v1/portal/documents/{documentId}/download-url", {
      params: { path: { documentId } },
    });
    const url = res.data?.url;
    if (url) window.open(url, "_blank", "noopener");
  }

  async function upload(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadMsg(null);
    setBusy(true);
    try {
      const init = await client.POST("/api/v1/portal/documents/upload-init", {
        body: {
          purpose,
          mimeType: file.type || "application/octet-stream",
          expectedByteSize: file.size,
        },
      });
      if (init.error || !init.data) {
        setUploadMsg({ tone: "err", msg: readError(init.response?.status) });
        return;
      }
      const { uploadId } = init.data as { uploadId: string };
      // The bytes go to the M31 content route under the caregiver's session, through the typed client so the
      // CSRF header and correlation id ride along (a raw `fetch` carries neither). Sealed server-side on arrival.
      const put = await client.PUT("/api/v1/portal/documents/uploads/{uploadId}/content", {
        params: { path: { uploadId } },
        body: file as never,
        bodySerializer: (body: unknown) => body as BodyInit,
        headers: { "content-type": file.type || "application/octet-stream" },
      } as never);
      if (put.error) {
        setUploadMsg({
          tone: "err",
          msg: "Upload failed while sending the file. Please try again.",
        });
        return;
      }
      const done = await client.POST("/api/v1/portal/documents/upload-complete/{uploadId}", {
        params: { path: { uploadId } },
      });
      if (done.error) {
        setUploadMsg({ tone: "err", msg: readError(done.response?.status) });
        return;
      }
      setUploadMsg({ tone: "ok", msg: "Uploaded. Your team will review it shortly." });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalPage title="Documents" subtitle="Files your team has shared, and documents you send in.">
      <PortalCard heading="Send a document">
        <div className="wx-portal-upload-controls">
          <SelectField
            label="Document type"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as UploadPurpose)}
            options={PURPOSE_OPTIONS}
          />
          <label className="wx-portal-file-button" aria-disabled={busy || undefined}>
            {busy ? "Uploading…" : "Choose a file…"}
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.tif,.tiff"
              hidden
              disabled={busy}
              onChange={(e) => void upload(e)}
            />
          </label>
        </div>
        <p className="wx-portal-supporting-copy">
          PDF, JPEG, PNG, HEIC or TIFF up to 50 MB. Files are scanned before your team can open
          them.
        </p>
        {uploadMsg ? (
          <p
            role={uploadMsg.tone === "err" ? "alert" : "status"}
            className={`wx-portal-feedback wx-portal-feedback--${uploadMsg.tone}`}
          >
            {uploadMsg.msg}
          </p>
        ) : null}
      </PortalCard>

      <PortalLoadState
        loading={loading}
        error={error}
        empty={docs.length === 0}
        emptyTitle="No documents shared yet"
        emptyDescription="Documents your team shares with you will appear here."
        onRetry={() => void load()}
      >
        <PortalCard heading="Shared with you">
          <table className="wx-portal-data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Shared</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.documentId}>
                  <td data-label="Document">{d.title ?? "Document"}</td>
                  <td data-label="Type">
                    {d.documentType ? (
                      <StatusPill tone="neutral" label={humanize(d.documentType)} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="Shared">{day(d.sharedAt)}</td>
                  <td className="wx-portal-data-table__action" data-label="Action">
                    <button
                      type="button"
                      className="wx-portal-link-button"
                      onClick={() => void download(d.documentId)}
                    >
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}
