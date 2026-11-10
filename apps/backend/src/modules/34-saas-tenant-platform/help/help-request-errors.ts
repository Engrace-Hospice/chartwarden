// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-errors.ts — the help-request failure codes.
//
// The `M34_SUPPORT_SESSION_ERROR_STATUS` / `M34_LIFECYCLE_ERROR_STATUS` precedent: one catalog of code -> HTTP status, one error
// class that reads it, so a route and its service never disagree about a status.
import { ChartWardenError } from "@chartwarden/types";

export const M34_HELP_REQUEST_ERROR_STATUS = {
  /**
   * The tenant account already has a live (open or approved) help request. The error's `details` carries it as
   * `[{ field: "helpRequestId", code: "HELP_REQUEST_ALREADY_OPEN", message: <the live request's id> }]` so the dialog can show it.
   */
  HELP_REQUEST_ALREADY_OPEN: 409,
} as const;

export type M34HelpRequestErrorCode = keyof typeof M34_HELP_REQUEST_ERROR_STATUS;

/** Where the live request's id travels in the 409's `details` (the pricing `currentUpdatedAt` precedent). */
export const HELP_REQUEST_ID_DETAIL_FIELD = "helpRequestId";

export class HelpRequestError extends ChartWardenError {
  constructor(
    code: M34HelpRequestErrorCode,
    message: string,
    details?: { field: string; code: string; message: string }[],
  ) {
    super(code, message, M34_HELP_REQUEST_ERROR_STATUS[code], details);
    this.name = "HelpRequestError";
  }
}
