import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  humanizeIdentifier,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — DOC.VersionHistory (M22 §5.1, Track B / ADR-0030).
// Spec: §5.1 "DOC.VersionHistory" — the per-document version chain with author/version metadata and a
// signed-URL preview per version.
//
// #91 — the version chain is where a document is ACTED on, and it offered no action: no way to add a
// version, correct a mis-typed title, or open the content each row describes. All three are here now,
// and "Open" is a §164.528 accounting event rather than a link (see `document-actions.tsx`). The
// side-by-side version diff and the inline PDF viewer are still unbuilt — both need an artifact-render
// surface this slice does not add. Built to the Lantern look: Detail Page pattern, the §6.2 Lantern
// Card, mono identifiers (§3.1), No-Line table (§6.7), warm-paper surfaces, the §6.6 status pill. The SERVER
// owns authz + legal-hold (ADR-0030); reads GET /api/v1/documents/:id (header) + GET
// /api/v1/documents/:id/versions (cursor-paginated chain) via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { DocumentEditDialog, DocumentPreviewDialog } from "./document-actions";
import { DocumentTags } from "./document-tags";
import { DocumentUploadDialog } from "./document-upload-dialog";
import type { DocumentView } from "./documents-api";
import { Card, CardTitle, Eyebrow, Mono, StatusPill, lifecycleTone, ts } from "./lantern";

interface DocumentHeader {
  id: string;
  title: string;
  retentionClass: string;
  status: string;
  version: number;
  versionsCount: number;
}
interface VersionRow {
  id: string;
  versionNumber: number;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
}

const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

export function VersionHistory(): JSX.Element {
  const client = useApiClient();
  const { documentId } = useParams<{ documentId: string }>();
  const [doc, setDoc] = useState<DocumentHeader | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState<VersionRow | null>(null);

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    const [{ data: head, error: hErr }, { data: list, error: lErr }] = await Promise.all([
      client.GET("/api/v1/documents/{id}", { params: { path: { id: documentId } } }),
      client.GET("/api/v1/documents/{id}/versions", { params: { path: { id: documentId } } }),
    ]);
    if (hErr || lErr) {
      setError("Could not load this document's version history.");
      setLoading(false);
      return;
    }
    setDoc((head ?? null) as DocumentHeader | null);
    setVersions((list?.items ?? []) as VersionRow[]);
    setLoading(false);
  }, [client, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && !doc) return <LoadingSpinner />;

  return (
    <DetailPageLayout
      header={
        <PageHeader title={doc?.title ?? "Document"} breadcrumb={<>Documents / Version history</>}>
          {doc ? (
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <Button size="sm" onClick={() => setUploading(true)}>
                Upload new version
              </Button>
              <Button size="sm" tone="tertiary" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            </div>
          ) : null}
        </PageHeader>
      }
      aside={
        doc ? (
          <aside style={{ width: "20rem", flexShrink: 0, padding: "1.5rem" }}>
            <Card>
              <Eyebrow>Current version</Eyebrow>
              <div
                style={{
                  fontSize: "2rem",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1.1,
                }}
              >
                v{doc.version}
              </div>
              <div
                style={{
                  marginTop: "0.75rem",
                  display: "grid",
                  gap: "0.5rem",
                  fontSize: "0.85rem",
                }}
              >
                <div>
                  <Eyebrow>Status</Eyebrow>
                  <StatusPill tone={lifecycleTone(doc.status)}>
                    {humanizeIdentifier(doc.status)}
                  </StatusPill>
                </div>
                <div>
                  <Eyebrow>Retention</Eyebrow>
                  {humanizeIdentifier(doc.retentionClass)}
                </div>
                <div>
                  <Eyebrow>Versions</Eyebrow>
                  {doc.versionsCount}
                </div>
              </div>
              {/* #91's M22 row deferred tag editing as UNBUILDABLE (#153); the reader it needed
                  exists now, so the editor lives beside the metadata it annotates. */}
              <div style={{ marginTop: "1rem" }}>
                <DocumentTags documentId={doc.id} />
              </div>
            </Card>
          </aside>
        ) : undefined
      }
    >
      <Card>
        <CardTitle>Version history</CardTitle>
        {versions.length === 0 ? (
          <EmptyState
            title="No versions"
            description="This document has no recorded versions yet."
          />
        ) : (
          <table className="tabular-nums">
            <thead>
              <tr>
                <th>Version</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Id</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>v{v.versionNumber}</td>
                  <td>{v.mimeType}</td>
                  <td>{kb(v.byteSize)}</td>
                  <td>{ts(v.uploadedAt)}</td>
                  <td>
                    <Mono>{v.id.slice(0, 8)}</Mono>
                  </td>
                  <td>
                    <Button size="sm" tone="tertiary" onClick={() => setPreviewing(v)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {doc !== null ? (
        <DocumentEditDialog
          open={editing}
          document={doc as unknown as DocumentView}
          onClose={() => setEditing(false)}
          onDone={() => {
            void load();
          }}
        />
      ) : null}
      {documentId ? (
        <DocumentUploadDialog
          open={uploading}
          targetDocumentId={documentId}
          onClose={() => setUploading(false)}
          onDone={() => {
            void load();
          }}
        />
      ) : null}
      {previewing !== null && documentId ? (
        <DocumentPreviewDialog
          open
          documentId={documentId}
          versionId={previewing.id}
          versionNumber={previewing.versionNumber}
          onClose={() => setPreviewing(null)}
        />
      ) : null}
    </DetailPageLayout>
  );
}
