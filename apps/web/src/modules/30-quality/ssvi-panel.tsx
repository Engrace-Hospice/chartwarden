import { Glyph, StatusPill } from "@wardenx/ui";
// apps/web/src/modules/30-quality — the SERVICE AND SPENDING VARIATION INDEX panel on the quality hub (FY2027,
// CMS-1851-F §III.B.2). Mockup: the Home dashboard tiles (03_19_57) over a flat clinical section with the
// per-metric drill-down as a list table — the same shape the hub gives HCI rows, folded into one view.
//
// The SSVI is CMS-calculated from national Medicare claims; hospices submit nothing and it is not an HQRP or
// Care Compare measure. Everything here is the agency's INTERNAL ESTIMATE from its own records and is labelled
// that way. Metric 9 (non-hospice spending, 0–8 points) needs other providers' claims, so the total is shown as
// a range until it can be computed — never as a lower score.
import type { JSX } from "react";
import { fraction, measureRate } from "./quality-status";
import {
  SSVI_INTERNAL_ESTIMATE_LABEL,
  SSVI_MAX_SCORE,
  SSVI_OUTLIER_SCORE,
  type SsviMeasureRow,
  type SsviMetricState,
  summarizeSsvi,
} from "./ssvi-summary";

const STATE_PILL: Record<
  SsviMetricState,
  { label: string; tone: "error" | "success" | "neutral" | "warning" }
> = {
  point: { label: "Point", tone: "error" },
  no_point: { label: "No point", tone: "success" },
  low_n: { label: "No population", tone: "neutral" },
  not_computable: { label: "Not computable here", tone: "neutral" },
  not_computed: { label: "Not computed", tone: "warning" },
};

export function SsviPanel({ rows }: { rows: readonly SsviMeasureRow[] }): JSX.Element | null {
  const s = summarizeSsvi(rows);
  if (!s.present) return null;
  const segments = Array.from({ length: SSVI_MAX_SCORE }, (_, i) => i);
  const filled = s.score ?? s.lowerBound;
  return (
    <section className="wx-clinical-section wx-ssvi" aria-labelledby="ssvi-title">
      <header>
        <span className="wx-clinical-section-icon" aria-hidden>
          <Glyph name="scale" size={22} strokeWidth={1.6} />
        </span>
        <div className="wx-rates-drawer-title">
          <h3 id="ssvi-title">Service and Spending Variation Index</h3>
          <p>{SSVI_INTERNAL_ESTIMATE_LABEL}</p>
        </div>
        <div className="wx-clinical-section-aside">
          {s.outlier === true ? (
            <StatusPill label={`Outlier (≥ ${SSVI_OUTLIER_SCORE})`} tone="error" glyph="alert" />
          ) : s.outlier === false ? (
            <StatusPill label="Not an outlier" tone="success" />
          ) : (
            <StatusPill label="Outlier status undetermined" tone="neutral" />
          )}
        </div>
      </header>
      <div className="wx-clinical-section-body">
        <div className="wx-ssvi-tiles">
          <div className={`wx-ssvi-tile${s.outlier ? " is-outlier" : ""}`}>
            <span>SSVI score</span>
            <strong>
              {s.score !== null
                ? `${s.score} / ${SSVI_MAX_SCORE}`
                : `${s.lowerBound}–${s.upperBound}`}
            </strong>
            <small>
              {s.score !== null
                ? `Outlier at ${SSVI_OUTLIER_SCORE} or more`
                : "Range until every metric is computable"}
            </small>
            <div className="wx-ssvi-meter" aria-hidden>
              {segments.map((i) => (
                <span
                  key={i}
                  className={
                    i < filled
                      ? `is-on${s.outlier ? " is-outlier" : ""}`
                      : i < s.upperBound && s.score === null
                        ? "is-unknown"
                        : undefined
                  }
                />
              ))}
            </div>
          </div>
          <div className="wx-ssvi-tile">
            <span>Utilization metrics flagged</span>
            <strong>{s.flagged} / 8</strong>
            <small>One point each</small>
          </div>
          <div className="wx-ssvi-tile">
            <span>Non-hospice spending</span>
            <strong>{s.metrics[8]?.points ?? "—"}</strong>
            <small>
              {s.metrics[8]?.state === "not_computable"
                ? "Needs other providers' Medicare claims"
                : "0–8 points by octile"}
            </small>
          </div>
          <div className="wx-ssvi-tile">
            <span>Published by</span>
            <strong>CMS</strong>
            <small>No hospice submission · not on Care Compare</small>
          </div>
        </div>

        <div className="wx-list-table-wrap wx-ssvi-metrics">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">SSVI metrics (internal estimate)</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">CMS cut (FY2025 data)</th>
                <th scope="col" className="wx-num-col">
                  Value
                </th>
                <th scope="col" className="wx-num-col">
                  Population
                </th>
                <th scope="col">Points</th>
              </tr>
            </thead>
            <tbody>
              {s.metrics.map((m, i) => {
                const v = m.row?.latestValue ?? null;
                const pill = STATE_PILL[m.state];
                return (
                  <tr key={m.code}>
                    <td>
                      <span className="wx-row-title">
                        {i + 1}. {m.name}
                      </span>
                      {v?.unavailableReason ? (
                        <span className="wx-row-sub">{v.unavailableReason}</span>
                      ) : null}
                    </td>
                    <td>{m.cut}</td>
                    <td className="wx-nums wx-num-col">
                      {v && m.maxPoints === 1 ? measureRate(m.code, v) : "—"}
                    </td>
                    <td className="wx-nums wx-num-col">
                      {v && m.maxPoints === 1 && !v.unavailableReason
                        ? fraction(v.numerator, v.denominator)
                        : "—"}
                    </td>
                    <td>
                      <span className="wx-ssvi-points">
                        {m.points === null ? "?" : m.points}/{m.maxPoints}
                      </span>{" "}
                      <StatusPill label={pill.label} tone={pill.tone} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
