// apps/admin/src/shell — submit-time form validation helpers (#597, F-042). A form with a disabled submit and no
// message leaves the operator guessing why; instead the submit stays enabled, a failed attempt shows an inline message
// per field (the kit's `error` prop) and focus moves to the first invalid control.

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** True when no field has a message. */
export function isValid<K extends string>(errors: FieldErrors<K>): boolean {
  return Object.values(errors).every((m) => m === undefined || m === "");
}

/**
 * Move focus to the first control the kit marked `aria-invalid` once the error render has committed. Takes the form (or
 * any ancestor) rather than a field id so every form can use it without wiring refs per field.
 */
export function focusFirstInvalid(root: ParentNode | null): void {
  setTimeout(() => {
    root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, 0);
}
