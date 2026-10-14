import type { JSX } from "react";
import { useId, useMemo, useState } from "react";
// M36 WP 3.4 - choose who a task is for. The candidates are the conversation's own members, from the same lookup the
// composer's @-menu uses (no new endpoint); "me" is offered separately because that lookup leaves the caller out.
import { useSession } from "../../shell/session";
import { useMentionCandidates } from "./use-mention-candidates";

export interface Assignee {
  readonly id: string;
  readonly name: string;
}

export interface AssigneePickerProps {
  readonly channelId: string;
  readonly meId: string;
  readonly selected: Assignee | null;
  readonly onSelect: (assignee: Assignee) => void;
  readonly error: string | null;
  readonly inputRef?: React.Ref<HTMLInputElement>;
}

export function AssigneePicker({
  channelId,
  meId,
  selected,
  onSelect,
  error,
  inputRef,
}: AssigneePickerProps): JSX.Element {
  const baseId = useId();
  const session = useSession();
  const [text, setText] = useState("");
  // A stable object per search text: the lookup's effect depends on its identity, so a fresh literal each render would
  // re-run it forever.
  const lookup = useMemo(() => ({ query: text, start: 0 }), [text]);
  const {
    candidates,
    loading,
    error: lookupFailed,
    retry,
  } = useMentionCandidates({
    channelId,
    meId,
    query: lookup,
  });
  const people = candidates.flatMap((c) => (c.kind === "staff" ? [c] : []));
  const choice = (assignee: Assignee, label: string): JSX.Element => (
    <li key={assignee.id}>
      <button
        type="button"
        className="wx-task-person"
        aria-pressed={selected?.id === assignee.id}
        aria-label={label}
        onClick={() => onSelect(assignee)}
      >
        {label}
      </button>
    </li>
  );
  return (
    <div className="wx-task-field">
      <label htmlFor={`${baseId}-search`}>Assign to</label>
      <input
        id={`${baseId}-search`}
        ref={inputRef}
        type="search"
        value={text}
        placeholder="Search people in this conversation"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${baseId}-error` : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      <ul className="wx-task-people" aria-label="People in this conversation">
        {choice({ id: meId, name: session?.displayName ?? "me" }, "Assign to me")}
        {people.map((person) =>
          choice({ id: person.entityId, name: person.displayName }, person.displayName),
        )}
      </ul>
      {loading ? <p className="wx-task-hint">Looking up people...</p> : null}
      {lookupFailed ? (
        <p className="wx-task-hint">
          People could not be loaded.{" "}
          <button type="button" className="wx-task-link" onClick={retry}>
            Try again
          </button>
        </p>
      ) : null}
      <p className="wx-task-hint" aria-live="polite">
        {selected ? `Selected: ${selected.name}` : "No one selected yet."}
      </p>
      {error ? (
        <p className="wx-task-error" id={`${baseId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
