import { Button, LoadingSpinner, StatusPill, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the ADR WORK PANEL (hospice ADR/TPE/QIC PRD, milestone 2a). Reads the
// case fresh (so the If-Match version is the one the server holds NOW), shows HOW the response due date was
// reached (request date + the MAC window, any business-day roll-back, and whether that window is verified),
// and offers only the moves the ADR state machine has an arc for. There is no "submit" here: filing needs the
// reviewed packet and proof of submission that milestone 2b adds. The server re-validates every move and
// every refusal is shown verbatim (ADR-0030).
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ActionRail, ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import { type AdrDetail, type AdrTransitionTarget, loadAdr, transitionAdr } from "./remittance-api";
import { ADR_STATE_TONE, humanize, toneOf } from "./remittance-status";

/** The moves a person may make from each state (the server re-validates). */
const MOVES: Record<string, readonly AdrTransitionTarget[]> = {
  received: ["in_assembly", "denied_no_response", "withdrawn"],
  in_assembly: ["in_review", "denied_no_response", "withdrawn"],
  in_review: ["in_assembly", "denied_no_response", "withdrawn"],
};

const MOVE_LABEL: Record<AdrTransitionTarget, string> = {
  in_assembly: "Start assembling",
  in_review: "Send to review",
  denied_no_response: "Record MAC denial",
  withdrawn: "Withdraw",
};

export interface AdrDetailPanelProps {
  readonly adrId: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

export function AdrDetailPanel({ adrId, onClose, onChanged }: AdrDetailPanelProps): JSX.Element {
  const client = useApiClient();
  const [adr, setAdr] = useState<AdrDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadAdr(client, adrId);
    if (!mounted.current) return;
    if (res.ok) {
      setAdr(res.value);
      setLoadError(null);
    } else {
      setLoadError(res.message);
    }
  }, [client, adrId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(to: AdrTransitionTarget): Promise<void> {
    if (!adr) return;
    setBusy(true);
    setError(null);
    const res = await transitionAdr(client, adrId, adr.version, to);
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice(`${MOVE_LABEL[to]}: done.`);
    onChanged();
    await load();
  }

  const moves = adr ? (MOVES[adr.state] ?? []) : [];
  const rolledBack = adr ? adr.calendarDueDay !== adr.dueDay : false;

  return (
    <ActionRail ariaLabel="ADR case" onClose={onClose}>
      {loadError ? (
        <ErrorAlert message={loadError} />
      ) : !adr ? (
        <LoadingSpinner />
      ) : (
        <>
          <Facts
            items={[
              ["MAC", adr.macName],
              ["Review type", adr.reviewType === "re_adr" ? "Re-ADR" : "ADR"],
              ["MAC reference", adr.adrReference ?? "None recorded"],
              [
                "State",
                <StatusPill
                  key="s"
                  label={humanize(adr.state)}
                  tone={toneOf(ADR_STATE_TONE, adr.state)}
                />,
              ],
              ["Claim", adr.claimId],
              ["Request date", adr.requestedOn],
              ["Response window", `${adr.windowDays} days`],
              ["Response due", adr.dueDay],
            ]}
          />
          <Hint>
            Due date basis: {adr.requestedOn} plus {adr.windowDays} days is {adr.calendarDueDay}
            {rolledBack
              ? `, a weekend or federal holiday, so the response is due on the previous business day, ${adr.dueDay}`
              : ""}
            . The day ends at 23:59 in the provider's time zone.
          </Hint>
          <Hint>
            {adr.windowVerified
              ? "This MAC window is verified."
              : adr.windowSource === "platform_default"
                ? "Unverified: no rule is set for this MAC, so the platform default window was used. Confirm it against the ADR letter."
                : "Unverified: this MAC rule has not been confirmed. Check it against the ADR letter."}
          </Hint>
          <NoticeAlert message={notice} />
          <ErrorAlert message={error} />
          <ButtonRow>
            {moves.map((to) => (
              <Button
                key={to}
                tone={to === "withdrawn" || to === "denied_no_response" ? "tertiary" : "secondary"}
                size="sm"
                disabled={busy}
                onClick={() => void move(to)}
              >
                {MOVE_LABEL[to]}
              </Button>
            ))}
            {moves.length === 0 ? <Hint>No move is available from this state.</Hint> : null}
          </ButtonRow>
          <Hint>
            Sending a packet to the MAC is added in a later release; until then, file outside
            WardenX and record the MAC's response here.
          </Hint>
          <h3 className="wx-action-title">History</h3>
          <ul>
            {adr.events.map((e) => (
              <li key={e.id}>
                {humanize(e.eventKind)} · {new Date(e.occurredAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </>
      )}
      <ButtonRow end>
        <Button tone="tertiary" onClick={onClose}>
          Close panel
        </Button>
      </ButtonRow>
    </ActionRail>
  );
}
