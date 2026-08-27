import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { Button } from "@wardenx/ui";
// apps/web/src/modules/10-hope — Patient HOPE timeline (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Patient Workspace + Documentation Workspace."
// Per-patient chronology: Admission → HUV1 → HUV2 → SFV(s) → Discharge, newest first — each row carries the
// RFA kind, target date, author discipline, the server-authoritative J2051 max-severity + trigger chip, a
// late chip, and the signed/draft/superseded status. A row drills into the assessment detail. Reads
// GET /api/v1/patients/:patientId/hope/assessments via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
//
// #91 — the chart's HOPE tab now offers the two writes that belong to a PATIENT rather than to a window:
// Record timepoint (an unscheduled capture — a Discharge RFA in particular has no pre-computed window)
// and Recompute schedules (§4.1 route 20, after a post-hoc admission-date correction). Both need the
// admission id, which this read carries per row; a patient with NO HOPE record yet therefore gets
// neither, and the schedule worklist — whose rows carry the admission — is the entry point for the first
// capture. Naming the reason beats an inert button.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type HopeAction, HopeActionModal } from "./hope-action-modal";
import { HopeRecordModal } from "./hope-record-modal";
import { ASSESSMENT_TONE, J2051_TONE, rfaLabel, stateLabel } from "./hope-status";

interface AssessmentRow {
  id: string;
  admissionId: string;
  rfaKind: string;
  status: string;
  targetDate: string;
  authorDiscipline: string;
  j2051MaxSeverity: string | null;
  j2051TriggerFired: boolean;
  wasLate: boolean;
  supersededByAssessmentId: string | null;
}

export function PatientHopeTimeline(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [acting, setActing] = useState<HopeAction | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger, not read in the body.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/hope/assessments",
        {
          params: { path: { patientId } },
        },
      );
      if (!active) return;
      if (err) {
        setError("Could not load HOPE timeline.");
        setLoading(false);
        return;
      }
      setItems((data?.assessments ?? []) as AssessmentRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, reloadKey]);

  const triggered = items.filter((a) => a.j2051TriggerFired).length;
  // Every row on this timeline belongs to the same patient; the admission comes off the newest of them.
  const admissionId = items[0]?.admissionId ?? null;

  return (
    <DetailPageLayout
      header={
        <PageHeader title="HOPE Timeline">
          <span style={meta}>
            {items.length} timepoints{triggered > 0 ? ` · ${triggered} triggered an SFV` : ""}
          </span>
          {admissionId !== null ? (
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <Button size="sm" onClick={() => setRecording(true)}>
                Record timepoint
              </Button>
              <Button size="sm" tone="tertiary" onClick={() => setActing("regenerate")}>
                Recompute schedules
              </Button>
            </div>
          ) : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No HOPE timepoints"
          description="No HOPE assessments have been recorded for this patient."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>RFA</th>
              <th>Target date</th>
              <th>Author</th>
              <th>J2051</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr
                key={a.id}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/hope/assessments/${a.id}`)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    navigate(`/hope/assessments/${a.id}`);
                  }
                }}
                style={{
                  cursor: "pointer",
                  // Superseded (corrected) rows render in strikethrough as a chronology cue (§5.2).
                  textDecoration: a.supersededByAssessmentId ? "line-through" : "none",
                }}
              >
                <td>{rfaLabel(a.rfaKind)}</td>
                <td className="tabular-nums">{a.targetDate.slice(0, 10)}</td>
                <td>{stateLabel(a.authorDiscipline)}</td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                    {a.j2051MaxSeverity ? (
                      <StatusPill
                        label={stateLabel(a.j2051MaxSeverity)}
                        tone={J2051_TONE[a.j2051MaxSeverity] ?? "neutral"}
                      />
                    ) : (
                      <span style={{ color: "var(--color-muted)" }}>—</span>
                    )}
                    {/* J2051 trigger fired → a 2-day Symptom Follow-Up Visit obligation (§2.3). */}
                    {a.j2051TriggerFired ? (
                      <StatusPill label="SFV" tone="warning" glyph="alert" />
                    ) : null}
                  </span>
                </td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                    <StatusPill
                      label={stateLabel(a.status)}
                      tone={ASSESSMENT_TONE[a.status] ?? "neutral"}
                    />
                    {a.wasLate ? <StatusPill label="Late" tone="warning" /> : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {recording && admissionId !== null ? (
        <HopeRecordModal
          open
          admissionId={admissionId}
          onClose={() => setRecording(false)}
          onDone={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
      {acting !== null && admissionId !== null ? (
        <HopeActionModal
          open
          action={acting}
          targetId={admissionId}
          onClose={() => setActing(null)}
          onDone={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
