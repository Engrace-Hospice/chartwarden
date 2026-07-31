import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the IDG-DRIVEN REVISION REVIEW (§5.1 #14, Track B).
// Spec layout: "Use Detail Page."
//
// After an IDG meeting adjourns, M14's `idg.decision_recorded` outbox event is consumed by M15 and its
// mutations are APPLIED to the plan, opening a new draft version (§7.7). This screen is the plan author's
// review of that already-applied revision before it is finalized and signed — it is a finalize gate, not a
// second approval of the IDG's decision. The IDG decided; M15 recorded; the author confirms the record.
//
// The screen therefore reads what the consumer WROTE (the draft version's goals and interventions, tagged
// with the IDG meeting the version carries) rather than re-reading M14 — M15 owns no M14 schema and has no
// M14 read seam, so anything else would be a cross-module import the boundary forbids.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type PlanDetail,
  type VersionDetail,
  errorMessage,
  getPlanByKind,
  getVersion,
  normalizeSignerSet,
  writeHeaders,
} from "./discipline-api";
import {
  Card,
  Field,
  Notice,
  SummaryGrid,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";
import {
  GOAL_STATUS_TONE,
  INTERVENTION_STATUS_TONE,
  VERSION_STATUS_TONE,
  dateTime,
  humanize,
  kindLabel,
  shortId,
  toneOf,
} from "./discipline-status";

export function IdgRevisionReview(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId, kind, versionId } = useParams<{
    patientId: string;
    kind: string;
    versionId: string;
  }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId || !kind || !versionId) return;
    setLoading(true);
    setError(null);
    const { plan: loaded, error: planErr } = await getPlanByKind(client, patientId, kind);
    if (planErr || !loaded) {
      setError(errorMessage(planErr, `No ${kindLabel(kind)} is available for this patient.`));
      setLoading(false);
      return;
    }
    setPlan(loaded);
    const { version: v, error: vErr } = await getVersion(client, loaded.planId, versionId);
    if (vErr || !v) {
      setError(errorMessage(vErr, "This revision could not be opened."));
      setLoading(false);
      return;
    }
    setVersion(v);
    setLoading(false);
  }, [client, patientId, kind, versionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Finalize the reviewed revision — seals its snapshot and freezes the D11 quorum. */
  async function finalize(): Promise<void> {
    if (!plan || !version) return;
    setActionError(null);
    const res = await client.POST(
      "/api/v1/discipline-plans/{planId}/versions/{versionId}/finalize",
      {
        params: {
          path: { planId: plan.planId, versionId: version.versionId },
          header: writeHeaders(version.version),
        },
        body: {},
      } as never,
    );
    if (res.error) {
      setActionError(errorMessage(res.error, "This revision could not be finalized."));
      return;
    }
    navigate(`/patients/${patientId}/discipline-plans/${(kind ?? "").replace(/_/g, "-")}`);
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan || !version)
    return <EmptyState title="Not found" description="This revision is not available." />;

  // The goals/interventions the IDG consumer touched most recently — the revision's visible content. The
  // plan read carries no per-mutation provenance, so the ordering (newest authored first) is the honest
  // proxy, and it is labelled as such rather than presented as an IDG-attributed diff.
  const recentGoals = [...plan.goals]
    .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
    .slice(0, 10);
  const recentInterventions = [...plan.interventions]
    .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
    .slice(0, 10);

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{kindLabel(kind)} — IDG revision review</span>}
        breadcrumb="Clinical — post-IDG finalization"
        actions={
          <Link to={`/patients/${patientId}/discipline-plans/${kind}/versions`} style={ghostButtonStyle}>
            Version history
          </Link>
        }
      />

      <Notice tone="info">
        The interdisciplinary group's decisions have already been applied to this plan. Reviewing here
        confirms the record before the revision is finalized and signed — it does not re-decide it.
      </Notice>
      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card
        title={`Version ${version.sequence}`}
        actions={
          <StatusPill
            label={humanize(version.status)}
            tone={toneOf(VERSION_STATUS_TONE, version.status)}
          />
        }
      >
        <SummaryGrid>
          <Field label="Version kind" value={humanize(version.kind)} />
          <Field label="IDG meeting" value={shortId(version.idgMeetingId)} mono />
          <Field label="Finalized" value={dateTime(version.finalizedAt)} />
          <Field label="Signed" value={dateTime(version.signedAt)} />
        </SummaryGrid>
        {version.status === "draft" ? (
          <button type="button" style={primaryButtonStyle} onClick={() => void finalize()}>
            Finalize revision
          </button>
        ) : (
          <span style={mutedStyle}>
            This revision is {humanize(version.status).toLowerCase()} — its snapshot is sealed. Signing
            happens on the plan view.
          </span>
        )}
        {normalizeSignerSet(version.requiredSignerSet).length > 0 ? (
          <span style={mutedStyle}>
            Quorum:{" "}
            {normalizeSignerSet(version.requiredSignerSet)
              .map((s) => `${humanize(s.role)}${s.isAcknowledgment ? " (ack)" : ""} ×${s.count}`)
              .join(" · ")}
          </span>
        ) : null}
      </Card>

      <Card title="Most recently authored goals">
        {recentGoals.length === 0 ? (
          <span style={mutedStyle}>No goals on this plan.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Goal</th>
                <th style={th}>Source</th>
                <th style={th}>Added</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentGoals.map((g) => (
                <tr key={g.goalId} style={rowLine}>
                  <td style={td}>{g.revisedText ?? g.originalText}</td>
                  <td style={td}>{humanize(g.source)}</td>
                  <td style={td}>{dateTime(g.addedAt)}</td>
                  <td style={td}>
                    <StatusPill label={humanize(g.status)} tone={toneOf(GOAL_STATUS_TONE, g.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Most recently authored interventions">
        {recentInterventions.length === 0 ? (
          <span style={mutedStyle}>No interventions on this plan.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Scope</th>
                <th style={th}>Frequency</th>
                <th style={th}>Added</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentInterventions.map((iv) => (
                <tr key={iv.interventionId} style={rowLine}>
                  <td style={td}>{iv.scopeText}</td>
                  <td style={td}>{iv.frequencyText}</td>
                  <td style={td}>{dateTime(iv.addedAt)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(iv.status)}
                      tone={toneOf(INTERVENTION_STATUS_TONE, iv.status)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={{ ...mutedStyle, color: t.onSurfaceVariant }}>
          Ordered by authorship time; the plan read carries no per-mutation IDG attribution.
        </span>
      </Card>
    </div>
  );
}
