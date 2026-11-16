// apps/backend/src/modules/10-hope/hope-log-id.ts — the one way a M10 log line names a record.
import { ROUTE_FORMATS } from "@chartwarden/shared/route-kit";

/**
 * An id safe to put in a log line: a uuid as written, anything else masked (a service call can pass any string, and a
 * log line carries ids and error classes, never record content or a target date).
 */
export const idForLog = (value: string): string =>
  ROUTE_FORMATS.uuid?.(value) ? value : "[not-a-uuid]";

/** The class of a failure for a log line: a seam or driver failure's MESSAGE can carry arbitrary text, its class cannot. */
export const errorClassForLog = (error: unknown): string =>
  error instanceof Error ? error.name : "a non-error";
