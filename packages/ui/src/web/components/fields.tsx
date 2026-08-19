import { useId } from "react";
import type {
  InputHTMLAttributes,
  JSX,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { t } from "../theme/tokens";

interface FieldFrameProps {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: (ids: { inputId: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}: FieldFrameProps): JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <label
      htmlFor={inputId}
      className="wx-field"
      style={{ display: "flex", flexDirection: "column", gap: t.space2, color: t.onSurface }}
    >
      <span style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {children({ inputId, describedBy, invalid: Boolean(error) })}
      {hint && !error ? (
        <span id={hintId} style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ color: t.error, fontSize: "0.75rem" }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

const inputStyle = (invalid: boolean) => ({
  width: "100%",
  minHeight: "2.5rem",
  padding: "0.5rem 0.75rem",
  border: `1px solid ${invalid ? t.error : t.outlineVariant}`,
  borderRadius: t.radiusLg,
  background: t.surfaceLow,
  color: t.onSurface,
  fontFamily: t.fontSans,
});

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextField({
  id,
  label,
  hint,
  error,
  required,
  style,
  ...props
}: TextFieldProps): JSX.Element {
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      {({ inputId, describedBy, invalid }) => (
        <input
          {...props}
          id={inputId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          style={{ ...inputStyle(invalid), ...style }}
        />
      )}
    </FieldFrame>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  options: readonly SelectOption[];
}

export function SelectField({
  id,
  label,
  hint,
  error,
  required,
  options,
  style,
  ...props
}: SelectFieldProps): JSX.Element {
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      {({ inputId, describedBy, invalid }) => (
        <select
          {...props}
          id={inputId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          style={{ ...inputStyle(invalid), ...style }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldFrame>
  );
}

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextAreaField({
  id,
  label,
  hint,
  error,
  required,
  style,
  ...props
}: TextAreaFieldProps): JSX.Element {
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      {({ inputId, describedBy, invalid }) => (
        <textarea
          {...props}
          id={inputId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          style={{ ...inputStyle(invalid), minHeight: "6rem", resize: "vertical", ...style }}
        />
      )}
    </FieldFrame>
  );
}
