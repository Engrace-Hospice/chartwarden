import {
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
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import { cap, toneFor } from "./care-plan-status";

interface Version {
  id: string;
  sequence: number;
  kind: string;
  status: string;
  signatures: { signerRole: string; signedAt: string }[];
  requiredSignerSet: string[];
  signedAt: string | null;
}
interface Problem {
  id: string;
  description: string;
  kind: string;
  source: string;
  sudRelated: boolean;
  status: string;
}
interface Goal {
  id: string;
  problemId: string;
  originalText: string;
  revisedText: string | null;
  source: string;
  status: string;
}
interface Intervention {
  id: string;
  problemId: string;
  scopeText: string;
  frequencyText: string;
  discipline: string;
  status: string;
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
  }, [client, patientId]);

  const sortedProblems = useMemo(
    () =>
      plan
        ? [...plan.problems].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
        : [],
    [plan],
  );
  const activeVersion = plan?.versions.find((v) => v.id === plan.activeVersionId) ?? null;
  const draftVersion = plan?.versions.find((v) => v.status === "draft") ?? null;

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
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <EmptyState
          title="No care plan yet"
          description="An initial IPOC is created when the patient is admitted; problems, goals, and interventions appear here."
        />
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
                  {activeVersion.requiredSignerSet.map((role) => {
                    const signed = activeVersion.signatures.some((s) => s.signerRole === role);
                    return (
                      <li
                        key={role}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          margin: "0.25rem 0",
                          color: signed ? t.success : t.warning,
                        }}
                      >
                        <Glyph name={signed ? "check-circle" : "clock"} size={13} />
                        {cap(role)}
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

        {/* Sticky footer — IDG-quorum guard + the real plan actions */}
        <div style={footer}>
          <span style={guardChip}>
            <Glyph name="lock" size={14} /> IDG quorum required to approve
          </span>
          <span style={{ flex: 1 }} />
          {draftVersion ? (
            <button
              type="button"
              onClick={() => navigate(`/care-plans/${plan.id}/versions`)}
              style={ghostBtn}
            >
              Open draft (v{draftVersion.sequence})
            </button>
          ) : null}
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
            style={primaryBtn}
          >
            Version history
          </button>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function ProblemBlock({
  first,
  problem,
  goals,
  interventions,
}: {
  first: boolean;
  problem: Problem;
  goals: Goal[];
  interventions: Intervention[];
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
      </div>

      <div style={indentBlock}>
        <span style={miniLabel}>Goals</span>
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
            </div>
          ))
        )}
      </div>

      <div style={indentBlock}>
        <span style={miniLabel}>Interventions</span>
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
