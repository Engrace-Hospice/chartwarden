import type { PollDetailView, PollView } from "@chartwarden/types";
// WP 2.10: the poll on a message. A single-choice radio group with NAMED votes: choosing an option saves the vote
// (a different choice later changes it, until the poll is closed). Results are text first ("3 votes (60%)"), the bar is
// decoration; a polite live region says what changed. Everything is a native control, so it is keyboard operable
// (arrow keys move the choice, Tab leaves the group). The question itself is the message body above this card.
import { Button, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { type PollAction, pollFailureCopy, pollStatusText, voteSummary } from "./poll-utils";
import "./polls.css";

const POLL_PATH = "/api/v1/messaging/channels/{id}/messages/{messageId}/poll";

interface PollCardProps {
  readonly channelId: string;
  readonly messageId: string;
  readonly poll: PollView;
  /** False in an archived channel: results still show, nothing changes. */
  readonly canVote: boolean;
}

function optionLabel(poll: PollView, optionId: string | null): string {
  return poll.options.find((o) => o.optionId === optionId)?.label ?? "";
}

export function PollCard({
  channelId,
  messageId,
  poll: served,
  canVote,
}: PollCardProps): JSX.Element {
  const client = useApiClient();
  const path = { id: channelId, messageId };
  const [override, setOverride] = useState<PollView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [detail, setDetail] = useState<PollDetailView | null>(null);
  const [showVoters, setShowVoters] = useState(false);
  const busyRef = useRef(false);
  const poll = override ?? served;
  const groupName = `poll-${poll.pollId}`;

  // A fresh read of the message is the truth; drop whatever our last answer said.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the server's values change identity
  useEffect(() => {
    setOverride(null);
    setDetail(null);
  }, [served]);

  async function run(
    action: PollAction,
    work: () => Promise<{ ok: true; note: string } | { ok: false; status?: number }>,
  ): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await work();
      const text = result.ok ? result.note : pollFailureCopy(result.status, action);
      if (!result.ok) setFailure(text);
      setAnnouncement(text);
    } catch {
      const text = pollFailureCopy(undefined, action);
      setFailure(text);
      setAnnouncement(text);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function vote(optionId: string): Promise<void> {
    return run("vote", async () => {
      const { data, error, response } = await client.PUT(`${POLL_PATH}/vote`, {
        params: { path },
        body: { optionId },
      });
      if (error || !data) {
        // The poll closed under the voter: show it closed so the radios lock without a reload.
        if (response?.status === 409) setOverride({ ...poll, closed: true, canClose: false });
        return { ok: false, status: response?.status };
      }
      setOverride(data.poll);
      setDetail(null);
      return { ok: true, note: `Vote saved: ${optionLabel(data.poll, optionId)}.` };
    });
  }

  function closePoll(): Promise<void> {
    return run("close", async () => {
      const { data, error, response } = await client.POST(`${POLL_PATH}/close`, {
        params: { path },
      });
      if (error || !data) return { ok: false, status: response?.status };
      setOverride(data.poll);
      setConfirmClose(false);
      return { ok: true, note: "Poll closed. Votes can no longer be changed." };
    });
  }

  async function toggleVoters(): Promise<void> {
    if (showVoters) {
      setShowVoters(false);
      return;
    }
    setShowVoters(true);
    await run("load", async () => {
      const { data, error, response } = await client.GET(POLL_PATH, { params: { path } });
      if (error || !data) {
        setShowVoters(false);
        return { ok: false, status: response?.status };
      }
      setDetail(data);
      return { ok: true, note: "Votes shown by name." };
    });
  }

  const locked = poll.closed || !canVote || busy;
  return (
    <section className="wx-poll" aria-label="Poll">
      <fieldset className="wx-poll-options">
        <legend className="wx-poll-legend">
          {poll.closed ? "Poll closed" : "Choose one option"}
        </legend>
        {poll.options.map((option) => {
          const chosen = poll.myOptionId === option.optionId;
          return (
            <label
              key={option.optionId}
              className="wx-poll-option"
              data-chosen={chosen || undefined}
            >
              <input
                type="radio"
                name={groupName}
                checked={chosen}
                disabled={locked}
                onChange={() => void vote(option.optionId)}
              />
              <span className="wx-poll-label">{option.label}</span>
              <span className="wx-poll-count">
                {voteSummary(option.voteCount, poll.totalVotes)}
              </span>
              <progress
                className="wx-poll-bar"
                value={option.voteCount}
                max={Math.max(poll.totalVotes, 1)}
                aria-hidden="true"
              />
            </label>
          );
        })}
      </fieldset>
      <div className="wx-poll-footer">
        <span className="wx-poll-status">{pollStatusText(poll)}</span>
        {poll.myOptionId ? (
          <span className="wx-poll-mine">Your vote: {optionLabel(poll, poll.myOptionId)}</span>
        ) : null}
        <Button
          type="button"
          tone="secondary"
          size="sm"
          aria-expanded={showVoters}
          disabled={busy}
          onClick={() => void toggleVoters()}
        >
          {showVoters ? "Hide who voted" : "Who voted"}
        </Button>
        {poll.canClose && canVote && !confirmClose ? (
          <Button
            type="button"
            tone="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmClose(true)}
          >
            Close poll
          </Button>
        ) : null}
      </div>
      {confirmClose ? (
        <fieldset className="wx-poll-confirm">
          <legend className="sr-only">Close this poll?</legend>
          <span>Close this poll? Nobody can vote or change a vote afterwards.</span>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            loading={busy}
            onClick={() => void closePoll()}
          >
            Close poll
          </Button>
          <Button
            type="button"
            tone="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmClose(false)}
          >
            Keep open
          </Button>
        </fieldset>
      ) : null}
      {showVoters && detail ? <PollVoters poll={poll} detail={detail} /> : null}
      {failure ? (
        <div role="alert" className="wx-poll-error">
          {failure}
        </div>
      ) : null}
      <output className="wx-poll-live" aria-live="polite">
        {announcement}
      </output>
    </section>
  );
}

function PollVoters({ poll, detail }: { poll: PollView; detail: PollDetailView }): JSX.Element {
  return (
    <div className="wx-poll-voters">
      {poll.options.map((option) => {
        const voters = detail.voters[option.optionId] ?? [];
        return (
          <div key={option.optionId}>
            <h4>{option.label}</h4>
            {voters.length === 0 ? (
              <p>No votes yet.</p>
            ) : (
              <ul>
                {voters.map((voter) => (
                  <li key={voter.userId}>{voter.displayName}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
