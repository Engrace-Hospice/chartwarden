// String-valued adapters over the kit's fields. The module screens keep their form state as strings and call
// `onChange(value)`; the kit's fields take the native change event. These unwrap it once, here, so a screen gets the
// kit's label / hint / error wiring and focus ring without rewriting every handler.
import {
  SelectField as KitSelectField,
  TextAreaField as KitTextAreaField,
  TextField as KitTextField,
  t,
} from "@chartwarden/ui";
import { useId } from "react";
import type { JSX, ReactNode } from "react";

export type TextFieldType =
  | "text"
  | "number"
  | "date"
  | "time"
  | "datetime-local"
  | "email"
  | "tel";

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  describedBy,
  hint,
  maxLength,
  mono,
  required,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: TextFieldType;
  placeholder?: string;
  /** An id elsewhere on the page that describes this field; kept after the hint's own id. */
  describedBy?: string;
  hint?: ReactNode;
  maxLength?: number;
  /** Marks the field required (the kit adds the marker). */
  required?: boolean;
  /** An announced error under the field; the hint stays beside it. */
  error?: ReactNode;
  /** An identifier or code: set in the mono face. */
  mono?: boolean;
}): JSX.Element {
  return (
    <KitTextField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      type={type}
      placeholder={placeholder}
      hint={hint}
      error={error}
      required={required}
      maxLength={maxLength}
      style={mono ? { fontFamily: t.fontMono } : undefined}
      aria-describedby={describedBy}
    />
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  error,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Linked to the select (`aria-describedby`) so a screen reader hears why it is empty or disabled. */
  hint?: string;
  error?: string;
}): JSX.Element {
  return (
    <KitSelectField
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      hint={hint}
      error={error}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  hint,
  minChars,
  placeholder,
  required,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: ReactNode;
  placeholder?: string;
  required?: boolean;
  error?: ReactNode;
  /**
   * The server's minimum length, shown as a live counter. It counts TRIMMED characters, because the database CHECK does
   * (length(btrim(...))): forty spaces would satisfy a naive length and be refused. A pre-flight aid, never a substitute
   * for the server's own refusal.
   */
  minChars?: number;
}): JSX.Element {
  const countId = useId();
  const field = (
    <KitTextAreaField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      rows={rows}
      hint={hint}
      error={error}
      required={required}
      placeholder={placeholder}
      aria-describedby={minChars === undefined ? undefined : countId}
    />
  );
  if (minChars === undefined) return field;
  const owed = Math.max(0, minChars - value.trim().length);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
      {field}
      <output
        id={countId}
        aria-live="polite"
        className={owed > 0 ? "wx-text-error" : "wx-text-muted"}
        style={{ fontSize: "0.75rem" }}
      >
        {owed > 0
          ? `${owed} more character${owed === 1 ? "" : "s"} required — the server asks for at least ${minChars}.`
          : `Minimum of ${minChars} characters met.`}
      </output>
    </div>
  );
}
