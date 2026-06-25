import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/18-evv — EVV Event Detail (M18 §5.1 `/app/evv/event/:eventId`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Detail Page". One `evv_event`'s raw + computed fields. Coordinates are redacted
// unless evv.read_coords (D10) — this read path never requests them, so the view is coordinate-free; the
// "file correction" action (correction-of-record, step-up) fills in as that write path hardens. The SERVER owns
// the §4.7 ABAC (ADR-0030 — an out-of-scope event 404s). Reads GET /api/v1/evv/events/:eventId via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { EVV_QUALITY_TONE, StatusChip, mono, stateLabel, ts } from "./evv-shared";

interface EvvEventDetailView {
  id: string;
  visitId: string;
  patientId: string;
  kind: string;
  serviceTypeCode: string;
  postingMembershipId: string;
  postingDisciplineAtRecording: string;
  capturedAt: string;
  recordedAt: string;
  gpsQuality: string;
  offlineCapture: boolean;
  replacesEventId: string | null;
  supersededByEventId: string | null;
}

export function EvvEventDetail(): JSX.Element {
  const client = useApiClient();
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<EvvEventDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/events/{eventId}", {
      params: { path: { eventId } },
    });
    if (err) {
      setError("This event is unavailable or outside your scope.");
      setLoading(false);
      return;
    }
    setEvent((data ?? null) as EvvEventDetailView | null);
    setLoading(false);
  }, [client, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DetailPageLayout header={<PageHeader title="EVV Event Detail" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !event ? (
        <LoadingSpinner />
      ) : (
        <dl style={{ margin: 0, maxWidth: "40rem" }}>
          <Row label="Kind" value={stateLabel(event.kind)} />
          <Row
            label="GPS quality"
            value={<StatusChip value={event.gpsQuality} toneMap={EVV_QUALITY_TONE} />}
          />
          <Row
            label="Captured (device)"
            value={<span className="tabular-nums">{ts(event.capturedAt)}</span>}
          />
          <Row
            label="Recorded (server)"
            value={<span className="tabular-nums">{ts(event.recordedAt)}</span>}
          />
          <Row label="Clinician" value={mono(event.postingMembershipId)} />
          <Row
            label="Discipline"
            value={
              event.postingDisciplineAtRecording
                ? stateLabel(event.postingDisciplineAtRecording)
                : "—"
            }
          />
          <Row
            label="Service type"
            value={event.serviceTypeCode ? mono(event.serviceTypeCode) : "—"}
          />
          <Row label="Visit" value={mono(event.visitId)} />
          <Row label="Patient" value={mono(event.patientId)} />
          <Row label="Offline capture" value={event.offlineCapture ? "Yes" : "No"} />
          {event.replacesEventId ? (
            <Row label="Replaces" value={mono(event.replacesEventId)} />
          ) : null}
          {event.supersededByEventId ? (
            <Row label="Superseded by" value={mono(event.supersededByEventId)} />
          ) : null}
        </dl>
      )}
    </DetailPageLayout>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        gap: "1rem",
        padding: "0.4rem 0",
        borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
      }}
    >
      <dt style={{ width: "11rem", color: "var(--color-on-surface-variant)", fontSize: "0.8rem" }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface)" }}>{value}</dd>
    </div>
  );
}
