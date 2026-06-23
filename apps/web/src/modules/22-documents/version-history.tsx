// apps/web/src/modules/22-documents — Document Version History (M22 §5.1 `DOC.VersionHistory`
// `/documents/:documentId/versions`, Track B / ADR-0030, M22-T10). Spec: docs/ui/screens — "Use Work Queue".
// The append-only version ledger for one document — author kind, size, and SHA-256 per version (the §2.2.2 ledger
// is immutable; a new version supersedes, never edits). The side-by-side render diff + per-version signed-URL
// preview fill in with the preview write path (§4.12). The SERVER gates the full history behind
// `documents.read_history` + the `document_owner_or_caseload` ABAC (ADR-0030 — an out-of-scope document 404s).
// Reads GET /api/v1/documents/{id}/versions via the typed client. Leaves only (@wardenx/ui + shared primitives).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, WorkQueueLayout, useApiClient } from "@wardenx/ui";
import { DataTable, ts } from "./documents-shared";

interface VersionRow {
  id: string;
  versionNumber: number;
  mimeType: string;
  byteSize: number;
  sha256Hex: string;
  uploadedByKind: string;
  uploadedAt: string;
}

export function DocumentVersionHistory(): JSX.Element {
  const client = useApiClient();
  const { documentId } = useParams<{ documentId: string }>();
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/documents/{id}/versions", {
      params: { path: { id: documentId } },
    });
    if (err) {
      setError("Version history is unavailable or outside your scope.");
      setLoading(false);
      return;
    }
    setVersions(((data ?? []) as VersionRow[]) ?? []);
    setLoading(false);
  }, [client, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Version History" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : versions.length === 0 ? (
          <EmptyState title="No versions" description="This document has no version history visible to you." />
        ) : (
          <DataTable<VersionRow>
            rows={versions}
            rowKey={(v) => v.id}
            columns={[
              { header: "Version", cell: (v) => `v${v.versionNumber}` },
              { header: "MIME", cell: (v) => v.mimeType },
              { header: "Size", cell: (v) => `${v.byteSize} bytes` },
              { header: "Author", cell: (v) => v.uploadedByKind },
              { header: "SHA-256", cell: (v) => v.sha256Hex.slice(0, 12) },
              { header: "Uploaded", cell: (v) => ts(v.uploadedAt) },
            ]}
          />
        )
      }
    />
  );
}
