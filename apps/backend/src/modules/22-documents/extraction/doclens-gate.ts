// apps/backend/src/modules/22-documents/extraction/doclens-gate.ts — M22-T08 (§Phase / §32 / §8.10).
//
// The Phase-1 `documents.doclens` feature-flag gate. DocLens (Pillar 3 — intake extraction) depends on M32 (AI
// Platform) binding the real classifier / extractor / vision providers; until M32 lands, the three capabilities
// ship as deny-stubs (`@wardenx/intake-extraction`) and EVERY DocLens route returns `503 EXTRACTION_DISABLED` with
// `Retry-After: 0`. Pillars 1 + 2 (manual document upload + form rendering) stay fully operational (§8.10.2).
//
// The flag is per-tenant (the M32 capability is registered + not denied for that tenant). In Phase 1 no tenant can
// enable it (M32 is not deployed), so {@link phase1DocLensFlag} returns false for every org and the gate 503s. The
// flag is INJECTED so a later phase flips it per-tenant without touching the routes. The gate runs AFTER the M3
// permission guard (an unauthorized caller still gets 401/403 first — the 503 only reveals "feature off" to a
// caller who is otherwise allowed).
import { WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** `503 EXTRACTION_DISABLED` — the DocLens feature is off for this tenant in Phase 1 (M32 not yet bound). */
export class ExtractionDisabledError extends WardenXError {
  constructor(message = "DocLens extraction is disabled in this phase (documents.doclens OFF; M32 not yet bound)") {
    super("EXTRACTION_DISABLED", message, 503);
    this.name = "ExtractionDisabledError";
  }
}

/** The per-tenant `documents.doclens` feature-flag port. Phase 1: always false; a later phase reads tenant config. */
export interface DocLensFeatureFlag {
  isEnabled(organizationId: string): boolean;
}

/** The Phase-1 flag: DocLens is OFF for every tenant (M32 deny-stubbed). */
export const phase1DocLensFlag: DocLensFeatureFlag = {
  isEnabled(): boolean {
    return false;
  },
};

/** Throw {@link ExtractionDisabledError} unless the `documents.doclens` flag is enabled for the org (fail closed). */
export function assertDocLensEnabled(flag: DocLensFeatureFlag, organizationId: string): void {
  if (!flag.isEnabled(organizationId)) throw new ExtractionDisabledError();
}

/**
 * Build the DocLens-route preHandler. Resolves the org from the server-side `request.context` (never the body),
 * sets `Retry-After: 0` (the M32-bound capability is unavailable, not rate-limited), and throws
 * {@link ExtractionDisabledError} (503) when the flag is off — the M1 error handler renders the envelope. In
 * Phase 1 this 503s on every DocLens route; once `documents.doclens` is on for a tenant it falls through and the
 * underlying pipeline runs.
 */
export function requireDocLensEnabled(
  flag: DocLensFeatureFlag,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const organizationId = request.context?.organizationId ?? "";
    if (!flag.isEnabled(organizationId)) {
      reply.header("Retry-After", "0");
      throw new ExtractionDisabledError();
    }
  };
}
