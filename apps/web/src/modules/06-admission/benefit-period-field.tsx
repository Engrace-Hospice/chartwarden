import { Glyph, InlineAlert, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — the benefit-period entry every NEW admission makes (readmission screen and the
// plain New admission screen): the period number (prefilled with our history's suggestion, editable), a
// "Confirmed against HETS / ELGA / ELGH" checkbox with the date checked, and a WARNING — never a block — when the
// number is unconfirmed or differs from the suggestion, because Medicare counts periods across every hospice.
//
// HETS INTEGRATION POINT: `useHetsHospicePeriods` is the one place a live CMS eligibility answer (the HETS 270/271
// hospice-period read, GET /api/v1/billing/eligibility/hospice-periods?patientId=) will plug in. Until it is wired it
// returns `null` and the confirmation stays a manual checkbox + date.
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { Field, type Loadable } from "./end-of-episode-ui";
import {
  type BenefitPeriodDraft,
  type BenefitPeriodPlan,
  MAX_BENEFIT_PERIOD,
  basisLabel,
  benefitPeriodWarnings,
  periodLengthLabel,
} from "./readmission-model";

/**
 * The slice of the HETS hospice-period read (GET /api/v1/billing/eligibility/hospice-periods?patientId=,
 * `billing.eligibility.read`) the field shows: the next period CMS would assign, why, and whether a hospice election
 * is still open on the CWF (then a new NOE would be rejected).
 */
export interface HetsHospicePeriods {
  readonly nextPeriodNumber: number | null;
  readonly nextPeriodBasis: string | null;
  readonly hospiceElectionOpen: boolean;
  readonly checkedAt: string;
  readonly stale: boolean;
}

/**
 * HETS integration point — always `null` until the eligibility read is wired (see the file header). Kept as a hook
 * so the screens already call it where the answer belongs.
 */
export function useHetsHospicePeriods(
  _patientId: string | null | undefined,
): HetsHospicePeriods | null {
  return null;
}

/** The benefit-period plan for a readmission (`admissionId`) or any new admission (`patientId`). */
export function useBenefitPeriodPlan(
  target: { admissionId: string } | { patientId: string } | null,
  query: { sequence?: number; startDate?: string } = {},
): Loadable<BenefitPeriodPlan> {
  const client = useApiClient();
  const [plan, setPlan] = useState<Loadable<BenefitPeriodPlan>>(null);
  const admissionId = target && "admissionId" in target ? target.admissionId : null;
  const patientId = target && "patientId" in target ? target.patientId : null;
  const { sequence, startDate } = query;
  useEffect(() => {
    if (!admissionId && !patientId) {
      setPlan(null);
      return;
    }
    let active = true;
    const q: { sequence?: number; startDate?: string } = {};
    if (sequence && Number.isInteger(sequence) && sequence >= 1 && sequence <= MAX_BENEFIT_PERIOD)
      q.sequence = sequence;
    if (startDate) q.startDate = startDate;
    void Promise.resolve()
      .then(() =>
        admissionId
          ? client.GET("/api/v1/admissions/{id}/readmission-context", {
              params: { path: { id: admissionId }, query: q },
            })
          : client.GET("/api/v1/patients/{patientId}/benefit-period-plan", {
              params: { path: { patientId: patientId as string }, query: q },
            }),
      )
      .then(({ data, error }) => {
        if (!active) return;
        setPlan(error || !data ? "error" : (data as BenefitPeriodPlan));
      })
      .catch(() => {
        if (active) setPlan("error");
      });
    return () => {
      active = false;
    };
  }, [client, admissionId, patientId, sequence, startDate]);
  return plan;
}

export function BenefitPeriodField({
  idPrefix,
  draft,
  onChange,
  suggested,
  basis,
  today,
  errors,
  hets,
}: {
  idPrefix: string;
  draft: BenefitPeriodDraft;
  onChange: (patch: Partial<BenefitPeriodDraft>) => void;
  /** Our history's suggestion (`null` while unknown). */
  suggested: number | null;
  basis?: string;
  today: string;
  errors: Partial<Record<"sequence" | "confirmedOn", string>>;
  hets?: HetsHospicePeriods | null;
}): JSX.Element {
  const warnings = benefitPeriodWarnings(draft, suggested);
  const n = Number(draft.sequence);
  const seqId = `${idPrefix}-seq`;
  const dateId = `${idPrefix}-confirmed-on`;
  return (
    <div style={{ display: "grid", gap: "0.875rem" }}>
      <div className="wx-field-grid">
        <Field
          id={seqId}
          label="Benefit period number"
          required
          hint={
            Number.isInteger(n) && n >= 1
              ? `${periodLengthLabel(n)}${suggested !== null ? ` · suggested from our history: ${suggested}` : ""}`
              : "1 and 2 are 90-day periods; 3 and later are 60 days."
          }
          error={errors.sequence}
        >
          <input
            id={seqId}
            type="number"
            min={1}
            max={MAX_BENEFIT_PERIOD}
            step={1}
            inputMode="numeric"
            value={draft.sequence}
            aria-invalid={errors.sequence ? true : undefined}
            onChange={(e) => onChange({ sequence: e.target.value })}
          />
        </Field>
        <Field
          id={dateId}
          label="Date checked"
          required={draft.hetsConfirmed}
          optional={!draft.hetsConfirmed}
          hint="When you looked the period up in HETS / ELGA / ELGH."
          error={errors.confirmedOn}
        >
          <input
            id={dateId}
            type="date"
            max={today}
            value={draft.confirmedOn}
            disabled={!draft.hetsConfirmed}
            aria-invalid={errors.confirmedOn ? true : undefined}
            onChange={(e) => onChange({ confirmedOn: e.target.value })}
          />
        </Field>
      </div>
      <label className={draft.hetsConfirmed ? "wx-tile checked" : "wx-tile"}>
        <input
          type="checkbox"
          checked={draft.hetsConfirmed}
          onChange={(e) =>
            onChange({
              hetsConfirmed: e.currentTarget.checked,
              confirmedOn: e.currentTarget.checked ? draft.confirmedOn || today : "",
            })
          }
        />
        <span className="wx-tile-text">
          <span>Confirmed against HETS / ELGA / ELGH</span>
          <small>The CMS eligibility record lists this patient's hospice benefit periods.</small>
        </span>
      </label>
      {basis ? <p className="wx-hope-field-hint">{basisLabel(basis)}</p> : null}
      {hets?.nextPeriodNumber ? (
        <InlineAlert tone="info">
          HETS: the next benefit period is {hets.nextPeriodNumber}
          {hets.nextPeriodBasis ? ` (${hets.nextPeriodBasis})` : ""}, checked {hets.checkedAt}
          {hets.stale ? " — this answer is stale, re-check" : ""}.
        </InlineAlert>
      ) : null}
      {hets?.hospiceElectionOpen ? (
        <WarningNote>
          HETS shows a hospice election still open — Medicare rejects a new NOE until the previous
          election is closed (NOTR or final claim).
        </WarningNote>
      ) : null}
      {warnings.map((w) => (
        <WarningNote key={w}>{w}</WarningNote>
      ))}
    </div>
  );
}

/** A non-blocking warning line (warning tint + alert glyph; the colour is never the only signal). */
export function WarningNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <output
      style={{
        display: "flex",
        gap: "0.5rem",
        alignItems: "flex-start",
        padding: "0.5rem 0.75rem",
        borderRadius: "0.5rem",
        background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)",
        color: "var(--color-on-surface)",
        fontSize: "0.8125rem",
      }}
    >
      <span aria-hidden style={{ color: "var(--color-warning)", flexShrink: 0 }}>
        <Glyph name="alert" size={16} />
      </span>
      <span>
        <span className="wx-sr-only">Warning: </span>
        {children}
      </span>
    </output>
  );
}
