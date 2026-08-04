// apps/web/src/modules/19-oncall — S19.11 ON-CALL PROGRAM METRICS (`/triage/metrics`, §5.1, Track B /
// ADR-0030). Spec: WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md — the Performance Metrics tab.
//
// READ THIS BEFORE READING A NUMBER ON THIS PAGE: EVERY FIGURE IS PAGE-DERIVED, AND SEVERAL §5.1 METRICS
// ARE NOT BUILT AT ALL.
//
// `TriageCallMetricsProvider` is a SEAM, not a route. §4.1 publishes no aggregate endpoint, and §4.1.1
// forbids `total_count` on a PHI list because a count is an enumeration oracle. So this screen computes
// what it can from the call page it fetched, states the window it fetched, and carries an explicit "at
// least" notice the moment that page is truncated. A dashboard that silently under-counts escalations is
// worse than no dashboard: the whole point of the escalation rate is that somebody acts on it.
//
// FIVE §5.1 METRICS ARE ABSENT AND THE SCREEN NAMES EACH ONE rather than approximating it:
//   • Hospitalization-avoidance rate — the outcome (did the patient go to hospital anyway?) lives in
//     admission/encounter data M19 does not read. A "rate" computed from dispositions alone would count
//     an intention as an outcome.
//   • After-hours visit-conversion rate — the conversion happens when the scheduling module accepts the
//     visit proposal, and M19 sees only that it emitted one.
//   • Late-checkout-to-triage conversion rate — the denominator (how many late check-outs occurred) is
//     the EVV module's, not M19's.
//   • Calls per shift / per clinician — requires joining calls to the covering shift's actor, and the
//     call list carries no membership.
//   • AI-suggestion acceptance / override rate — the suggestion and the selection are both recorded, but
//     the list DTO carries neither, so the figure would have to be assembled from per-call detail reads,
//     which is a PHI read per row for a management statistic. It belongs to the AI-governance surface that
//     already receives the suggestion-vs-selection deltas.
//
// WHAT IS BUILT IS WHAT THE LIST DTO HONESTLY SUPPORTS: volume, disposition mix, escalation and red-flag
// incidence, mean time to first response and mean time to close, and the coverage-gap verdict per
// ProviderEntity read live.
import { EmptyState, LoadingSpinner, PageHeader, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type CurrentOnCallView,
  type TriageCallListItem,
  errorMessage,
  getCurrentOnCall,
  listTriageCalls,
} from "./oncall-api";
import { dateTime, dispositionLabel, durationLabel, humanize, shortId } from "./oncall-status";
import {
  Card,
  CountGrid,
  FilterRow,
  Notice,
  SelectField,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./oncall-ui";

const METRICS_PAGE = 100;

const WINDOWS = [
  { value: "1", label: "last 24 hours" },
  { value: "7", label: "last 7 days" },
  { value: "30", label: "last 30 days" },
];

/** Mean of a numeric list, or null for an empty one. A mean over nothing is not 0 — it is unanswerable,
 *  and rendering 0 minutes to disposition on a night with no calls would read as an achievement. */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Whole minutes between two instants, or null when either is missing/unparseable. */
function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((b - a) / 60_000));
}

export function TriageMetricsScreen(): JSX.Element {
  const client = useApiClient();
  const [days, setDays] = useState("7");
  const [calls, setCalls] = useState<TriageCallListItem[]>([]);
  const [current, setCurrent] = useState<CurrentOnCallView | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const openedFrom = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
    const [board, now] = await Promise.all([
      listTriageCalls(client, { limit: METRICS_PAGE, openedFrom }),
      getCurrentOnCall(client, {}),
    ]);
    if (board.error) {
      setError(errorMessage(board.error, "The call history could not be read."));
      setLoading(false);
      return;
    }
    setCalls(board.page?.data ?? []);
    setTruncated(board.page?.has_more ?? false);
    setCurrent(now.current);
    setLoading(false);
  }, [client, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const withEscalation = calls.filter((c) => c.openEscalationCount > 0).length;
  const withRedFlag = calls.filter((c) => c.redFlagAnswerCount > 0).length;
  const abandoned = calls.filter((c) => c.state === "abandoned").length;
  const closed = calls.filter((c) => c.state === "closed" || c.state === "documented").length;
  const fromMachine = calls.filter(
    (c) => c.source !== "manual" && c.source !== "paper_origin",
  ).length;
  const paperOrigin = calls.filter((c) => c.source === "paper_origin").length;

  const firstResponse = calls
    .map((c) => minutesBetween(c.openedAt, c.firstResponseAt))
    .filter((v): v is number => v !== null);
  const toClose = calls
    .map((c) => minutesBetween(c.openedAt, c.closedAt))
    .filter((v): v is number => v !== null);

  const dispositionMix = new Map<string, number>();
  for (const c of calls) {
    if (!c.disposition) continue;
    dispositionMix.set(c.disposition, (dispositionMix.get(c.disposition) ?? 0) + 1);
  }
  const mix = [...dispositionMix.entries()].sort((a, b) => b[1] - a[1]);

  const byHour = new Array<number>(24).fill(0);
  for (const c of calls) {
    const ms = Date.parse(c.openedAt);
    if (!Number.isNaN(ms)) {
      const h = new Date(ms).getHours();
      byHour[h] = (byHour[h] ?? 0) + 1;
    }
  }
  const peakHour = byHour.reduce((best, v, i) => (v > (byHour[best] ?? 0) ? i : best), 0);
  const gapEntities = current?.perProviderEntity.filter((p) => p.rnCoverageGap).length ?? 0;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>On-call metrics</span>}
        breadcrumb="On-call triage · program health"
        actions={
          <Link to="/triage/shifts" style={ghostButtonStyle}>
            Roster
          </Link>
        }
      />

      <Notice tone="info">
        Every number here is computed from the call page this screen fetched — at most{" "}
        {METRICS_PAGE} calls in the selected window. There is no aggregate route and no total count
        on a triage list (a count is an enumeration oracle), so these are program indicators, not a
        census. Where a §5.1 metric cannot be computed honestly, it is listed at the bottom rather
        than approximated.
      </Notice>

      {truncated ? (
        <Notice tone="warning" live>
          The window returned more calls than one page holds. Every count below is therefore "at
          least" — narrow the window before reading any of them as a rate.
        </Notice>
      ) : null}

      <FilterRow>
        <SelectField label="Window" value={days} options={WINDOWS} onChange={setDays} />
      </FilterRow>

      <Card title="Volume">
        <CountGrid
          entries={[
            { label: "Calls in window", value: calls.length },
            { label: "Closed / documented", value: closed },
            { label: "Abandoned", value: abandoned, tone: abandoned > 0 ? "error" : undefined },
            { label: "Machine-triggered", value: fromMachine },
            {
              label: "Re-entered from paper",
              value: paperOrigin,
              tone: paperOrigin > 0 ? "error" : undefined,
            },
            {
              label: "Busiest hour",
              value: calls.length > 0 ? `${String(peakHour).padStart(2, "0")}:00` : "—",
            },
          ]}
        />
        <span style={mutedStyle}>
          Machine-triggered calls are the ones a no-show, a late check-out or a failed alert opened
          — proactive contact the agency made because a system noticed something, not because a
          family rang.
        </span>
      </Card>

      <Card title="Escalation & safety">
        <CountGrid
          entries={[
            { label: "Calls with an escalation", value: withEscalation },
            { label: "Calls with a red-flag answer", value: withRedFlag },
            {
              label: "Provider entities with an RN gap now",
              value: gapEntities,
              tone: gapEntities > 0 ? "error" : undefined,
            },
          ]}
        />
        <span style={mutedStyle}>
          The coverage figure is read live and counted per provider entity, never unioned: coverage
          is proved per CCN, and one covered entity must not mask another's dark night.
        </span>
      </Card>

      <Card title="Timeliness">
        <CountGrid
          entries={[
            {
              label: "Mean time to first response",
              value: durationLabel(mean(firstResponse) ?? undefined),
            },
            { label: "Mean time to close", value: durationLabel(mean(toClose) ?? undefined) },
            { label: "Calls with a first response recorded", value: firstResponse.length },
            { label: "Calls closed in window", value: toClose.length },
          ]}
        />
        <span style={mutedStyle}>
          A mean over no calls is shown as "—", not as zero: an unanswerable average is not an
          achievement. Both means cover only the calls in this page that carry the stamp — the
          counts beside them are the denominators, stated rather than implied.
        </span>
      </Card>

      <Card title="Disposition mix">
        {mix.length === 0 ? (
          <span style={mutedStyle}>No call in this window carries a disposition yet.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Disposition</th>
                <th style={thNum}>Calls</th>
                <th style={thNum}>Share of dispositioned calls</th>
              </tr>
            </thead>
            <tbody>
              {mix.map(([d, n]) => {
                const total = mix.reduce((a, [, v]) => a + v, 0);
                return (
                  <tr key={d} style={rowLine}>
                    <td style={td}>{dispositionLabel(d)}</td>
                    <td style={tdNum}>{n}</td>
                    <td style={tdNum}>{total > 0 ? `${Math.round((n / total) * 100)}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          The share is of calls in this page that HAVE a disposition, not of all calls — an open
          call has not chosen yet, and folding it into the denominator would understate every
          outcome.
        </span>
      </Card>

      <Card title="Coverage right now">
        {!current ? (
          <span style={mutedStyle}>
            The live coverage verdict could not be read. That is an outage, not a finding of "no
            coverage".
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Provider entity</th>
                <th style={th}>RN coverage</th>
                <th style={thNum}>Covering actors</th>
              </tr>
            </thead>
            <tbody>
              {current.perProviderEntity.map((p) => (
                <tr key={p.providerEntityId} style={rowLine}>
                  <td style={td}>{shortId(p.providerEntityId)}</td>
                  <td style={td}>{p.rnCoverageGap ? "Gap — no RN" : "Covered"}</td>
                  <td style={tdNum}>{p.actors.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>Read at {dateTime(current?.asOf)}.</span>
      </Card>

      <Card title="What is deliberately not on this page">
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", color: "inherit" }}>
          <li style={mutedStyle}>
            <strong>Hospitalization-avoidance rate.</strong> The outcome lives in admission data M19
            does not read; computing it from dispositions would count an intention as a result.
          </li>
          <li style={mutedStyle}>
            <strong>After-hours visit-conversion rate.</strong> The conversion happens when
            scheduling accepts the proposal; M19 knows only that it emitted one.
          </li>
          <li style={mutedStyle}>
            <strong>Late-checkout-to-triage conversion.</strong> The denominator belongs to the
            visit verification module, not to this one.
          </li>
          <li style={mutedStyle}>
            <strong>Calls per shift / per clinician.</strong> The call list carries no membership —
            the covering shift is the assignment, and joining the two needs a read M19 does not
            publish.
          </li>
          <li style={mutedStyle}>
            <strong>AI suggestion-acceptance rate.</strong> Both facts are recorded per call but not
            on the list, so the figure would cost one patient-level read per row to produce a
            management statistic. The suggestion-vs-selection delta already flows to the
            AI-governance channel that owns it.
          </li>
          <li style={mutedStyle}>
            <strong>Escalation acknowledgement against SLA.</strong> The per-severity target is
            tenant-shaped JSON on the on-call policy and no route resolves it to a per-row target;
            the escalation inbox shows true elapsed minutes instead.
          </li>
        </ul>
      </Card>
    </div>
  );
}
