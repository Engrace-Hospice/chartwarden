// apps/backend/src/modules/22-documents/outbox-consumers/consent-gate.ts — M22-T06 the §4.11/§7.16 SUD gate.
//
// Before rendering or serving a SUD-class (42 CFR Part 2) document, M22 consults M39's REAL `ConsentEvaluator`
// seam (the same one M7's `sud_disclosure_allowed` predicate consumes). M22 `dependsOn` is `[1, 5]` — it does
// NOT depend on M39, so it MUST NOT import `@chartwarden/consent` (that would create a dependency-cruiser edge).
// Instead it resolves the already-registered real seam OPAQUELY via `getSeam("ConsentEvaluator")` and casts
// it to the locally-declared structural minimum {@link ConsentEvaluatorPort} (only the `evaluate` arm M22
// needs). M39 owns the canonical rich interface in @chartwarden/consent; this port is the M22-side projection.
//
// Fail-CLOSED: any seam error, an unregistered seam, or `allowed !== true` returns `false` (consent absent →
// the decider refuses the SUD render per §7.16). The actual refuse/redact decision is the pure
// {@link decideDocumentRequest} reading `facts.sudConsentPresent`; this helper is the impure resolver that
// produces that fact in the live consumer.
import { getSeam } from "../../../bootstrap/index";

/** The M22-side structural projection of M39's `ConsentEvaluator.evaluate` (the only arm M22 consumes). The
 * real (richer) contract lives in @chartwarden/consent; M22 reads it opaquely from the M1 registry. */
export interface ConsentEvaluatorPort {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    asOf?: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
  }): Promise<{ allowed: boolean; denyReason?: string }>;
}

/** The 42 CFR Part 2 / SUD-release consent type M22 checks before rendering a SUD-class document (§7.16). */
export const SUD_CONSENT_TYPE = "42_cfr_part_2_release" as const;

/**
 * Resolve `facts.sudConsentPresent` for a SUD-class render (§4.11 / §7.16). Consults M39's real
 * `ConsentEvaluator` via the opaque M1 registry; fail-CLOSED on any error / missing seam / not-allowed.
 */
export async function resolveSudConsentPresent(input: {
  organizationId: string;
  patientId: string;
  asOf?: string;
}): Promise<boolean> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorPort;
    const res = await evaluator.evaluate({
      organizationId: input.organizationId,
      patientId: input.patientId,
      consentType: SUD_CONSENT_TYPE,
      asOf: input.asOf,
      sessionContext: { sessionClass: "staff" },
      callerModule: "m22",
    });
    return res.allowed === true;
  } catch {
    return false; // fail-closed — no consent confirmable ⇒ refuse the SUD render
  }
}
