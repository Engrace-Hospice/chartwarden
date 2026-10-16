import { Button, SelectField, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the TPE tracker forms (hospice ADR/TPE/QIC PRD, milestone 5): open a program,
// start a round, record a round's results, education, a sampled claim, and the outcome. Each form collects facts typed
// from the MAC's letters and shows the server's message verbatim (ADR-0030); a 409 means the record changed under the
// user, so the form hands the message to the panel, which reloads. Nothing here decides a threshold or a deadline.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ProviderEntityLookupField } from "../../shell/entity-lookups";
import { ActionModal, ButtonRow, ErrorAlert, FormButtons, Hint } from "./action-ui";
import { type WriteResult, isUuid } from "./remittance-api";
import { humanize } from "./remittance-status";
import {
  TPE_CLAIM_RESULTS,
  TPE_REFERRAL_KINDS,
  type TpeProgramDetail,
  type TpeRound,
  type TpeVersioned,
  createTpeProgram,
  createTpeRound,
  recordTpeOutcome,
  saveTpeClaim,
  saveTpeEducation,
  saveTpeResults,
} from "./tpe-api";

export interface TpeFormProps<T = TpeVersioned> {
  readonly onClose: () => void;
  readonly onDone: (value: T) => void;
  /** The record changed under the user (HTTP 409): the panel shows the message and reloads. */
  readonly onStale: (message: string) => void;
}

/** One submit at a time; unmounted forms drop their result; a 409 goes to `onStale` instead of the form. */
function useSubmit<T>(props: TpeFormProps<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(call: () => Promise<WriteResult<T>>): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await call();
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok) {
      props.onDone(res.value);
      return;
    }
    // Only a true version conflict means "the record moved: reload". A business 409 (a duplicate active program, a
    // previous round still open, a closed program...) is an ordinary refusal: show it here and keep what was typed.
    if (res.code === "VERSION_CONFLICT") props.onStale(res.message);
    else setError(res.message);
  }
  return { busy, error, run };
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** Same calendar day one year on (29 Feb rolls to 28 Feb). Only ever a suggestion. */
function plusOneYear(day: string): string {
  if (!DAY_SHAPE.test(day)) return "";
  const year = Number(day.slice(0, 4)) + 1;
  const md = day.slice(5);
  return `${year}-${md === "02-29" ? "02-28" : md}`;
}

export function TpeProgramModal(
  props: TpeFormProps & { readonly onClose: () => void },
): JSX.Element {
  const client = useApiClient();
  const { busy, error, run } = useSubmit(props);
  const [providerEntityId, setProviderEntityId] = useState("");
  const [macName, setMacName] = useState("");
  const [openedOn, setOpenedOn] = useState("");
  const blocked = providerEntityId === "" || macName.trim() === "" || openedOn === "";
  return (
    <ActionModal ariaLabel="Open a TPE program" onClose={props.onClose}>
      <ProviderEntityLookupField
        label="Provider entity"
        value={providerEntityId}
        onChange={(id) => setProviderEntityId(id)}
      />
      <TextField
        label="MAC"
        value={macName}
        onChange={(e) => setMacName(e.target.value)}
        maxLength={120}
      />
      <TextField
        label="Date on the MAC's TPE notice"
        type="date"
        value={openedOn}
        onChange={(e) => setOpenedOn(e.target.value)}
      />
      <Hint>
        One active program per provider entity and MAC. Round dates come from the MAC's letters.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Open program"
        busy={busy}
        blocked={blocked}
        onSubmit={() =>
          void run(() =>
            createTpeProgram(client, { providerEntityId, macName: macName.trim(), openedOn }),
          )
        }
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}

export function TpeRoundModal(
  props: TpeFormProps<{ id: string; version: number; roundNumber: number; warnings: string[] }> & {
    readonly program: TpeProgramDetail;
  },
): JSX.Element {
  const client = useApiClient();
  const { busy, error, run } = useSubmit(props);
  const [noticeOn, setNoticeOn] = useState("");
  const next = props.program.roundsRecorded + 1;
  return (
    <ActionModal ariaLabel={`Start round ${next}`} onClose={props.onClose}>
      <TextField
        label="Date on the MAC's notice for this round"
        type="date"
        value={noticeOn}
        onChange={(e) => setNoticeOn(e.target.value)}
      />
      <Hint>
        A program has at most {props.program.maxRounds} rounds, and the previous round needs its
        results first. A gap under 45 days is shown as a warning, not blocked: record what really
        happened.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Start round"
        busy={busy}
        blocked={noticeOn === ""}
        onSubmit={() =>
          void run(() => createTpeRound(client, props.program.id, props.program.version, noticeOn))
        }
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}

export function TpeResultsModal(props: TpeFormProps & { readonly round: TpeRound }): JSX.Element {
  const client = useApiClient();
  const { busy, error, run } = useSubmit(props);
  const { round } = props;
  const [resultsOn, setResultsOn] = useState(round.resultsOn ?? "");
  const [rate, setRate] = useState(
    round.macErrorRatePct === null ? "" : String(round.macErrorRatePct),
  );
  const [result, setResult] = useState<string>(round.macResult ?? "");
  const rateNumber = rate.trim() === "" ? null : Number(rate);
  const badRate =
    rateNumber !== null && (!Number.isFinite(rateNumber) || rateNumber < 0 || rateNumber > 100);
  const blocked = resultsOn === "" || result === "" || badRate;
  return (
    <ActionModal ariaLabel={`Results for round ${round.roundNumber}`} onClose={props.onClose}>
      <TextField
        label="Date on the MAC's results letter"
        type="date"
        value={resultsOn}
        onChange={(e) => setResultsOn(e.target.value)}
      />
      <TextField
        label="Error rate stated in the letter (%)"
        type="number"
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        error={badRate ? "Enter a percentage from 0 to 100." : undefined}
      />
      <SelectField
        label="Result stated in the letter"
        value={result}
        onChange={(e) => setResult(e.target.value)}
        options={[
          { value: "", label: "Choose…" },
          { value: "compliant", label: "Compliant" },
          { value: "non_compliant", label: "Non-compliant" },
        ]}
      />
      <Hint>
        The letter's rate and result are the official values. The threshold in force for this MAC is
        recorded when you first save, so a later threshold edit does not change this round.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Save results"
        busy={busy}
        blocked={blocked}
        onSubmit={() =>
          void run(() =>
            saveTpeResults(client, round.id, round.version, {
              resultsOn,
              macErrorRatePct: rateNumber,
              macResult: result as "compliant" | "non_compliant",
            }),
          )
        }
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}

export function TpeEducationModal(props: TpeFormProps & { readonly round: TpeRound }): JSX.Element {
  const client = useApiClient();
  const { busy, error, run } = useSubmit(props);
  const { round } = props;
  const [educationOn, setEducationOn] = useState(round.educationOn ?? "");
  const [note, setNote] = useState(round.educationNote ?? "");
  return (
    <ActionModal ariaLabel={`Education for round ${round.roundNumber}`} onClose={props.onClose}>
      <TextField
        label="Education date (leave blank to clear)"
        type="date"
        value={educationOn}
        onChange={(e) => setEducationOn(e.target.value)}
      />
      <TextField
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
      />
      <Hint>
        The earliest next round is the education date plus 45 days. What the interval counts from is
        unconfirmed.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Save education"
        busy={busy}
        blocked={false}
        onSubmit={() =>
          void run(() =>
            saveTpeEducation(client, round.id, round.version, {
              educationOn: educationOn === "" ? null : educationOn,
              note: note.trim() === "" ? null : note.trim(),
            }),
          )
        }
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}

export function TpeClaimModal(props: TpeFormProps & { readonly round: TpeRound }): JSX.Element {
  const client = useApiClient();
  const { busy, error, run } = useSubmit(props);
  const [claimId, setClaimId] = useState("");
  const [adrCaseId, setAdrCaseId] = useState("");
  const [result, setResult] = useState<string>("pending");
  const blocked = !isUuid(claimId) || (adrCaseId.trim() !== "" && !isUuid(adrCaseId));
  return (
    <ActionModal
      ariaLabel={`Sampled claim for round ${props.round.roundNumber}`}
      onClose={props.onClose}
    >
      <TextField
        label="Claim ID"
        value={claimId}
        onChange={(e) => setClaimId(e.target.value)}
        error={claimId && !isUuid(claimId) ? "Enter the claim's UUID." : undefined}
      />
      <TextField
        label="ADR ID (optional)"
        value={adrCaseId}
        onChange={(e) => setAdrCaseId(e.target.value)}
        error={adrCaseId.trim() && !isUuid(adrCaseId) ? "Enter the ADR's UUID." : undefined}
      />
      <SelectField
        label="Result"
        value={result}
        onChange={(e) => setResult(e.target.value)}
        options={TPE_CLAIM_RESULTS.map((r) => ({ value: r, label: humanize(r) }))}
      />
      <Hint>
        Log and answer the claim's ADR in ADR Requests as usual; linking it here only shows its
        state. Saving an existing claim ID updates it.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Save claim"
        busy={busy}
        blocked={blocked}
        onSubmit={() =>
          void run(() =>
            saveTpeClaim(client, props.round.id, props.round.version, claimId.trim(), {
              result: result as (typeof TPE_CLAIM_RESULTS)[number],
              ...(adrCaseId.trim() ? { adrCaseId: adrCaseId.trim() } : {}),
            }),
          )
        }
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}

export function TpeOutcomeModal(
  props: TpeFormProps & { readonly program: TpeProgramDetail },
): JSX.Element {
  const client = useApiClient();
  const { busy, error, run } = useSubmit(props);
  const [kind, setKind] = useState<"compliant" | "referred">("compliant");
  const [outcomeOn, setOutcomeOn] = useState("");
  const [reliefUntil, setReliefUntil] = useState("");
  const [kinds, setKinds] = useState<readonly string[]>([]);
  const suggestedRelief = plusOneYear(outcomeOn);
  const blocked = outcomeOn === "" || (kind === "referred" && kinds.length === 0);
  const toggle = (k: string) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  return (
    <ActionModal ariaLabel="Record the program outcome" onClose={props.onClose}>
      <SelectField
        label="Outcome"
        value={kind}
        onChange={(e) => setKind(e.target.value as "compliant" | "referred")}
        options={[
          { value: "compliant", label: "Relief from TPE" },
          { value: "referred", label: "Referred to CMS" },
        ]}
      />
      <TextField
        label="Date on the MAC / CMS letter"
        type="date"
        value={outcomeOn}
        onChange={(e) => setOutcomeOn(e.target.value)}
      />
      {kind === "compliant" ? (
        <>
          <TextField
            label="Relief runs until"
            type="date"
            value={reliefUntil}
            onChange={(e) => setReliefUntil(e.target.value)}
          />
          {suggestedRelief ? (
            <ButtonRow>
              <Button tone="tertiary" size="sm" onClick={() => setReliefUntil(suggestedRelief)}>
                Use suggested date ({suggestedRelief})
              </Button>
            </ButtonRow>
          ) : null}
          <Hint>
            Leave blank unless the letter states an end date. The suggestion is one year after the
            letter date; whether relief runs from the results letter or the CMS notice is
            unconfirmed.
          </Hint>
        </>
      ) : (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="wx-action-hint">Referral types named in the letter</legend>
          {TPE_REFERRAL_KINDS.map((k) => (
            <label
              key={k}
              style={{ display: "flex", gap: "0.5rem", alignItems: "center", padding: "0.2rem 0" }}
            >
              <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(k)} />
              <span>{humanize(k)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Record outcome"
        busy={busy}
        blocked={blocked}
        onSubmit={() =>
          void run(() =>
            recordTpeOutcome(
              client,
              props.program.id,
              props.program.version,
              kind === "compliant"
                ? { kind, outcomeOn, ...(reliefUntil ? { reliefUntil } : {}) }
                : {
                    kind,
                    outcomeOn,
                    referralKinds: [...kinds] as (typeof TPE_REFERRAL_KINDS)[number][],
                  },
            ),
          )
        }
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}
