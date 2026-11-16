import {
  Button,
  EmptyState,
  InlineAlert,
  PatientWorkspaceLayout,
  StatusPill,
  interactiveRowProps,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — Patient HOPE timeline (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Patient Workspace + Documentation Workspace."
// Per-patient chronology: Admission → HUV1 → HUV2 → SFV(s) → Discharge, newest first — each row carries the
// RFA kind, target date, author discipline, the server-authoritative J2051 max-severity + trigger chip, a
// late chip, and the signed/draft/superseded status. A row drills into the assessment detail. Reads
// GET /api/v1/patients/:patientId/hope/assessments via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Leaves only (@chartwarden/ui).
//
// #91 — the chart's HOPE tab now offers the two writes that belong to a PATIENT rather than to a window:
// Record timepoint (an unscheduled capture — a Discharge RFA in particular has no pre-computed window)
// and Recompute schedules (§4.1 route 20, after a post-hoc admission-date correction). Both need the
// admission id.
//
// IT USED TO COME OFF `items[0]`, WHICH MEANT NO PATIENT COULD HAVE THEIR FIRST ONE RECORDED (F-085).
// This header said so and named the way out — "a patient with NO HOPE record yet therefore gets neither,
// and the schedule worklist … is the entry point for the first capture" — and that exit does not exist
// for the people who record HOPE: `/hope` with no `patientId` filter is an ORG-WIDE read, so M10's own
// `hope.scope` predicate admits only `medical_director` / `compliance_officer` / `survey_coordinator`
// (correctly — an unfiltered list applies no caseload narrowing), the dashboard offers no patient
// filter, and an RN opening it gets a 404. So the first HOPE assessment for a patient — the CMS
// ADMISSION timepoint, due within 5 days of election, the one every newly admitted patient needs and
// the one no patient can already have — was recordable from nowhere by the discipline that performs it.
//
// The missing fact was `admissionId`, and it is the same gap F-065 fixed for M12 and F-083 for M8: the
// org-wide census takes no patient filter and its items carry no `patientId`, so nothing could resolve a
// patient's admission until `GET /api/v1/patients/{patientId}/admissions` existed. It does. The
// timeline reads it, preferring an OPEN admission, and falls back to the newest row's admission so a
// patient whose admissions read is unavailable behaves exactly as before rather than losing a control
// that was working.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { type HopeAction, HopeActionModal } from "./hope-action-modal";
import { readSucceeded, withRequestTimeout } from "./hope-api";
import { formatTargetDate } from "./hope-format";
import { HopeRecordModal } from "./hope-record-modal";
import { LoadingRegion, useRetryFocus } from "./hope-retry-focus";
import { ASSESSMENT_TONE, J2051_TONE, rfaLabel, stateLabel } from "./hope-status";

const TIMELINE_UNAVAILABLE = "Could not load HOPE timeline.";
/** hope.scope answers a patient outside the caller's caseload with 404 (deny-as-not-found), a plain refusal with 403: Try again changes neither. */
const TIMELINE_NOT_AVAILABLE =
  "This patient's HOPE timeline was not found, or is not available to you.";

interface AssessmentRow {
  id: string;
  admissionId: string;
  rfaKind: string;
  status: string;
  targetDate: string;
  /** The read projection has no author column (the server sends ""), so the table does not show one. */
  authorDiscipline: string | null;
  j2051MaxSeverity: string | null;
  j2051TriggerFired: boolean;
  wasLate: boolean;
  supersededByAssessmentId: string | null;
}

/** Rebuilt for each patient, so nothing read for one (rows, admission, an error) can reach the next one's controls. */
export function PatientHopeTimeline(): JSX.Element {
  const { patientId } = useParams<{ patientId: string }>();
  return <PatientHopeTimelineView key={patientId} patientId={patientId} />;
}

function PatientHopeTimelineView({ patientId }: { patientId: string | undefined }): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [recording, setRecording] = useState(false);
  const [patientAdmissionId, setPatientAdmissionId] = useState<string | null>(null);
  const [acting, setActing] = useState<HopeAction | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const retry = useRetryFocus(loading, error);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger, not read in the body.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      // Rows and the admission read last time stay until the new read answers: this effect re-runs for the SAME
      // patient (a recorded timepoint, Try again), and blanking them would pull the record controls — and the dialog
      // that just reported success — out from under the clinician. A different patient remounts the view (see the key).
      setLoading(true);
      setError(null);
      setRetryable(true);
      try {
        // Bounded: a request nobody answers is the error state below (with Try again), not a spinner that never ends.
        const result = await withRequestTimeout((signal) =>
          client.GET("/api/v1/patients/{patientId}/hope/assessments", {
            params: { path: { patientId } },
            signal,
          }),
        );
        if (!active) return;
        // Not `error` alone: openapi-fetch leaves it undefined (or "") for a non-OK reply with no body, and a 502 is not an
        // empty timeline — it would wipe the rows kept on screen and say "No HOPE timepoints".
        if (readSucceeded(result)) {
          setItems((result.data?.assessments ?? []) as AssessmentRow[]);
        } else if (result.response?.status === 403 || result.response?.status === 404) {
          setRetryable(false);
          setError(TIMELINE_NOT_AVAILABLE);
        } else {
          setError(TIMELINE_UNAVAILABLE);
        }
      } catch {
        if (active) setError(TIMELINE_UNAVAILABLE);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, reloadKey]);

  // The patient's own admission (F-085). Separate from the timeline read because it must answer for a
  // patient who has NO timepoints yet — which is precisely the patient whose ADMISSION timepoint is due.
  // Re-read with the timeline, so "Try again" heals a transient failure of this read too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger, not read in the body.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      let rows: { id: string; dischargedAt: string | null }[];
      try {
        const result = await withRequestTimeout((signal) =>
          client.GET("/api/v1/patients/{patientId}/admissions", {
            params: { path: { patientId } },
            signal,
          }),
        );
        // An unreadable answer (an error reply, not only a throw) keeps the admission already known: it is not "no open
        // admission", and treating it as one would take Record timepoint away from a patient with no timepoints.
        if (!readSucceeded(result)) return;
        rows = (result.data?.items ?? []) as { id: string; dischargedAt: string | null }[];
      } catch {
        // Best-effort: without the admissions read the controls fall back to the timeline's own newest row.
        return;
      }
      if (!active) return;
      // ONLY an open admission. The capture route refuses a closed one outright
      // (`409 M10_ADMISSION_NOT_ACTIVE`), so offering the control for a discharged admission would be
      // an enabled button whose route always denies — and a patient whose only admission is closed
      // falls back to the timeline's own `items[0]`, i.e. exactly the behaviour that was there before.
      setPatientAdmissionId(rows.find((r) => r.dischargedAt === null)?.id ?? null);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, reloadKey]);

  const triggered = items.filter((a) => a.j2051TriggerFired).length;
  // The patient's admission, or — if that read is unavailable — the newest timepoint's, which is where
  // this used to come from and which is still correct whenever there IS a timepoint.
  const admissionId = patientAdmissionId ?? items[0]?.admissionId ?? null;

  // The shared chart banner and summary rail, so this tab reads like every other chart tab (the
  // patient's identity stays on screen; the page's own title and actions live in the content pane).
  const identity = useChartIdentity(patientId);
  const banner = <ChartPatientBanner patientId={patientId} identity={identity} />;
  const rail = patientId ? <PatientSummaryPanel identity={identity} /> : undefined;

  return (
    <PatientWorkspaceLayout banner={banner} rail={rail}>
      <div
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          height: "100%",
          overflow: "hidden",
        }}
      >
        <ChartModuleRail patientId={patientId ?? ""} current="hope" />

        <main
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            padding: "1.5rem",
          }}
        >
          <div style={headingRow}>
            <div>
              <h1 style={pageTitle}>HOPE Timeline</h1>
              {loading || error ? null : (
                <span style={meta}>
                  {items.length} {items.length === 1 ? "timepoint" : "timepoints"}
                  {triggered > 0 ? ` · ${triggered} triggered an SFV` : ""}
                </span>
              )}
            </div>
            {admissionId !== null ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Button size="sm" onClick={() => setRecording(true)}>
                  Record timepoint
                </Button>
                <Button size="sm" tone="tertiary" onClick={() => setActing("regenerate")}>
                  Recompute schedules
                </Button>
              </div>
            ) : null}
          </div>
          {error ? (
            <div ref={retry.errorRef} tabIndex={-1}>
              <InlineAlert tone="error">
                {error}
                {retryable ? (
                  <>
                    {" "}
                    <Button
                      size="sm"
                      tone="secondary"
                      onClick={() => {
                        retry.retried();
                        setReloadKey((key) => key + 1);
                      }}
                    >
                      Try again
                    </Button>
                  </>
                ) : null}
              </InlineAlert>
            </div>
          ) : loading ? (
            <LoadingRegion label="Loading HOPE timeline…" regionRef={retry.loadingRef} />
          ) : items.length === 0 ? (
            <EmptyState
              title="No HOPE timepoints"
              description="No HOPE assessments have been recorded for this patient."
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr>
                    <th>RFA</th>
                    <th>Target date</th>
                    <th>J2051</th>
                    <th>Status</th>
                  </tr>
                </thead>

                <tbody>
                  {items.map((a) => (
                    <tr
                      key={a.id}
                      className="wx-data-row-interactive"
                      {...interactiveRowProps(() => navigate(`/hope/assessments/${a.id}`))}
                      style={{
                        textDecoration: a.supersededByAssessmentId ? "line-through" : "none",
                      }}
                    >
                      <td>{rfaLabel(a.rfaKind)}</td>

                      <td className="tabular-nums">{formatTargetDate(a.targetDate)}</td>

                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                          }}
                        >
                          {a.j2051MaxSeverity ? (
                            <StatusPill
                              label={stateLabel(a.j2051MaxSeverity)}
                              tone={J2051_TONE[a.j2051MaxSeverity] ?? "neutral"}
                            />
                          ) : (
                            <span
                              style={{
                                color: "var(--color-muted)",
                              }}
                            >
                              —
                            </span>
                          )}

                          {a.j2051TriggerFired ? (
                            <StatusPill label="SFV" tone="warning" glyph="alert" />
                          ) : null}
                        </span>
                      </td>

                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                          }}
                        >
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
            </div>
          )}
        </main>
      </div>
      {recording && admissionId !== null ? (
        <HopeRecordModal
          open
          admissionId={admissionId}
          onClose={() => setRecording(false)}
          onDone={() => setReloadKey((k) => k + 1)}
          onOpenExisting={(draft) => navigate(`/hope/assessments/${draft.id}`)}
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
    </PatientWorkspaceLayout>
  );
}

const headingRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
  marginBottom: "1rem",
} as const;

const pageTitle = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.375rem",
  color: t.onSurface,
} as const;

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
