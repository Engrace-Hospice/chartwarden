// apps/backend/src/modules/18-evv/capture-classification.ts — GAP-027: the service-type code and posting
// discipline an EVV event is stamped with are derived from the visit's registration row (written from the
// published M17 visit), never from the client body and never defaulted to "". An aggregator submission with an
// empty service-type code is rejected by the vendor, so an unresolved code refuses the capture and the
// submission payload builder.
import { ValidationError } from "@wardenx/types";

export interface CaptureClassification {
  readonly serviceTypeCode: string;
  readonly postingDisciplineAtRecording: string;
}

function required(field: string, value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    const message = `the visit registration has no ${field}; the capture cannot be classified`;
    throw new ValidationError(message, [{ field, code: "UNRESOLVED", message }]);
  }
  return trimmed;
}

/** The stamp for a new event, from the visit registration. Throws when either value is unresolved. */
export function classifyCapture(registration: {
  readonly serviceTypeCode: string | null;
  readonly assignedDiscipline: string | null;
}): CaptureClassification {
  return {
    serviceTypeCode: required("serviceTypeCode", registration.serviceTypeCode),
    postingDisciplineAtRecording: required("assignedDiscipline", registration.assignedDiscipline),
  };
}

/**
 * The code to submit: the event's own stamp, or (for events captured before the stamp was resolved) the
 * registration's. Throws rather than submit an empty code.
 */
export function submissionServiceTypeCode(
  eventCode: string | null,
  registrationCode: string | null,
): string {
  const fromEvent = (eventCode ?? "").trim();
  return fromEvent !== "" ? fromEvent : required("serviceTypeCode", registrationCode);
}
