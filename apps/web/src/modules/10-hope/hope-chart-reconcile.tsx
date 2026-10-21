// HOPE A0600B (Medicare number) / A0700 (Medicaid number) vs the patient's chart — the reconcile dialog
// behind the "Not on the patient's chart" / "Differs from the chart" notes. Three ways out:
//   * fix HOPE  — use the chart's number (a draft only; a signed record needs a correction),
//   * fix the chart — add the HOPE number as Medicare / Medicaid coverage, or re-file the existing
//     coverage with the HOPE number (POST /patients/:id/payers closes the row at that rank and inserts
//     its replacement, so the chart keeps history), or
//   * neither — type the number from the member card; it goes to HOPE (drafts) and to the chart's coverage.
// M5 keeps payer numbers on `patient_payer`; a chart MBI held as a patient identifier has no write route,
// so that case points to the patient chart.
import {
  isValidMedicaidNumber,
  isValidMedicareNumber,
  normalizeMedicaidNumber,
  normalizeMedicareNumber,
} from "@chartwarden/types";
import { Button, useApiClient } from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";

export interface ChartPayer {
  id: string;
  payerId: string;
  rank: number;
  coverageKind: string;
  subscriberId: string | null;
  groupNumber: string | null;
  binPcn: string | null;
  current: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Where the chart's number comes from: an MBI identifier, or a coverage row's subscriber ID. */
export interface ChartNumber {
  value: string;
  source: "identifier" | "coverage";
  coverage: ChartPayer | null;
}

export type ReconcileItem = "A0600B" | "A0700";

const ITEM_META: Record<
  ReconcileItem,
  { noun: string; kinds: { value: string; label: string }[] }
> = {
  A0600B: {
    noun: "Medicare number",
    kinds: [
      { value: "medicare_ffs", label: "Medicare fee-for-service" },
      { value: "medicare_advantage", label: "Medicare Advantage" },
    ],
  },
  A0700: { noun: "Medicaid number", kinds: [{ value: "medicaid", label: "Medicaid" }] },
};

const COVERAGE_LABEL: Record<string, string> = {
  medicare_ffs: "Medicare FFS",
  medicare_advantage: "Medicare Advantage",
  medicaid: "Medicaid",
};
const coverageLabel = (kind: string) => COVERAGE_LABEL[kind] ?? kind.replace(/_/g, " ");

function normalize(itemCode: ReconcileItem, raw: string): string {
  return itemCode === "A0600B" ? normalizeMedicareNumber(raw) : normalizeMedicaidNumber(raw);
}

function isValid(itemCode: ReconcileItem, raw: string): boolean {
  return itemCode === "A0600B" ? isValidMedicareNumber(raw) : isValidMedicaidNumber(raw);
}

export function ChartReconcileDialog(props: {
  itemCode: ReconcileItem;
  hopeValue: string;
  chart: ChartNumber | null;
  patientId: string;
  payers: ChartPayer[];
  /** Default effective date for new coverage — the admission date (A0220), so HOPE sees it in force. */
  admissionDate: string | null;
  /** False on a signed record: HOPE can then only change through a correction. */
  canEditHope: boolean;
  /** Signed records: opens the correction draft (creating it when none is in progress). */
  correction?: { label: string; onOpen: () => void } | null;
  /** Saves a number in the HOPE answer (the chart's, or one typed from the member card). */
  onUseChart: (value: string) => Promise<void>;
  onChartUpdated: () => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const client = useApiClient();
  const meta = ITEM_META[props.itemCode];
  // Local copy: saving a corrected number in HOPE (no chart yet) re-offers "Add it to the chart" for it.
  const [hopeValue, setHopeValue] = useState(props.hopeValue);
  const hopeNumber = normalize(props.itemCode, hopeValue);
  const hopeValid = isValid(props.itemCode, hopeValue);
  const [entered, setEntered] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const currentRanks = props.payers.filter((p) => p.current).map((p) => p.rank);
  const [busy, setBusy] = useState<"hope" | "chart" | "both" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [payerId, setPayerId] = useState("");
  const [coverageKind, setCoverageKind] = useState(meta.kinds[0]!.value);
  const [rank, setRank] = useState(String(currentRanks.length ? Math.max(...currentRanks) + 1 : 1));
  const [effectiveFrom, setEffectiveFrom] = useState(
    props.admissionDate ?? new Date().toISOString().slice(0, 10),
  );

  const post = client.POST as unknown as (
    path: string,
    init: unknown,
  ) => Promise<{ data?: unknown; error?: unknown }>;

  async function postCoverage(body: Record<string, unknown>): Promise<boolean> {
    const result = await post("/api/v1/patients/{id}/payers", {
      params: { path: { id: props.patientId } },
      body,
    });
    if (result.error) {
      const message = (result.error as { error?: { message?: string } }).error?.message;
      setError(
        message ?? "The chart could not be updated. Check your permission to edit patients.",
      );
      return false;
    }
    await props.onChartUpdated();
    return true;
  }

  async function fileCoverage(body: Record<string, unknown>, success: string): Promise<void> {
    setBusy("chart");
    setError(null);
    const ok = await postCoverage(body);
    setBusy(null);
    if (ok) setDone(success);
  }

  async function useChart(): Promise<void> {
    if (!props.chart) return;
    setBusy("hope");
    setError(null);
    try {
      await props.onUseChart(props.chart.value);
      setDone(`HOPE now uses the chart's ${meta.noun}.`);
    } catch {
      setError("The HOPE answer could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  const chart = props.chart;
  const coverage = chart?.source === "coverage" ? chart.coverage : null;
  const chartValid = chart ? isValid(props.itemCode, chart.value) : false;
  const numberKind = props.itemCode === "A0600B" ? "MBI" : "Medicaid number";
  const enteredNumber = normalize(props.itemCode, entered);
  const enteredValid = isValid(props.itemCode, entered);
  const refile = (subscriberId: string) =>
    coverage
      ? {
          payerId: coverage.payerId,
          rank: coverage.rank,
          coverageKind: coverage.coverageKind,
          subscriberId,
          groupNumber: coverage.groupNumber,
          binPcn: coverage.binPcn,
          effectiveFrom: coverage.effectiveFrom,
        }
      : null;

  // "Neither is right": the member-card number goes to HOPE (drafts) and re-files the chart's coverage.
  async function saveEntered(): Promise<void> {
    if (!enteredValid) return;
    setBusy("both");
    setError(null);
    setNote(null);
    const wrote: string[] = [];
    if (props.canEditHope && enteredNumber !== hopeNumber) {
      try {
        await props.onUseChart(enteredNumber);
        wrote.push("in HOPE");
      } catch {
        setError("The HOPE answer could not be saved.");
        setBusy(null);
        return;
      }
    }
    const body = refile(enteredNumber);
    if (body && enteredNumber !== chart?.value) {
      if (!(await postCoverage(body))) {
        setBusy(null);
        return;
      }
      wrote.push("on the chart");
    }
    setBusy(null);
    if (props.canEditHope) setHopeValue(enteredNumber);
    if (!chart && props.canEditHope) {
      setEntered("");
      setNote(`Saved in HOPE. Add it to the patient's chart below.`);
      return;
    }
    setDone(
      wrote.length
        ? `The ${meta.noun} is saved ${wrote.join(" and ")}.`
        : `Nothing to change — both already use that ${meta.noun}.`,
    );
  }
  const correctionButton = props.correction ? (
    <Button tone="primary" onClick={props.correction.onOpen}>
      {props.correction.label}
    </Button>
  ) : null;

  return (
    <div style={backdrop} role="presentation">
      <dialog style={modal} open aria-modal="true" aria-labelledby="hope-reconcile-title">
        <h2 id="hope-reconcile-title" style={title}>
          Reconcile {meta.noun}
        </h2>
        <dl style={compare}>
          <dt>In HOPE ({props.itemCode})</dt>
          <dd>
            <code>{hopeNumber}</code>
            {!hopeValid ? <span style={warn}> — not a valid {numberKind}</span> : null}
          </dd>
          <dt>On the chart</dt>
          <dd>
            {chart ? (
              <>
                <code>{chart.value}</code>
                {!chartValid ? <span style={warn}> — not a valid {numberKind}</span> : null}
                <span style={muted}>
                  {" "}
                  {chart.source === "identifier"
                    ? "(patient identifier)"
                    : `(${coverageLabel(coverage?.coverageKind ?? "")} coverage, rank ${coverage?.rank})`}
                </span>
              </>
            ) : (
              <span style={muted}>Not recorded</span>
            )}
          </dd>
        </dl>

        {done ? (
          <output style={success}>{done}</output>
        ) : (
          <>
            {chart ? (
              <section style={option}>
                <h3 style={optionTitle}>The chart is right</h3>
                <p style={muted}>Replace the number in HOPE with the chart's.</p>
                {!chartValid ? (
                  <p style={warn}>
                    The chart's value is not a valid {numberKind} either — check the member card
                    before relying on it.
                  </p>
                ) : null}
                {props.canEditHope ? (
                  <Button tone="secondary" disabled={busy !== null} onClick={() => void useChart()}>
                    {busy === "hope" ? "Saving…" : "Use the chart's number in HOPE"}
                  </Button>
                ) : (
                  <>
                    <p style={muted}>
                      This HOPE record is signed, so it changes only through a correction. Reconcile
                      again from the correction draft.
                    </p>
                    {correctionButton}
                  </>
                )}
              </section>
            ) : null}

            {note ? <output style={success}>{note}</output> : null}
            <section style={option}>
              <h3 style={optionTitle}>
                {chart ? "The HOPE number is right" : "Add it to the patient's chart"}
              </h3>
              {!hopeValid ? (
                <p style={muted}>
                  The HOPE value is not a valid {numberKind}, so it cannot go on the chart. Correct
                  it in HOPE first.
                </p>
              ) : chart?.source === "identifier" ? (
                <p style={muted}>
                  The chart's number is a patient identifier, which is corrected from the{" "}
                  <Link to={`/patients/${props.patientId}?view=demographics`}>patient chart</Link>.
                </p>
              ) : coverage ? (
                <>
                  <p style={muted}>
                    Re-file the {coverageLabel(coverage.coverageKind)} coverage (rank{" "}
                    {coverage.rank}) with the HOPE number. Its payer and dates are kept; the old
                    entry stays in the coverage history.
                  </p>
                  <Button
                    tone="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void fileCoverage(
                        {
                          payerId: coverage.payerId,
                          rank: coverage.rank,
                          coverageKind: coverage.coverageKind,
                          subscriberId: hopeNumber,
                          groupNumber: coverage.groupNumber,
                          binPcn: coverage.binPcn,
                          effectiveFrom: coverage.effectiveFrom,
                        },
                        `The chart's ${meta.noun} is updated.`,
                      )
                    }
                  >
                    {busy === "chart" ? "Updating…" : "Update the chart"}
                  </Button>
                </>
              ) : (
                <div style={form}>
                  <MdmEntityLookupField
                    kind="payer"
                    label="Payer"
                    value={payerId}
                    onChange={setPayerId}
                    required
                  />
                  <div style={row}>
                    <label style={field}>
                      Coverage kind
                      <select
                        value={coverageKind}
                        onChange={(e) => setCoverageKind(e.target.value)}
                        disabled={meta.kinds.length === 1}
                      >
                        {meta.kinds.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={field}>
                      Rank
                      <input
                        type="number"
                        min={1}
                        value={rank}
                        onChange={(e) => setRank(e.target.value)}
                      />
                    </label>
                    <label style={field}>
                      Effective from
                      <input
                        type="date"
                        value={effectiveFrom}
                        onChange={(e) => setEffectiveFrom(e.target.value)}
                      />
                    </label>
                  </div>
                  <p style={muted}>
                    Effective from defaults to the admission date so this assessment sees the
                    coverage in force.
                  </p>
                  <Button
                    tone="primary"
                    disabled={busy !== null || !payerId || !effectiveFrom || Number(rank) < 1}
                    onClick={() =>
                      void fileCoverage(
                        {
                          payerId,
                          rank: Number(rank),
                          coverageKind,
                          subscriberId: hopeNumber,
                          groupNumber: null,
                          binPcn: null,
                          effectiveFrom,
                        },
                        `Added to the chart as ${coverageLabel(coverageKind)} coverage.`,
                      )
                    }
                  >
                    {busy === "chart" ? "Adding…" : "Add to chart"}
                  </Button>
                </div>
              )}
            </section>

            <section style={option}>
              <h3 style={optionTitle}>{chart ? "Neither is right" : "The HOPE number is wrong"}</h3>
              <p style={muted}>
                Enter the {meta.noun} from the member card.
                {props.itemCode === "A0600B"
                  ? " An MBI has 11 characters, starts with 1–9, and never uses S, L, O, I, B or Z."
                  : ""}
              </p>
              <label style={field}>
                Correct {meta.noun}
                <input
                  value={entered}
                  onChange={(e) => setEntered(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={entered.trim() !== "" && !enteredValid}
                />
              </label>
              {entered.trim() !== "" && !enteredValid ? (
                <p style={warn}>Not a valid {numberKind}.</p>
              ) : null}
              <p style={muted}>
                {props.canEditHope && coverage
                  ? `Saves it in HOPE and re-files the ${coverageLabel(coverage.coverageKind)} coverage (rank ${coverage.rank}) with it.`
                  : props.canEditHope && chart?.source === "identifier"
                    ? "Saves it in HOPE. The chart's patient identifier is corrected from the patient chart."
                    : props.canEditHope
                      ? "Saves it in HOPE, then offers to add it to the chart."
                      : coverage
                        ? `Re-files the ${coverageLabel(coverage.coverageKind)} coverage (rank ${coverage.rank}) with it. HOPE is signed — reconcile again from the correction draft to change it there.`
                        : "HOPE is signed — open the correction draft to enter it there."}
              </p>
              {props.canEditHope || coverage ? (
                <Button
                  tone="primary"
                  disabled={busy !== null || !enteredValid}
                  onClick={() => void saveEntered()}
                >
                  {busy === "both" ? "Saving…" : "Save the correct number"}
                </Button>
              ) : null}
              {/* With a chart number the correction button already sits under "The chart is right". */}
              {!props.canEditHope && !chart ? correctionButton : null}
            </section>
          </>
        )}

        {error ? (
          <p role="alert" style={warn}>
            {error}
          </p>
        ) : null}
        <div style={actions}>
          <Button tone="secondary" onClick={props.onClose}>
            {done ? "Done" : "Cancel"}
          </Button>
        </div>
      </dialog>
    </div>
  );
}

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--color-scrim)",
  zIndex: 20,
};
const modal: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(560px, calc(100% - 2rem))",
  maxHeight: "calc(100% - 2rem)",
  overflowY: "auto",
  margin: 0,
  border: 0,
  borderRadius: 8,
  background: "var(--color-surface)",
  padding: "1.25rem",
  boxShadow: "var(--shadow-float)",
};
const title: CSSProperties = { margin: "0 0 0.75rem", fontSize: "1.2rem" };
const compare: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "0.35rem 1rem",
  margin: "0 0 1rem",
  fontSize: "0.875rem",
};
const option: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
  justifyItems: "start",
  padding: "0.875rem 0",
  borderTop: "1px solid var(--color-card-border)",
};
const optionTitle: CSSProperties = { margin: 0, fontSize: "0.9375rem" };
const form: CSSProperties = { display: "grid", gap: "0.75rem", width: "100%" };
const row: CSSProperties = { display: "flex", gap: "0.75rem", flexWrap: "wrap" };
const field: CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  fontSize: "0.8125rem",
  fontWeight: 600,
};
const muted: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};
const warn: CSSProperties = { color: "var(--color-error)", fontSize: "0.8125rem" };
const success: CSSProperties = {
  display: "block",
  color: "var(--color-success-pill-fg)",
  fontWeight: 600,
};
const actions: CSSProperties = { display: "flex", justifyContent: "flex-end", marginTop: "0.5rem" };
