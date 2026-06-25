import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/10-hope — HOPE submission worklist (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Work Queue."
// Submission batches per ProviderEntity, per-period: status, item/accepted/rejected counts, transmit time.
// A row drills into the submission detail (per-item outcomes + retry). Reads GET /api/v1/hope/submissions
// via the typed client; the server enforces every scope incl. PE scope (ADR-0030 — no authz on the
// frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { SUBMISSION_TONE, stateLabel } from "./hope-status";

interface SubmissionRow {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: string | null;
}

export function SubmissionWorklist(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/hope/submissions", {
        params: { query: {} },
      });
      if (!active) return;
      if (err) {
        setError("Could not load HOPE submissions.");
        setLoading(false);
        return;
      }
      setItems((data?.submissions ?? []) as SubmissionRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="HOPE Submissions" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No submissions"
            description="No HOPE submission batches have been assembled."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th>Items</th>
                <th>Accepted</th>
                <th>Rejected</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr
                  key={s.id}
                  // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/hope/submissions/${s.id}`)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      navigate(`/hope/submissions/${s.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td>{s.submissionPeriod}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(s.status)}
                      tone={SUBMISSION_TONE[s.status] ?? "neutral"}
                    />
                  </td>
                  <td className="tabular-nums">{s.itemCount}</td>
                  <td className="tabular-nums">{s.acceptedCount}</td>
                  <td
                    className="tabular-nums"
                    style={{ color: s.rejectedCount > 0 ? "var(--color-error)" : undefined }}
                  >
                    {s.rejectedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
