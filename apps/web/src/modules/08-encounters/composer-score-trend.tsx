// apps/web/src/modules/08-encounters — the composer's right-panel "Latest assessment scores + trend" (visit-documentation screen spec,
// Right Panel; ADR-0114 VN-D15). The latest PPS and ESAS-r reading up to the visit, the change against the reading before it, and the
// last few readings. It reads the existing M9 series route; the draft's own sentences carry the change since the last visit, this is the
// numbers beside them.
//
// NO EMPTY FRAME: with no scored reading, or a viewer who may not read scales (403), nothing renders. A failed read says so once.
import { Button, InlineAlert, Panel, useApiClient } from "@chartwarden/ui";
import { Fragment, useEffect, useState } from "react";
import type { JSX } from "react";
import { TREND_SCALES, type TrendScale, loadScaleSeries } from "./draft-api";
import { type ScoreTrend, describeChange, trendOf, trendWindow } from "./draft-model";

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
  | { readonly status: "ready"; readonly trends: Readonly<Record<TrendScale, ScoreTrend>> };

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
      const [pps, esas] = outcomes.map((outcome) =>
        trendOf(outcome.ok ? outcome.data.points : [], visitTime ?? undefined),
      );
      setLoad(
        pps && esas && (pps.latest || esas.latest)
          ? { status: "ready", trends: { pps, esas_r: esas } }
          : { status: "hidden" },
      );
    });
    return () => {
      active = false;
    };
  }, [client, patientId, serviceDate, visitTime, reloadKey]);

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

  return (
    <Panel
      title="Scores and trend"
      icon="trending-up"
      description="Latest reading up to this visit, and the change since the reading before it."
    >
      <dl className="wx-kv">
        {TREND_SCALES.map((scale) => {
          const trend = load.trends[scale];
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
    </Panel>
  );
}
