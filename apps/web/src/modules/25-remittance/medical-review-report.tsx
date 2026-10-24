import {
  Button,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  TextField,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the MEDICAL REVIEW REPORT (hospice ADR/TPE/QIC PRD, milestone 9a-2). Leadership sees
// FIGURES from the organization's own records for a period and the change against the previous equal period: ADRs, denials
// by reason, appeals by tier and outcome, reopenings, TPE, open audit requests and which denial reasons have no playbook.
// There is NO target, benchmark, score, red/green threshold or "compliant" wording anywhere on this page; the only
// threshold that can appear is a TPE exit threshold the organization recorded itself. Deadline figures are "against the due
// date on the case" and carry the count of due dates that came from unverified rules. A tile with no data shows a dash.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { RetryAlert } from "./action-ui";
import { PLAYBOOK_CODE_KIND_LABEL } from "./playbook-api";
import { humanize } from "./remittance-status";
import { type MedicalReviewReport, type ReportFigure, loadMedicalReviewReport } from "./report-api";

export const REPORT_NOTE =
  "Figures from your records. No targets or benchmarks are set. Deadlines are those on each case.";
const DEFAULT_PERIOD_DAYS = 30;
const DAY_MS = 86_400_000;

/** A calendar day `days` ago in the reader's own time zone (YYYY-MM-DD). */
const localDay = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toLocaleDateString("en-CA");
/** The report counts whole UTC days and refuses a future one, so the latest day offered is the earlier of the two "today"s. */
const latestDay = (): string => {
  const utc = new Date().toISOString().slice(0, 10);
  const local = localDay(0);
  return local < utc ? local : utc;
};

const kindLabel = (k: string): string => PLAYBOOK_CODE_KIND_LABEL[k] ?? k;
const NO_DATA = "no data in this period";
const count = (f: ReportFigure): string => (f.value === null ? "—" : String(f.value));
/** Exact dollars from the server ("1234.50") shown with a sign and thousands separators, never through a float. */
const money = (exact: string): string => {
  const [whole = "0", cents = "00"] = exact.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${exact.startsWith("-") ? "-" : ""}$${grouped}.${cents}`;
};
const percent = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** "vs previous period: 4 (+3)" in plain words; a missing side reads as no comparison, never as zero. */
function vsPrevious(f: ReportFigure, unit: "count" | "share" | "days" = "count"): string {
  if (f.value === null) return NO_DATA;
  if (f.previous === null || f.change === null) return "no previous period to compare";
  const show = (n: number): string =>
    unit === "share" ? percent(n) : unit === "days" ? `${n} d` : String(n);
  const sign = f.change > 0 ? "+" : "";
  const delta =
    unit === "share" ? `${sign}${Math.round(f.change * 100)} pts` : `${sign}${f.change}`;
  return `vs previous period: ${show(f.previous)} (${delta})`;
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} style={{ padding: "0 1.5rem 1.5rem" }}>
      <h2 id={headingId} className="wx-action-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Rows({
  caption,
  head,
  rows,
  empty,
}: {
  readonly caption: string;
  readonly head: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
  readonly empty: string;
}): JSX.Element {
  if (rows.length === 0) return <p className="wx-action-hint">{empty}</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="wx-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption className="wx-sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                style={{ textAlign: "left", padding: "0.4rem 0.75rem", fontSize: "0.75rem" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr
              key={`${caption}-${i}`}
              style={{ borderTop: "1px solid var(--color-surface-container)" }}
            >
              {cells.map((c, j) => (
                <td key={`${caption}-${i}-${j}`} style={{ padding: "0.4rem 0.75rem" }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportBody({ r }: { readonly r: MedicalReviewReport }): JSX.Element {
  const a = r.adrs;
  const unverified = count(a.dueDatesFromUnverifiedWindows);
  return (
    <>
      <Section title="ADR requests">
        <Rows
          caption="ADR figures"
          head={["Figure", "This period", "Previous period"]}
          empty="No ADRs in this period."
          rows={[
            ["Received", count(a.received), a.received.previous ?? "—"],
            ["Filed", count(a.filed), a.filed.previous ?? "—"],
            [
              "Filed on or before the due date on the case",
              count(a.filedOnOrBeforeDue),
              a.filedOnOrBeforeDue.previous ?? "—",
            ],
            [
              "Filed after the due date on the case",
              count(a.filedAfterDue),
              a.filedAfterDue.previous ?? "—",
            ],
            [
              "Share of filed ADRs on or before the due date",
              percent(a.onOrBeforeDueShareOfFiled.value),
              percent(a.onOrBeforeDueShareOfFiled.previous),
            ],
            [
              "Filed with a recorded receipt",
              count(a.withRecordedProof),
              a.withRecordedProof.previous ?? "—",
            ],
            [
              "Median days from request to filing",
              a.medianDaysToFile.value ?? "—",
              a.medianDaysToFile.previous ?? "—",
            ],
            [
              "Denied for no response",
              count(a.deniedNoResponse),
              a.deniedNoResponse.previous ?? "—",
            ],
          ]}
        />
        <p className="wx-action-hint">
          {`Due dates are those on each case. ${unverified} of the ADRs received this period have a due date from a response window nobody has verified.`}
        </p>
        <Rows
          caption="ADRs by MAC"
          head={[
            "MAC",
            "Received",
            "Filed",
            "Filed on or before the due date",
            "Denied for no response",
          ]}
          empty=""
          rows={a.byMac.map((m) => [
            m.macName,
            m.received,
            m.filed,
            m.filedOnOrBeforeDue,
            m.deniedNoResponse,
          ])}
        />
      </Section>
      <Section title="Denials">
        <p className="wx-action-hint">
          {`Opened ${count(r.denials.opened)} (${money(r.denials.openedDollars.value)}). Denials whose MAC reason field says ${r.denials.macReasonAsTyped.code}, as typed: ${count(r.denials.macReasonAsTyped.figure)}. This is counted apart from ADRs denied for no response.`}
        </p>
        <Rows
          caption="Denials by reason"
          head={["Reason", "Denials", "Dollars"]}
          empty="No denials opened in this period."
          rows={r.denials.byReason.rows.map((x) => [
            `${kindLabel(x.codeKind)} ${x.code}`,
            x.count,
            money(x.dollars),
          ])}
        />
        {r.denials.byReason.omitted > 0 ? (
          <p className="wx-action-hint">{`${r.denials.byReason.omitted} more reason(s) not shown.`}</p>
        ) : null}
        <Rows
          caption="Denials by month"
          head={["Month", "Denials", "Dollars"]}
          empty=""
          rows={r.denials.byMonth.map((m) => [m.month, m.count, money(m.dollars)])}
        />
        <Rows
          caption="Closure outcomes"
          head={["Closed with outcome", "Denials"]}
          empty="No denial was closed in this period."
          rows={r.denials.closureOutcomes.map((c) => [humanize(c.outcome), c.count])}
        />
        <p className="wx-action-hint">
          <Link to="/remittance/denials">Open the denials worklist</Link>
        </p>
      </Section>
      <Section title="Appeals">
        <Rows
          caption="Appeals filed by tier"
          head={["Tier", "Filed", "Filed on or before the deadline on the case", "Deadline source"]}
          empty="No appeals filed in this period."
          rows={r.appeals.filedByTier.map((t) => [
            humanize(t.tier),
            t.filed,
            t.filedOnOrBeforeDeadline,
            t.deadlineWindowUnconfirmed ? "window not SME-confirmed" : "window as set up",
          ])}
        />
        <Rows
          caption="Appeals decided by outcome"
          head={["Outcome", "Appeals"]}
          empty="No appeal was decided in this period."
          rows={r.appeals.decidedByOutcome.map((o) => [humanize(o.outcome), o.count])}
        />
        <p className="wx-action-hint">
          {`Favorable decisions as a share of decided appeals: ${percent(r.appeals.favorableShareOfDecided)} (partial and unfavorable are counted separately above). ${vsPrevious(r.appeals.decided)}.`}
        </p>
        <Rows
          caption="Open appeals by tier"
          head={["Tier", "Open now"]}
          empty="No open appeals."
          rows={r.appeals.openByTier.map((o) => [humanize(o.tier), o.count])}
        />
        <p className="wx-action-hint">
          <Link to="/remittance/appeals">Open the appeals tracker</Link>
        </p>
      </Section>
      <Section title="Reopenings">
        <p className="wx-action-hint">{`Opened: ${count(r.reopenings.opened)} · ${vsPrevious(r.reopenings.opened)}`}</p>
        <Rows
          caption="Reopenings by outcome"
          head={["Outcome", "Reopenings"]}
          empty="No reopening was decided in this period."
          rows={r.reopenings.decidedByOutcome.map((o) => [humanize(o.outcome), o.count])}
        />
      </Section>
      <Section title="TPE programs">
        {!r.tpe.available ? (
          <p className="wx-action-hint">TPE figures are not available.</p>
        ) : (
          <Rows
            caption="Active TPE programs"
            head={["MAC", "Round", "MAC error rate (latest)", "Exit threshold you recorded"]}
            empty="No active TPE program."
            rows={r.tpe.active.map((p) => [
              p.macName,
              p.currentRound ?? "—",
              p.latestMacErrorRatePct === null ? "No results" : `${p.latestMacErrorRatePct}%`,
              p.thresholdPct === null
                ? "No threshold confirmed"
                : `${p.thresholdPct}%${p.thresholdVerified ? "" : " (unverified)"}`,
            ])}
          />
        )}
        {r.tpe.truncated ? (
          <p className="wx-action-hint">Only the first programs are shown.</p>
        ) : null}
        <p className="wx-action-hint">
          <Link to="/remittance/tpe">Open the TPE tracker</Link>
        </p>
      </Section>
      <Section title="Audit requests">
        <p className="wx-action-hint">
          {`Open now: ${r.audits.open}. Open with no recorded deadline: ${r.audits.openWithNoRecordedDeadline}.`}{" "}
          <Link to="/remittance/audits">Open the audit requests</Link>
        </p>
      </Section>
      <Section title="Playbook coverage">
        <p className="wx-action-hint">
          {`${r.playbookCoverage.denialsWithoutPlaybook} of ${r.playbookCoverage.denialsSeen} denials opened in this period have no matching published playbook (same MAC and code matching as the denial panel). ${r.playbookCoverage.reasonsWithoutPlaybook} of ${r.playbookCoverage.reasonsSeen} reasons have at least one such denial.`}
        </p>
        <Rows
          caption="Reasons without a playbook"
          head={["Reason", "Denials without a matching playbook", "Dollars", "Playbook"]}
          empty="Every denial opened in this period has a matching published playbook."
          rows={r.playbookCoverage.withoutPlaybook.rows.map((x) => [
            `${kindLabel(x.codeKind)} ${x.code}`,
            x.count,
            money(x.dollars),
            <Link
              key={`${x.codeKind}-${x.code}`}
              to={`/remittance/playbooks?new=1&kind=${x.codeKind}&code=${encodeURIComponent(x.code)}`}
            >
              Write one
            </Link>,
          ])}
        />
      </Section>
    </>
  );
}

export function MedicalReviewReportScreen(): JSX.Element {
  const client = useApiClient();
  const [from, setFrom] = useState(localDay(DEFAULT_PERIOD_DAYS));
  const [to, setTo] = useState(localDay(1));
  const [applied, setApplied] = useState({
    from: localDay(DEFAULT_PERIOD_DAYS),
    to: localDay(1),
  });
  const [report, setReport] = useState<MedicalReviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const res = await loadMedicalReviewReport(client, applied);
    if (request !== latest.current) return;
    if (res.ok) {
      setReport(res.value);
      setError(null);
    } else setError(res.message);
  }, [client, applied]);
  useEffect(() => {
    void load();
  }, [load]);

  // The report on screen belongs to ITS OWN period. Figures are used (and the KPI tiles filled) only when that period is the
  // one asked for; otherwise they are never shown under the new From/To.
  const matches =
    report !== null && report.window.from === applied.from && report.window.to === applied.to;
  const current = matches ? report : null;
  const a = current?.adrs;
  const d = current?.denials;
  const shown = (f: ReportFigure | undefined): string => (f ? count(f) : "—");

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Medical Review Report"
          breadcrumb="Revenue Cycle — Medical Review Report"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            {REPORT_NOTE}
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="ADRs received"
            value={shown(a?.received)}
            detail={a ? vsPrevious(a.received) : NO_DATA}
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="ADRs filed on or before the due date"
            value={a ? percent(a.onOrBeforeDueShareOfFiled.value) : "—"}
            detail={a ? vsPrevious(a.onOrBeforeDueShareOfFiled, "share") : NO_DATA}
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Denials opened"
            value={shown(d?.opened)}
            detail={d ? vsPrevious(d.opened) : NO_DATA}
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Appeals filed"
            value={shown(current?.appeals.filed)}
            detail={current ? vsPrevious(current.appeals.filed) : NO_DATA}
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
        </KpiStrip>
      }
      filters={
        <form
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "flex-end",
            flexWrap: "wrap",
            padding: "0 1.5rem",
          }}
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ from, to });
          }}
        >
          <TextField
            label="From"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            max={latestDay()}
            onChange={(e) => setTo(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={from === "" || to === "" || from > to}>
            Show period
          </Button>
          {current ? (
            <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8rem" }}>
              {`${current?.window.days} days, compared with ${current?.window.previous.from} to ${current?.window.previous.to}`}
            </span>
          ) : null}
        </form>
      }
      table={
        <>
          {error ? <RetryAlert message={error} onRetry={() => void load()} /> : null}
          {report && !matches ? (
            <p className="wx-action-hint" style={{ padding: "0 1.5rem" }}>
              {`Showing the earlier period ${report.window.from} to ${report.window.to}; ${applied.from} to ${applied.to} ${error ? "could not be loaded" : "is loading"}.`}
            </p>
          ) : null}
          {!report && !error ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : report && (matches || error) ? (
            <ReportBody r={report} />
          ) : report ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : null}
        </>
      }
      fullPageScroll
    />
  );
}
