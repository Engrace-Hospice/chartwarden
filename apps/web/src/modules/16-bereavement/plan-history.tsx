// apps/web/src/modules/16-bereavement — the PLAN HISTORY AUDIT VIEW (§5.1 #19, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Record Detail."
//
// §7.15's survey-reconstruction surface: the compliance officer / survey coordinator / auditor opens one
// plan and sees, in chronological order, everything that happened to it.
//
// WHERE THE TIMELINE COMES FROM. M16 publishes no "plan event log" route — the authoritative event trail
// is Module 4's immutable audit store, which has its own reader and its own permission surface. So this
// screen RECONSTRUCTS the timeline from the three M16 read routes it does have (the plan detail's dated
// state fields, the full touchpoint book, and the append-only score ledger), and it SAYS SO. Each entry is
// therefore a fact the plan's own rows carry, not a paraphrase of an audit row this module never read.
//
// The honest gap is stated on the screen rather than papered over: the M4 audit trail carries entries this
// reconstruction cannot — a read that was refused, a break-glass access, the exact actor on a cascade —
// and a surveyor who needs those goes to the audit surface that owns them.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ClosureView,
  type OutreachRow,
  type PlanDetail,
  type RiskScoreRow,
  errorMessage,
  getClosure,
  getPlan,
  listOutreach,
  listRiskScores,
} from "./bereavement-api";
import {
  CLOSURE_REASON_TONE,
  anniversaryMarkLabel,
  dateTime,
  humanize,
  outreachKindLabel,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
  Notice,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./bereavement-ui";

type Entry = {
  at: string;
  category: "Plan" | "Contact" | "Touchpoint" | "Risk" | "Closure";
  what: string;
  detail: string;
};

export function BereavementPlanHistory(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [closureReason, setClosureReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const [detail, outreach, scores, closureRes] = await Promise.all([
      getPlan(client, planId),
      listOutreach(client, planId, { limit: 200 }),
      listRiskScores(client, planId, { limit: 100 }),
      getClosure(client, planId),
    ]);
    if (detail.error || !detail.plan) {
      setError(errorMessage(detail.error, "This bereavement plan could not be loaded."));
      setLoading(false);
      return;
    }
    setClosureReason(closureRes.closure?.reason ?? null);
    setEntries(
      buildTimeline(
        detail.plan,
        outreach.page?.data ?? [],
        scores.page?.data ?? [],
        closureRes.closure,
      ),
    );
    setLoading(false);
  }, [client, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Plan history</span>}
        breadcrumb={`Bereavement — plan ${shortId(planId ?? "")}`}
        actions={
          <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
            Back to plan
          </Link>
        }
      />

      <Notice tone="info">
        Reconstructed from this plan's own rows — the dated fields on the plan and its survivors,
        the full touchpoint book, the append-only risk ledger, and the closure record. The immutable
        audit trail carries entries this view cannot reconstruct (a refused read, a break-glass
        access, the acting principal on a cascade); those live on the audit surface that owns them.
      </Notice>

      {closureReason ? (
        <Notice tone="info">
          Closed:{" "}
          <StatusPill
            label={humanize(closureReason)}
            tone={toneOf(CLOSURE_REASON_TONE, closureReason)}
          />
        </Notice>
      ) : null}

      <Card title={`Timeline (${entries.length})`}>
        {entries.length === 0 ? (
          <span style={mutedStyle}>Nothing dated has happened on this plan yet.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Area</th>
                <th style={th}>Event</th>
                <th style={th}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={`${e.at}-${e.category}-${e.what}-${e.detail}`} style={rowLine}>
                  <td style={td}>{dateTime(e.at)}</td>
                  <td style={td}>{e.category}</td>
                  <td style={td}>{e.what}</td>
                  <td style={td}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/** Fold the four reads into one chronological list. Undated facts are omitted, never given a guessed date. */
function buildTimeline(
  plan: PlanDetail,
  outreach: OutreachRow[],
  scores: RiskScoreRow[],
  closure: ClosureView | null,
): Entry[] {
  const out: Entry[] = [];
  const push = (
    at: string | null | undefined,
    category: Entry["category"],
    what: string,
    detail: string,
  ) => {
    if (at) out.push({ at, category, what, detail });
  };

  const nameOf = (contactId: string | null) =>
    contactId === null
      ? "plan-level"
      : (plan.contacts.find((c) => c.contactId === contactId)?.displayName ?? shortId(contactId));

  // ── plan-level state transitions the plan row dates ──
  push(
    plan.assignedCounselorAssignedAt,
    "Plan",
    "Counselor assigned",
    shortId(plan.assignedCounselorUserId),
  );
  push(
    plan.assignedVolunteerAssignedAt,
    "Plan",
    "Volunteer assigned",
    shortId(plan.assignedVolunteerUserId),
  );
  push(plan.openedAt, "Plan", "Plan opened", "roster seeded and schedule materialized");
  push(plan.pausedAt, "Plan", "Plan paused", humanize(plan.pauseKind));
  push(plan.closedAt, "Plan", "Plan closed", humanize(plan.status));
  if (plan.externalSource?.ackReceivedAt)
    push(
      String(plan.externalSource.ackReceivedAt),
      "Plan",
      "External death notice acknowledged",
      String(plan.externalSource.sourceFacilityName ?? "external source"),
    );
  if (plan.externalSource?.cosignedAt)
    push(
      String(plan.externalSource.cosignedAt),
      "Plan",
      "Medical-director cosign received",
      "first-contact gate released",
    );

  // ── per-survivor lifecycle ──
  for (const c of plan.contacts) {
    push(c.confirmedAt, "Contact", "Survivor confirmed", c.displayName);
    push(c.optedOutAt, "Contact", "Opted out", c.displayName);
    push(c.unreachableAt, "Contact", "Marked unreachable", c.displayName);
    push(c.deceasedAt, "Contact", "Survivor deceased", c.displayName);
  }

  // ── touchpoints ──
  for (const o of outreach) {
    const label = `${outreachKindLabel(o.kind)}${o.anniversaryMark ? ` (${anniversaryMarkLabel(o.anniversaryMark)})` : ""}`;
    push(o.startedAt, "Touchpoint", "Started", `${label} — ${nameOf(o.contactId)}`);
    push(
      o.completedAt,
      "Touchpoint",
      "Completed",
      `${label} — ${nameOf(o.contactId)}${o.sourceEncounterId ? ` · encounter ${shortId(o.sourceEncounterId)}` : ""}`,
    );
    push(o.cancelledAt, "Touchpoint", "Cancelled", `${label} — ${nameOf(o.contactId)}`);
  }

  // ── risk ledger (every row is an append; an override shows as a tier off the rubric's) ──
  for (const s of scores) {
    const overridden = s.tier !== s.deterministicTier;
    push(
      s.assessedAt,
      "Risk",
      overridden ? "Score recorded with counselor override" : "Score recorded",
      `${nameOf(s.contactId)} — ${humanize(s.tier)}${overridden ? ` (rubric: ${humanize(s.deterministicTier)})` : ""} · ${s.confidenceBand} confidence${s.evidenceDegraded ? " · evidence degraded" : ""}`,
    );
  }

  // ── closure ──
  if (closure) {
    push(closure.closedAt, "Closure", humanize(closure.reason), humanize(closure.closeKind));
    push(closure.cosignedAt, "Closure", "Early close cosigned", shortId(closure.cosignedByUserId));
  }

  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
