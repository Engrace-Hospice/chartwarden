import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Document library (`/p/:patientId/documents`). Outbound: the documents shared TO the
// caregiver (GET /portal/documents via M22 PortalDocumentReader); download mints a short-lived watermarked
// URL (GET .../download-url). Inbound: the M31-T06 upload path — init (signed URL + 50 MB / MIME allowlist
// enforced server-side) → PUT the bytes → complete, which hands the file to the M22 intake + virus-scan
// pipeline. M31 never stores the blob; it brokers the signed URL and records the intent.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ChangeEvent, JSX } from "react";
import { day, humanize, readError } from "./portal-format";
import {
  PortalCard,
  PortalLoadState,
  PortalPage,
  tableCell,
  tableHead,
  tableRow,
} from "./portal-page";

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

const control: CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderRadius: "0.45rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.9rem",
};
const linkBtn: CSSProperties = {
  color: t.primary,
  background: "none",
  border: "none",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.85rem",
};

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
      const { uploadId, signedUploadUrl } = init.data as {
        uploadId: string;
        signedUploadUrl: string;
      };
      const put = await fetch(signedUploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream" },
      });
      if (!put.ok) {
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
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as UploadPurpose)}
            style={control}
            aria-label="Document purpose"
          >
            <option value="insurance_card">Insurance card</option>
            <option value="prior_records">Prior records</option>
            <option value="wound_photo">Wound photo</option>
            <option value="advance_directive_copy">Advance directive</option>
            <option value="other">Other</option>
          </select>
          <label style={{ ...linkBtn, opacity: busy ? 0.5 : 1 }}>
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
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.78rem", color: t.onSurfaceVariant }}>
          PDF, JPEG, PNG, HEIC or TIFF up to 50 MB. Files are scanned before your team can open
          them.
        </p>
        {uploadMsg ? (
          <p
            role={uploadMsg.tone === "err" ? "alert" : "status"}
            style={{
              margin: "0.6rem 0 0",
              fontSize: "0.85rem",
              color: uploadMsg.tone === "err" ? t.error : t.success,
            }}
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
      >
        <PortalCard heading="Shared with you">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={tableHead}>Document</th>
                <th style={tableHead}>Type</th>
                <th style={tableHead}>Shared</th>
                <th style={tableHead} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.documentId} style={tableRow}>
                  <td style={tableCell}>{d.title ?? "Document"}</td>
                  <td style={tableCell}>
                    {d.documentType ? (
                      <StatusPill tone="neutral" label={humanize(d.documentType)} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={tableCell}>{day(d.sharedAt)}</td>
                  <td style={{ ...tableCell, textAlign: "right" }}>
                    <button
                      type="button"
                      style={linkBtn}
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
