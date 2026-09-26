import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/10-hope — HOPE submission detail (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Documentation Workspace."
// Per-batch outcomes: status, item/accepted/rejected counts, transmit/accept timestamps. The §4.10 iQIES
// submission lifecycle is read-only here; the inline Correct/Retry write actions fill in as their write
// surfaces harden. Reads GET /api/v1/hope/submissions/:id via the typed client; the server enforces every
// scope incl. PE scope (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { SUBMISSION_TONE, stateLabel } from "./hope-status";

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
}

export function SubmissionDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const reload = async (): Promise<void> => {
    if (!id) return;
    const { data, error: err } = await client.GET("/api/v1/hope/submissions/{id}", {
      params: { path: { id } },
    });
    if (err) setError("Could not refresh the HOPE submission.");
    else setRow(data as SubmissionDetail);
  };

  const downloadPackage = async (): Promise<void> => {
    if (!id) return;
    window.location.href = `/api/v1/hope/submissions/${id}/package`;
    await reload();
  };

  const markUploaded = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    const api = client as unknown as {
      POST: (path: string, init: unknown) => Promise<{ error?: unknown }>;
    };
    const { error: err } = await api.POST("/api/v1/hope/submissions/{id}/mark-uploaded", {
      params: { path: { id } },
      body: { submittedAt: new Date().toISOString() },
    });
    setBusy(false);
    if (err) setError("Could not mark this package uploaded.");
    else await reload();
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
                {row.packageFilename ? (
                  <button type="button" style={button} onClick={() => void downloadPackage()}>
                    Download ZIP
                  </button>
                ) : null}
                {row.status === "packaged" || row.status === "exported" ? (
                  <button
                    type="button"
                    style={button}
                    onClick={() => void markUploaded()}
                    disabled={busy}
                  >
                    Mark uploaded
                  </button>
                ) : null}
              </div>
            ) : undefined
          }
        >
          {row ? <span style={meta}>{row.submissionPeriod}</span> : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
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
        </dl>
      )}
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
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
