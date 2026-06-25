import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — IV continuous session (M13 §4.1/§6.1 #5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail". The IPU-specific surface
// (limited Phase-1 utility; primary value lands at M37). Shows the session's ordered row sequence
// (start → rate_change → pause/resume → stop) as a read-only timeline. The Titrate / Pause / Resume / Stop
// write CTAs (with the order's rate-bound validation and the controlled-substance wastage entry) fill in as
// their write surfaces harden; the SERVER owns the IV_SESSION_GRAPH ordering and the rate bounds (ADR-0030).
// Reads GET /api/v1/administrations/iv-sessions/:sessionId via the typed client. Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { stateLabel } from "./emar-status";

interface IvSessionView {
  sessionId: string;
  medicationOrderId: string;
  segments: { kind: string; recordedAt: string }[];
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function IvSession(): JSX.Element {
  const client = useApiClient();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [row, setRow] = useState<IvSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!sessionId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET(
        "/api/v1/administrations/iv-sessions/{sessionId}",
        {
          params: { path: { sessionId } },
        },
      );
      if (!active) return;
      if (err) {
        setError("Could not load the IV session.");
        setLoading(false);
        return;
      }
      setRow(data as IvSessionView);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, sessionId]);

  return (
    <DetailPageLayout
      header={
        <PageHeader title="IV Continuous Session">
          {row ? (
            <span style={meta}>
              order <span className="wx-data-md">{row.medicationOrderId.slice(0, 8)}</span>
            </span>
          ) : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : row.segments.length === 0 ? (
        <EmptyState title="No segments" description="This session has no recorded segments." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Segment</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {row.segments.map((s, i) => (
              <tr key={`${s.kind}-${s.recordedAt}`}>
                <td className="tabular-nums">{i + 1}</td>
                <td>{stateLabel(s.kind)}</td>
                <td className="tabular-nums">{ts(s.recordedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
