import {
  EmptyState,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
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
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { useSession } from "../../shell/session";
import { ADMISSION_TONE, WINDOW_TONE, stateLabel } from "./admission-status";

interface Bundle {
  id: string;
  status: string;
}
interface ElectionStatement extends Bundle {
  signerKind: string;
  signedAt: string | null;
  sourceType: "structured" | "uploaded";
}
interface Cti extends Bundle {
  hospiceMdSigned: boolean;
  attendingMdSigned: boolean;
  signedLate: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  sourceType?: "structured" | "uploaded";
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
  const session = useSession();
  const { patientId } = useParams<{ patientId: string }>();
  const [data, setData] = useState<ElectionCert | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingCtiId, setSigningCtiId] = useState<string | null>(null);

  const roles = session?.roles ?? [];

  const canPrepareCti =
    roles.includes("rn") ||
    roles.includes("registered_nurse") ||
    roles.includes("medical_director") ||
    roles.includes("hospice_physician");

  const canSignCti = roles.includes("medical_director") || roles.includes("hospice_physician");

  const canManageF2f =
    roles.includes("medical_director") ||
    roles.includes("hospice_physician") ||
    roles.includes("np");

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [eRes, pRes] = await Promise.all([
      client.GET("/api/v1/patients/{patientId}/election-certification", {
        params: { path: { patientId } },
      }),
      client.GET("/api/v1/patients/{id}", {
        params: { path: { id: patientId } },
      }),
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

  const signCti = useCallback(
    async (ctiId: string): Promise<void> => {
      if (!canSignCti) return;

      setSigningCtiId(ctiId);
      setActionError(null);

      const { data: currentCti, error: readError } = await client.GET("/api/v1/cti/{id}", {
        params: {
          path: {
            id: ctiId,
          },
        },
      });

      if (readError || !currentCti) {
        setActionError("Could not load the current CTI.");
        setSigningCtiId(null);
        return;
      }

      const detail = currentCti as unknown as {
        version: number;
      };

      const { error: signError } = await client.POST("/api/v1/cti/{id}/sign-hospice-md", {
        params: {
          path: {
            id: ctiId,
          },
        },
        body: {
          ifVersion: detail.version,
        } as never,
      });

      if (signError) {
        setActionError(
          "Could not sign the CTI. Check your permissions and the current CTI status.",
        );
        setSigningCtiId(null);
        return;
      }

      setSigningCtiId(null);
      await load();
    },
    [canSignCti, client, load],
  );

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
      <div style={workspaceBody}>
        <ChartModuleRail patientId={patientId ?? ""} current="election" />

        <div style={contentWithRail}>
          {/* Center — admission + benefit-period ladder */}
          <main style={mainContent}>
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
                <section
                  style={{
                    ...cardSurface,
                    padding: "1.125rem 1.25rem",
                    marginBottom: "1rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                    }}
                  >
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
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.75rem",
                    }}
                  >
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
                          <span
                            style={{
                              marginLeft: "auto",
                              color: t.muted,
                              fontSize: "0.78rem",
                            }}
                          >
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
                                ? p.electionStatement.sourceType === "uploaded"
                                  ? [
                                      "Uploaded document",
                                      p.electionStatement.signedAt
                                        ? `Signed ${fmtDate(p.electionStatement.signedAt)}`
                                        : "Signature pending",
                                    ].join(" · ")
                                  : [
                                      stateLabel(p.electionStatement.signerKind),
                                      p.electionStatement.signedAt
                                        ? `Signed ${fmtDate(p.electionStatement.signedAt)}`
                                        : "Signature pending",
                                    ].join(" · ")
                                : "Not drafted"
                            }
                          />
                          <CertificationCard
                            title="Certification of Terminal Illness"
                            status={p.cti?.status ?? "missing"}
                            summary={
                              p.cti
                                ? p.cti.sourceType === "uploaded"
                                  ? [
                                      "Uploaded document",
                                      p.cti.hospiceMdSigned
                                        ? "Hospice MD signed"
                                        : "Hospice MD signature pending",
                                    ].join(" · ")
                                  : [
                                      p.cti.hospiceMdSigned
                                        ? "Hospice MD signed"
                                        : "Hospice MD pending",
                                      p.cti.attendingMdSigned
                                        ? "Attending signed"
                                        : "Attending pending",
                                      p.cti.signedLate ? "Signed late" : null,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")
                                : "No CTI created for this period."
                            }
                            details={
                              p.cti ? (
                                <dl style={compactDetailGrid}>
                                  <dt style={dtStyle}>Source</dt>
                                  <dd style={ddStyle}>
                                    {p.cti.sourceType === "uploaded"
                                      ? "Uploaded document"
                                      : "Structured CTI"}
                                  </dd>

                                  <dt style={dtStyle}>Status</dt>
                                  <dd style={ddStyle}>{stateLabel(p.cti.status)}</dd>

                                  <dt style={dtStyle}>Period start</dt>
                                  <dd style={ddStyle}>{fmtDate(p.cti.periodStart)}</dd>

                                  <dt style={dtStyle}>Period end</dt>
                                  <dd style={ddStyle}>{fmtDate(p.cti.periodEnd)}</dd>

                                  <dt style={dtStyle}>Hospice MD</dt>
                                  <dd style={ddStyle}>
                                    {p.cti.hospiceMdSigned ? "Signed" : "Pending"}
                                  </dd>

                                  <dt style={dtStyle}>Attending</dt>
                                  <dd style={ddStyle}>
                                    {p.cti.attendingMdSigned ? "Signed" : "Pending"}
                                  </dd>

                                  <dt style={dtStyle}>Late</dt>
                                  <dd style={ddStyle}>{p.cti.signedLate ? "Yes" : "No"}</dd>
                                </dl>
                              ) : null
                            }
                            actions={
                              <>
                                {canPrepareCti && !p.cti ? (
                                  <Link
                                    to={`/admissions/${admission.id}`}
                                    style={primaryLinkAction}
                                  >
                                    Create CTI
                                  </Link>
                                ) : null}

                                {canSignCti &&
                                p.cti &&
                                p.cti.sourceType !== "uploaded" &&
                                !p.cti.hospiceMdSigned &&
                                p.cti.status !== "voided" ? (
                                  <button
                                    type="button"
                                    style={primaryAction}
                                    disabled={signingCtiId === p.cti.id}
                                    onClick={() => {
                                      return p?.cti && void signCti(p.cti.id);
                                    }}
                                  >
                                    {signingCtiId === p.cti.id ? "Signing..." : "Sign CTI"}
                                  </button>
                                ) : null}
                              </>
                            }
                          />

                          <CertificationCard
                            title="Face-to-Face"
                            status={p.faceToFace?.status ?? "missing"}
                            summary={
                              p.faceToFace
                                ? [
                                    stateLabel(p.faceToFace.performerRole),
                                    p.faceToFace.encounterDate
                                      ? fmtDate(p.faceToFace.encounterDate)
                                      : null,
                                    p.faceToFace.attested ? "Attested" : "Pending attestation",
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")
                                : "No Face-to-Face encounter scheduled."
                            }
                            details={
                              p.faceToFace ? (
                                <dl style={compactDetailGrid}>
                                  <dt style={dtStyle}>Status</dt>
                                  <dd style={ddStyle}>{stateLabel(p.faceToFace.status)}</dd>

                                  <dt style={dtStyle}>Performer</dt>
                                  <dd style={ddStyle}>{stateLabel(p.faceToFace.performerRole)}</dd>

                                  <dt style={dtStyle}>Encounter date</dt>
                                  <dd style={ddStyle}>{fmtDate(p.faceToFace.encounterDate)}</dd>

                                  <dt style={dtStyle}>Within window</dt>
                                  <dd style={ddStyle}>
                                    {p.faceToFace.withinWindow == null
                                      ? "—"
                                      : p.faceToFace.withinWindow
                                        ? "Yes"
                                        : "No"}
                                  </dd>

                                  <dt style={dtStyle}>Window override</dt>
                                  <dd style={ddStyle}>
                                    {p.faceToFace.windowOverride ? "Yes" : "No"}
                                  </dd>

                                  <dt style={dtStyle}>Attestation</dt>
                                  <dd style={ddStyle}>
                                    {p.faceToFace.attested ? "Attested" : "Pending"}
                                  </dd>
                                </dl>
                              ) : null
                            }
                            footer={
                              canManageF2f ? (
                                <span style={permissionHint}>
                                  Hospice MD / NP actions available for this record.
                                </span>
                              ) : (
                                <span style={permissionHint}>Read only</span>
                              )
                            }
                          />
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}

            {actionError ? (
              <div role="alert" style={actionErrorStyle}>
                {actionError}
              </div>
            ) : null}
          </main>

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
                    <li
                      key={w.id}
                      style={{
                        borderTop: `1px solid ${t.outlineVariant}`,
                        paddingTop: "0.6rem",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          marginBottom: "0.2rem",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: "0.82rem",
                            color: t.onSurface,
                          }}
                        >
                          {stateLabel(w.windowKind)}
                        </span>

                        <StatusPill
                          label={stateLabel(w.status)}
                          tone={WINDOW_TONE[w.status] ?? "neutral"}
                        />
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
      </div>
    </PatientWorkspaceLayout>
  );
}

function CertificationCard({
  title,
  status,
  summary,
  details,
  actions,
  footer,
}: {
  title: string;
  status: string;
  summary: string;
  details?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  const missing = status === "missing";

  return (
    <div style={certificationCard}>
      <div style={certificationHeader}>
        <div style={{ minWidth: 0 }}>
          <div style={certificationTitle}>{title}</div>

          <div style={certificationSummary}>{summary}</div>
        </div>

        <StatusPill
          label={missing ? "Missing" : stateLabel(status)}
          tone={missing ? "neutral" : subTone(status)}
        />
      </div>

      {details ? (
        <details style={detailsBlock}>
          <summary style={detailsSummary}>View details</summary>

          <div style={detailsContent}>{details}</div>
        </details>
      ) : null}

      {actions ? <div style={certificationActions}>{actions}</div> : null}

      {footer ? <div style={certificationFooter}>{footer}</div> : null}
    </div>
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
    <div
      style={{
        ...cardSurface,
        background: t.surfaceLow,
        padding: "0.75rem 0.85rem",
      }}
    >
      <div
        style={{
          fontSize: "0.72rem",
          color: t.onSurfaceVariant,
          marginBottom: "0.35rem",
        }}
      >
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

const workspaceBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
};

const contentWithRail: CSSProperties = {
  display: "flex",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  overflow: "hidden",
};

const rightRail: CSSProperties = {
  flex: "0 0 19rem",
  width: "19rem",
  minWidth: "19rem",
  height: "100%",
  overflowY: "auto",
  overflowX: "hidden",
  padding: "1.5rem",
  borderLeft: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLow,
};

const mainContent: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  height: "100%",
  overflowY: "auto",
  overflowX: "hidden",
  padding: "1.5rem",
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
const meta: CSSProperties = {
  fontSize: "0.8rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};

const certificationCard: CSSProperties = {
  ...cardSurface,
  background: t.surfaceLow,
  padding: "0.9rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.7rem",
  minWidth: 0,
};

const certificationHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const certificationTitle: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 650,
  color: t.onSurface,
};

const certificationSummary: CSSProperties = {
  marginTop: "0.3rem",
  fontSize: "0.74rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

const certificationActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.5rem",
};

const certificationFooter: CSSProperties = {
  paddingTop: "0.15rem",
};

const detailsBlock: CSSProperties = {
  borderTop: `1px solid ${t.outlineVariant}`,
  paddingTop: "0.55rem",
};

const detailsSummary: CSSProperties = {
  cursor: "pointer",
  color: t.primary,
  fontSize: "0.76rem",
  fontWeight: 600,
  userSelect: "none",
};

const detailsContent: CSSProperties = {
  marginTop: "0.65rem",
};

const compactDetailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(7rem, auto) 1fr",
  gap: "0.4rem 0.85rem",
  margin: 0,
  fontSize: "0.76rem",
};

const primaryAction: CSSProperties = {
  border: 0,
  borderRadius: "var(--radius-sm)",
  background: t.primary,
  color: t.onPrimary,
  padding: "0.5rem 0.8rem",
  font: "inherit",
  fontSize: "0.76rem",
  fontWeight: 650,
  cursor: "pointer",
};

const permissionHint: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
};

const actionErrorStyle: CSSProperties = {
  margin: "0 0 1rem",
  padding: "0.75rem 0.9rem",
  borderRadius: "var(--radius-sm)",
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  color: t.error,
  fontSize: "0.8rem",
};

const primaryLinkAction: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--radius-sm)",
  background: t.primary,
  color: t.onPrimary,
  padding: "0.5rem 0.8rem",
  fontSize: "0.76rem",
  fontWeight: 650,
  textDecoration: "none",
};
