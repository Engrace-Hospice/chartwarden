import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — IV continuous session (M13 §6.1 #5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail". The IPU-specific surface
// (limited Phase-1 utility; primary value lands at M37). Shows the session's ordered row sequence
// (start → rate_change → pause/resume → stop) as a read-only timeline. Reads
// GET /api/v1/administrations/iv-sessions/:sessionId via the typed client. Leaves only (@wardenx/ui).
//
// F-031 — the Titrate / Pause / Resume / Stop CTAs are DELIBERATELY still absent, and this is the one M13
// surface where that is the honest answer rather than a deferral. `administration_record.iv_session_id` is
// written NOWHERE: the production write path (`emar-route-service-db.ts`) never sets it, the in-memory slice
// hard-codes it `null`, and there is no route that appends a segment to a session. Recording a segment
// through `POST /api/v1/administrations` with an `iv_continuous_*` mode would therefore commit a loose row
// that joins no session — and the §2.11 D11 ordering + rate bounds (`assertIvSegmentLegal` /
// `checkIvRateBounds`, both real and unit-tested in @wardenx/emar) are never called by the service, so the
// graph the CTAs would be stepping through is not enforced anywhere either. Four buttons producing orphan
// rows against an unenforced state machine is worse than a read screen. This surface needs an IV-session
// PRODUCER first (an M13 start-session route that mints the id and binds the pure core); the write CTAs are
// out of launch scope until it exists, not merely "not built yet".
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
        <EmptyState
          title="No segments"
          description="This session has no recorded segments. Nothing in the platform starts an IV continuous session yet, so this surface stays read-only until a session producer exists."
        />
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
