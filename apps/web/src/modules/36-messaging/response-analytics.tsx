// M36 WP 6.2 (ADR-0092, PROPOSED) - "Response analytics" for compliance and operations. KPI strip plus a breakdown by kind of request or by
// discipline, all on the shared kit. AGGREGATES ONLY: the server never sends a person, patient or message, and withholds any group with fewer
// than the minimum number of distinct people; this screen says so rather than showing a hole. Every bar has its figure in the table beside it
// (the table is the chart's twin); nothing is conveyed by colour alone. There is no view of an individual.
import type { AnalyticsGroupBy, ResponseAnalyticsReport } from "@chartwarden/types";
import { Button, KpiCard, KpiStrip, PageHeader } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import * as W from "./response-analytics-wording";
import { SkeletonRows } from "./skeleton-rows";
import { useResponseAnalytics } from "./use-response-analytics";
import "./response-analytics.css";

type OkReport = Extract<ResponseAnalyticsReport, { status: "ok" }>;

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

function Kpis({ report }: { readonly report: OkReport }): JSX.Element {
  const k = report.kpis;
  return (
    <KpiStrip>
      <KpiCard
        label={W.KPI_MEDIAN}
        value={W.duration(k.medianAckSeconds)}
        detail={W.ackedDetail(k.acknowledged, k.requests)}
      />
      <KpiCard label={W.KPI_IN_TIME} value={W.percent(k.ackedBeforeDeadlineRate)} />
      <KpiCard label={W.KPI_ESCALATION} value={W.percent(k.escalationRate)} />
      <KpiCard
        label={W.KPI_HANDOFF}
        value={
          k.medianHandoffAcceptSeconds === null
            ? W.HANDOFF_WITHHELD
            : W.duration(k.medianHandoffAcceptSeconds)
        }
        detail={
          k.handoffsOffered === null
            ? undefined
            : W.acceptedDetail(k.handoffsAccepted ?? 0, k.handoffsOffered)
        }
      />
    </KpiStrip>
  );
}

function Breakdown({ report }: { readonly report: OkReport }): JSX.Element {
  const most = Math.max(1, ...report.cells.map((c) => c.requests));
  return (
    <>
      {report.breakdownWithheld ? (
        <p className="wx-analytics-state">{W.BREAKDOWN_WITHHELD}</p>
      ) : report.cells.length === 0 ? (
        <p className="wx-analytics-state">{W.NO_GROUPS}</p>
      ) : (
        <table className="wx-analytics-table">
          <caption>{W.TABLE_LABEL}</caption>
          <thead>
            <tr>
              <th scope="col">{W.COL_GROUP}</th>
              <th scope="col">{W.COL_REQUESTS}</th>
              <th scope="col">{W.COL_MEDIAN}</th>
              <th scope="col">{W.COL_IN_TIME}</th>
              <th scope="col">{W.COL_ESCALATED}</th>
            </tr>
          </thead>
          <tbody>
            {report.cells.map((c) => (
              <tr key={c.group}>
                <th scope="row">{W.groupLabel(report.groupBy, c.group)}</th>
                <td>
                  {c.requests}
                  <progress
                    aria-hidden="true"
                    className="wx-analytics-bar"
                    value={c.requests}
                    max={most}
                  />
                </td>
                <td>{W.duration(c.medianAckSeconds)}</td>
                <td>{W.percent(c.ackedBeforeDeadlineRate)}</td>
                <td>{W.percent(c.escalationRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.suppressedGroups > 0 ? (
        <p className="wx-analytics-note">{W.suppressedText(report.suppressedGroups)}</p>
      ) : null}
    </>
  );
}

export function ResponseAnalytics(): JSX.Element {
  const [days, setDays] = useState<number>(30);
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy>("class");
  const { view, reload } = useResponseAnalytics(days, groupBy);
  const online = useOnline();

  return (
    <section className="wx-analytics" aria-label={W.TITLE}>
      <PageHeader title={W.TITLE} />
      <p className="wx-analytics-note">{W.INTRO}</p>
      <p className="wx-analytics-note">{W.TODAY_NOTE}</p>
      {online ? null : <p className="wx-analytics-banner">{W.OFFLINE}</p>}
      {view.status === "flag_off" ? (
        <p className="wx-analytics-state">{W.FLAG_OFF}</p>
      ) : view.status === "denied" ? (
        <p className="wx-analytics-state" role="alert">
          {view.code === 401 ? W.SIGN_IN : W.DENIED}
        </p>
      ) : (
        <>
          <div className="wx-analytics-controls">
            <label className="wx-analytics-control">
              {W.RANGE_LABEL}
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {W.RANGES.map((r) => (
                  <option key={r.days} value={r.days}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wx-analytics-control">
              {W.GROUP_LABEL}
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as AnalyticsGroupBy)}
              >
                {W.GROUPS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div aria-live="polite">
            {view.status === "loading" ? <SkeletonRows label={W.LOADING} /> : null}
            {view.status === "error" ? (
              <div className="wx-analytics-state">
                <p>{W.LOAD_FAILED}</p>
                <Button type="button" tone="secondary" size="sm" onClick={reload}>
                  {W.RETRY_LABEL}
                </Button>
              </div>
            ) : null}
            {view.status === "ready" && view.report.status === "insufficient_data" ? (
              <div className="wx-analytics-state">
                <h2>{W.INSUFFICIENT_TITLE}</h2>
                <p>{W.insufficientText(view.report.minCohort)}</p>
              </div>
            ) : null}
            {view.status === "ready" && view.report.status === "ok" ? (
              <>
                <Kpis report={view.report} />
                <Breakdown report={view.report} />
                <p className="wx-analytics-note">{W.provisionalText(view.report.minCohort)}</p>
              </>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
