// apps/web/src/modules/10-hope — HOPE submission detail (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Documentation Workspace."
// Per-batch outcomes: status, item/accepted/rejected counts, transmit/accept timestamps. The §4.10 iQIES
// submission lifecycle is read-only here; the inline Correct/Retry write actions fill in as their write
// surfaces harden. Reads GET /api/v1/hope/submissions/:id via the typed client; the server enforces every
// scope incl. PE scope (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface SubmissionDetail {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: string | null;
  acceptedAt: string | null;
}

export function SubmissionDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/hope/submissions/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the HOPE submission.");
        setLoading(false);
        return;
      }
      setRow(data as SubmissionDetail);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  return (
    <DetailPageLayout
      header={
        <PageHeader title="HOPE Submission">
          {row ? <span style={meta}>{row.submissionPeriod} · {row.status}</span> : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl style={{ display: "grid", gridTemplateColumns: "10rem 1fr", gap: "0.4rem 1rem", fontSize: "0.85rem" }}>
          <dt style={dt}>Provider entity</dt>
          <dd style={dd}>{row.providerEntityId}</dd>
          <dt style={dt}>Period</dt>
          <dd style={dd}>{row.submissionPeriod}</dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>{row.status}</dd>
          <dt style={dt}>Items</dt>
          <dd style={dd}>{row.itemCount}</dd>
          <dt style={dt}>Accepted</dt>
          <dd style={dd}>{row.acceptedCount}</dd>
          <dt style={dt}>Rejected</dt>
          <dd style={{ ...dd, color: row.rejectedCount > 0 ? "#b91c1c" : undefined }}>
            {row.rejectedCount}
          </dd>
          <dt style={dt}>Transmitted</dt>
          <dd style={dd}>{row.transmittedAt ? row.transmittedAt.slice(0, 16).replace("T", " ") : "—"}</dd>
          <dt style={dt}>Accepted at</dt>
          <dd style={dd}>{row.acceptedAt ? row.acceptedAt.slice(0, 16).replace("T", " ") : "—"}</dd>
        </dl>
      )}
    </DetailPageLayout>
  );
}

const meta = { fontSize: "0.75rem", color: "#6b7280", margin: "0.25rem 0" } as const;
const dt = { fontWeight: 600, color: "#374151" } as const;
const dd = { margin: 0 } as const;
