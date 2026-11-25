// apps/web/src/modules/08-encounters — the composer's right-panel "Latest assessment scores + trend" (visit-documentation screen spec,
// Right Panel; ADR-0114 VN-D15). The latest PPS and ESAS-r reading up to the visit, the change against the reading before it, and the
// last few readings. It reads the existing M9 series route; the draft's own sentences carry the change since the last visit, this is the
// numbers beside them.
//
// Under the numbers sits the advisory ESAS-r symptom prompt (`esas-symptom-prompt.tsx`): the items of the latest reading at 4 or more of 10,
// each with "consider a fuller assessment of this symptom". It is a prompt, not a finding, and blocks nothing.
//
// NO EMPTY FRAME: with no scored reading, or a viewer who may not read scales (403), nothing renders. A failed read says so once.
// The readings are read per patient and service date; the visit time the draft names only filters what was read. On a same-day visit that time
// is "now" and differs on every read of the draft, so it must not be what triggers a read (the panel would blink after every link or resolve).
import { Button, InlineAlert, Panel, useApiClient } from "@chartwarden/ui";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { TREND_SCALES, type TrendScale, loadScaleSeries } from "./draft-api";
import {
  type ScorePoint,
  type ScoreTrend,
  describeChange,
  trendOf,
  trendWindow,
} from "./draft-model";
import { EsasSymptomPrompt } from "./esas-symptom-prompt";

export interface ComposerScoreTrendProps {
  readonly patientId: string;
  readonly serviceDate: string;
  /** The visit time the draft describes the patient at (a reading after it is left out), when known. */
  readonly visitTime: string | null;
}

type Load =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly points: Readonly<Record<TrendScale, readonly ScorePoint[]>>;
    };

const SCALE_LABEL: Readonly<Record<TrendScale, string>> = { pps: "PPS", esas_r: "ESAS-r total" };
const SCALE_UNIT: Readonly<Record<TrendScale, string>> = { pps: "%", esas_r: "" };
const FORBIDDEN = 403;

const dayOf = (instant: string): string =>
  new Date(instant).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function ComposerScoreTrend({
  patientId,
  serviceDate,
  visitTime,
}: ComposerScoreTrendProps): JSX.Element | null {
  const client = useApiClient();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadKey` is the retry trigger, not read in the body.
  useEffect(() => {
    let active = true;
    // A service date that is not a date has no 90 days before it: nothing to ask for, so nothing to show.
    const range = trendWindow(serviceDate);
    if (range === null) {
      setLoad({ status: "hidden" });
      return;
    }
    setLoad({ status: "loading" });
    void Promise.all(
      TREND_SCALES.map((scale) => loadScaleSeries(client, patientId, scale, range)),
    ).then((outcomes) => {
      if (!active) return;
      if (outcomes.every((outcome) => !outcome.ok && outcome.status === FORBIDDEN)) {
        setLoad({ status: "hidden" });
        return;
      }
      if (outcomes.some((outcome) => !outcome.ok && outcome.status !== FORBIDDEN)) {
        setLoad({ status: "error" });
        return;
      }
      const [pps = [], esas = []] = outcomes.map((outcome) =>
        outcome.ok ? outcome.data.points : [],
      );
      setLoad({ status: "ready", points: { pps, esas_r: esas } });
    });
    return () => {
      active = false;
    };
  }, [client, patientId, serviceDate, reloadKey]);

  const trends = useMemo((): Readonly<Record<TrendScale, ScoreTrend>> | null => {
    if (load.status !== "ready") return null;
    const at = visitTime ?? undefined;
    return { pps: trendOf(load.points.pps, at), esas_r: trendOf(load.points.esas_r, at) };
  }, [load, visitTime]);

  if (load.status === "loading" || load.status === "hidden") return null;
  if (load.status === "error") {
    return (
      <Panel title="Scores and trend" icon="trending-up">
        <InlineAlert tone="warning">The scores could not be loaded.</InlineAlert>
        <Button tone="secondary" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
          Try again
        </Button>
      </Panel>
    );
  }

  // No scored reading up to the visit: nothing to show.
  if (trends === null || !(trends.pps.latest || trends.esas_r.latest)) return null;

  return (
    <Panel
      title="Scores and trend"
      icon="trending-up"
      description="Latest reading up to this visit, and the change since the reading before it."
      stack
    >
      <dl className="wx-kv">
        {TREND_SCALES.map((scale) => {
          const trend = trends[scale];
          if (!trend.latest) return null;
          const unit = SCALE_UNIT[scale];
          return (
            <Fragment key={scale}>
              <dt>{SCALE_LABEL[scale]}</dt>
              <dd>
                {`${trend.latest.score}${unit}`}
                <span className="wx-row-sub">
                  {`${describeChange(trend.change)}${
                    trend.previous ? ` since ${dayOf(trend.previous.capturedAt)}` : ""
                  } · read ${dayOf(trend.latest.capturedAt)}`}
                </span>
                {trend.recent.length > 2 ? (
                  <span className="wx-row-sub">
                    {`Recent: ${trend.recent
                      .map((reading) => `${reading.score}${unit}`)
                      .join(", ")}`}
                  </span>
                ) : null}
              </dd>
            </Fragment>
          );
        })}
      </dl>
      {trends.esas_r.latest ? (
        <EsasSymptomPrompt
          itemScores={trends.esas_r.latest.itemScores}
          readOn={dayOf(trends.esas_r.latest.capturedAt)}
        />
      ) : null}
    </Panel>
  );
}
