import { Button, LoadingSpinner, StatusPill, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the TPE PROGRAM PANEL (hospice ADR/TPE/QIC PRD, milestone 5). Reads the program
// fresh (so the If-Match version is the one the server holds NOW) and shows each round's notice, the MAC's results
// letter, education date, sampled claims (linked to the ADR flow) and the outcome. The MAC's rate and result are the
// official values; the claim-count rate is advisory and labelled so; the referral risk is advisory and labelled so. A
// missing threshold is shown as "No threshold confirmed", never assumed. Server messages are shown verbatim and a 409
// reloads the panel (ADR-0030). Nothing is filed or computed beyond what the letters state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ActionRail, ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import {
  ADR_STATE_TONE,
  TPE_PROGRAM_STATE_TONE,
  TPE_RISK_TONE,
  humanize,
  toneOf,
} from "./remittance-status";
import { type TpeProgramDetail, type TpeRound, closeTpeProgram, loadTpeProgram } from "./tpe-api";
import {
  TpeClaimModal,
  TpeEducationModal,
  TpeOutcomeModal,
  TpeResultsModal,
  TpeRoundModal,
} from "./tpe-forms";

type Modal =
  | { readonly kind: "round" }
  | { readonly kind: "outcome" }
  | { readonly kind: "results" | "education" | "claim"; readonly roundId: string };

export const NO_THRESHOLD_TEXT = "No threshold confirmed — enter it from your MAC's TPE letter";

export function thresholdText(t: { pct: number | null; verified: boolean }): string {
  if (t.pct === null) return NO_THRESHOLD_TEXT;
  return `${t.pct}% exit threshold${t.verified ? "" : " (unverified)"}`;
}

export function rateText(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? "Not stated" : `${pct}%`;
}

export interface TpeDetailPanelProps {
  readonly programId: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

export function TpeDetailPanel({
  programId,
  onClose,
  onChanged,
}: TpeDetailPanelProps): JSX.Element {
  const client = useApiClient();
  const [program, setProgram] = useState<TpeProgramDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadTpeProgram(client, programId);
    if (!mounted.current) return;
    if (res.ok) {
      setProgram(res.value);
      setLoadError(null);
    } else {
      setLoadError(res.message);
    }
  }, [client, programId]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = (message: string) => async () => {
    setModal(null);
    setError(null);
    setNotice(message);
    onChanged();
    await load();
  };
  const stale = (message: string) => {
    setModal(null);
    setNotice(null);
    setError(message);
    void load();
    onChanged();
  };
  const common = { onClose: () => setModal(null), onStale: stale };

  async function closeProgram(): Promise<void> {
    if (!program) return;
    setBusy(true);
    setError(null);
    const res = await closeTpeProgram(client, programId, program.version);
    if (!mounted.current) return;
    setBusy(false);
    setConfirmClose(false);
    if (!res.ok) {
      if (res.status === 409) stale(res.message);
      else setError(res.message);
      return;
    }
    setNotice("Program closed.");
    onChanged();
    await load();
  }

  const round = (id: string): TpeRound | undefined => program?.rounds.find((r) => r.id === id);
  const closed = program?.state === "closed";
  const canStartRound = program?.state === "active" && program.roundsRecorded < program.maxRounds;
  const modalRound = modal && "roundId" in modal ? round(modal.roundId) : undefined;

  return (
    <ActionRail ariaLabel="TPE program" onClose={onClose}>
      {loadError ? (
        <ErrorAlert message={loadError} />
      ) : !program ? (
        <LoadingSpinner />
      ) : (
        <>
          <Facts
            items={[
              ["MAC", program.macName],
              ["Provider entity", program.providerEntityId],
              ["Program opened", program.openedOn],
              [
                "State",
                <StatusPill
                  key="s"
                  label={humanize(program.state)}
                  tone={toneOf(TPE_PROGRAM_STATE_TONE, program.state)}
                />,
              ],
              [
                "Round",
                program.currentRound === null
                  ? "No round yet"
                  : `${program.currentRound} of ${program.maxRounds}`,
              ],
              [
                "MAC error rate",
                program.latestRound
                  ? `${rateText(program.latestRound.macErrorRatePct)} (round ${program.latestRound.roundNumber}, ${humanize(program.latestRound.macResult)})`
                  : "No results yet",
              ],
              ["Threshold", thresholdText(program.threshold)],
              ["Earliest next round", program.nextRoundEarliest ?? "Not known yet"],
              [
                "Referral risk (advisory)",
                <StatusPill
                  key="r"
                  label={humanize(program.risk)}
                  tone={toneOf(TPE_RISK_TONE, program.risk)}
                />,
              ],
            ]}
          />
          <Hint>
            Referral risk is an advisory label from the MAC's results so far, not a CMS
            determination and not legal advice. The MAC's letter is the official result.
          </Hint>
          <NoticeAlert message={notice} />
          <ErrorAlert message={error} />

          {program.rounds.map((r) => (
            <section key={r.id} aria-label={`Round ${r.roundNumber}`}>
              <h3 className="wx-action-title">Round {r.roundNumber}</h3>
              <Facts
                items={[
                  ["Notice", r.noticeOn],
                  [
                    "Results letter",
                    r.resultsOn
                      ? `${r.resultsOn} · ${rateText(r.macErrorRatePct)} · ${humanize(r.macResult)}`
                      : "Awaiting results",
                  ],
                  [
                    "Threshold when recorded",
                    r.threshold ? thresholdText(r.threshold) : "Recorded with the results",
                  ],
                  [
                    "Education",
                    r.educationOn
                      ? `${r.educationOn}${r.educationNote ? ` · ${r.educationNote}` : ""}`
                      : "Not recorded",
                  ],
                ]}
              />
              {r.warnings.map((w) => (
                <Hint key={w}>Warning: {w}</Hint>
              ))}
              {r.claims.length === 0 ? (
                <Hint>No sampled claims recorded.</Hint>
              ) : (
                <table className="wx-table">
                  <thead>
                    <tr>
                      <th>Claim</th>
                      <th>ADR</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.claims.map((c) => (
                      <tr key={c.id}>
                        <td>{c.claimId}</td>
                        <td>
                          {c.adrCaseId ? (
                            <>
                              <Link to="/remittance/adrs">View in ADR Requests</Link>{" "}
                              {c.adrState ? (
                                <StatusPill
                                  label={humanize(c.adrState)}
                                  tone={toneOf(ADR_STATE_TONE, c.adrState)}
                                />
                              ) : null}
                            </>
                          ) : (
                            "Not linked"
                          )}
                        </td>
                        <td>{humanize(c.result)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {r.claimCountRate ? (
                <Hint>
                  Claim count: {r.claimCountRate.errors} of {r.claimCountRate.reviewed} reviewed
                  claims in error ({r.claimCountRate.pct}%). This is a claim count, not the MAC's
                  calculation.
                </Hint>
              ) : null}
              {closed ? null : (
                <ButtonRow>
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => setModal({ kind: "results", roundId: r.id })}
                  >
                    {r.resultsOn ? "Edit results" : "Record results"}
                  </Button>
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => setModal({ kind: "education", roundId: r.id })}
                  >
                    Education
                  </Button>
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => setModal({ kind: "claim", roundId: r.id })}
                  >
                    Add sampled claim
                  </Button>
                </ButtonRow>
              )}
            </section>
          ))}

          <h3 className="wx-action-title">Outcome</h3>
          {program.outcomeOn ? (
            <Facts
              items={[
                [
                  "Outcome",
                  program.state === "referred" || program.referralKinds.length > 0
                    ? "Referred to CMS"
                    : "Relief from TPE",
                ],
                ["Letter date", program.outcomeOn],
                ["Relief until", program.reliefUntil ?? "Not recorded"],
                [
                  "Referral types",
                  program.referralKinds.length > 0
                    ? program.referralKinds.map(humanize).join(", ")
                    : "None",
                ],
              ]}
            />
          ) : (
            <Hint>No outcome recorded. Record it when the MAC or CMS sends its final letter.</Hint>
          )}

          {closed ? (
            <Hint>This program is closed and can no longer change.</Hint>
          ) : (
            <ButtonRow>
              {canStartRound ? (
                <Button size="sm" disabled={busy} onClick={() => setModal({ kind: "round" })}>
                  Start round {program.roundsRecorded + 1}
                </Button>
              ) : null}
              {program.state === "active" ? (
                <Button
                  tone="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setModal({ kind: "outcome" })}
                >
                  Record outcome
                </Button>
              ) : null}
              {confirmClose ? (
                <Button tone="danger" size="sm" disabled={busy} onClick={() => void closeProgram()}>
                  Confirm close
                </Button>
              ) : (
                <Button
                  tone="tertiary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmClose(true)}
                >
                  Close program
                </Button>
              )}
            </ButtonRow>
          )}
          {confirmClose ? (
            <Hint>Closing freezes the program, its rounds and its sampled claims.</Hint>
          ) : null}
        </>
      )}
      <ButtonRow end>
        <Button tone="tertiary" onClick={onClose}>
          Close panel
        </Button>
      </ButtonRow>

      {program && modal?.kind === "round" ? (
        <TpeRoundModal
          {...common}
          program={program}
          onDone={(created) => {
            const warn =
              created.warnings.length > 0 ? ` Warning: ${created.warnings.join(" ")}` : "";
            void done(`Round ${created.roundNumber} started.${warn}`)();
          }}
        />
      ) : null}
      {program && modal?.kind === "outcome" ? (
        <TpeOutcomeModal
          {...common}
          program={program}
          onDone={() => void done("Outcome recorded.")()}
        />
      ) : null}
      {modalRound && modal?.kind === "results" ? (
        <TpeResultsModal
          {...common}
          round={modalRound}
          onDone={() => void done("Results saved.")()}
        />
      ) : null}
      {modalRound && modal?.kind === "education" ? (
        <TpeEducationModal
          {...common}
          round={modalRound}
          onDone={() => void done("Education saved.")()}
        />
      ) : null}
      {modalRound && modal?.kind === "claim" ? (
        <TpeClaimModal
          {...common}
          round={modalRound}
          onDone={() => void done("Sampled claim saved.")()}
        />
      ) : null}
    </ActionRail>
  );
}
