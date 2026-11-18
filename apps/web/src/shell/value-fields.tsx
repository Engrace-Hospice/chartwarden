// String-valued adapters over the kit's fields. The module screens keep their form state as strings and call
// `onChange(value)`; the kit's fields take the native change event. These unwrap it once, here, so a screen gets the
// kit's label / hint / error wiring and focus ring without rewriting every handler.
import {
  SelectField as KitSelectField,
  TextAreaField as KitTextAreaField,
  TextField as KitTextField,
} from "@chartwarden/ui";
import type { JSX } from "react";

export type TextFieldType = "text" | "number" | "date" | "datetime-local" | "email" | "tel";

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  describedBy,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: TextFieldType;
  placeholder?: string;
  /** An id elsewhere on the page that describes this field; kept after the hint's own id. */
  describedBy?: string;
  hint?: string;
}): JSX.Element {
  return (
    <KitTextField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      type={type}
      placeholder={placeholder}
      hint={hint}
      aria-describedby={describedBy}
    />
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <KitSelectField
      label={label}
      value={value}
      options={options}
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}): JSX.Element {
  return (
    <KitTextAreaField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      rows={rows}
      hint={hint}
    />
  );
}
