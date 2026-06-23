// apps/web/src/modules/22-documents — Document Detail (M22 §5.1 `/documents/:documentId`, Track B / ADR-0030,
// M22-T10). Spec: docs/ui/screens — "Use Detail Page". One document's metadata + active-version + tags, with a
// link to the §5.1 `DOC.VersionHistory` ledger. The active legal-hold banner (`DOC.LegalHoldBanner`) renders when
// the document's status is `legal_hold` (delete/redact are SERVER-blocked, §5.7). The binary itself is never
// inlined here — content opens through a short-TTL signed URL on demand (§4.12), which fills in with the preview
// write path. The SERVER owns the §4.7 `document_owner_or_caseload` ABAC (ADR-0030 — an out-of-scope document
// 404s). Reads GET /api/v1/documents/{id} via the typed client. Leaves only (@wardenx/ui + shared primitives).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { DetailPageLayout, EmptyState, LoadingSpinner, PageHeader, useApiClient } from "@wardenx/ui";
import { DOC_RETENTION_COLOR, DOC_STATUS_COLOR, DetailRow, StatusChip, ts } from "./documents-shared";

interface DocumentVersion {
  id: string;
  versionNumber: number;
  mimeType: string;
  byteSize: number;
  sha256Hex: string;
  uploadedByKind: string;
  uploadedAt: string;
}

interface DocumentTag {
  id: string;
  tagKind: string;
  tagKey: string;
  tagValue: string | null;
}

interface DocumentDetailView {
  id: string;
  patientId: string | null;
  admissionId: string | null;
  retentionClass: string;
  sourceKind: string;
  aggregateType: string;
  title: string;
  patientFacing: boolean;
  attachToDisclosures: boolean;
  status: string;
  activeVersion: DocumentVersion | null;
  versionsCount: number;
  tags: DocumentTag[];
  createdAt: string;
  updatedAt: string;
}

export function DocumentDetail(): JSX.Element {
  const client = useApiClient();
  const { documentId } = useParams<{ documentId: string }>();
  const [doc, setDoc] = useState<DocumentDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/documents/{id}", {
      params: { path: { id: documentId } },
    });
    if (err) {
      setError("This document is unavailable or outside your scope.");
      setLoading(false);
      return;
    }
    setDoc((data ?? null) as DocumentDetailView | null);
    setLoading(false);
  }, [client, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DetailPageLayout header={<PageHeader title="Document" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !doc ? (
        <LoadingSpinner />
      ) : (
        <div style={{ maxWidth: "44rem" }}>
          {doc.status === "legal_hold" ? (
            <div
              role="status"
              style={{
                margin: "0 0 1rem",
                padding: "0.6rem 0.9rem",
                background: "#fef3c7",
                border: "1px solid #b45309",
                borderRadius: "0.25rem",
                fontSize: "0.85rem",
                color: "#92400e",
              }}
            >
              This document is under an active legal hold. Delete and redact are disabled.
            </div>
          ) : null}
          <dl style={{ margin: 0 }}>
            <DetailRow label="Title" value={doc.title} />
            <DetailRow label="Type" value={doc.aggregateType} />
            <DetailRow label="Retention" value={<StatusChip value={doc.retentionClass} colorMap={DOC_RETENTION_COLOR} />} />
            <DetailRow label="Status" value={<StatusChip value={doc.status} colorMap={DOC_STATUS_COLOR} />} />
            <DetailRow label="Source" value={doc.sourceKind} />
            <DetailRow label="Patient" value={doc.patientId ?? "—"} />
            <DetailRow label="Admission" value={doc.admissionId ?? "—"} />
            <DetailRow label="Patient-facing" value={doc.patientFacing ? "yes" : "no"} />
            <DetailRow label="Attach to disclosures" value={doc.attachToDisclosures ? "yes" : "no"} />
            <DetailRow
              label="Active version"
              value={
                doc.activeVersion
                  ? `v${doc.activeVersion.versionNumber} · ${doc.activeVersion.mimeType} · ${doc.activeVersion.byteSize} bytes`
                  : "—"
              }
            />
            <DetailRow
              label="Versions"
              value={<Link to={`/documents/${doc.id}/versions`}>{`${doc.versionsCount} (history)`}</Link>}
            />
            <DetailRow
              label="Tags"
              value={doc.tags.length === 0 ? "—" : doc.tags.map((t) => `${t.tagKey}${t.tagValue ? `=${t.tagValue}` : ""}`).join(", ")}
            />
            <DetailRow label="Created" value={ts(doc.createdAt)} />
            <DetailRow label="Updated" value={ts(doc.updatedAt)} />
          </dl>
        </div>
      )}
    </DetailPageLayout>
  );
}
