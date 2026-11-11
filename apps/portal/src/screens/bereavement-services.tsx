import { Button, Glyph, NO_ANSWER, useApiClient, useAttemptKey } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// M31 bereavement support — the family's memorial-service invitations (ADR-0109 D10, PR 3), with a reply form while replies are open.
// M16 decides who is invited and when replies close (`rsvpOpen`); this section only shows the invitation and sends the family's answer.
// No invitation (or a route this account may not use) shows nothing at all; a failure is said with a retry. A reply carries one
// Idempotency-Key per attempt (the shared useAttemptKey), tied to what is sent: any answer the app gives ends the attempt, a dropped
// connection (or a gateway page, or the in-flight 409) keeps the key for a retry of the SAME answer (so it cannot reply twice), and a
// changed answer or guest count gets a new key. No answer is chosen for the family: a
// reply sent without one is asked for it. The reply's answer never carries the join link, so a "yes" re-reads the invitations to show it.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { SectionError, SectionLoading } from "./bereavement-section";
import { formatPortalInstant, readError } from "./portal-format";

interface Invitation {
  invitationId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  modality: "in_person" | "virtual";
  venueText: string | null;
  joinUrl: string | null;
  rsvpBy: string | null;
  status: string;
  guests: number;
  rsvpOpen: boolean;
}
type Answer = "yes" | "no" | "maybe";
type Loaded =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: Invitation[] };

const MAX_GUESTS = 10;
const ANSWER_OF: Record<string, Answer> = { rsvp_yes: "yes", rsvp_no: "no", rsvp_maybe: "maybe" };
const ANSWER_TEXT: Record<string, string> = {
  rsvp_yes: "You told us you plan to come.",
  rsvp_no: "You told us you can't make it. You are always welcome to reach out to your team.",
  rsvp_maybe: "You told us you might come.",
  attended: "Thank you for joining us.",
};

/** Only a secure link may leave the portal (the server already requires https; this re-checks). */
function safeJoinUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The server's machine code of a refusal (`{ error: { code } }`), or null. */
const errorCode = (error: unknown): string | null => {
  const code = (error as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === "string" ? code : null;
};
const REFUSAL_TEXT: Record<string, string> = {
  MEMORIAL_RSVP_CLOSED:
    "Replies for this service have closed. Please contact your hospice team if you would like to talk.",
  MEMORIAL_FULL:
    "This service is full. Please contact your hospice team if you would like to talk about coming.",
  IDEMPOTENCY_CONFLICT:
    "Your reply changed while it was being sent. Please check your answer and send it again.",
};

/** Read the family's invitations; never throws. */
async function readInvitations(client: ApiClient): Promise<Exclude<Loaded, { kind: "loading" }>> {
  try {
    const res = await client.GET("/api/v1/portal/bereavement/memorials", {});
    const status = res.response?.status;
    if (res.error) {
      return status === 403 || status === 404
        ? { kind: "hidden" }
        : { kind: "error", message: readError(status) };
    }
    const items = (res.data as { items?: unknown } | undefined)?.items;
    return Array.isArray(items)
      ? { kind: "ready", items: items as Invitation[] }
      : { kind: "error", message: readError(undefined) };
  } catch {
    return { kind: "error", message: readError(undefined) };
  }
}

export function BereavementServicesSection(): JSX.Element | null {
  const client = useApiClient();
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  // Every answer bumps this; a post-yes re-read applies only if no newer answer landed while it was in flight.
  const answerSeq = useRef(0);
  useEffect(() => {
    // StrictMode mounts, unmounts and mounts again: set it here, not only at ref creation.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void attempt;
    let active = true;
    setState({ kind: "loading" });
    void readInvitations(client).then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [client, attempt]);

  const replace = useCallback(
    (next: Invitation) => {
      answerSeq.current += 1;
      const seq = answerSeq.current;
      setState((prev) =>
        prev.kind === "ready"
          ? {
              kind: "ready",
              items: prev.items.map((i) => (i.invitationId === next.invitationId ? next : i)),
            }
          : prev,
      );
      if (next.status !== "rsvp_yes") return;
      // The reply never carries the join link: re-read in place (what is on screen stays if the read fails).
      void readInvitations(client).then((fresh) => {
        if (mounted.current && seq === answerSeq.current && fresh.kind === "ready") setState(fresh);
      });
    },
    [client],
  );

  if (state.kind === "hidden" || (state.kind === "ready" && state.items.length === 0)) return null;
  return (
    <section className="wx-bereavement-panel" aria-labelledby="bereavement-services-heading">
      <div className="wx-bereavement-panel__heading">
        <span className="wx-bereavement-panel__icon" aria-hidden="true">
          <Glyph name="calendar" size={21} />
        </span>
        <div>
          <h2 id="bereavement-services-heading">Memorial services</h2>
          <p>A time to remember together. You are welcome to come, and welcome not to.</p>
        </div>
      </div>
      {state.kind === "loading" ? (
        <SectionLoading label="Loading memorial services" />
      ) : state.kind === "error" ? (
        <SectionError message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <ul className="wx-bereavement-resources">
          {state.items.map((item) => (
            <ServiceCard key={item.invitationId} item={item} onReplied={replace} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ServiceCard({
  item,
  onReplied,
}: {
  item: Invitation;
  onReplied: (next: Invitation) => void;
}): JSX.Element {
  const client = useApiClient();
  const formId = useId();
  const [answer, setAnswer] = useState<Answer | null>(ANSWER_OF[item.status] ?? null);
  const [guests, setGuests] = useState(String(item.guests));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);
  /** The key of the attempt in doubt (a dropped connection) and the reply it carried: reused only for that same reply. */
  const attempt = useAttemptKey();
  const guestCount = answer === "no" ? 0 : Number(guests);
  const guestsValid = Number.isInteger(guestCount) && guestCount >= 0 && guestCount <= MAX_GUESTS;
  const when = formatPortalInstant(item.startsAt) ?? item.startsAt;
  const joinUrl = safeJoinUrl(item.joinUrl);
  const replyBy = item.rsvpBy ? (formatPortalInstant(item.rsvpBy) ?? item.rsvpBy) : null;

  async function send(): Promise<void> {
    if (sending || !guestsValid) return;
    if (answer === null) {
      setThanks(false);
      setError("Please choose an answer.");
      return;
    }
    setSending(true);
    setError(null);
    setThanks(false);
    const body = { response: answer, guests: guestCount };
    const key = attempt.keyFor(JSON.stringify([item.invitationId, body]));
    try {
      const res = await client.POST("/api/v1/portal/bereavement/memorials/{invitationId}/rsvp", {
        params: { path: { invitationId: item.invitationId } },
        headers: { "Idempotency-Key": key },
        body,
      });
      attempt.settle(res.response.status, res.error); // the app answered: a new reply is a new attempt
      if (res.error || !res.data) {
        const code = errorCode(res.error);
        setError(
          (code ? REFUSAL_TEXT[code] : undefined) ??
            "We couldn't send your reply. Please try again in a moment.",
        );
        return;
      }
      onReplied(res.data as Invitation);
      setThanks(true);
    } catch {
      attempt.settle(NO_ANSWER);
      setError(
        "We couldn't confirm your reply was received. Please check your connection and try again.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <li className="wx-bereavement-resource">
      <div className="wx-bereavement-resource__body">
        <span className="wx-bereavement-eyebrow">
          {item.modality === "virtual" ? "Online" : "In person"}
        </span>
        <h3>{item.title}</h3>
        <p>{when}</p>
        {item.venueText ? <p>{item.venueText}</p> : null}
        {item.description ? <p>{item.description}</p> : null}
        {ANSWER_TEXT[item.status] ? <p>{ANSWER_TEXT[item.status]}</p> : null}
        {joinUrl ? (
          <a
            className="wx-bereavement-resource__link"
            href={joinUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Join online: ${item.title} (opens in a new tab)`}
          >
            Join online <Glyph name="arrow-right" size={16} aria-hidden="true" />
          </a>
        ) : null}
        {item.rsvpOpen ? (
          <form
            aria-labelledby={`${formId}-legend`}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <fieldset className="wx-bereavement-rsvp" disabled={sending}>
              <legend id={`${formId}-legend`}>
                Will you be able to come?{replyBy ? ` Please let us know by ${replyBy}.` : ""}
              </legend>
              {(
                [
                  ["yes", "Yes, I plan to come"],
                  ["maybe", "Maybe"],
                  ["no", "I can't make it"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`${formId}-answer`}
                    value={value}
                    checked={answer === value}
                    onChange={() => setAnswer(value)}
                  />{" "}
                  {label}
                </label>
              ))}
              {answer === "no" ? null : (
                <label>
                  How many guests will come with you? (0 to {MAX_GUESTS})
                  <input
                    type="number"
                    min={0}
                    max={MAX_GUESTS}
                    value={guests}
                    onChange={(e) => setGuests(e.target.value)}
                  />
                </label>
              )}
              {!guestsValid ? (
                <p role="alert">Please enter a number of guests from 0 to {MAX_GUESTS}.</p>
              ) : null}
              <Button type="submit" loading={sending} disabled={sending || !guestsValid}>
                Send my reply
              </Button>
            </fieldset>
          </form>
        ) : (
          <p>Replies for this service are closed.</p>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: the region stays mounted so the thank-you is announced */}
        <div role="status">{thanks ? "Thank you. We have your reply." : ""}</div>
        {error ? (
          <div className="wx-bereavement-opt-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </li>
  );
}
