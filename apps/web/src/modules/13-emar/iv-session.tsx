import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — IV continuous session (M13 §4.1/§6.1 #5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Detail". The IPU-specific surface
// (limited Phase-1 utility; primary value lands at M37). The session's ordered segment sequence
// (start → rate_change → pause/resume → stop) with the Titrate / Pause / Resume / Stop write CTAs.
//
// F-031 / #134 — this screen was read-only, and correctly so: `administration_record.iv_session_id` was
// written NOWHERE, so no session could exist, this route 404'd for every input, and the §2.11 D11 ordering
// graph and titration bounds (`assertIvSegmentLegal` / `checkIvRateBounds`, both real and unit-tested in
// @chartwarden/emar) were called by nothing. The producer exists now — `iv_continuous_start` mints the session
// and every continuation names it — so the CTAs are real.
//
// The buttons offered are the ones `IV_SESSION_GRAPH` accepts from the session's PUBLISHED state, not all
// five: offering a Resume on a running pump would be inviting a clinician to discover a 409 at the bedside.
// The server still decides — `assertIvSegmentLegal` runs on every write — so a session that moved under
// this view refuses and the refusal is shown verbatim. Reads
// GET /api/v1/administrations/iv-sessions/:sessionId via the typed client.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type ActiveMedicationOrder,
  IV_NEXT_SEGMENTS,
  type IvSegmentMode,
  type IvSessionView,
  getIvSession,
  listPatientMedicationOrders,
} from "./emar-api";
import { stateLabel } from "./emar-status";
import { IvSegmentModal } from "./iv-segment-modal";

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

const SEGMENT_CTA: Record<IvSegmentMode, string> = {
  iv_continuous_start: "Start",
  iv_continuous_rate_change: "Titrate",
  iv_continuous_pause: "Pause",
  iv_continuous_resume: "Resume",
  iv_continuous_stop: "Stop",
};

const STATE_TONE: Record<IvSessionView["state"], "progress" | "warning" | "neutral"> = {
  none: "neutral",
  running: "progress",
  paused: "warning",
  stopped: "neutral",
};

export function IvSession(): JSX.Element {
  const client = useApiClient();
  const { patientId, sessionId } = useParams<{ patientId: string; sessionId: string }>();
  const [row, setRow] = useState<IvSessionView | null>(null);
  const [order, setOrder] = useState<ActiveMedicationOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<IvSegmentMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    const { session, error: err } = await getIvSession(client, sessionId);
    if (err || !session) {
      setError("Could not load the IV session.");
      setLoading(false);
      return;
    }
    setRow(session);
    setLoading(false);
    // The med class decides whether the D7 witness field appears. A caller without `prescribing.read`
    // gets nothing here and the ceremony falls back to `standard` — where a controlled infusion is then
    // refused by the SERVER with the D7 message, never silently recorded unwitnessed.
    if (!patientId) return;
    const { orders } = await listPatientMedicationOrders(client, patientId);
    setOrder(orders.find((o) => o.id === session.medicationOrderId) ?? null);
  }, [client, patientId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The rate the session is running at — the last segment that carried one. A titration starts from the
  // truth rather than a blank field, and `previousRate` on the recorded row is that same value.
  const currentRate = row
    ? ([...row.segments].reverse().find((s) => s.rate != null) ?? null)
    : null;
  const nextSegments = row ? IV_NEXT_SEGMENTS[row.state] : [];

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="IV Continuous Session"
          actions={
            row ? (
              <StatusPill label={stateLabel(row.state)} tone={STATE_TONE[row.state]} />
            ) : undefined
          }
        >
          {row ? (
            <span style={meta}>
              {order ? `${order.drugName} ${order.strength}` : null}
              {order ? " · " : null}
              started <span className="tabular-nums">{ts(row.startedAt)}</span>
              {row.endedAt ? (
                <>
                  {" · ended "}
                  <span className="tabular-nums">{ts(row.endedAt)}</span>
                </>
              ) : null}
              {currentRate?.rate != null && row.state !== "stopped" ? (
                <>
                  {" · running at "}
                  <span className="tabular-nums">{currentRate.rate}</span>
                  {currentRate.rateUnit ? ` ${currentRate.rateUnit}` : ""}
                </>
              ) : null}
            </span>
          ) : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Segment</th>
                <th>Rate</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {row.segments.map((s, i) => (
                <tr key={`${s.kind}-${s.recordedAt}`}>
                  <td className="tabular-nums">{i + 1}</td>
                  <td>{stateLabel(s.kind)}</td>
                  <td className="tabular-nums">
                    {s.rate != null ? `${s.rate}${s.rateUnit ? ` ${s.rateUnit}` : ""}` : "—"}
                  </td>
                  <td className="tabular-nums">{ts(s.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {actionError ? (
            <p role="alert" style={{ ...meta, color: "var(--color-error)" }}>
              {actionError}
            </p>
          ) : null}

          {nextSegments.length > 0 ? (
            <section style={actions}>
              {nextSegments.map((m) => (
                <Button
                  key={m}
                  tone={m === "iv_continuous_stop" ? "danger" : "primary"}
                  onClick={() => {
                    setActionError(null);
                    setSegment(m);
                  }}
                >
                  {SEGMENT_CTA[m]}
                </Button>
              ))}
            </section>
          ) : (
            <p style={{ ...meta, marginTop: "1.5rem" }}>
              This session is stopped. A stopped session is terminal — a new infusion starts a new
              one.
            </p>
          )}

          {segment ? (
            <IvSegmentModal
              open
              mode={segment}
              medicationOrderId={row.medicationOrderId}
              medClass={order?.medClass ?? "standard"}
              ivSessionId={row.sessionId}
              currentRate={currentRate?.rate ?? null}
              currentRateUnit={currentRate?.rateUnit ?? null}
              onClose={() => setSegment(null)}
              onRecorded={() => {
                setSegment(null);
                void load();
              }}
            />
          ) : null}
        </>
      )}
    </DetailPageLayout>
  );
}

const meta: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
};
const actions: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
  marginTop: "1.5rem",
};
