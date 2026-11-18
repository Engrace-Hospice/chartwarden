// apps/web/src/modules/23-billing-medicare — the SIA (Service Intensity Add-on) card on the claim editor's pricing row. Three states:
// none (no add-on on this claim), legacy (a `minutes_v1` row computed before the units model: the old summary and a note),
// and units (`units_v2`: units x CHC hourly rate / 4 as dollars, paid / eligible / truncated units, and a per-visit table that
// says in plain words why a visit counted or did not). A death in the first 7 days of a month puts part of the window on the PRIOR
// month's claim: a banner says Medicare adjusts that claim and there is nothing to submit here. Read-only; all figures come from
// the server's newest `sia_calculation` revision (`pricing.sia`). Built from the shared kit (Card / InfoRows / DataTable /
// StatusPill / InlineAlert), no inline-styled tables.
import { Card, DataTable, InfoRows, InlineAlert, StatusPill } from "@chartwarden/ui";
import type { DataTableColumn } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { dollars } from "./billing-status";
import {
  type SiaPricing,
  type SiaVisit,
  minutesCellText,
  siaEquation,
  siaPaidNote,
  siaReasonText,
  siaUnitsSummary,
} from "./sia-card-model";

const TITLE_ID = "sia-card-title";
const TITLE = "Service Intensity Add-on (SIA)";
const NONE_TEXT = "No SIA add-on for this claim.";
const LEGACY_NOTE =
  "Calculated under the earlier minutes-based method; per-visit detail is not available for this claim.";
const LEGACY_AMOUNT_CAVEAT =
  "This dollar amount came from the earlier method and may not match the units-based amount Medicare pays.";
const NO_PAYABLE_NOTE = "No units are payable on this claim.";
const SEE_VISITS_NOTE = " The visits below show why.";
const PRIOR_CLAIM_NOTE =
  "Death fell in the first 7 days of the month: Medicare adjusts the prior month's claim for the add-on; nothing to submit here.";

const mutedStyle = { margin: 0, fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" };

const span = (from: string, to: string): string => `${from} → ${to}`;

// A visit's id IS its encounter id: the date opens the encounter so a reviewer can fix what excluded it.
const visitColumns = (patientId: string | undefined): readonly DataTableColumn<SiaVisit>[] => [
  {
    id: "date",
    header: "Date",
    cell: (v) =>
      patientId === undefined ? (
        v.date
      ) : (
        <Link to={`/patients/${patientId}/encounters/${v.id}`}>{v.date}</Link>
      ),
  },
  { id: "discipline", header: "Discipline", cell: (v) => v.discipline.toUpperCase() },
  {
    id: "minutes",
    header: "Minutes",
    numeric: true,
    cell: (v) => minutesCellText(v),
  },
  { id: "units", header: "Units", numeric: true, cell: (v) => v.units ?? "—" },
  {
    id: "result",
    header: "Result",
    cell: (v) =>
      v.counted ? (
        <StatusPill label="Counted" tone="success" />
      ) : (
        <StatusPill label="Excluded" tone="warning" />
      ),
  },
  {
    id: "detail",
    header: "Why",
    cell: (v) => (v.counted ? (siaPaidNote(v) ?? "") : siaReasonText(v.reason)),
  },
];

function VisitTable({
  visits,
  patientId,
}: { visits: readonly SiaVisit[]; patientId: string | undefined }): JSX.Element | null {
  if (visits.length === 0) return null;
  // The reason a visit did not count is the point of this table, so it wraps (see `.wx-sia-visits` in index.css) instead of
  // being ellipsised like a list-screen cell.
  return (
    <div className="wx-sia-visits">
      <DataTable
        rows={visits}
        columns={visitColumns(patientId)}
        getRowId={(v) => v.id}
        ariaLabel="SIA visits in the last 7 days"
      />
    </div>
  );
}

function PriorClaimBanner({
  advisory,
}: { advisory: NonNullable<SiaPricing["priorClaimAdvisory"]> }): JSX.Element {
  return (
    <InlineAlert tone="info">
      {PRIOR_CLAIM_NOTE} The prior month's days in the window ({span(advisory.from, advisory.to)})
      are worth {advisory.units === 1 ? "1 unit" : `${advisory.units} units`}
      {advisory.cents === null
        ? " (not priced: the CHC hourly rate for the year of death is unavailable)."
        : `, ${dollars(advisory.cents)}.`}
    </InlineAlert>
  );
}

function UnitsBody({
  sia,
  patientId,
}: { sia: SiaPricing; patientId: string | undefined }): JSX.Element {
  const { paidUnits, eligibleUnits, truncatedUnits, chcHourlyRateCents } = sia;
  const priced =
    paidUnits !== null &&
    paidUnits > 0 &&
    eligibleUnits !== null &&
    truncatedUnits !== null &&
    chcHourlyRateCents !== null;
  const rateLabel = `${chcHourlyRateCents === null ? "—" : dollars(chcHourlyRateCents)}${
    sia.wageIndexFiscalYear === null ? "" : ` · wage index FY${sia.wageIndexFiscalYear}`
  }`;
  return (
    <>
      {priced ? (
        <>
          <p
            style={{
              margin: 0,
              fontSize: "0.95rem",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {siaEquation(paidUnits, chcHourlyRateCents, sia.amountCents)}
          </p>
          <p style={mutedStyle}>{siaUnitsSummary(paidUnits, eligibleUnits, truncatedUnits)}</p>
        </>
      ) : (
        <p style={mutedStyle}>
          {NO_PAYABLE_NOTE}
          {sia.visits.length > 0 ? SEE_VISITS_NOTE : ""}
        </p>
      )}
      <InfoRows
        labelWidth="8rem"
        rows={[
          { label: "Window", value: span(sia.windowStart, sia.windowEnd) },
          { label: "CHC hourly rate", value: rateLabel },
          ...(sia.revision > 1
            ? [{ label: "Calculation", value: `Revision ${sia.revision}` }]
            : []),
        ]}
      />
      {sia.priorClaimAdvisory ? <PriorClaimBanner advisory={sia.priorClaimAdvisory} /> : null}
      <VisitTable visits={sia.visits} patientId={patientId} />
    </>
  );
}

function LegacyBody({ sia }: { sia: SiaPricing }): JSX.Element {
  return (
    <>
      <InfoRows
        labelWidth="8rem"
        rows={[
          { label: "Window", value: span(sia.windowStart, sia.windowEnd) },
          { label: "Qualifying minutes", value: String(sia.totalQualifyingMinutes) },
          { label: "SIA add-on", value: dollars(sia.amountCents) },
        ]}
      />
      <p style={mutedStyle}>{LEGACY_NOTE}</p>
      <p style={mutedStyle}>{LEGACY_AMOUNT_CAVEAT}</p>
    </>
  );
}

/** `patientId` (the claim's patient) makes each visit's date a link to its encounter; without it the date is plain text. */
export function SiaCard({
  sia,
  patientId,
}: { sia: SiaPricing | null; patientId?: string }): JSX.Element {
  return (
    <Card
      aria-labelledby={TITLE_ID}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        minWidth: "16rem",
        flex: "1 1 16rem",
      }}
    >
      <h3
        id={TITLE_ID}
        style={{
          margin: 0,
          fontFamily: "var(--font-display)",
          fontSize: "0.95rem",
          fontWeight: 500,
        }}
      >
        {TITLE}
      </h3>
      {sia === null ? (
        <p style={mutedStyle}>{NONE_TEXT}</p>
      ) : sia.basis === "minutes_v1" ? (
        <LegacyBody sia={sia} />
      ) : (
        <UnitsBody sia={sia} patientId={patientId} />
      )}
    </Card>
  );
}
