import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/07-care-plan — Care Plan View (M7 §5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CARE_PLAN.md — "Use Patient Workspace + Documentation Workspace."
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `UaKVf`): a Patient Workspace (banner +
// module nav rail) over a document-style "Interdisciplinary care plan" card (every problem with its
// goals + interventions inline), a right rail (IDG review + AI suggestion), and a sticky footer
// (IDG-quorum guard + actions). The active IPOC for a patient. SUD-flagged problems the caller may not
// see are omitted SERVER-side (§7.6 SQL WHERE; the response carries `redacted: true`) — never a
// frontend hide. Reads GET /patients/:patientId/care-plan (+ the patient summary for the banner); the
// server enforces every scope. Honest gaps: the API exposes no next-review date and AI care-plan
// suggestions are M29 (not built) — those regions render as honest substitutions, never fabricated.
//
// #91 — this screen displayed the IPOC and could not author it. The plan of care is the legal predicate
// for delivering hospice care at all (42 CFR 418.56(b)) and the IDG must review it every 15 days
// (418.56(d)); the footer's three buttons were all NAVIGATION, and the "IDG quorum required to approve"
// chip was a static string that read the same whether the quorum was unmet, met, or not applicable.
// Every problem, goal and intervention is now authorable and editable in place, and the footer carries
// the §2 version ceremonies — each offered only in the state the SERVER accepts it in.
//
// The quorum chip now names the roles actually outstanding, computed from the signer SLOTS the server
// published against the signatures collected. That comparison was impossible before: both M7 screens
// typed `requiredSignerSet` as `string[]` when the wire has always sent `{ role, count }`, so the
// checklist compared an object to a role string (always false) and passed the object to `cap()`, which
// calls `s.replace`. It never threw only because `requiredSignerSet` is populated at FINALIZE and
// nothing in the product could finalize.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import { bootstrapCarePlan, loadPatientAdmissions } from "./care-plan-api";
import {
  CarePlanElementModal,
  type ElementAction,
  type ElementSubject,
} from "./care-plan-element-modal";
import { cap, toneFor } from "./care-plan-status";
import { CarePlanVersionModal, type VersionAction } from "./care-plan-version-modal";

interface Version {
  id: string;
  sequence: number;
  kind: string;
  status: string;
  signatures: { signerRole: string; signedAt: string }[];
  // #91 — `{ role, count }`, NOT `string`. The wire has always sent slot OBJECTS; both M7 screens
  // declared `string[]` and rendered each entry through `cap()`, which calls `s.replace` — so the IDG
  // signature checklist would have THROWN the first time a version carried a non-empty signer set, and
  // the `signerRole === role` comparison beside it was an object-vs-string that could only ever be
  // false. It never fired because `requiredSignerSet` is populated at FINALIZE and nothing could
  // finalize; enabling that write is what would have surfaced it.
  requiredSignerSet: { role: string; count: number }[];
  signedAt: string | null;
  // §7.7 — the row version a write must quote. Read here, sent verbatim; never invented.
  version: number;
}
interface Problem {
  id: string;
  description: string;
  kind: string;
  source: string;
  sudRelated: boolean;
  status: string;
  // §7.7 — the row version a write must quote. Read here, sent verbatim; never invented.
  version: number;
}
interface Goal {
  id: string;
  problemId: string;
  originalText: string;
  revisedText: string | null;
  source: string;
  status: string;
  // §7.7 — the row version a write must quote. Read here, sent verbatim; never invented.
  version: number;
}
interface Intervention {
  id: string;
  problemId: string;
  scopeText: string;
  frequencyText: string;
  discipline: string;
  status: string;
  // §7.7 — the row version a write must quote. Read here, sent verbatim; never invented.
  version: number;
}
interface CarePlan {
  id: string;
  status: string;
  activeVersionId: string | null;
  versions: Version[];
  problems: Problem[];
  goals: Goal[];
  interventions: Intervention[];
  redacted: boolean;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// Terminal first, then related, then unrelated — the spec's problem ordering.
const KIND_ORDER: Record<string, number> = { terminal: 0, related: 1, unrelated: 2 };

export function CarePlanView(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  // F-066 (#161) — the open admission `POST /patients/:id/care-plan` is keyed by. `null` while the
  // read is in flight or when the patient has none; a patient with only discharged admissions is not
  // currently under care, and bootstrapping a plan into one would be wrong.
  const [openAdmissionId, setOpenAdmissionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [element, setElement] = useState<{
    action: ElementAction;
    problemId?: string | null;
    subject?: ElementSubject | null;
  } | null>(null);
  const [versionAction, setVersionAction] = useState<VersionAction | null>(null);
  /** Bumped after every write so the effect re-reads — including the row versions the next write quotes. */
  const [reloadKey, setReloadKey] = useState(0);
  const reload = (): void => setReloadKey((k) => k + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger, not read in the body.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const [planRes, patRes] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } }),
        client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
      ]);
      if (!active) return;
      if (patRes.data) setPatient(patRes.data as PatientSummary);
      if (planRes.error) {
        setError("Could not load the care plan.");
        setLoading(false);
        return;
      }
      const data = planRes.data;
      // The read response is now a typed union: the no-plan branch is `{ carePlan: null }` (no `id`), a
      // real plan carries the assembled fields. Narrow on `"id" in data` so the assembled branch is typed.
      if (!data || !("id" in data) || !data.id) {
        // No plan yet — resolve the admission a bootstrap would hang off, so the empty state can
        // offer the create rather than assert that admission already did it.
        const admissions = await loadPatientAdmissions(client, patientId);
        if (!active) return;
        setOpenAdmissionId(admissions.find((a) => a.dischargedAt == null)?.id ?? null);
        setEmpty(true);
        setLoading(false);
        return;
      }
      setPlan({
        id: data.id,
        status: data.status ?? "draft",
        activeVersionId: data.activeVersionId ?? null,
        versions: (data.versions ?? []) as unknown as Version[],
        problems: (data.problems ?? []) as unknown as Problem[],
        goals: (data.goals ?? []) as unknown as Goal[],
        interventions: (data.interventions ?? []) as unknown as Intervention[],
        redacted: data.redacted ?? false,
      });
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, reloadKey]);

  const sortedProblems = useMemo(
    () =>
      plan
        ? [...plan.problems].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
        : [],
    [plan],
  );
  const activeVersion = plan?.versions.find((v) => v.id === plan.activeVersionId) ?? null;
  const draftVersion = plan?.versions.find((v) => v.status === "draft") ?? null;
  // The version the lifecycle acts on: a draft is edited and finalized; anything finalized-but-unsigned
  // is signed or returned. `activeVersion` is signed and in force — it is not the subject of a ceremony.
  const pendingVersion =
    plan?.versions.find(
      (v) => v.status !== "draft" && v.id !== plan.activeVersionId && !v.signedAt,
    ) ?? null;
  // The §418.56 quorum, as the SERVER published it — slots required vs signatures collected. This chip
  // used to be a static "IDG quorum required to approve" that said the same thing whether the quorum was
  // unmet, met, or not yet applicable. The server decides whether a version activates; this reports it.
  const quorumSubject = pendingVersion ?? draftVersion ?? activeVersion;
  const signatures = quorumSubject?.signatures ?? [];
  const outstandingSlots = (quorumSubject?.requiredSignerSet ?? []).filter(
    (slot) => signatures.filter((sig) => sig.signerRole === slot.role).length < slot.count,
  );

  const bailBanner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}`}
      chips={<MonoChip title="Medical record number">{patient.mrn}</MonoChip>}
    />
  ) : (
    <PatientBanner name="Care Plan" />
  );
  if (loading) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <LoadingSpinner />
      </PatientChartBail>
    );
  }
  if (error) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <EmptyState title="Unavailable" description={error} />
      </PatientChartBail>
    );
  }
  if (empty || !plan) {
    // F-066 (#161) — this used to say the plan "is created when the patient is admitted", which was
    // not true of anything in the product: `POST /patients/:id/care-plan` had a client and no control,
    // and no caller could resolve the `admissionId` it requires. The plan of care is the legal
    // predicate for delivering hospice care at all (42 CFR 418.56(b)), so "it will appear by itself"
    // was the one description that could not be acted on.
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <EmptyState
          title="No care plan yet"
          description={
            openAdmissionId
              ? "Start the individualised plan of care for this admission (42 CFR 418.56(b)). Problems, goals, and interventions are added to it here."
              : "This patient has no open admission, so there is no admission to hang a plan of care on. Admit the patient first."
          }
          action={
            openAdmissionId ? (
              <Button
                onClick={() => {
                  if (!patientId || !openAdmissionId || starting) return;
                  setStarting(true);
                  setStartError(null);
                  void bootstrapCarePlan(client, patientId, openAdmissionId).then((res) => {
                    setStarting(false);
                    if (!res.ok) {
                      setStartError("Could not start the care plan.");
                      return;
                    }
                    setEmpty(false);
                    reload();
                  });
                }}
                disabled={starting}
              >
                {starting ? "Starting…" : "Start the care plan"}
              </Button>
            ) : undefined
          }
        />
        {startError ? (
          <p role="alert" aria-live="assertive" style={{ color: "var(--color-error)" }}>
            {startError}
          </p>
        ) : null}
      </PatientChartBail>
    );
  }

  const age = patient ? ageYears(patient.dob) : null;
  const versionBadge = activeVersion
    ? `v${activeVersion.sequence} · ${cap(activeVersion.status)}`
    : `${cap(plan.status)} (no signed version)`;

  return (
    <PatientWorkspaceLayout
      banner={
        patient ? (
          <PatientBanner
            name={`${patient.firstName} ${patient.lastName}`}
            meta={`DOB ${patient.dob}${age != null ? ` · ${age}y` : ""}`}
            chips={
              <>
                <MonoChip title="Medical record number">{patient.mrn}</MonoChip>
                <StatusPill label={cap(patient.status)} tone={toneFor(patient.status)} />
                {plan.redacted ? (
                  <span style={restricted}>
                    <Glyph name="lock" size={12} /> some content restricted
                  </span>
                ) : null}
              </>
            }
            actions={
              <Link to={`/patients/${patientId}`} style={ghostBtn}>
                Open chart
              </Link>
            }
          />
        ) : (
          <PatientBanner name="Care Plan" />
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <ChartModuleRail patientId={patientId ?? ""} current="care-plan" />

          {/* Center — the interdisciplinary care plan document */}
          <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
                marginBottom: "1rem",
              }}
            >
              <h1
                style={{
                  margin: 0,
                  fontFamily: t.fontDisplay,
                  fontWeight: 500,
                  fontSize: "1.375rem",
                  color: t.onSurface,
                }}
              >
                Interdisciplinary care plan
              </h1>
              <StatusPill
                label={versionBadge}
                tone={activeVersion ? toneFor(activeVersion.status) : "neutral"}
              />
            </div>

            <section style={{ ...cardSurface, padding: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
                <Button size="sm" onClick={() => setElement({ action: "create-problem" })}>
                  Add problem
                </Button>
              </div>
              {sortedProblems.length === 0 ? (
                <p style={meta}>No problems on this plan.</p>
              ) : (
                sortedProblems.map((p, i) => (
                  <ProblemBlock
                    key={p.id}
                    first={i === 0}
                    problem={p}
                    goals={plan.goals.filter((g) => g.problemId === p.id)}
                    interventions={plan.interventions.filter((iv) => iv.problemId === p.id)}
                    onAct={(action, problemId, subject) =>
                      setElement({ action, problemId, subject })
                    }
                  />
                ))
              )}
            </section>
          </div>

          {/* Right rail — IDG review + AI suggestion */}
          <aside style={rightRail}>
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>IDG review</h2>
              {activeVersion ? (
                <p style={meta}>
                  Active v{activeVersion.sequence} ({cap(activeVersion.kind)})
                  {activeVersion.signedAt ? ` · signed ${activeVersion.signedAt.slice(0, 10)}` : ""}
                </p>
              ) : (
                <p style={meta}>No active (signed) version yet.</p>
              )}
              {activeVersion ? (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0.5rem 0 0",
                    fontSize: "0.8rem",
                  }}
                >
                  {activeVersion.requiredSignerSet.map((slot) => {
                    const collected = activeVersion.signatures.filter(
                      (sig) => sig.signerRole === slot.role,
                    ).length;
                    const signed = collected >= slot.count;
                    return (
                      <li
                        key={slot.role}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          margin: "0.25rem 0",
                          color: signed ? t.success : t.warning,
                        }}
                      >
                        <Glyph name={signed ? "check-circle" : "clock"} size={13} />
                        {cap(slot.role)}
                        {slot.count > 1 ? ` ${collected}/${slot.count}` : ""}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <p style={{ ...meta, marginTop: "0.5rem" }}>
                Patient/family participation is recorded with the plan · CoP §418.56(a).
              </p>
            </div>

            {/* AI suggestion — honest placeholder; real care-plan suggestions arrive with M29 (not built). */}
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={{ ...railTitle, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <Glyph name="sparkle" size={15} /> AI suggestion
              </h2>
              <p style={meta}>
                AI-assisted care-plan suggestions (grounded in the chart, with a provenance +
                confidence label and accept/dismiss) arrive with the M29 Clinical Copilot. None are
                generated yet.
              </p>
            </div>
          </aside>
        </div>

        {/* Sticky footer — the REAL quorum state + the §2 version ceremonies */}
        <div style={footer}>
          {outstandingSlots.length > 0 ? (
            <span style={guardChip}>
              <Glyph name="lock" size={14} /> Awaiting{" "}
              {outstandingSlots.map((slot) => cap(slot.role)).join(", ")}
            </span>
          ) : quorumSubject?.status === "draft" ? (
            <span style={guardChip}>
              <Glyph name="lock" size={14} /> Draft — close for signature to collect the IDG quorum
            </span>
          ) : (
            <span style={{ flex: 0 }} />
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => navigate(`/care-plans/${plan.id}/summary`)}
            style={ghostBtn}
          >
            Patient-friendly summary
          </button>
          <button
            type="button"
            onClick={() => navigate(`/care-plans/${plan.id}/versions`)}
            style={ghostBtn}
          >
            Version history
          </button>
          {/* Each ceremony is offered only in the state the SERVER accepts it in, so no control here
              is one the server will refuse. A draft is closed for signature; a closed-but-unsigned
              version is signed or reopened; with neither, a new version is opened. */}
          {draftVersion ? (
            <button type="button" onClick={() => setVersionAction("finalize")} style={primaryBtn}>
              Close draft for signature
            </button>
          ) : pendingVersion ? (
            <>
              <button
                type="button"
                onClick={() => setVersionAction("return-to-draft")}
                style={ghostBtn}
              >
                Return to draft
              </button>
              <button type="button" onClick={() => setVersionAction("sign")} style={primaryBtn}>
                Sign
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setVersionAction("revise")} style={primaryBtn}>
              Start IDG review
            </button>
          )}
        </div>
      </div>
      {element !== null ? (
        <CarePlanElementModal
          open
          action={element.action}
          planId={plan.id}
          problemId={element.problemId ?? null}
          subject={element.subject ?? null}
          onClose={() => setElement(null)}
          onDone={reload}
        />
      ) : null}
      {versionAction !== null ? (
        <CarePlanVersionModal
          open
          action={versionAction}
          planId={plan.id}
          version={versionAction === "finalize" ? draftVersion : pendingVersion}
          onClose={() => setVersionAction(null)}
          onDone={reload}
        />
      ) : null}
    </PatientWorkspaceLayout>
  );
}

function ProblemBlock({
  first,
  problem,
  goals,
  interventions,
  onAct,
}: {
  first: boolean;
  problem: Problem;
  goals: Goal[];
  interventions: Intervention[];
  /** Opens the authoring modal. The block never writes; it names the operation and its subject. */
  onAct: (action: ElementAction, problemId: string | null, subject: ElementSubject | null) => void;
}): JSX.Element {
  return (
    <div
      style={{
        paddingTop: first ? 0 : "1.25rem",
        marginTop: first ? 0 : "1.25rem",
        borderTop: first ? "none" : ghostBorder,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: t.onSurface }}>{problem.description}</span>
        <span style={chip}>{cap(problem.kind)}</span>
        <StatusPill label={cap(problem.status)} tone={toneFor(problem.status)} />
        {problem.sudRelated ? (
          <span style={restricted}>
            <Glyph name="lock" size={11} /> SUD
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {problem.status !== "resolved" ? (
          <span style={{ display: "flex", gap: "0.375rem" }}>
            <Button size="sm" tone="tertiary" onClick={() => onAct("edit-problem", null, problem)}>
              Edit
            </Button>
            <Button
              size="sm"
              tone="tertiary"
              onClick={() => onAct("resolve-problem", null, problem)}
            >
              Resolve
            </Button>
          </span>
        ) : null}
      </div>

      <div style={indentBlock}>
        <span style={miniLabel}>
          Goals{" "}
          <Button size="sm" tone="tertiary" onClick={() => onAct("create-goal", problem.id, null)}>
            Add goal
          </Button>
        </span>
        {goals.length === 0 ? (
          <p style={meta}>None recorded.</p>
        ) : (
          goals.map((g) => (
            <div key={g.id} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
              <Glyph name="dot" size={12} />
              <span style={{ flex: 1 }}>
                <span
                  style={{
                    color: t.onSurface,
                    fontStyle: g.source !== "clinical" ? "italic" : "normal",
                  }}
                >
                  {g.revisedText ?? g.originalText}
                </span>
                {g.source !== "clinical" ? <span style={tag}> {cap(g.source)}-stated</span> : null}
              </span>
              <StatusPill label={cap(g.status)} tone={toneFor(g.status)} />
              <Button size="sm" tone="tertiary" onClick={() => onAct("edit-goal", problem.id, g)}>
                Revise
              </Button>
            </div>
          ))
        )}
      </div>

      <div style={indentBlock}>
        <span style={miniLabel}>
          Interventions{" "}
          <Button
            size="sm"
            tone="tertiary"
            onClick={() => onAct("create-intervention", problem.id, null)}
          >
            Add intervention
          </Button>
        </span>
        {interventions.length === 0 ? (
          <p style={meta}>None recorded.</p>
        ) : (
          interventions.map((iv) => (
            <div key={iv.id} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
              <Glyph name="dot" size={12} />
              <span style={{ flex: 1, color: t.onSurface }}>
                {iv.scopeText}
                <span style={tag}>
                  {" "}
                  {cap(iv.discipline)} · {iv.frequencyText}
                </span>
              </span>
              <StatusPill label={cap(iv.status)} tone={toneFor(iv.status)} />
              {iv.status !== "discontinued" ? (
                <span style={{ display: "flex", gap: "0.375rem" }}>
                  <Button
                    size="sm"
                    tone="tertiary"
                    onClick={() => onAct("edit-intervention", problem.id, iv)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    tone="tertiary"
                    onClick={() => onAct("discontinue-intervention", problem.id, iv)}
                  >
                    Stop
                  </Button>
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MonoChip({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span
      title={title}
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
  width: "20rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  background: t.surfaceLow,
};
const railTitle: CSSProperties = {
  margin: "0 0 0.5rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const footer: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  padding: "0.875rem 1.5rem",
  borderTop: ghostBorder,
  background: t.surfaceLowest,
  flexShrink: 0,
};
const guardChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: t.warning,
  background: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
  borderRadius: "9999px",
  padding: "0.3rem 0.7rem",
};
const ghostBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.45rem 0.9rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.8125rem",
  fontWeight: 600,
  textDecoration: "none",
  border: "none",
  cursor: "pointer",
};
const primaryBtn: CSSProperties = {
  padding: "0.45rem 1rem",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const indentBlock: CSSProperties = {
  paddingLeft: "0.5rem",
  marginTop: "0.6rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  fontSize: "0.875rem",
};
const miniLabel: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: t.muted,
};
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};
const chip: CSSProperties = {
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  borderRadius: "9999px",
  padding: "0.05rem 0.5rem",
  fontWeight: 600,
  fontSize: "0.72rem",
};
const tag: CSSProperties = { color: t.muted, fontSize: "0.75rem" };
const restricted: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  color: t.warning,
  fontSize: "0.72rem",
  fontWeight: 600,
};
