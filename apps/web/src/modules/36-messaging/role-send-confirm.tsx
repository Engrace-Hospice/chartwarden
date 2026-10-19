// M36 role-based send (ADR-0081, PROPOSED) - the confirm step of "Message the on-call role": the server's answer to "who covers this
// role right now?" in words. Covered: the person (name, role, shift end and zone in the ROSTER's zone) is chosen and restated in a polite
// live region. Everything else (gap, roster not connected, no schedule, names unavailable, lookup failed, not available) is an explicit
// message with the telephone procedure and NO way to send: there is never a guessed person or a fall-back to a backup. Presentational.
import type {
  OnCallDirectoryRole,
  OnCallRank,
  RoleSendPersonDto,
  RoleSendResolutionDto,
} from "@wardenx/types";
import { Button } from "@wardenx/ui";
import type { JSX, RefObject } from "react";
import {
  CONFIRM_LEGEND,
  LOADING_TEXT,
  LOOKUP_FAILED_TEXT,
  NAMES_UNAVAILABLE_TEXT,
  NOT_AVAILABLE_TEXT,
  RETRY_LABEL,
  confirmLine,
  personLine,
  refusalText,
  shiftLine,
} from "./role-send-wording";
import type { RoleResolutionView } from "./use-role-resolution";

export interface NamedPerson {
  readonly userId: string;
  readonly name: string;
  readonly rank: OnCallRank;
}

/** Only people whose name can be shown are offered (the sender must be able to say who they are messaging). */
export function namedPeople(resolution: RoleSendResolutionDto): {
  readonly named: readonly NamedPerson[];
  readonly hidden: number;
} {
  const named = resolution.people
    .filter((p: RoleSendPersonDto) => (p.display_name ?? "").trim() !== "")
    .map((p) => ({ userId: p.user_id, name: (p.display_name as string).trim(), rank: p.rank }));
  return { named, hidden: resolution.people.length - named.length };
}

/** The confirmed person: the one the sender chose, or the only one on call. Null while a choice among several is still to be made. */
export function chosenPerson(named: readonly NamedPerson[], chosenId: string): NamedPerson | null {
  return (
    named.find((p) => p.userId === chosenId) ?? (named.length === 1 ? (named[0] ?? null) : null)
  );
}

export interface RoleSendConfirmProps {
  readonly id: string;
  readonly role: OnCallDirectoryRole;
  readonly view: RoleResolutionView;
  readonly chosenId: string;
  readonly disabled: boolean;
  readonly regionRef: RefObject<HTMLDivElement>;
  readonly onChoose: (userId: string) => void;
  readonly onRetry: () => void;
}

export function RoleSendConfirm({
  id,
  role,
  view,
  chosenId,
  disabled,
  regionRef,
  onChoose,
  onRetry,
}: RoleSendConfirmProps): JSX.Element {
  const retry = (
    <Button type="button" tone="secondary" disabled={disabled} onClick={onRetry}>
      {RETRY_LABEL}
    </Button>
  );
  let body: JSX.Element;
  if (view.status === "idle" || view.status === "loading") {
    body = <output>{LOADING_TEXT}</output>;
  } else if (view.status === "denied") {
    body = (
      <p className="wx-urgent-error" role="alert">
        {NOT_AVAILABLE_TEXT}
      </p>
    );
  } else if (view.status === "failed") {
    body = (
      <>
        <p className="wx-urgent-error" role="alert">
          {LOOKUP_FAILED_TEXT}
        </p>
        {retry}
      </>
    );
  } else if (view.resolution.status !== "covered") {
    body = (
      <>
        <p className="wx-urgent-error" role="alert">
          {refusalText(view.resolution.status)}
        </p>
        {retry}
      </>
    );
  } else {
    const { resolution } = view;
    const { named, hidden } = namedPeople(resolution);
    const chosen = chosenPerson(named, chosenId);
    body =
      named.length === 0 ? (
        <>
          <p className="wx-urgent-error" role="alert">
            {NAMES_UNAVAILABLE_TEXT}
          </p>
          {retry}
        </>
      ) : (
        <>
          <fieldset disabled={disabled}>
            <legend>{CONFIRM_LEGEND}</legend>
            {named.map((person) => (
              <label key={person.userId}>
                <input
                  type="radio"
                  name={`${id}-person`}
                  value={person.userId}
                  checked={chosen?.userId === person.userId}
                  aria-labelledby={`${id}-p-${person.userId}`}
                  aria-describedby={`${id}-s-${person.userId}`}
                  onChange={() => onChoose(person.userId)}
                />
                <span>
                  <span id={`${id}-p-${person.userId}`}>
                    {personLine(role, person.name, person.rank)}
                  </span>
                  <span className="wx-urgent-hint" id={`${id}-s-${person.userId}`}>
                    {" "}
                    {shiftLine(resolution.as_of, resolution.shift_ends_at, resolution.time_zone)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {hidden > 0 ? <p className="wx-urgent-hint">{NAMES_UNAVAILABLE_TEXT}</p> : null}
          <p className="wx-urgent-notice" aria-live="polite">
            {chosen ? confirmLine(role, chosen.name, chosen.rank) : ""}
          </p>
        </>
      );
  }
  return (
    <div ref={regionRef} tabIndex={-1} className="wx-urgent-confirm">
      {body}
    </div>
  );
}
