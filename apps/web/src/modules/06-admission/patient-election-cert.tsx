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
} from "@chartwarden/ui";
import type { StatusTone } from "@chartwarden/ui";
// apps/web/src/modules/06-admission — patient-scoped Election & Certification (M6 §5.2/§5.3, Track B).
// Spec: docs/modules/CHARTWARDEN_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md — the
// per-patient slice reached from the patient chart "Election & Certification" tab. A Patient
// Workspace (banner + shared module rail) over the patient's current admission, its single hospice
// election, and its benefit-period CTI / F2F ladder — with the admission's compliance windows on the
// right rail. Backed by the M6
// aggregate read GET /api/v1/patients/:patientId/election-certification (+ the patient summary for the
// banner) via the typed client. The SERVER owns authoritative state (ADR-0030, no frontend authz); a
// patient with no admission renders an honest empty state, never fabricated certification data.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { useSession } from "../../shell/session";
import { ADMISSION_TONE, WINDOW_TONE, stateLabel } from "./admission-status";
import { CtiDetailModal } from "./cti-detail-modal";
import { CtiNarrativeSignModal } from "./cti-narrative-sign-modal";
import { ADDENDUM_WINDOW_LABEL } from "./election-addendum-format";
import { ElectionAddendumPanel } from "./election-addendum-panel";
import type { F2fEncounterLocation } from "./election-certification-api";
import { ElectionStatementDetailModal } from "./election-statement-detail-modal";
import { FaceToFaceRail } from "./face-to-face-rail";
import { F2fScheduleRail } from "./face-to-face-schedule-rail";

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
  performerUserId?: string | null;
  encounterDate: string | null;
  encounterLocation?: F2fEncounterLocation | null;
  attestationNoteEncounterId?: string | null;
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
  /** The CTI whose sign was refused for a missing narrative (transfer-in drafts) — the narrative prompt. */
  const [narrativeCti, setNarrativeCti] = useState<{ id: string; periodLabel: string } | null>(
    null,
  );
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [electionDetailOpen, setElectionDetailOpen] = useState(false);
  const [ctiDetailPeriod, setCtiDetailPeriod] = useState<Period | null>(null);
  const [f2fDetailPeriod, setF2fDetailPeriod] = useState<Period | null>(null);
  const [f2fSchedulePeriod, setF2fSchedulePeriod] = useState<Period | null>(null);

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
    async (ctiId: string, periodLabel: string, narrative?: string): Promise<void> => {
      if (!canSignCti) return;

      setSigningCtiId(ctiId);
      setActionError(null);
      setNarrativeError(null);

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
          ...(narrative !== undefined ? { narrative } : {}),
        } as never,
      });

      if (signError) {
        setSigningCtiId(null);
        const err = signError as { error?: { code?: string; message?: string } };
        // The CTI has no (or too short a) physician narrative — e.g. the one transfer-in drafts. Ask the
        // signing physician for it and sign again with it (42 CFR 418.22(b)(3)).
        if (err.error?.code === "CTI_NARRATIVE_REQUIRED") {
          if (narrative !== undefined)
            setNarrativeError(err.error.message ?? "The narrative is too short.");
          setNarrativeCti({ id: ctiId, periodLabel });
          return;
        }
        setNarrativeCti(null);
        setActionError(
          err.error?.message ??
            "Could not sign the CTI. Check your permissions and the current CTI status.",
        );
        return;
      }

      setSigningCtiId(null);
      setNarrativeCti(null);
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

  // The rail reads the CURRENT period row, so a completion/attestation reload refreshes it in place.
  const f2fSelected =
    data?.periods.find((period) => period.id === f2fDetailPeriod?.id) ?? f2fDetailPeriod;
  const admission = data?.admission ?? null;
  const windows = data?.complianceWindows ?? [];
  const electionPeriod = data?.periods.find((period) => period.electionStatement !== null) ?? null;
  const electionStatement = electionPeriod?.electionStatement ?? null;

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={workspaceBody}>
        <ChartModuleRail patientId={patientId ?? ""} current="election" />

        <div style={contentWithRail}>
          {/* Center — admission + hospice election + benefit-period ladder */}
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
                    <h2 style={{ ...cardHeading, margin: 0 }}>Admission summary</h2>
                    <StatusPill
                      label={stateLabel(admission.state)}
                      tone={ADMISSION_TONE[admission.state] ?? "neutral"}
                    />
                    {(admission.state === "discharged" || admission.state === "closed") &&
                    session?.permissions?.includes("admission.create") ? (
                      <Link
                        to={`/admissions/${admission.id}/readmit`}
                        className="wx-btn-secondary"
                        style={{ marginLeft: "auto" }}
                      >
                        Readmit patient
                      </Link>
                    ) : null}
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

                <h2 style={{ ...cardHeading, margin: "0 0 0.5rem" }}>Hospice Election</h2>
                <section
                  style={{
                    ...cardSurface,
                    padding: "1rem 1.125rem",
                    marginBottom: "1rem",
                  }}
                >
                  <div style={certificationHeader}>
                    <div style={{ minWidth: 0 }}>
                      <div style={electionTitle}>Election Statement</div>
                      {!electionStatement ? (
                        <p style={electionEmptyMessage}>
                          No Election Statement has been created for this admission.
                        </p>
                      ) : null}
                    </div>
                    <StatusPill
                      label={electionStatement ? stateLabel(electionStatement.status) : "Missing"}
                      tone={electionStatement ? subTone(electionStatement.status) : "warning"}
                    />
                  </div>

                  {electionStatement ? (
                    <>
                      <dl style={electionDetailGrid}>
                        <dt style={dtStyle}>Effective date</dt>
                        <dd style={ddStyle}>
                          {fmtDate(electionPeriod?.effectiveAt ?? electionStatement.signedAt)}
                        </dd>

                        <dt style={dtStyle}>Signed by</dt>
                        <dd style={ddStyle}>{stateLabel(electionStatement.signerKind)}</dd>

                        <dt style={dtStyle}>Statement type</dt>
                        <dd style={ddStyle}>
                          {electionStatement.sourceType === "uploaded"
                            ? "Uploaded document"
                            : "Structured"}
                        </dd>

                        <dt style={dtStyle}>Signed date</dt>
                        <dd style={ddStyle}>{fmtDate(electionStatement.signedAt)}</dd>
                      </dl>
                      <div style={standaloneDetailAction}>
                        <button
                          type="button"
                          aria-label="View Election Statement details"
                          style={secondaryAction}
                          onClick={() => setElectionDetailOpen(true)}
                        >
                          View details
                        </button>
                      </div>
                    </>
                  ) : null}
                </section>

                {/* FY2027 — 42 CFR 418.24(c) election statement addendum. */}
                <ElectionAddendumPanel admissionId={admission.id} />

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
                    {data?.periods.map((p) => {
                      const isF2fRequired = p.sequenceNumber >= 3;
                      const f2fStatus = !isF2fRequired
                        ? "not_required"
                        : (p.faceToFace?.status ?? "missing");

                      return (
                        <section key={p.id} style={{ ...cardSurface, padding: "1rem 1.125rem" }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              flexWrap: "wrap",
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
                              {fmtDate(p.effectiveAt)}
                              {p.scheduledEndAt ? ` → ${fmtDate(p.scheduledEndAt)}` : ""}
                            </span>
                          </div>
                          <div style={bundleGrid}>
                            <CertificationCard
                              title={`CTI — ${
                                p.sequenceNumber === 1 ? "Initial Certification" : "Recertification"
                              }`}
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
                                        p.sequenceNumber === 1
                                          ? p.cti.attendingMdSigned
                                            ? "Attending signed"
                                            : "Attending pending"
                                          : null,
                                        p.cti.signedLate ? "Signed late" : null,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")
                                  : "No CTI created for this period."
                              }
                              actions={
                                <>
                                  {p.cti ? (
                                    <button
                                      type="button"
                                      aria-label={`View Period ${p.sequenceNumber} CTI details`}
                                      style={secondaryAction}
                                      onClick={() => setCtiDetailPeriod(p)}
                                    >
                                      View details
                                    </button>
                                  ) : null}

                                  {/* A voided CTI is history: `cti_period_active_idx` covers only
                                      non-voided rows, so the period can be certified again. A
                                      superseded CTI is not offered — its replacement is live. */}
                                  {canPrepareCti && (!p.cti || p.cti.status === "voided") ? (
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
                                        return (
                                          p?.cti &&
                                          void signCti(p.cti.id, `Period ${p.sequenceNumber}`)
                                        );
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
                              status={f2fStatus}
                              statusLabel={
                                !isF2fRequired
                                  ? "Not required"
                                  : !p.faceToFace
                                    ? "Required — not scheduled"
                                    : undefined
                              }
                              statusTone={
                                !isF2fRequired ? "neutral" : !p.faceToFace ? "warning" : undefined
                              }
                              summary={
                                !isF2fRequired
                                  ? "Not required for this benefit period."
                                  : p.faceToFace
                                    ? [
                                        stateLabel(p.faceToFace.performerRole),
                                        p.faceToFace.encounterDate
                                          ? fmtDate(p.faceToFace.encounterDate)
                                          : null,
                                        p.faceToFace.attested ? "Attested" : "Pending attestation",
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")
                                    : "A Face-to-Face encounter is required and has not been scheduled."
                              }
                              actions={
                                p.faceToFace ? (
                                  <button
                                    type="button"
                                    aria-label={`View Period ${p.sequenceNumber} Face-to-Face details`}
                                    style={secondaryAction}
                                    onClick={() => {
                                      setF2fSchedulePeriod(null);
                                      setF2fDetailPeriod(p);
                                    }}
                                  >
                                    View details
                                  </button>
                                ) : isF2fRequired && canManageF2f && data?.admission ? (
                                  <button
                                    type="button"
                                    aria-label={`Schedule Period ${p.sequenceNumber} Face-to-Face`}
                                    style={secondaryAction}
                                    onClick={() => {
                                      setF2fDetailPeriod(null);
                                      setF2fSchedulePeriod(p);
                                    }}
                                  >
                                    Schedule
                                  </button>
                                ) : null
                              }
                              footer={
                                isF2fRequired && canManageF2f ? (
                                  <span style={permissionHint}>
                                    Hospice MD / NP actions available for this record.
                                  </span>
                                ) : isF2fRequired ? (
                                  <span style={permissionHint}>Read only</span>
                                ) : null
                              }
                            />
                          </div>
                        </section>
                      );
                    })}
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

          {f2fSchedulePeriod && data?.admission && session?.userId ? (
            <div className="wx-f2f-rail-slot">
              <F2fScheduleRail
                key={f2fSchedulePeriod.id}
                admissionId={data.admission.id}
                electionPeriodId={f2fSchedulePeriod.id}
                sequenceNumber={f2fSchedulePeriod.sequenceNumber}
                periodEffectiveAt={f2fSchedulePeriod.effectiveAt}
                clinicianUserId={session.userId}
                onClose={() => setF2fSchedulePeriod(null)}
                onScheduled={() => {
                  setF2fSchedulePeriod(null);
                  void load();
                }}
              />
            </div>
          ) : f2fSelected?.faceToFace ? (
            <div className="wx-f2f-rail-slot">
              <FaceToFaceRail
                key={f2fSelected.faceToFace.id}
                faceToFaceId={f2fSelected.faceToFace.id}
                patientId={patientId ?? null}
                canManage={canManageF2f}
                snapshot={{
                  sequenceNumber: f2fSelected.sequenceNumber,
                  performerRole: f2fSelected.faceToFace.performerRole,
                  performerUserId: f2fSelected.faceToFace.performerUserId ?? null,
                  encounterDate: f2fSelected.faceToFace.encounterDate,
                  encounterLocation: f2fSelected.faceToFace.encounterLocation ?? null,
                  attestationNoteEncounterId:
                    f2fSelected.faceToFace.attestationNoteEncounterId ?? null,
                  withinWindow: f2fSelected.faceToFace.withinWindow,
                  windowOverride: f2fSelected.faceToFace.windowOverride,
                  attested: f2fSelected.faceToFace.attested,
                }}
                onClose={() => setF2fDetailPeriod(null)}
                onChanged={() => void load()}
              />
            </div>
          ) : (
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
                            {ADDENDUM_WINDOW_LABEL[w.windowKind] ?? stateLabel(w.windowKind)}
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
          )}
        </div>
      </div>

      <ElectionStatementDetailModal
        open={electionDetailOpen}
        statementId={electionStatement?.id ?? null}
        snapshot={
          electionStatement
            ? {
                effectiveDate: electionPeriod?.effectiveAt ?? electionStatement.signedAt,
                signerKind: electionStatement.signerKind,
                signedAt: electionStatement.signedAt,
                sourceType: electionStatement.sourceType,
              }
            : null
        }
        onOpenChange={setElectionDetailOpen}
      />

      <CtiNarrativeSignModal
        open={narrativeCti !== null}
        periodLabel={narrativeCti?.periodLabel ?? ""}
        busy={narrativeCti !== null && signingCtiId === narrativeCti.id}
        error={narrativeError}
        onCancel={() => {
          setNarrativeCti(null);
          setNarrativeError(null);
        }}
        onSubmit={(text) => {
          if (narrativeCti) void signCti(narrativeCti.id, narrativeCti.periodLabel, text);
        }}
      />

      <CtiDetailModal
        open={ctiDetailPeriod !== null}
        ctiId={ctiDetailPeriod?.cti?.id ?? null}
        snapshot={
          ctiDetailPeriod?.cti
            ? {
                sequenceNumber: ctiDetailPeriod.sequenceNumber,
                effectiveAt: ctiDetailPeriod.effectiveAt,
                scheduledEndAt: ctiDetailPeriod.scheduledEndAt,
                sourceType: ctiDetailPeriod.cti.sourceType,
                hospiceMdSigned: ctiDetailPeriod.cti.hospiceMdSigned,
                attendingMdSigned: ctiDetailPeriod.cti.attendingMdSigned,
                signedLate: ctiDetailPeriod.cti.signedLate,
                periodStart: ctiDetailPeriod.cti.periodStart,
                periodEnd: ctiDetailPeriod.cti.periodEnd,
              }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setCtiDetailPeriod(null);
        }}
      />
    </PatientWorkspaceLayout>
  );
}

function CertificationCard({
  title,
  status,
  statusLabel,
  statusTone,
  summary,
  actions,
  footer,
}: {
  title: string;
  status: string;
  statusLabel?: string;
  statusTone?: StatusTone;
  summary: string;
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
          label={statusLabel ?? (missing ? "Missing" : stateLabel(status))}
          tone={statusTone ?? (missing ? "warning" : subTone(status))}
        />
      </div>

      {actions ? <div style={certificationActions}>{actions}</div> : null}

      {footer ? <div style={certificationFooter}>{footer}</div> : null}
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
  flexWrap: "wrap",
  alignContent: "flex-start",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  overflowY: "auto",
  overflowX: "hidden",
};

const rightRail: CSSProperties = {
  flex: "1 1 16rem",
  width: "auto",
  minWidth: "min(100%, 16rem)",
  overflowY: "visible",
  overflowX: "hidden",
  padding: "1.5rem",
  borderLeft: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLow,
};

const mainContent: CSSProperties = {
  flex: "999 1 32rem",
  minWidth: 0,
  overflowY: "visible",
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
const electionTitle: CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 650,
  color: t.onSurface,
};
const electionEmptyMessage: CSSProperties = {
  margin: "0.35rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
  lineHeight: 1.45,
};
const electionDetailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.35rem 1rem",
  margin: "0.9rem 0 0",
  fontSize: "0.8rem",
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

const standaloneDetailAction: CSSProperties = {
  marginTop: "0.9rem",
};

const secondaryAction: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: "var(--radius-sm)",
  background: t.surfaceLowest,
  color: t.primary,
  padding: "0.45rem 0.75rem",
  font: "inherit",
  fontSize: "0.76rem",
  fontWeight: 650,
  cursor: "pointer",
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
