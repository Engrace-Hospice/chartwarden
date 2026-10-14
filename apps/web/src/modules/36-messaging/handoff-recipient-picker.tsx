// M36 WP 3.5 - choose who a handoff is for. Same staff lookup as the new-conversation dialog (no new endpoint); the
// server decides whether the person may receive it and answers one uniform refusal, so nothing is pre-checked here.
import { useApiClient } from "@wardenx/ui";
import { useEffect, useId, useState } from "react";
import type { JSX } from "react";

export interface Recipient {
  readonly id: string;
  readonly name: string;
}

const SEARCH_DEBOUNCE_MS = 250;

export interface HandoffRecipientPickerProps {
  readonly meId: string;
  readonly selected: Recipient | null;
  readonly onSelect: (recipient: Recipient) => void;
  readonly error: string | null;
  readonly inputRef?: React.Ref<HTMLInputElement>;
}

export function HandoffRecipientPicker({
  meId,
  selected,
  onSelect,
  error,
  inputRef,
}: HandoffRecipientPickerProps): JSX.Element {
  const baseId = useId();
  const client = useApiClient();
  const [text, setText] = useState("");
  const [people, setPeople] = useState<readonly Recipient[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` is the manual re-read trigger
  useEffect(() => {
    let current = true;
    setFailed(false);
    const timer = window.setTimeout(() => {
      client
        .GET("/api/v1/messaging/dm/staff", { params: { query: { q: text.trim() || undefined } } })
        .then(({ data }) => {
          if (!current) return;
          if (!data) return setFailed(true);
          setPeople(
            data.staff
              .filter((person) => person.userId !== meId)
              .map((person) => ({ id: person.userId, name: person.displayName })),
          );
        })
        .catch(() => {
          if (current) setFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [client, meId, text, retry]);

  return (
    <div className="wx-task-field">
      <label htmlFor={`${baseId}-search`}>Hand off to</label>
      <input
        id={`${baseId}-search`}
        ref={inputRef}
        type="search"
        value={text}
        placeholder="Search colleagues"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${baseId}-error` : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      <ul className="wx-task-people" aria-label="Colleagues">
        {people.map((person) => (
          <li key={person.id}>
            <button
              type="button"
              className="wx-task-person"
              aria-pressed={selected?.id === person.id}
              onClick={() => onSelect(person)}
            >
              {person.name}
            </button>
          </li>
        ))}
      </ul>
      {failed ? (
        <p className="wx-task-hint">
          People could not be loaded.{" "}
          <button type="button" className="wx-task-link" onClick={() => setRetry((n) => n + 1)}>
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
