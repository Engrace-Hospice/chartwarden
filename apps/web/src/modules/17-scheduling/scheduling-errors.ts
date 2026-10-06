export interface SchedulingUiError {
  readonly message: string;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly code?: string;
  readonly correlationId?: string;
}
type Detail = { field?: unknown; message?: unknown };
type Envelope = {
  code?: unknown;
  message?: unknown;
  reason?: unknown;
  correlationId?: unknown;
  details?: unknown;
  error?: Envelope;
};
const messageFor = (signal: string, status?: number | null): string => {
  if (/CLINICIAN_CREDENTIAL|clinician_credentials_active/.test(signal))
    return "This clinician does not have an active clinical credential for the selected visit date.";
  if (/CLINICIAN_DISCIPLINE|discipline_matches_visit/.test(signal))
    return "This clinician cannot perform the selected type of visit.";
  if (/CLINICIAN_ON_PTO|not_on_pto/.test(signal))
    return "This clinician is unavailable during the selected time.";
  if (
    /CLINICIAN_NOT_IN_CASELOAD|within_caseload_or_unassigned_pool|PRE_SCHEDULE_GATE_FAILED/.test(
      signal,
    )
  )
    return "This clinician is not currently eligible for this patient.";
  if (status === 412)
    return "This visit was changed by someone else. Refresh the visit and try again.";
  if (status === 409)
    return "This clinician already has another visit during the selected time.";
  if (status === 403)
    return "You don't have permission to perform this action.";
  if (status === 422) return "Please review the highlighted fields.";
  return "We couldn't complete this action. Please try again.";
};
const fieldMessage = (field: string, value: unknown): string => {
  const raw = typeof value === "string" ? value : "";
  if (field === "reason" && /greater or equal to 20|minLength.*20/i.test(raw))
    return "Please enter at least 20 characters.";
  if (
    field === "evvMissingReason" &&
    /greater or equal to 40|minLength.*40/i.test(raw)
  )
    return "Please enter at least 40 characters.";
  return "Please review this field.";
};
/** One human-facing translation layer for every M17 mutation response. */
export function mapSchedulingApiError(
  body: unknown,
  status?: number | null,
): SchedulingUiError {
  const outer = (body && typeof body === "object" ? body : {}) as Envelope;
  const error =
    outer.error && typeof outer.error === "object" ? outer.error : outer;
  const code = typeof error.code === "string" ? error.code : undefined;
  const reason = typeof error.reason === "string" ? error.reason : "";
  const raw = typeof error.message === "string" ? error.message : "";
  const fieldErrors: Record<string, string> = {};
  for (const detail of (Array.isArray(error.details)
    ? error.details
    : []) as Detail[])
    if (typeof detail.field === "string")
      fieldErrors[detail.field] = fieldMessage(detail.field, detail.message);
  return {
    message: Object.keys(fieldErrors).length
      ? "Please review the highlighted fields."
      : messageFor(`${code ?? ""} ${reason} ${raw}`, status),
    fieldErrors,
    ...(code ? { code } : {}),
    ...(typeof error.correlationId === "string"
      ? { correlationId: error.correlationId }
      : {}),
  };
}
