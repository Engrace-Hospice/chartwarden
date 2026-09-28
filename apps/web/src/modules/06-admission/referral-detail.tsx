import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { CSSProperties, JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ReferralDocumentsPanel } from "../../shell/document-workflows";
import { PatientLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import {
  PATIENT_RESOLUTION_LABEL,
  PATIENT_RESOLUTION_TONE,
  PRIORITY_LABEL,
  REFERRAL_TONE,
  stateLabel,
} from "./admission-status";
import { PatientIntakeDetails } from "./patient-intake-details";
import {
  type ReferralActivity,
  type ReferralCandidate,
  type ReferralNote,
  type ReferralView,
  getReferral,
  listReferralActivity,
  listReferralNotes,
  patchReferral,
  referralCommand,
} from "./referrals-api";

export function ReferralDetail(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [referral, setReferral] = useState<ReferralView | null>(null);
  const [notes, setNotes] = useState<ReferralNote[]>([]);
  const [activity, setActivity] = useState<ReferralActivity[]>([]);
  const [candidates, setCandidates] = useState<ReferralCandidate[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [newNote, setNewNote] = useState("");
  const [pendingReason, setPendingReason] = useState("");
  const [terminalReason, setTerminalReason] = useState("");
  const [primaryDiagnosisIcd10, setPrimaryDiagnosisIcd10] = useState("");
  const [edit, setEdit] = useState({
    referrerName: "",
    referrerOrganization: "",
    referrerPhone: "",
    referringDxText: "",
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [ref, noteRows, activityRows] = await Promise.all([
        getReferral(client, id),
        listReferralNotes(client, id),
        listReferralActivity(client, id),
      ]);
      setReferral(ref);
      setNotes(noteRows);
      setActivity(activityRows);
      setPrimaryDiagnosisIcd10(ref.icd10TerminalPrimary ?? "");
      setEdit({
        referrerName: ref.referrerName ?? "",
        referrerOrganization: ref.referrerOrganization ?? "",
        referrerPhone: ref.referrerPhone ?? "",
        referringDxText: ref.referringDxText ?? "",
      });
    } catch (err) {
      setError(errorMessage(err, "Referral not found or not visible to you."));
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<void>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err, "The action could not be completed."));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (error && !referral) return <EmptyState title="Unavailable" description={error} />;
  if (!referral) return <EmptyState title="Unavailable" description="Referral not found." />;

  const r = referral;
  const resolved =
    r.patientResolutionStatus === "matched" || r.patientResolutionStatus === "created";
  const terminal = ["declined", "duplicate", "withdrawn", "converted"].includes(r.status);
  const canEditReferral = ["received", "under_review", "pending_information"].includes(r.status);
  const canReview = r.status === "received" || r.status === "pending_information";
  const canPending = r.status === "under_review";
  const canQualify = r.status === "under_review" && r.qualificationBlockers.length === 0;
  const canConvert = r.status === "qualified" && resolved;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={r.patientNameAtReceipt}
          breadcrumb="Admissions / Referral"
          actions={
            <div style={actions}>
              <StatusPill
                label={stateLabel(r.status)}
                tone={REFERRAL_TONE[r.status] ?? "neutral"}
              />
              {r.priority === "urgent" ? <span style={urgent}>Urgent</span> : null}
              {r.status === "converted" && r.convertedAdmissionId ? (
                <Button
                  tone="primary"
                  onClick={() => navigate(`/admissions/${r.convertedAdmissionId}`)}
                >
                  View Admission
                </Button>
              ) : null}
            </div>
          }
        >
          <div style={muted}>
            Referral {r.externalReferralId || shortId(r.id)} ·{" "}
            {sourceLabel(r.referrerOrganization || r.source)} · Received{" "}
            {formatDateTime(r.receivedAt)}
          </div>
          <div style={muted}>
            {r.assignedToUserId ? `Assigned to ${shortId(r.assignedToUserId)}` : "Unassigned"}
          </div>
        </PageHeader>
      }
    >
      {error ? (
        <div role="alert" style={alert}>
          {error}
        </div>
      ) : null}
      <div style={layout}>
        <main style={main}>
          <section style={section}>
            <div style={sectionHead}>
              <h2 style={heading}>Overview</h2>
              <div style={actions}>
                {canReview ? (
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={busy === "review"}
                    onClick={() =>
                      void run("review", async () => {
                        await referralCommand(client, r.id, "review", {
                          ifVersion: r.version,
                        });
                      })
                    }
                  >
                    Return to review
                  </Button>
                ) : null}
                {canQualify ? (
                  <Button
                    size="sm"
                    tone="primary"
                    disabled={busy === "qualify"}
                    onClick={() =>
                      void run("qualify", async () => {
                        await referralCommand(client, r.id, "qualify", {
                          ifVersion: r.version,
                        });
                      })
                    }
                  >
                    Mark Qualified
                  </Button>
                ) : null}
              </div>
            </div>
            <div style={factsGrid}>
              <Fact label="Status" value={stateLabel(r.status)} />
              <Fact label="Priority" value={PRIORITY_LABEL[r.priority] ?? r.priority} />
              <Fact
                label="Owner"
                value={r.assignedToUserId ? shortId(r.assignedToUserId) : "Unassigned"}
              />
              <Fact
                label="Patient match"
                value={
                  PATIENT_RESOLUTION_LABEL[r.patientResolutionStatus] ?? r.patientResolutionStatus
                }
              />
              <Fact label="Source" value={sourceLabel(r.referrerOrganization || r.source)} />
              <Fact label="Reason" value={r.referringDxText || "Not provided"} />
            </div>
            {!terminal ? (
              <div style={inlineControls}>
                <label style={labelInline}>
                  Priority
                  <select
                    value={r.priority}
                    disabled={!canEditReferral || busy === "priority"}
                    onChange={(ev) =>
                      void run("priority", async () => {
                        await referralCommand(client, r.id, "priority", {
                          priority: ev.target.value,
                          ifVersion: r.version,
                        });
                      })
                    }
                  >
                    <option value="routine">Routine</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!session?.userId || busy === "assign"}
                  onClick={() =>
                    void run("assign", async () => {
                      await referralCommand(client, r.id, "assign", {
                        assignedToUserId: session?.userId,
                        ifVersion: r.version,
                      });
                    })
                  }
                >
                  Assign to me
                </Button>
                {r.assignedToUserId ? (
                  <Button
                    size="sm"
                    tone="tertiary"
                    onClick={() =>
                      void run("assign", async () => {
                        await referralCommand(client, r.id, "assign", {
                          ifVersion: r.version,
                        });
                      })
                    }
                  >
                    Clear owner
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section style={section}>
            <h2 style={heading}>Patient Resolution</h2>
            <StatusPill
              label={
                PATIENT_RESOLUTION_LABEL[r.patientResolutionStatus] ?? r.patientResolutionStatus
              }
              tone={PATIENT_RESOLUTION_TONE[r.patientResolutionStatus] ?? "neutral"}
            />
            {resolved ? (
              <div style={resolvedBox}>
                <strong>Patient resolved</strong>
                <span>
                  {r.patientId ? `M5 patient ${shortId(r.patientId)}` : "Patient link confirmed"}
                </span>
                {r.patientId ? (
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={() => navigate(`/patients/${r.patientId}`)}
                  >
                    View patient
                  </Button>
                ) : null}
              </div>
            ) : (
              <div style={stack}>
                <p style={muted}>No canonical patient has been linked to this referral yet.</p>
                <div style={actions}>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={
                      busy === "matches" ||
                      !["under_review", "pending_information"].includes(r.status)
                    }
                    onClick={() =>
                      void run("matches", async () => {
                        const result = await referralCommand<{
                          candidates: ReferralCandidate[];
                        }>(client, r.id, "patient-matches", {
                          ifVersion: r.version,
                        });
                        setCandidates(result.candidates ?? []);
                      })
                    }
                  >
                    Find patient matches
                  </Button>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={busy === "create-patient"}
                    onClick={() =>
                      void run("create-patient", async () => {
                        await referralCommand(client, r.id, "create-patient", {
                          ifVersion: r.version,
                        });
                      })
                    }
                  >
                    Create new patient
                  </Button>
                </div>
                <PatientLookupField
                  label="Search patients manually"
                  value={selectedPatientId}
                  onChange={setSelectedPatientId}
                  clearable
                />
                <Button
                  size="sm"
                  tone="primary"
                  disabled={!selectedPatientId || busy === "confirm-patient"}
                  onClick={() =>
                    void run("confirm-patient", async () => {
                      await referralCommand(client, r.id, "confirm-patient", {
                        patientId: selectedPatientId,
                        ifVersion: r.version,
                      });
                    })
                  }
                >
                  Confirm selected patient
                </Button>
                {candidates.length ? (
                  <div style={candidateList}>
                    {candidates.map((c) => {
                      const patientId = c.patientId ?? c.id ?? "";
                      return (
                        <div key={candidateKey(c)} style={candidate}>
                          <strong>
                            {c.displayName ?? c.name ?? `Patient ${shortId(patientId)}`}
                          </strong>
                          <span style={muted}>
                            {c.dob ? `DOB ${formatDate(c.dob)}` : "DOB not shown"}
                            {c.mrn ? ` · MRN ${c.mrn}` : ""}
                            {c.phoneLast4 ? ` · Phone ending ${c.phoneLast4}` : ""}
                          </span>
                          <span style={muted}>{c.confidence ?? c.score ?? "Potential match"}</span>
                          <Button
                            size="sm"
                            tone="primary"
                            disabled={!patientId}
                            onClick={() =>
                              void run("confirm-patient", async () => {
                                await referralCommand(client, r.id, "confirm-patient", {
                                  patientId,
                                  ifVersion: r.version,
                                });
                              })
                            }
                          >
                            Confirm patient
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section style={section}>
            <h2 style={heading}>Patient Information</h2>

            {r.patientId ? (
              <PatientIntakeDetails patientId={r.patientId} onSaved={load} />
            ) : (
              <div style={resolvedBox}>
                <strong>Resolve the patient first</strong>
                <span>
                  Address and Coverage / Payers can be added once this referral is linked to a
                  canonical patient.
                </span>
              </div>
            )}
          </section>

          <section style={section}>
            <h2 style={heading}>Referral Information</h2>
            <div style={formGrid}>
              <ReadOnly label="Patient name at receipt" value={r.patientNameAtReceipt} />
              <ReadOnly
                label="DOB at receipt"
                value={r.patientDobAtReceipt ? formatDate(r.patientDobAtReceipt) : "Not provided"}
              />
              <ReadOnly label="Source channel" value={sourceLabel(r.source)} />
              <ReadOnly
                label="External referral ID"
                value={r.externalReferralId || "Not provided"}
              />
              <label style={label}>
                Organization
                <input
                  value={edit.referrerOrganization}
                  disabled={!canEditReferral}
                  onChange={(ev) => setEdit({ ...edit, referrerOrganization: ev.target.value })}
                />
              </label>
              <label style={label}>
                Referrer
                <input
                  value={edit.referrerName}
                  disabled={!canEditReferral}
                  onChange={(ev) => setEdit({ ...edit, referrerName: ev.target.value })}
                />
              </label>
              <label style={label}>
                Phone
                <input
                  value={edit.referrerPhone}
                  disabled={!canEditReferral}
                  onChange={(ev) => setEdit({ ...edit, referrerPhone: ev.target.value })}
                />
              </label>
            </div>
          </section>

          <ReferralDocumentsPanel
            referralId={r.id}
            patientId={r.patientId}
            admissionId={r.convertedAdmissionId}
          />

          <section style={section}>
            <h2 style={heading}>Clinical Information</h2>
            <label style={label}>
              Referral reason or diagnosis
              <textarea
                value={edit.referringDxText}
                rows={4}
                disabled={!canEditReferral}
                onChange={(ev) => setEdit({ ...edit, referringDxText: ev.target.value })}
              />
            </label>
            <Button
              size="sm"
              tone="secondary"
              disabled={!canEditReferral || busy === "save-info"}
              onClick={() =>
                void run("save-info", async () => {
                  await patchReferral(client, r.id, {
                    ...edit,
                    ifVersion: r.version,
                  });
                })
              }
            >
              Save referral information
            </Button>
          </section>
        </main>

        <aside style={side}>
          <section style={section}>
            <h2 style={heading}>Referral readiness</h2>
            {r.qualificationBlockers.length === 0 ? (
              <div style={ok}>Ready to proceed</div>
            ) : (
              <ul style={blockerList}>
                {r.qualificationBlockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            )}
          </section>

          <section style={section}>
            <h2 style={heading}>Start Admission</h2>
            {r.status === "converted" ? (
              <Button
                tone="primary"
                onClick={() => navigate(`/admissions/${r.convertedAdmissionId}`)}
                disabled={!r.convertedAdmissionId}
              >
                View Admission
              </Button>
            ) : (
              <div style={stack}>
                <label style={label}>
                  Primary ICD-10
                  <input
                    value={primaryDiagnosisIcd10}
                    onChange={(ev) => setPrimaryDiagnosisIcd10(ev.target.value)}
                    placeholder="C34.90"
                  />
                </label>
                <Button
                  tone="primary"
                  disabled={!canConvert || !primaryDiagnosisIcd10.trim() || busy === "convert"}
                  onClick={() =>
                    void run("convert", async () => {
                      const result = await referralCommand<{
                        admissionId: string;
                      }>(client, r.id, "convert", {
                        primaryDiagnosisIcd10: primaryDiagnosisIcd10.trim(),
                        ifVersion: r.version,
                      });
                      navigate(`/admissions/${result.admissionId}`);
                    })
                  }
                >
                  Start Admission
                </Button>
                {!canConvert ? (
                  <p style={muted}>Resolve and qualify the referral before starting admission.</p>
                ) : null}
              </div>
            )}
          </section>

          <section style={section}>
            <h2 style={heading}>Missing Information</h2>
            <label style={label}>
              What is missing?
              <textarea
                value={pendingReason}
                onChange={(ev) => setPendingReason(ev.target.value)}
                rows={3}
              />
            </label>
            <Button
              size="sm"
              tone="secondary"
              disabled={!canPending || !pendingReason.trim() || busy === "pending"}
              onClick={() =>
                void run("pending", async () => {
                  await referralCommand(client, r.id, "pending-information", {
                    reason: pendingReason.trim(),
                    ifVersion: r.version,
                  });
                  setPendingReason("");
                })
              }
            >
              Mark pending
            </Button>
          </section>

          <section style={section}>
            <h2 style={heading}>Notes</h2>
            <div style={stack}>
              {notes.map((note) => (
                <div key={note.id} style={noteBox}>
                  <div style={muted}>
                    {note.authorId ? shortId(note.authorId) : "System"} ·{" "}
                    {formatTime(note.createdAt)}
                  </div>
                  <div>{note.content}</div>
                </div>
              ))}
              <label style={label}>
                Add note
                <textarea value={newNote} onChange={(ev) => setNewNote(ev.target.value)} rows={3} />
              </label>
              <Button
                size="sm"
                tone="secondary"
                disabled={!newNote.trim() || busy === "note"}
                onClick={() =>
                  void run("note", async () => {
                    await referralCommand(client, r.id, "notes", {
                      content: newNote.trim(),
                    });
                    setNewNote("");
                  })
                }
              >
                Add note
              </Button>
            </div>
          </section>

          {!terminal ? (
            <section style={section}>
              <h2 style={heading}>Terminal actions</h2>
              <label style={label}>
                Reason
                <textarea
                  value={terminalReason}
                  onChange={(ev) => setTerminalReason(ev.target.value)}
                  rows={3}
                />
              </label>
              <div style={actions}>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={terminalReason.trim().length < 10 || busy === "decline"}
                  onClick={() =>
                    void run("decline", async () => {
                      await referralCommand(client, r.id, "decline", {
                        reason: terminalReason.trim(),
                        ifVersion: r.version,
                      });
                    })
                  }
                >
                  Decline Referral
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={() =>
                    void run("duplicate", async () => {
                      await referralCommand(client, r.id, "duplicate", {
                        reason: terminalReason || undefined,
                        ifVersion: r.version,
                      });
                    })
                  }
                >
                  Mark Duplicate
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={() =>
                    void run("withdraw", async () => {
                      await referralCommand(client, r.id, "withdraw", {
                        reason: terminalReason || undefined,
                        ifVersion: r.version,
                      });
                    })
                  }
                >
                  Withdraw
                </Button>
              </div>
            </section>
          ) : null}

          <section style={section}>
            <h2 style={heading}>Activity</h2>
            <div style={timeline}>
              {activity.map((a) => (
                <div key={a.id} style={timelineItem}>
                  <strong>{activityLabel(a.action)}</strong>
                  <span style={muted}>{formatTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </DetailPageLayout>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={factLabel}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

function ReadOnly({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div>
      <div style={factLabel}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

/** A candidate's patient id is its identity; when the matcher returns none, derive one from the
 *  demographics it did return, so the key never depends on list position. */
function candidateKey(c: ReferralCandidate): string {
  const id = c.patientId ?? c.id;
  if (id) return id;
  return [c.displayName ?? c.name ?? "", c.dob ?? "", c.mrn ?? "", c.phoneLast4 ?? ""].join("|");
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function sourceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function activityLabel(value: string): string {
  const labels: Record<string, string> = {
    referral_received: "Referral received",
    review_started: "Review started",
    returned_to_review: "Returned to review",
    patient_match_suggested: "Patient matches found",
    patient_match_confirmed: "Patient match confirmed",
    patient_created: "Patient created",
    qualified: "Referral marked qualified",
    converted: "Admission created",
    assigned: "Assignment updated",
    priority_updated: "Priority updated",
    pending_information_requested: "Information requested",
    note_added: "Note added",
    duplicate: "Marked duplicate",
    withdrawn: "Withdrawn",
    declined: "Declined",
  };
  return labels[value] ?? sourceLabel(value);
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as {
    error?: { message?: string; details?: Array<{ message?: string }> };
    message?: string;
  };
  return e.error?.details?.[0]?.message ?? e.error?.message ?? e.message ?? fallback;
}

const layout: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(20rem, 26rem)",
  gap: "1rem",
};
const main: CSSProperties = { display: "grid", gap: "1rem", minWidth: 0 };
const side: CSSProperties = {
  display: "grid",
  gap: "1rem",
  alignContent: "start",
  minWidth: 0,
};
const section: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  padding: "1rem",
  display: "grid",
  gap: "0.85rem",
};
const sectionHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
};
const heading: CSSProperties = { margin: 0, fontSize: "1rem" };
const muted: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};
const actions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const urgent: CSSProperties = {
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  borderRadius: "999px",
  padding: "0.2rem 0.55rem",
  fontSize: "0.8rem",
  fontWeight: 700,
};
const alert: CSSProperties = {
  marginBottom: "1rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
  borderRadius: "8px",
  color: "var(--color-error)",
  padding: "0.75rem 1rem",
};
const factsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.8rem",
};
const factLabel: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: 0,
};
const inlineControls: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "end",
  flexWrap: "wrap",
};
const labelInline: CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  fontSize: "0.8rem",
  fontWeight: 600,
};
const label: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const stack: CSSProperties = { display: "grid", gap: "0.7rem" };
const resolvedBox: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  padding: "0.75rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
};
const candidateList: CSSProperties = { display: "grid", gap: "0.6rem" };
const candidate: CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  padding: "0.75rem",
};
const formGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};
const ok: CSSProperties = { color: "var(--color-success)", fontWeight: 700 };
const blockerList: CSSProperties = {
  margin: 0,
  paddingLeft: "1.2rem",
  color: "var(--color-on-surface)",
};
const noteBox: CSSProperties = {
  borderBottom: "1px solid var(--color-outline-variant)",
  paddingBottom: "0.6rem",
};
const timeline: CSSProperties = { display: "grid", gap: "0.65rem" };
const timelineItem: CSSProperties = {
  display: "grid",
  gap: "0.15rem",
  borderLeft: "2px solid var(--color-outline-variant)",
  paddingLeft: "0.65rem",
};
