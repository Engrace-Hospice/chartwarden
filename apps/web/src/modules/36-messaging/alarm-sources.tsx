// M36 WP 6.10 (ADR-0102, PROPOSED) - "Alarm sources": a READ-ONLY list of the outside systems allowed to send an alarm notice into ChartWarden. Per
// source: its name, whether it is active (a word, never colour alone), what each alarm code becomes and the most urgent it can ever be, when it last
// delivered, and what happened to the alarms of the last 24 hours (alerted, nobody to alert, an unmapped code, still waiting), so a silent drop is a
// number on this screen. It shows no secret and has no action: the one-time secret is returned only by the API at create and rotate. Every view says
// that an alarm here is a notice only and does not replace the nurse-call system.
import type { AlarmSourceDto } from "@chartwarden/types";
import { Button, EmptyState, PageHeader, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import * as W from "./alarm-sources-wording";
import { LoadGate, formatTime } from "./export-common";
import { useAlarmSources } from "./use-alarm-sources";
import "./export.css";

function countsText(source: AlarmSourceDto): string {
  const c = source.last24h;
  return `Last 24 hours: ${c.alerted} alerted · ${c.noRecipients} with nobody to alert · ${c.unmapped} unmapped code · ${c.pending} waiting`;
}

function SourceRow({ source }: { readonly source: AlarmSourceDto }): JSX.Element {
  const titleId = `wx-alarm-source-${source.id}`;
  const attention = source.last24h.noRecipients + source.last24h.unmapped + source.last24h.pending;
  return (
    <li className="wx-export-row" aria-labelledby={titleId}>
      <div className="wx-export-main">
        <span className="wx-export-title" id={titleId}>
          {source.name}
        </span>
        <span className="wx-export-detail">
          Last delivered {source.lastAcceptedAt ? formatTime(source.lastAcceptedAt) : W.NEVER} ·
          Secret version {source.secretGeneration}
          {source.rotatedAt ? ` (replaced ${formatTime(source.rotatedAt)})` : ""}
          {source.disabledAt ? ` · Disabled ${formatTime(source.disabledAt)}` : ""}
        </span>
        <ul
          className="wx-export-detail wx-export-codes"
          aria-label={`Alarm codes of ${source.name}`}
        >
          {source.mappings.map((m) => (
            <li key={m.alarmKind}>
              <code>{m.alarmKind}</code> becomes {W.kindWord(m.alertType)} ·{" "}
              {W.ceilingWord(m.severityCeiling)}
            </li>
          ))}
        </ul>
        <span className="wx-export-detail">{countsText(source)}</span>
        {attention > 0 ? (
          <span className="wx-export-detail">
            Some alarms from this source did not reach a person. Check the alert rules and the codes
            the sender uses.
          </span>
        ) : null}
      </div>
      <div className="wx-export-meta">
        <StatusPill
          tone={source.enabled ? "success" : "neutral"}
          label={source.enabled ? "Active" : "Disabled"}
        />
      </div>
    </li>
  );
}

export function AlarmSources(): JSX.Element {
  const { view, reload, refreshFailed } = useAlarmSources();
  return (
    <>
      <PageHeader title={W.TITLE} breadcrumb={W.BREADCRUMB}>
        <p className="wx-export-detail">{W.INTRO}</p>
        <p className="wx-export-detail">
          <strong>{W.NOT_A_NURSE_CALL}</strong>
        </p>
      </PageHeader>
      <section className="wx-export" aria-label="Alarm sources overview">
        <p className="wx-export-detail">{W.READ_ONLY}</p>
        <div>
          <Button type="button" tone="secondary" size="lg" onClick={reload}>
            Refresh
          </Button>
        </div>
        {refreshFailed && view.status === "ready" ? (
          <div className="wx-export-error" role="alert">
            <p>{W.REFRESH_FAILED}</p>
            <Button type="button" tone="secondary" size="lg" onClick={reload}>
              {W.RETRY}
            </Button>
          </div>
        ) : null}
        <LoadGate view={view} retry={reload} deniedText={W.LOAD_DENIED}>
          {(sources) =>
            sources.length === 0 ? (
              <EmptyState title={W.NO_SOURCES_TITLE} description={W.NO_SOURCES_TEXT} />
            ) : (
              <ul className="wx-export-rows" aria-label="Configured alarm sources">
                {sources.map((s) => (
                  <SourceRow key={s.id} source={s} />
                ))}
              </ul>
            )
          }
        </LoadGate>
      </section>
    </>
  );
}
