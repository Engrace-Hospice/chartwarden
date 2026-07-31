import {
  DashboardLayout,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the 5% VOLUNTEER TIME-COST RATIO (§5.1 #12, Track B).
// Spec: docs/design/screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md — Hours & 5% Ratio.
//
// 42 CFR §418.78(e): volunteer hours must be at least 5% of total patient-care hours, per provider entity
// per fiscal year. Green ≥5%, yellow 3–5% (corrective prompt), red <3% (escalates to DON + Compliance).
//
// THE POINT OF THIS SCREEN IS THE HONEST DENOMINATOR. The numerator (the volunteer hour ledger) is real;
// the denominator is M27's total patient-care hours, and that seam is not bound yet — so the server returns
// `status: "unavailable"` with the reason, NOT a 0% breach. This screen renders that as "cost basis
// unavailable" and shows the numerator it does have. A dashboard that drew a red 0% here would page a DON
// about a compliance failure that has not been measured, which is worse than showing nothing.
//
// A zero denominator is treated the same way for the same reason: a provider entity with no recorded
// patient-care hours has no ratio to fail.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { type HourRatioView, errorMessage, getHourRatio, writeHeaders } from "./discipline-api";
import {
  Card,
  Field,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  ghostButtonStyle,
  mutedStyle,
  primaryButtonStyle,
} from "./discipline-ui";
import { RATIO_STATUS_TONE, hours, humanize, pct, toneOf } from "./discipline-status";

/** The §7.6 bands, stated on the page so the color is never the only signal (Hard Rule §10.10). */
// The band NAME is the pill (it, not the tone, is what carries the meaning for a reader who cannot
// use the color); the threshold sits beside it as text. Keeping the whole sentence inside the pill
// made an unwrappable ~300px box that overflowed the aside rail and clipped mid-word.
const BANDS = [
  { label: "Green", detail: "at or above 5%", tone: "success" as const },
  { label: "Yellow", detail: "3% to 5%, corrective action prompted", tone: "warning" as const },
  { label: "Red", detail: "below 3%, escalates to DON and Compliance", tone: "error" as const },
];

function currentFiscalYear(): number {
  return new Date().getUTCFullYear();
}

export function VolunteerHourRatio(): JSX.Element {
  const client = useApiClient();
  const [providerEntityId, setProviderEntityId] = useState("");
  const [fiscalYear, setFiscalYear] = useState(String(currentFiscalYear()));
  const [ratio, setRatio] = useState<HourRatioView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  const load = useCallback(async () => {
    const pe = providerEntityId.trim();
    if (pe === "") {
      setRatio(null);
      return;
    }
    setLoading(true);
    setError(null);
    const { ratio: result, error: err } = await getHourRatio(client, {
      providerEntityId: pe,
      fiscalYear: Number(fiscalYear),
    });
    if (err) {
      setRatio(null);
      setError(errorMessage(err, "The volunteer hour ratio could not be read."));
      setLoading(false);
      return;
    }
    setRatio(result);
    setLoading(false);
  }, [client, providerEntityId, fiscalYear]);

  useEffect(() => {
    void load();
  }, [load]);

  const yearOptions = [0, 1, 2, 3].map((back) => {
    const y = currentFiscalYear() - back;
    return { value: String(y), label: String(y) };
  });

  const unavailable = ratio?.status === "unavailable";

  return (
    <>
      <DashboardLayout
        header={
          <PageHeader
            title="Volunteer 5% ratio"
            breadcrumb="Admin — 42 CFR §418.78(e) volunteer time-cost ratio"
            actions={
              <button type="button" style={ghostButtonStyle} onClick={() => setAdjusting(true)}>
                Log hour adjustment
              </button>
            }
          />
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Ratio"
              value={ratio ? (unavailable ? "unavailable" : pct(ratio.ratio)) : "—"}
            />
            <KpiCard label="Volunteer hours" value={ratio ? hours(ratio.volunteerHourMinutes) : "—"} />
            <KpiCard
              label="Patient-care hours"
              value={ratio ? hours(ratio.staffPatientCareMinutes) : "—"}
            />
            <KpiCard label="Fiscal year" value={ratio ? String(ratio.fiscalYear) : fiscalYear} />
          </KpiStrip>
        }
        charts={
          <FilterRow>
            <TextField
              label="Provider entity id"
              value={providerEntityId}
              onChange={setProviderEntityId}
            />
            <SelectField
              label="Fiscal year"
              value={fiscalYear}
              options={yearOptions}
              onChange={setFiscalYear}
            />
          </FilterRow>
        }
        table={
          loading ? (
            <LoadingSpinner />
          ) : error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : !ratio ? (
            <EmptyState
              title="Choose a provider entity"
              description="The 418.78(e) ratio is computed per provider entity per fiscal year."
            />
          ) : (
            <Card
              title="418.78(e) ratio"
              actions={
                <StatusPill
                  label={humanize(ratio.status)}
                  tone={toneOf(RATIO_STATUS_TONE, ratio.status)}
                />
              }
            >
              {unavailable ? (
                <Notice tone="warning">
                  Cost basis unavailable —{" "}
                  {ratio.reason ??
                    "the total patient-care hours this ratio divides by are not available yet."}{" "}
                  The volunteer hours below are real; the ratio is not computed, and this is not a
                  compliance breach.
                </Notice>
              ) : null}
              <SummaryGrid>
                <Field label="Volunteer hours (numerator)" value={hours(ratio.volunteerHourMinutes)} />
                <Field
                  label="Patient-care hours (denominator)"
                  value={
                    ratio.staffPatientCareMinutes === null
                      ? "not available"
                      : hours(ratio.staffPatientCareMinutes)
                  }
                />
                <Field label="Ratio" value={unavailable ? "not computed" : pct(ratio.ratio)} />
                <Field label="Provider entity" value={ratio.providerEntityId} mono />
              </SummaryGrid>
            </Card>
          )
        }
        aside={
          <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
            <Card title="Bands">
              {BANDS.map((b) => (
                <div
                  key={b.label}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: t.space1,
                  }}
                >
                  <StatusPill label={b.label} tone={b.tone} />
                  <span style={mutedStyle}>{b.detail}</span>
                </div>
              ))}
              <span style={mutedStyle}>
                An unavailable ratio never pages: alerting on a missing denominator would train the
                recipients to ignore a real breach.
              </span>
            </Card>
            <Card title="Numerator sources">
              <span style={mutedStyle}>
                Signed volunteer visits are ledgered nightly; administrative volunteer time is its own
                typed source; a manual adjustment is the audited correction path and is the only entry
                that may carry negative minutes.
              </span>
            </Card>
          </div>
        }
      />

      {adjusting ? (
        <HourAdjustmentModal
          providerEntityId={providerEntityId}
          fiscalYear={Number(fiscalYear)}
          onClose={() => setAdjusting(false)}
          onSaved={() => {
            setAdjusting(false);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

/** Route 24 — the audited manual hour adjustment (the only path that may carry negative minutes). */
function HourAdjustmentModal({
  providerEntityId,
  fiscalYear,
  onClose,
  onSaved,
}: {
  providerEntityId: string;
  fiscalYear: number;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [pe, setPe] = useState(providerEntityId);
  const [year, setYear] = useState(String(fiscalYear));
  const [volunteerMembershipId, setVolunteer] = useState("");
  const [durationMinutes, setDuration] = useState("");
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [adjustmentReason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minutes = Number(durationMinutes);
  const validMinutes = Number.isInteger(minutes) && minutes !== 0;
  const canSubmit =
    pe.trim() !== "" &&
    volunteerMembershipId.trim() !== "" &&
    validMinutes &&
    adjustmentReason.trim() !== "" &&
    !busy;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/volunteer-hour-entries", {
      params: { header: writeHeaders() },
      body: {
        providerEntityId: pe.trim(),
        fiscalYear: Number(year),
        volunteerMembershipId: volunteerMembershipId.trim(),
        durationMinutes: minutes,
        occurredAt: new Date(occurredAt).toISOString(),
        adjustmentReason,
      },
    } as never);
    setBusy(false);
    if (res.error) {
      setError(errorMessage(res.error, "The hour adjustment was not recorded."));
      return;
    }
    onSaved();
  }

  return (
    <Modal
      title="Log volunteer hour adjustment"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5 }}
        >
          {busy ? "Recording…" : "Record adjustment"}
        </button>
      }
    >
      <TextField label="Provider entity id" value={pe} onChange={setPe} />
      <TextField label="Fiscal year" type="number" value={year} onChange={setYear} />
      <TextField
        label="Volunteer membership id"
        value={volunteerMembershipId}
        onChange={setVolunteer}
      />
      <TextField
        label="Duration in minutes (negative to correct an over-count)"
        type="number"
        value={durationMinutes}
        onChange={setDuration}
      />
      <TextField label="Occurred on" type="date" value={occurredAt} onChange={setOccurredAt} />
      <TextAreaField
        label="Adjustment reason"
        value={adjustmentReason}
        onChange={setReason}
        rows={3}
        hint="Required. The adjustment is attributed to your membership on the ledger."
      />
      {!validMinutes && durationMinutes !== "" ? (
        <p style={alertStyle}>Enter a non-zero whole number of minutes.</p>
      ) : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
