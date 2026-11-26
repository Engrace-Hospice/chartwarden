// UR — one labelled text field with Cancel and a submit button: the form the decision panel (corrected
// value, rejection reason) and the safeguard blocks (false-positive reason, identity reason) all open
// inline. Focus lands in the field when it opens, like the legacy reviewer. The fields take PHI, so
// the browser is told not to remember them.
import { TextField } from "@chartwarden/ui";
import { useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";

export function ReasonForm({
  id,
  label,
  hint,
  value,
  placeholder,
  minLength,
  submitLabel,
  busy,
  canSubmit,
  onChange,
  onSubmit,
  onCancel,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  placeholder?: string;
  minLength?: number;
  submitLabel: string;
  busy: boolean;
  canSubmit: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector("input")?.focus();
  }, []);

  return (
    <form
      ref={formRef}
      className="wx-doclens-input"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <TextField
        id={id}
        type="text"
        autoComplete="off"
        label={label}
        hint={hint}
        value={value}
        placeholder={placeholder}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="wx-doclens-buttons">
        <button type="button" className="wx-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="wx-btn-primary"
          aria-busy={busy || undefined}
          disabled={!canSubmit || busy}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
