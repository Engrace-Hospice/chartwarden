// apps/web/src/shell — the two-tier RHC day-count carry-over (Claims Processing Manual ch. 11 §30.2), shown on the
// readmission screen (M6) and on the claim detail's pricing (M23). Both read the same server shape: the prior hospice
// days a new election continues — our earlier stays merged with other hospices' days from the HETS 271 history —
// with the chain counted, the basis (`internal_only` / `hets_merged` / `hets_stale`) and any warnings. Shared kit
// only (StatusPill, InlineAlert); flat rows, no cards. `rhcCarryOverModel` is the pure part (DOM-free tests).
import { InlineAlert, StatusPill, type StatusTone } from "@wardenx/ui";
import type { CSSProperties, JSX } from "react";

export type RhcCarryOverBasis = "internal_only" | "hets_merged" | "hets_stale";

export interface RhcCarryOverSpan {
  source: "internal" | "hets";
  /** `sending_hospice` = a transfer-in's sending hospice, from our transfer record (not HETS). */
  kind: "stay" | "sending_hospice" | "election" | "benefit_period";
  start: string;
  end: string;
  endAssumed: boolean;
  countedDays: number;
  hospiceNpi: string | null;
  ref: string | null;
}

/** Who the counted days belong to, and where we know them from. */
function spanSourceLabel(s: RhcCarryOverSpan): string {
  const npi = s.hospiceNpi ? `, NPI ${s.hospiceNpi}` : "";
  if (s.kind === "sending_hospice") return `Sending hospice (transfer-in record${npi})`;
  if (s.source === "internal") return "Our stay";
  return `Other hospice (HETS${npi})${s.kind === "election" ? ", unbilled election" : ""}`;
}

/** The server's carry-over shape (hospice-periods `rhcCarryOver`, claim `pricing.hipps.rhcCarryOver`). */
export interface RhcCarryOver {
  electionDate: string;
  priorDays: number;
  chainDays: number;
  basis: RhcCarryOverBasis;
  startsAtDay: number;
  highRateDaysRemaining: number;
  daysSinceLastCare: number | null;
  chain: RhcCarryOverSpan[];
  warnings: { code: string; message: string }[];
  hetsCheck: { checkId: string; checkedAt: string; ageDays: number; stale: boolean } | null;
}

export interface RhcCarryOverRow {
  key: string;
  source: string;
  dates: string;
  days: string;
}

export interface RhcCarryOverModel {
  headline: string;
  basisLabel: string;
  basisTone: StatusTone;
  rows: RhcCarryOverRow[];
  warnings: string[];
}

const BASIS: Record<RhcCarryOverBasis, { label: string; tone: StatusTone }> = {
  internal_only: { label: "Our records only", tone: "neutral" },
  hets_merged: { label: "Our records + HETS", tone: "success" },
  hets_stale: { label: "HETS check is stale", tone: "warning" },
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What to show for a carry-over (pure). `fmt` renders an ISO date. */
export function rhcCarryOverModel(
  carry: RhcCarryOver,
  fmt: (iso: string) => string,
): RhcCarryOverModel {
  const headline =
    carry.priorDays === 0
      ? "No earlier hospice days carry over: the RHC day count starts at day 1."
      : carry.highRateDaysRemaining === 0
        ? `${plural(carry.chainDays, "earlier hospice day")} carry over: no high-rate (days 1–60) RHC days are left.`
        : `${plural(carry.priorDays, "earlier hospice day")} carry over: this stay starts at RHC day ${carry.startsAtDay}, with ${plural(carry.highRateDaysRemaining, "high-rate day")} left.`;
  const rows = carry.chain.map((s, i) => ({
    key: `${s.source}-${s.start}-${i}`,
    source: spanSourceLabel(s),
    dates: `${fmt(s.start)} – ${fmt(s.end)}${s.endAssumed ? " (end assumed)" : ""}`,
    days: plural(s.countedDays, "day"),
  }));
  const hetsAge = carry.hetsCheck
    ? `HETS checked ${fmt(carry.hetsCheck.checkedAt.slice(0, 10))} (${plural(carry.hetsCheck.ageDays, "day")} ago).`
    : null;
  return {
    headline: hetsAge ? `${headline} ${hetsAge}` : headline,
    basisLabel: BASIS[carry.basis].label,
    basisTone: BASIS[carry.basis].tone,
    rows,
    warnings: carry.warnings.map((w) => w.message),
  };
}

const cellStyle: CSSProperties = {
  padding: "0.375rem 0.75rem 0.375rem 0",
  borderTop: "1px solid var(--color-outline-variant)",
  fontVariantNumeric: "tabular-nums",
  textAlign: "left",
  fontWeight: 400,
};

/** The carry-over: headline + basis pill, the counted stays (source / dates / days), and any warnings. */
export function RhcCarryOverSummary({
  carry,
  fmt,
  testId = "rhc-carry-over",
}: {
  carry: RhcCarryOver;
  fmt: (iso: string) => string;
  testId?: string;
}): JSX.Element {
  const m = rhcCarryOverModel(carry, fmt);
  return (
    <div style={{ display: "grid", gap: "0.5rem" }} data-testid={testId}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        <StatusPill label={m.basisLabel} tone={m.basisTone} />
        <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface)" }}>
          {m.headline}
        </span>
      </div>
      {m.rows.length > 0 ? (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <caption
            style={{
              textAlign: "left",
              fontSize: "0.75rem",
              color: "var(--color-on-surface-variant)",
            }}
          >
            Earlier hospice days counted
          </caption>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" style={cellStyle}>
                  {r.source}
                </th>
                <td style={cellStyle}>{r.dates}</td>
                <td style={{ ...cellStyle, textAlign: "right", paddingRight: 0 }}>{r.days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {m.warnings.map((w) => (
        <InlineAlert key={w} tone="info">
          {w}
        </InlineAlert>
      ))}
    </div>
  );
}
