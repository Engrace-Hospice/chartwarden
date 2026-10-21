import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  StatusPill,
  interactiveRowProps,
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
import { type HopeAction, HopeActionModal } from "./hope-action-modal";
import { HopeRecordModal } from "./hope-record-modal";
import { ASSESSMENT_TONE, J2051_TONE, rfaLabel, stateLabel } from "./hope-status";

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

export function PatientHopeTimeline(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [patientAdmissionId, setPatientAdmissionId] = useState<string | null>(null);
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

  // The patient's own admission (F-085). Separate from the timeline read because it must answer for a
  // patient who has NO timepoints yet — which is precisely the patient whose ADMISSION timepoint is due.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      const { data } = await client.GET("/api/v1/patients/{patientId}/admissions", {
        params: { path: { patientId } },
      });
      if (!active) return;
      const rows = (data?.items ?? []) as { id: string; dischargedAt: string | null }[];
      // ONLY an open admission. The capture route refuses a closed one outright
      // (`409 M10_ADMISSION_NOT_ACTIVE`), so offering the control for a discharged admission would be
      // an enabled button whose route always denies — and a patient whose only admission is closed
      // falls back to the timeline's own `items[0]`, i.e. exactly the behaviour that was there before.
      setPatientAdmissionId(rows.find((r) => r.dischargedAt === null)?.id ?? null);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  const triggered = items.filter((a) => a.j2051TriggerFired).length;
  // The patient's admission, or — if that read is unavailable — the newest timepoint's, which is where
  // this used to come from and which is still correct whenever there IS a timepoint.
  const admissionId = patientAdmissionId ?? items[0]?.admissionId ?? null;

  return (
    <PatientWorkspaceLayout
      banner={
        <PageHeader title="HOPE Timeline">
          <span style={meta}>
            {items.length} {items.length === 1 ? "timepoint" : "timepoints"}
            {triggered > 0 ? ` · ${triggered} triggered an SFV` : ""}
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
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
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

                      <td className="tabular-nums">{a.targetDate.slice(0, 10)}</td>

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

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
