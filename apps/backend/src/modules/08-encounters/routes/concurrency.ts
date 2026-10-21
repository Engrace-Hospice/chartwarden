// apps/backend/src/modules/08-encounters/routes/concurrency.ts — M8-T09 (§2.7, §7.7).
//
// The optimistic-concurrency pre-handler M8's PATCH routes layer on top of the REAL Authorization
// Contract. The PATCH carries the row `version` it read in the `If-Match` header (an ETag); the handler
// hands it to the service, where `checkVersion` compares it against the current row version and raises
// 412 VERSION_MISMATCH on skew (§2.7). A missing header is a 428 PRECONDITION_REQUIRED; a malformed one
// is a 400 (never silently treated as "no precondition"). Pure header guard — no IO, no cross-module
// import. Mirrors the M7 routes/concurrency.ts precedent; M8 surfaces the §2.7 `VERSION_MISMATCH` code.
import { ChartWardenError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler-shaped Fastify pre-handler. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Request carrying the parsed `If-Match` version the PATCH handler reads (set by {@link requireIfMatch}). */
export type WithIfMatch = FastifyRequest & { ifMatchVersion?: number };

/** 428 PRECONDITION_REQUIRED — the PATCH did not carry the required `If-Match` header (§7.7). */
export class IfMatchRequiredError extends ChartWardenError {
  constructor() {
    super(
      "PRECONDITION_REQUIRED",
      "an If-Match header (the row version you read) is required on this route",
      428,
    );
    this.name = "IfMatchRequiredError";
  }
}

const IF_MATCH_RE = /^"?(\d+)"?$/; // bare integer or quoted ETag form (`"3"`)

/**
 * §7.7 — require + parse the `If-Match` header into `request.ifMatchVersion`. The handler hands that to
 * the service, which raises 412 VERSION_MISMATCH when it no longer matches the current row version.
 */
export function requireIfMatch(): PreHandler {
  return async (request) => {
    const raw = request.headers["if-match"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.trim().length === 0) throw new IfMatchRequiredError();
    const m = IF_MATCH_RE.exec(value.trim());
    if (!m) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        "If-Match must be the integer row version you read",
        400,
      );
    }
    (request as WithIfMatch).ifMatchVersion = Number.parseInt(m[1] ?? "", 10);
  };
}

/** Read the parsed `If-Match` version off the request (the {@link requireIfMatch} guard ran first). */
export function ifMatchVersionOf(request: FastifyRequest): number {
  const v = (request as WithIfMatch).ifMatchVersion;
  if (typeof v !== "number") throw new IfMatchRequiredError(); // defensive — guard ordering invariant
  return v;
}
