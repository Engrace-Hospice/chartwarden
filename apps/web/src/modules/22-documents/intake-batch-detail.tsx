import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — INTAKE.BatchDetail (M22 §5.1, Track B / ADR-0030).
// Spec: §5.1 "INTAKE.BatchDetail" — the per-batch DocLens view: batch metadata + per-page extraction-job
// pipeline status. The original-thumbnails strip, the DocLens side-by-side review (§5.1 INTAKE.ReviewSideBySide),
// and the fax splitter are reviewer write surfaces that fill in as those paths harden (and the DocLens
// classifier/extractor are M32-gated — behind the `documents.doclens` flag the jobs queue with
// `awaiting_capability`, which renders as an in-progress pill, never a hard error). Built to the Lantern look:
// Detail Page pattern, §6.2 Lantern Card, §6.6 status pills (per-job pipeline state), §3.1 mono identifiers,
// No-Line tables. The SERVER owns authz (ADR-0030); reads GET /api/v1/intake/uploads/:id + .../jobs via the
// typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { Card, CardTitle, Eyebrow, Mono, StatusPill, lifecycleTone, ts } from "./lantern";

interface BatchHeader {
  id: string;
  patientId: string | null;
  status: string;
  uploadedAt: string;
  pages: number;
}
interface JobRow {
  id: string;
  status: string;
  createdAt: string;
}

export function IntakeBatchDetail(): JSX.Element {
  const client = useApiClient();
  const { batchId } = useParams<{ batchId: string }>();
  const [batch, setBatch] = useState<BatchHeader | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!batchId) return;
    setLoading(true);
    setError(null);
    const [{ data: head, error: hErr }, { data: list, error: lErr }] = await Promise.all([
      client.GET("/api/v1/intake/uploads/{id}", { params: { path: { id: batchId } } }),
      client.GET("/api/v1/intake/uploads/{id}/jobs", { params: { path: { id: batchId } } }),
    ]);
    if (hErr || lErr) {
      setError("Could not load this intake batch.");
      setLoading(false);
      return;
    }
    setBatch((head ?? null) as BatchHeader | null);
    setJobs((list?.items ?? []) as JobRow[]);
    setLoading(false);
  }, [client, batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = useMemo(
    () => jobs.filter((j) => /complete|writeback/.test(j.status.toLowerCase())).length,
    [jobs],
  );

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && !batch) return <LoadingSpinner />;

  return (
    <DetailPageLayout
      header={<PageHeader title="Intake batch" breadcrumb={<>Intake / Batch detail</>} />}
      aside={
        batch ? (
          <aside style={{ width: "20rem", flexShrink: 0, padding: "1.5rem" }}>
            <Card>
              <Eyebrow>Pages</Eyebrow>
              <div
                style={{
                  fontSize: "2rem",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1.1,
                }}
              >
                {batch.pages}
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
                  <StatusPill tone={lifecycleTone(batch.status)}>{batch.status}</StatusPill>
                </div>
                <div>
                  <Eyebrow>Patient</Eyebrow>
                  {batch.patientId ? <Mono>{batch.patientId.slice(0, 8)}</Mono> : "Unassigned"}
                </div>
                <div>
                  <Eyebrow>Uploaded</Eyebrow>
                  {ts(batch.uploadedAt)}
                </div>
                <div>
                  <Eyebrow>Jobs complete</Eyebrow>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {done} / {jobs.length}
                  </span>
                </div>
              </div>
            </Card>
          </aside>
        ) : undefined
      }
    >
      <Card>
        <CardTitle>Extraction jobs</CardTitle>
        {jobs.length === 0 ? (
          <EmptyState
            title="No extraction jobs"
            description="No extraction jobs for this batch yet. DocLens extraction runs once classification is confirmed."
          />
        ) : (
          <table className="tabular-nums">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <Mono>{j.id.slice(0, 8)}</Mono>
                  </td>
                  <td>
                    <StatusPill tone={lifecycleTone(j.status)}>{j.status}</StatusPill>
                  </td>
                  <td>{ts(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </DetailPageLayout>
  );
}
