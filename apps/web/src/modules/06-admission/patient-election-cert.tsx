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
// apps/web/src/modules/06-admission — patient-scoped Election & Certification (M6 §5.2/§5.3, Track B).
// Spec: docs/modules/WARDENX_MODULE_06_ADMISSION_SPEC — the per-patient slice reached from the patient
// chart "Election & Certification" tab. A Patient Workspace (banner + shared module rail) over the
// patient's current admission and its benefit-period ladder — each period's election statement / CTI /
// F2F recert bundle — with the admission's compliance windows on the right rail. Backed by the M6
// aggregate read GET /api/v1/patients/:patientId/election-certification (+ the patient summary for the
// banner) via the typed client. The SERVER owns authoritative state (ADR-0030, no frontend authz); a
// patient with no admission renders an honest empty state, never fabricated certification data.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ADMISSION_TONE, WINDOW_TONE, stateLabel } from "./admission-status";

interface Bundle {
  id: string;
  status: string;
}
interface ElectionStatement extends Bundle {
  signerKind: string;
  signedAt: string | null;
}
interface Cti extends Bundle {
  hospiceMdSigned: boolean;
  attendingMdSigned: boolean;
  signedLate: boolean;
  periodStart: string | null;
  periodEnd: string | null;
}
interface F2f extends Bundle {
  performerRole: string;
  encounterDate: string | null;
  withinWindow: boolean | null;
  windowOverride: boolean;
  attested: boolean;
}
interface Period {
  id: string;
  sequenceNumber: number;
  periodKind: string;
  effectiveAt: string | null;
  scheduledEndAt: string | null;
  actualEndAt: string | null;
  status: string;
  electionStatement: ElectionStatement | null;
  cti: Cti | null;
  faceToFace: F2f | null;
}
interface ComplianceWindow {
  id: string;
  windowKind: string;
  severity: string;
  status: string;
  mustCompleteBy: string;
  closedAt: string | null;
}
interface ElectionCert {
  admission: {
    id: string;
    state: string;
    admissionAt: string | null;
    activatedAt: string | null;
    dischargedAt: string | null;
    version: number;
  } | null;
  periods: Period[];
  complianceWindows: ComplianceWindow[];
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// A signature/lifecycle sub-status → §6.6 tone (statements, CTIs, F2F, periods share a small taxonomy).
const SUB_TONE: Record<string, StatusTone> = {
  drafted: "progress",
  pending: "progress",
  awaiting_attending: "progress",
  scheduled: "progress",
  completed: "progress",
  signed: "success",
  attested: "success",
  active: "success",
  voided: "neutral",
  expired: "neutral",
  closed: "neutral",
};
const subTone = (s: string): StatusTone => SUB_TONE[s] ?? "neutral";

const PATIENT_TONE: Record<string, StatusTone> = {
  active: "success",
  pending: "progress",
  admitted: "success",
  discharged: "neutral",
  deceased: "neutral",
};

export function PatientElectionCert(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [data, setData] = useState<ElectionCert | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [eRes, pRes] = await Promise.all([
      client.GET("/api/v1/patients/{patientId}/election-certification", {
        params: { path: { patientId } },
      }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (pRes.data) setPatient(pRes.data as PatientSummary);
    if (eRes.error) {
      setError("Could not load election & certification for this patient.");
      setLoading(false);
      return;
    }
    // `periods` is published loosely on the wire (see admission-typebox note); the rich per-period shape
    // is this screen's `Period` type, cast through unknown.
    setData(eRes.data as unknown as ElectionCert);
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
    <PatientBanner name="Election & Certification" />
  );

  const admission = data?.admission ?? null;
  const windows = data?.complianceWindows ?? [];

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="election" />

        {/* Center — admission + benefit-period ladder */}
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
            Election &amp; Certification
          </h1>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && data === null ? (
            <LoadingSpinner />
          ) : !admission ? (
            <EmptyState
              title="No admission on file"
              description="Election and certification records appear here once the patient is admitted."
            />
          ) : (
            <>
              <section style={{ ...cardSurface, padding: "1.125rem 1.25rem", marginBottom: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <h2 style={{ ...cardHeading, margin: 0 }}>Admission</h2>
                  <StatusPill
                    label={stateLabel(admission.state)}
                    tone={ADMISSION_TONE[admission.state] ?? "neutral"}
                  />
                </div>
                <dl style={detailGrid}>
                  <dt style={dtStyle}>Admitted</dt>
                  <dd style={ddStyle}>{fmtDate(admission.admissionAt)}</dd>
                  <dt style={dtStyle}>Activated</dt>
                  <dd style={ddStyle}>{fmtDate(admission.activatedAt)}</dd>
                  {admission.dischargedAt ? (
                    <>
                      <dt style={dtStyle}>Discharged</dt>
                      <dd style={ddStyle}>{fmtDate(admission.dischargedAt)}</dd>
                    </>
                  ) : null}
                </dl>
              </section>

              <h2 style={{ ...cardHeading, margin: "0 0 0.5rem" }}>Benefit periods</h2>
              {data && data.periods.length === 0 ? (
                <p style={meta}>No benefit periods opened yet for this admission.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {data?.periods.map((p) => (
                    <section key={p.id} style={{ ...cardSurface, padding: "1rem 1.125rem" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.6rem",
                          marginBottom: "0.5rem",
                        }}
                      >
                        <span style={{ fontWeight: 700, color: t.onSurface }}>
                          Period {p.sequenceNumber}
                        </span>
                        <span style={{ color: t.muted, fontSize: "0.78rem" }}>
                          {stateLabel(p.periodKind)}
                        </span>
                        <StatusPill label={stateLabel(p.status)} tone={subTone(p.status)} />
                        <span style={{ marginLeft: "auto", color: t.muted, fontSize: "0.78rem" }}>
                          {p.effectiveAt ? `${p.effectiveAt}` : "—"}
                          {p.scheduledEndAt ? ` → ${p.scheduledEndAt}` : ""}
                        </span>
                      </div>
                      <div style={bundleGrid}>
                        <BundleCell
                          label="Election statement"
                          present={!!p.electionStatement}
                          status={p.electionStatement?.status}
                          detail={
                            p.electionStatement
                              ? `${stateLabel(p.electionStatement.signerKind)}${
                                  p.electionStatement.signedAt
                                    ? ` · signed ${p.electionStatement.signedAt}`
                                    : ""
                                }`
                              : "Not drafted"
                          }
                        />
                        <BundleCell
                          label="Certification (CTI)"
                          present={!!p.cti}
                          status={p.cti?.status}
                          detail={
                            p.cti
                              ? [
                                  p.cti.hospiceMdSigned ? "Hospice MD ✓" : "Hospice MD —",
                                  p.cti.attendingMdSigned ? "Attending ✓" : "Attending —",
                                  p.cti.signedLate ? "late" : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : "Not drafted"
                          }
                        />
                        <BundleCell
                          label="Face-to-face"
                          present={!!p.faceToFace}
                          status={p.faceToFace?.status}
                          detail={
                            p.faceToFace
                              ? [
                                  stateLabel(p.faceToFace.performerRole),
                                  p.faceToFace.encounterDate ?? null,
                                  p.faceToFace.withinWindow === false
                                    ? p.faceToFace.windowOverride
                                      ? "override"
                                      : "out of window"
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : "Not scheduled"
                          }
                        />
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right rail — compliance windows */}
        <aside style={rightRail}>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>Compliance windows</h2>
            {windows.length === 0 ? (
              <p style={meta}>No open compliance windows for this admission.</p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.6rem",
                }}
              >
                {windows.map((w) => (
                  <li key={w.id} style={{ borderTop: `1px solid ${t.outlineVariant}`, paddingTop: "0.6rem" }}>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.2rem" }}
                    >
                      <span style={{ fontWeight: 600, fontSize: "0.82rem", color: t.onSurface }}>
                        {stateLabel(w.windowKind)}
                      </span>
                      <StatusPill label={stateLabel(w.status)} tone={WINDOW_TONE[w.status] ?? "neutral"} />
                    </div>
                    <div style={{ color: t.muted, fontSize: "0.76rem" }}>
                      due {fmtDate(w.mustCompleteBy)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </PatientWorkspaceLayout>
  );
}

function BundleCell({
  label,
  present,
  status,
  detail,
}: {
  label: string;
  present: boolean;
  status?: string;
  detail: string;
}): JSX.Element {
  return (
    <div style={{ ...cardSurface, background: t.surfaceLow, padding: "0.75rem 0.85rem" }}>
      <div style={{ fontSize: "0.72rem", color: t.onSurfaceVariant, marginBottom: "0.35rem" }}>
        {label}
      </div>
      {present && status ? (
        <StatusPill label={stateLabel(status)} tone={subTone(status)} />
      ) : (
        <StatusPill label="Missing" tone="neutral" />
      )}
      <div style={{ color: t.muted, fontSize: "0.74rem", marginTop: "0.35rem" }}>{detail}</div>
    </div>
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
// ISO timestamp or YYYY-MM-DD date → date-only display; "—" when absent.
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

const rightRail: CSSProperties = {
  width: "19rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  background: t.surfaceLow,
};
const railTitle: CSSProperties = {
  margin: "0 0 0.625rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const cardHeading: CSSProperties = {
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const bundleGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.6rem",
};
const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  alignItems: "center",
  gap: "0.4rem 1rem",
  margin: "0.75rem 0 0",
  fontSize: "0.82rem",
};
const dtStyle: CSSProperties = { color: t.onSurfaceVariant };
const ddStyle: CSSProperties = { margin: 0, color: t.onSurface };
const meta: CSSProperties = { fontSize: "0.8rem", color: t.onSurfaceVariant, margin: "0.25rem 0 0" };
