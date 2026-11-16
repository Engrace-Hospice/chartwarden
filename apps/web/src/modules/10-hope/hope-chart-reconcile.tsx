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
import { Button, Modal, useApiClient } from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import {
  failedWriteMessage,
  localToday,
  withRequestTimeout,
  writeOutcomeUnknown,
  writeSucceeded,
} from "./hope-api";
import { useFocusOnNewError } from "./use-focus-on-new-error";

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

/** The coverage write got no usable answer (offline, a reset, a timeout, an empty 5xx): it may or may not have landed. */
const CHART_UNCONFIRMED =
  "Could not confirm that the chart was updated. Check the patient's coverage before trying again.";
const CHART_REFUSED = "The chart could not be updated. Check your permission to edit patients.";
/** The HOPE answer save (the parent's) was rejected or never answered: it may or may not have been applied. */
const HOPE_UNCONFIRMED =
  "Could not confirm that the HOPE answer was saved. Check the answer before trying again.";
/**
 * What `onUseChart` rejects with when the HOPE answer save was DEFINITELY not applied (a refusal the server explained, a stale page, a save
 * that was never sent): its message is the words to show. Any other rejection (offline, a timeout, an empty or faulting 5xx) is an unknown
 * outcome and is worded as HOPE_UNCONFIRMED.
 */
export class HopeAnswerNotSavedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HopeAnswerNotSavedError";
  }
}
const hopeFailureWords = (error: unknown): string =>
  error instanceof HopeAnswerNotSavedError ? error.message : HOPE_UNCONFIRMED;
/** The coverage was written; only the re-read of the chart numbers behind this dialog failed. */
const CHART_REFRESH_FAILED =
  " The chart summary behind this dialog could not be refreshed; reload the page to see it.";

/** Why a coverage write did not land, and whether it may still have (no usable answer, or a fault of the server's own). */
interface CoverageFailure {
  readonly message: string;
  readonly outcomeUnknown: boolean;
}

/** What the typed client answers, as far as a write's outcome goes (the client is cast: see `post` below). */
interface PostReply {
  data?: unknown;
  error?: unknown;
  response?: { ok?: boolean; status?: number };
}

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
  const errorRef = useFocusOnNewError<HTMLParagraphElement>(error);
  const [chartStale, setChartStale] = useState(false);
  const [payerId, setPayerId] = useState("");
  const [coverageKind, setCoverageKind] = useState(meta.kinds[0]!.value);
  const [rank, setRank] = useState(String(currentRanks.length ? Math.max(...currentRanks) + 1 : 1));
  // The admission date, else the clinician's own today (not the UTC day, which a US evening has rolled into tomorrow).
  const [effectiveFrom, setEffectiveFrom] = useState(props.admissionDate ?? localToday());
  // The button that was pressed goes away with the options it sat in (and a cleared field disables its button): the outcome
  // takes focus, so Escape and Tab keep working inside the dialog instead of falling to the page behind it.
  const outcomeRef = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (done !== null || note !== null) outcomeRef.current?.focus();
  }, [done, note]);

  const post = client.POST as unknown as (path: string, init: unknown) => Promise<PostReply>;

  /**
   * Files a coverage row: null when it was written, else why it was not (or could not be confirmed). Never rejects, so the
   * callers' `busy` always clears; the request is bounded, so a stalled connection ends as "could not confirm".
   */
  async function postCoverage(body: Record<string, unknown>): Promise<CoverageFailure | null> {
    let reply: PostReply;
    try {
      reply = await withRequestTimeout((signal) =>
        post("/api/v1/patients/{id}/payers", {
          params: { path: { id: props.patientId } },
          body,
          signal,
        }),
      );
    } catch {
      return { message: CHART_UNCONFIRMED, outcomeUnknown: true };
    }
    // Not `error` alone: openapi-fetch leaves it undefined (or "") for a non-OK reply with no body.
    if (!writeSucceeded(reply)) {
      return {
        message: failedWriteMessage(reply, CHART_UNCONFIRMED, CHART_REFUSED),
        outcomeUnknown: writeOutcomeUnknown(reply),
      };
    }
    try {
      await props.onChartUpdated();
    } catch {
      // The coverage is written; only the re-read behind this dialog failed, which the done message says.
      setChartStale(true);
    }
    return null;
  }

  // The parent's save of the HOPE answer, bounded like the chart write: it ignores the signal, but a save nobody
  // answers must not hold this dialog shut for good.
  const saveInHope = (value: string): Promise<void> =>
    withRequestTimeout(() => props.onUseChart(value));

  async function fileCoverage(body: Record<string, unknown>, success: string): Promise<void> {
    setBusy("chart");
    setError(null);
    const failure = await postCoverage(body);
    setBusy(null);
    if (failure === null) setDone(success);
    else setError(failure.message);
  }

  async function useChart(): Promise<void> {
    if (!props.chart) return;
    setBusy("hope");
    setError(null);
    try {
      await saveInHope(props.chart.value);
      setDone(`HOPE now uses the chart's ${meta.noun}.`);
    } catch (error) {
      setError(hopeFailureWords(error));
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
        await saveInHope(enteredNumber);
        wrote.push("in HOPE");
      } catch (error) {
        setError(hopeFailureWords(error));
        setBusy(null);
        return;
      }
    }
    const body = refile(enteredNumber);
    if (body && enteredNumber !== chart?.value) {
      const failure = await postCoverage(body);
      if (failure !== null) {
        setBusy(null);
        // HOPE already holds the number: keep what the dialog shows in step, so a retry sends only the chart write.
        if (wrote.length > 0) setHopeValue(enteredNumber);
        // "Not on the chart" is only said of a refusal; a write that got no usable answer may have landed, which the words say.
        const saved = failure.outcomeUnknown
          ? "Saved in HOPE."
          : "Saved in HOPE, but not on the chart.";
        setError(wrote.length > 0 ? `${saved} ${failure.message}` : failure.message);
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
    // The kit Modal: focus goes in, Tab stays inside, Escape closes (held shut while a write is out: closing would hide its
    // outcome). The scrim never dismisses, so a number typed from the member card is not lost to a stray click.
    <Modal
      open
      onClose={busy !== null ? undefined : props.onClose}
      dismissOnScrim={false}
      ariaLabel={`Reconcile ${meta.noun}`}
      width="35rem"
    >
      <div style={body}>
        <h2 style={title}>Reconcile {meta.noun}</h2>
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
          <output ref={outcomeRef} tabIndex={-1} style={success}>
            {done}
            {chartStale ? CHART_REFRESH_FAILED : ""}
          </output>
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

            {note ? (
              <output ref={outcomeRef} tabIndex={-1} style={success}>
                {note}
              </output>
            ) : null}
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
          // Focus moves here: the pressed button is disabled while the write is out, which drops focus to the page.
          <p ref={errorRef} tabIndex={-1} role="alert" style={warn}>
            {error}
          </p>
        ) : null}
        <div style={actions}>
          {/* Held shut while a write is out (bounded by the request timeout): closing would hide its outcome. */}
          <Button tone="secondary" disabled={busy !== null} onClick={props.onClose}>
            {done ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = { padding: "1.25rem" };
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
