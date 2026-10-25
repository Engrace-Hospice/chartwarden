// apps/backend/src/modules/41-billing-commercial/errors.ts - typed refusals (the standard error envelope carries code + message).
//
// A refusal is a stable machine code plus a user-facing message that says what to do next. Messages here are fixed text: they
// never interpolate a member id, a clearinghouse reason or a vendor response.
import { COMMERCIAL_SEND_REFUSAL, ChartWardenError } from "@chartwarden/types";

const HTTP_UNAVAILABLE = 503;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

/** A send was refused before anything left the building (unbound, not routed, not enrolled, no coverage...). */
export class CommercialRefusalError extends ChartWardenError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "CommercialRefusalError";
  }
}

/** The HTTP status a send-gate refusal code answers with. */
export function statusForRefusal(code: string): number {
  return code === COMMERCIAL_SEND_REFUSAL.NOT_WIRED ? HTTP_UNAVAILABLE : HTTP_CONFLICT;
}

export const HTTP_STATUS = { UNAVAILABLE: HTTP_UNAVAILABLE, CONFLICT: HTTP_CONFLICT, UNPROCESSABLE: HTTP_UNPROCESSABLE } as const;
