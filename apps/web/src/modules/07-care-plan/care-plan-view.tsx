import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/07-care-plan — Care Plan View (M7 §5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CARE_PLAN.md — "Use Patient Workspace + Documentation Workspace."
// The active IPOC for a patient: a problems list (terminal first, then related, then unrelated) | the
// selected problem's goals + interventions | a right aside with the next-review date + current signers
// and an "Open draft" affordance. SUD-flagged problems the caller may not see are omitted SERVER-side
// (§7.6 SQL-level WHERE; the response carries `redacted: true`) — never a frontend hide. Patient/agent-
// stated goals render in a distinct style. Reads GET /api/v1/patients/:patientId/care-plan via the
// typed client; the server enforces every scope (no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
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

// Terminal first, then related, then unrelated — the spec's problem ordering.
const KIND_ORDER: Record<string, number> = { terminal: 0, related: 1, unrelated: 2 };

export function CarePlanView(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/patients/{patientId}/care-plan", {
        params: { path: { patientId } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the care plan.");
        setLoading(false);
        return;
      }
      // The no-plan response is `{ carePlan: null }` (no `id`); a real plan carries the assembled fields.
      if (!data?.id) {
        setEmpty(true);
        setLoading(false);
        return;
      }
      const loaded: CarePlan = {
        id: data.id,
        status: data.status ?? "draft",
        activeVersionId: data.activeVersionId ?? null,
        versions: (data.versions ?? []) as Version[],
        problems: (data.problems ?? []) as Problem[],
        goals: (data.goals ?? []) as Goal[],
        interventions: (data.interventions ?? []) as Intervention[],
        redacted: data.redacted ?? false,
      };
      setPlan(loaded);
      setSelectedProblemId(loaded.problems[0]?.id ?? null);
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

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (empty || !plan)
    return (
      <EmptyState
        title="No care plan yet"
        description="An initial IPOC is created when the patient is admitted; problems, goals, and interventions appear here."
      />
    );

  const selectedGoals = plan.goals.filter((g) => g.problemId === selectedProblemId);
  const selectedInterventions = plan.interventions.filter((i) => i.problemId === selectedProblemId);

  return (
    <DetailPageLayout
      header={
        <PageHeader title="Care Plan">
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
            <StatusPill label={cap(plan.status)} tone={toneFor(plan.status)} />
            {plan.redacted ? (
              <span
                style={{ ...meta, display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
              >
                <Glyph name="lock" size={12} /> some content restricted
              </span>
            ) : null}
          </span>
        </PageHeader>
      }
      aside={
        <aside
          style={{
            width: "18rem",
            flexShrink: 0,
            borderLeft: "1px solid var(--color-outline-variant)",
            padding: "1.5rem",
            overflow: "auto",
          }}
        >
          <h3 style={h3}>Review & signers</h3>
          {activeVersion ? (
            <>
              <p style={meta}>
                Active version v{activeVersion.sequence} ({activeVersion.kind})
                {activeVersion.signedAt ? ` · signed ${activeVersion.signedAt.slice(0, 10)}` : ""}
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0", fontSize: "0.8rem" }}>
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
                        color: signed ? "var(--color-success)" : "var(--color-warning)",
                      }}
                    >
                      <Glyph name={signed ? "check-circle" : "clock"} size={13} />
                      {cap(role)}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p style={meta}>No active (signed) version yet.</p>
          )}
          {draftVersion ? (
            <button
              type="button"
              onClick={() => navigate(`/care-plans/${plan.id}/versions`)}
              style={{ marginTop: "0.75rem" }}
            >
              Open draft (v{draftVersion.sequence})
            </button>
          ) : null}
          <div
            style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}
          >
            <button type="button" onClick={() => navigate(`/care-plans/${plan.id}/versions`)}>
              Version history
            </button>
            <button type="button" onClick={() => navigate(`/care-plans/${plan.id}/summary`)}>
              Patient-friendly summary
            </button>
          </div>
        </aside>
      }
    >
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>
        {/* Problems list */}
        <div style={{ width: "16rem", flexShrink: 0 }}>
          <h3 style={h3}>Problems</h3>
          {sortedProblems.length === 0 ? (
            <p style={meta}>No problems on this plan.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {sortedProblems.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedProblemId(p.id)}
                    aria-pressed={p.id === selectedProblemId}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "0.5rem",
                      border: "none",
                      borderLeft:
                        p.id === selectedProblemId
                          ? "3px solid var(--color-primary)"
                          : "3px solid transparent",
                      background:
                        p.id === selectedProblemId ? "var(--color-primary-tint)" : "transparent",
                      cursor: "pointer",
                      fontSize: "0.85rem",
                      color: "var(--color-on-surface)",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{p.description}</span>
                    <br />
                    <span
                      style={{
                        ...meta,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.3rem",
                      }}
                    >
                      {cap(p.kind)} · {cap(p.status)}
                      {p.sudRelated ? (
                        <>
                          {" · "}
                          <Glyph name="lock" size={11} /> SUD
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Selected problem's goals + interventions */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={h3}>Goals</h3>
          {selectedGoals.length === 0 ? (
            <p style={meta}>No goals for the selected problem.</p>
          ) : (
            selectedGoals.map((g) => (
              <div key={g.id} style={card}>
                {g.source !== "clinical" ? (
                  <div style={{ marginBottom: "0.4rem" }}>
                    <StatusPill label={`${cap(g.source)}-stated`} tone="neutral" glyph="info" />
                  </div>
                ) : null}
                <p
                  style={{
                    margin: 0,
                    color: "var(--color-on-surface)",
                    fontStyle: g.source !== "clinical" ? "italic" : "normal",
                  }}
                >
                  {g.revisedText ?? g.originalText}
                </p>
                {g.revisedText && g.source !== "clinical" ? (
                  <p style={meta}>
                    Original ({g.source}): {g.originalText}
                  </p>
                ) : null}
                <div style={{ marginTop: "0.4rem" }}>
                  <StatusPill label={cap(g.status)} tone={toneFor(g.status)} />
                </div>
              </div>
            ))
          )}
          <h3 style={{ ...h3, marginTop: "1.25rem" }}>Interventions</h3>
          {selectedInterventions.length === 0 ? (
            <p style={meta}>No interventions for the selected problem.</p>
          ) : (
            selectedInterventions.map((i) => (
              <div key={i.id} style={card}>
                <p style={{ margin: 0, color: "var(--color-on-surface)" }}>{i.scopeText}</p>
                <div
                  style={{
                    marginTop: "0.4rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={chip}>{cap(i.discipline)}</span>
                  <span style={meta}>{i.frequencyText}</span>
                  <StatusPill label={cap(i.status)} tone={toneFor(i.status)} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </DetailPageLayout>
  );
}

const h3 = {
  fontSize: "0.8rem",
  textTransform: "uppercase",
  color: "var(--color-on-surface-variant)",
  margin: "0 0 0.5rem",
} as const;
const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const card = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.375rem",
  padding: "0.75rem",
  marginBottom: "0.5rem",
  background: "var(--color-surface-lowest)",
} as const;
const chip = {
  display: "inline-block",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  borderRadius: "0.25rem",
  padding: "0 0.375rem",
  fontWeight: 600,
  fontSize: "0.75rem",
} as const;
