import {
  EmptyState,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  cardSurface,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { StatusTone } from "@wardenx/ui";
// apps/web/src/modules/14-idg — patient-scoped IDG review history (M14 §5, Track B / ADR-0030).
// Spec: docs/modules/WARDENX_MODULE_14_IDG — the per-patient slice reached from the patient chart "IDG
// History" tab. A Patient Workspace (banner + shared module rail) over a timeline of the meetings this
// patient was reviewed in, each with its decisions + action items. Backed by the M14 aggregate read
// GET /api/v1/patients/:patientId/idg-history (+ the patient summary for the banner) via the typed client.
// Metadata only — the server surfaces decision KINDS / action-item status, never packet or decision
// narrative (PHI-safe by construction; no §3.3 SUD content to redact). A patient never on an agenda
// renders an honest empty state. The SERVER owns authoritative state (ADR-0030, no frontend authz).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ACTION_TONE, MEETING_TONE, stateLabel } from "./idg-status";

interface DecisionRow {
  id: string;
  decisionKind: string;
  status: string;
  wasQuorate: boolean;
  recordedAt: string | null;
}
interface ActionItemRow {
  id: string;
  status: string;
  discipline: string | null;
  dueDate: string | null;
  closedAt: string | null;
}
interface MeetingRow {
  meetingId: string;
  status: string;
  scheduledStart: string;
  actualStart: string | null;
  actualEnd: string | null;
  reviewedAt: string | null;
  packetFrozenAt: string | null;
  decisions: DecisionRow[];
  actionItems: ActionItemRow[];
}
interface IdgHistory {
  meetings: MeetingRow[];
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// Decision lifecycle → §6.6 tone (open/superseded/emitted etc.).
const DECISION_TONE: Record<string, StatusTone> = {
  open: "progress",
  emitted: "success",
  superseded: "neutral",
  cancelled: "neutral",
};

const PATIENT_TONE: Record<string, StatusTone> = {
  active: "success",
  pending: "progress",
  admitted: "success",
  discharged: "neutral",
  deceased: "neutral",
};

export function PatientIdgHistory(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [data, setData] = useState<IdgHistory | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [hRes, pRes] = await Promise.all([
      client.GET("/api/v1/patients/{patientId}/idg-history", {
        params: { path: { patientId } },
      }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (pRes.data) setPatient(pRes.data as PatientSummary);
    if (hRes.error) {
      setError("Could not load IDG history for this patient.");
      setLoading(false);
      return;
    }
    // `meetings` is published loosely on the wire (see idg-typebox note); the rich shape is `MeetingRow`.
    setData(hRes.data as unknown as IdgHistory);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill
            label={stateLabel(patient.status)}
            tone={PATIENT_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
    />
  ) : (
    <PatientBanner name="IDG History" />
  );

  const meetings = data?.meetings ?? [];

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="idg" />

        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <h1
            style={{
              margin: "0 0 1rem",
              fontFamily: t.fontDisplay,
              fontWeight: 500,
              fontSize: "1.375rem",
              color: t.onSurface,
            }}
          >
            IDG History
          </h1>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && data === null ? (
            <LoadingSpinner />
          ) : meetings.length === 0 ? (
            <EmptyState
              title="No IDG reviews yet"
              description="This patient has not been reviewed in an interdisciplinary group meeting. Reviews appear here once the patient is placed on an IDG agenda."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
              {meetings.map((m) => (
                <section key={m.meetingId} style={{ ...cardSurface, padding: "1.125rem 1.25rem" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      marginBottom: "0.6rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 700, color: t.onSurface }}>
                      {fmtDate(m.actualStart ?? m.scheduledStart)}
                    </span>
                    <StatusPill label={stateLabel(m.status)} tone={MEETING_TONE[m.status] ?? "neutral"} />
                    {m.reviewedAt ? (
                      <span style={{ color: t.muted, fontSize: "0.76rem" }}>
                        reviewed {fmtDate(m.reviewedAt)}
                      </span>
                    ) : null}
                  </div>

                  <div style={twoCol}>
                    {/* Decisions */}
                    <div>
                      <h3 style={colHeading}>Decisions</h3>
                      {m.decisions.length === 0 ? (
                        <p style={meta}>No decisions recorded for this patient.</p>
                      ) : (
                        <ul style={list}>
                          {m.decisions.map((d) => (
                            <li key={d.id} style={rowItem}>
                              <span style={{ color: t.onSurface, fontWeight: 600 }}>
                                {stateLabel(d.decisionKind)}
                              </span>
                              <StatusPill
                                label={stateLabel(d.status)}
                                tone={DECISION_TONE[d.status] ?? "neutral"}
                              />
                              {!d.wasQuorate ? (
                                <span style={{ color: t.warning, fontSize: "0.72rem" }}>
                                  non-quorate
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* Action items */}
                    <div>
                      <h3 style={colHeading}>Action items</h3>
                      {m.actionItems.length === 0 ? (
                        <p style={meta}>No action items for this patient.</p>
                      ) : (
                        <ul style={list}>
                          {m.actionItems.map((a) => (
                            <li key={a.id} style={rowItem}>
                              <StatusPill
                                label={stateLabel(a.status)}
                                tone={ACTION_TONE[a.status] ?? "neutral"}
                              />
                              {a.discipline ? (
                                <span style={{ color: t.onSurfaceVariant, fontSize: "0.78rem" }}>
                                  {stateLabel(a.discipline)}
                                </span>
                              ) : null}
                              {a.dueDate ? (
                                <span style={{ color: t.muted, fontSize: "0.74rem" }}>
                                  due {fmtDate(a.dueDate)}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function ageYears(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 150 ? a : null;
}
function fmtDate(v: string | null): string {
  if (!v) return "—";
  return v.slice(0, 10);
}
function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: t.fontMono,
        fontSize: "0.78rem",
        color: t.onSurfaceVariant,
        background: t.surfaceContainer,
        borderRadius: "9999px",
        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}

const twoCol: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "1rem",
};
const colHeading: CSSProperties = {
  margin: "0 0 0.4rem",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: t.onSurfaceVariant,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};
const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};
const rowItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "0.85rem",
};
const meta: CSSProperties = { fontSize: "0.8rem", color: t.onSurfaceVariant, margin: "0.15rem 0 0" };
