import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  stepUpPath,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/18-evv — EVV Event Detail (M18 §5.1, Track B / ADR-0030).
// The read contract is intentionally coordinate-free (D10). Corrections are append-only replacements:
// this surface follows the linked evidence chain and invokes the server-owned correction machine; it
// never edits an event or decides authorization, step-up freshness, kind matching, or live-head status.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import { type CorrectionDraft, EventCorrectionModal } from "./event-correction-modal";
import type { CorrectEventResult, EvvEventView } from "./evv-api";
import { EVV_QUALITY_TONE, StatusChip, mono, stateLabel, ts } from "./evv-shared";
import { EvvWorkspaceNav } from "./workspace-nav";

const CORRECTION_ACTION = "evv.correct_record";
const CORRECTION_ACTIONS = [CORRECTION_ACTION] as const;
const MAX_CHAIN_LENGTH = 25;

interface EvidenceState {
  readonly events: EvvEventView[];
  readonly incomplete: boolean;
}

export function EvvEventDetail(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const returningFromStepUp = useStepUpReturn(owner, CORRECTION_ACTIONS);
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<EvvEventView | null>(null);
  const [evidence, setEvidence] = useState<EvidenceState>({ events: [], incomplete: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionDraft, setCorrectionDraft] = useState<CorrectionDraft | null>(null);
  const loadGeneration = useRef(0);
  const correctionKey = useMemo(
    () => (eventId ? stepUpDraftKey(owner, CORRECTION_ACTION, eventId) : null),
    [eventId, owner],
  );

  const loadOne = useCallback(
    async (id: string): Promise<EvvEventView | null> => {
      const { data, error: loadError } = await client.GET("/api/v1/evv/events/{eventId}", {
        params: { path: { eventId: id } },
      });
      return loadError || !data ? null : data;
    },
    [client],
  );

  const load = useCallback(
    async (generation: number) => {
      if (!eventId) return;
      const isCurrent = () => loadGeneration.current === generation;
      setLoading(true);
      setError(null);
      const selected = await loadOne(eventId);
      if (!isCurrent()) return;
      if (!selected) {
        setEvent(null);
        setEvidence({ events: [], incomplete: false });
        setError("This event is unavailable or outside your scope.");
        setLoading(false);
        return;
      }

      const seen = new Set([selected.id]);
      const before: EvvEventView[] = [];
      const after: EvvEventView[] = [];
      let incomplete = false;
      let cursor: EvvEventView = selected;

      while (cursor.replacesEventId && seen.size < MAX_CHAIN_LENGTH) {
        if (seen.has(cursor.replacesEventId)) {
          incomplete = true;
          break;
        }
        const previous = await loadOne(cursor.replacesEventId);
        if (!isCurrent()) return;
        if (!previous) {
          incomplete = true;
          break;
        }
        seen.add(previous.id);
        before.unshift(previous);
        cursor = previous;
      }

      cursor = selected;
      while (cursor.supersededByEventId && seen.size < MAX_CHAIN_LENGTH) {
        if (seen.has(cursor.supersededByEventId)) {
          incomplete = true;
          break;
        }
        const next = await loadOne(cursor.supersededByEventId);
        if (!isCurrent()) return;
        if (!next) {
          incomplete = true;
          break;
        }
        seen.add(next.id);
        after.push(next);
        cursor = next;
      }
      if (seen.size >= MAX_CHAIN_LENGTH && (cursor.replacesEventId || cursor.supersededByEventId)) {
        incomplete = true;
      }

      setEvent(selected);
      setEvidence({ events: [...before, selected, ...after], incomplete });
      setLoading(false);
    },
    [eventId, loadOne],
  );

  useEffect(() => {
    const generation = ++loadGeneration.current;
    void load(generation);
    return () => {
      if (loadGeneration.current === generation) loadGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!returningFromStepUp || !event || event.supersededByEventId) return;
    const draft = peekStepUpDraft<CorrectionDraft>(correctionKey);
    if (!draft) return;
    setCorrectionDraft(draft);
    setCorrectionOpen(true);
  }, [correctionKey, event, returningFromStepUp]);

  const closeCorrection = () => {
    clearStepUpDraft(correctionKey);
    setCorrectionDraft(null);
    setCorrectionOpen(false);
  };

  const requireStepUp = (draft: CorrectionDraft, refusal: unknown) => {
    const returnTo = `${location.pathname}${location.search}`;
    stashStepUpDraft(correctionKey, draft);
    navigate(stepUpRedirectFor(refusal, returnTo) ?? stepUpPath(returnTo));
  };

  const correctionDone = (result: CorrectEventResult) => {
    clearStepUpDraft(correctionKey);
    setCorrectionOpen(false);
    setCorrectionDraft(null);
    navigate(`/evv/events/${result.eventId}`);
  };

  const mayOfferCorrection =
    event !== null &&
    event.supersededByEventId === null &&
    (session?.permissions ?? []).includes("evv.correct_record");

  return (
    <DetailPageLayout
      header={
        <PageHeader title="EVV Event Detail">
          <EvvWorkspaceNav />
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !event ? (
        <LoadingSpinner />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: "54rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Recorded evidence</h2>
              <p
                style={{
                  margin: "0.3rem 0 0",
                  fontSize: "0.78rem",
                  color: "var(--color-on-surface-variant)",
                }}
              >
                Coordinates and correction reasons are excluded from this read contract.
              </p>
            </div>
            {mayOfferCorrection ? (
              <Button
                tone="secondary"
                onClick={() => {
                  setCorrectionDraft(null);
                  setCorrectionOpen(true);
                }}
              >
                File correction
              </Button>
            ) : null}
          </div>

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
          </dl>

          <EvidenceTimeline state={evidence} />
        </div>
      )}

      {event ? (
        <EventCorrectionModal
          event={event}
          open={correctionOpen}
          initialDraft={correctionDraft}
          onClose={closeCorrection}
          onDone={correctionDone}
          onStepUp={requireStepUp}
        />
      ) : null}
    </DetailPageLayout>
  );
}

function EvidenceTimeline({ state }: { state: EvidenceState }): JSX.Element {
  return (
    <section aria-label="Correction evidence">
      <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.05rem" }}>Correction evidence</h2>
      {state.incomplete ? (
        <p role="alert" style={{ fontSize: "0.8rem", color: "var(--color-error)" }}>
          Part of this correction chain could not be loaded. The visible records remain unchanged.
        </p>
      ) : null}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.65rem" }}>
        {state.events.map((item, index) => {
          const current = item.supersededByEventId === null;
          const label = index === 0 ? "Original event" : `Correction ${index}`;
          return (
            <li
              key={item.id}
              style={{
                border: "1px solid var(--color-outline-variant)",
                borderRadius: "0.65rem",
                padding: "0.8rem",
                background: current
                  ? "var(--color-surface-container-low)"
                  : "var(--color-surface-lowest)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <strong style={{ fontSize: "0.85rem" }}>
                  {label}
                  {current ? " · Current" : ""}
                </strong>
                <Link to={`/evv/events/${item.id}`} style={{ fontSize: "0.78rem" }}>
                  Open event {item.id.slice(0, 8)}
                </Link>
              </div>
              <div
                style={{
                  marginTop: "0.35rem",
                  fontSize: "0.78rem",
                  color: "var(--color-on-surface-variant)",
                }}
              >
                {stateLabel(item.kind)} · captured {ts(item.capturedAt)} · recorded{" "}
                {ts(item.recordedAt)} · {stateLabel(item.gpsQuality)}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
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
