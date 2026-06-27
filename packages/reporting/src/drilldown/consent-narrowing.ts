// @wardenx/reporting · drilldown — consent narrowing of a drilldown URL (M33 §4.4 / W-R-05 / D16).
//
// Step 2 of the drilldown emit: consult M39's `ConsentEvaluator.evaluateForReporting` over the patient cohort
// the tile's dimension context resolves to, and NARROW the candidate URL to exclude any patient the actor may
// not see under SUD / family-violence redaction. The narrowing is a NAVIGATION filter, not a data filter (D16):
// M33 appends `?consentNarrowed=true&excludePatientIds=…` so the owner module renders with the redacted cohort
// hidden — the drilldown is narrowed, NEVER refused, under redaction.
//
// ★ FAIL-CLOSED (the load-bearing invariant). When the injected M39 consent port is UNAVAILABLE — unbound at
//   boot (a fail-closed thunk that throws), down, or it raises any error — this handler NARROWS MAXIMALLY: it
//   excludes the ENTIRE candidate patient cohort (`excludePatientIds = every patientId`) and stamps the
//   narrowing reason `consent_evaluation_unavailable`. It NEVER widens, and it NEVER passes an un-narrowed
//   patient identifier through on a consent failure. A cohort with no patient identifiers (a pure-aggregate
//   drilldown) needs no consent call and is returned unchanged.
//
// PURE CORE + thin async shell (the `scheduled/delivery.ts` precedent): {@link decideConsentNarrowing} is a
// total pure function over the evaluation OUTCOME (including the `unavailable` sentinel); the async
// {@link narrowDrilldownForConsent} only resolves the M39 port (catching every error into `unavailable`) and
// applies the decided exclusion to the URL. No clock/RNG/Drizzle/`getSeam` import; M39 arrives as a port.
import type { ReportingConsentConsumer } from "../seams/consumed/m39-consent";
import { appendQueryParams } from "./url-template-resolver";

/** The narrowing reason stamped when the M39 consent port could not be evaluated (the fail-closed path). */
export const CONSENT_UNAVAILABLE_REASON = "consent_evaluation_unavailable" as const;

/** The M39 evaluation outcome the pure decider consumes — either an evaluation, or the fail-closed sentinel. */
export type ConsentEvaluation =
  | {
      readonly kind: "evaluated";
      readonly allowedPatientIds: readonly string[];
      readonly isNarrowed: boolean;
      readonly reason: string | null;
    }
  /** M39 was unbound / down / errored — narrow maximally (exclude the whole cohort), never widen. */
  | { readonly kind: "unavailable" };

/** The decided narrowing: which patients to exclude + whether/why the URL is narrowed. */
export interface ConsentNarrowingDecision {
  readonly excludedPatientIds: readonly string[];
  readonly isConsentNarrowed: boolean;
  readonly reason: string | null;
}

/**
 * Decide the consent narrowing for one drilldown cohort (PURE, total). With an evaluation: the excluded set is
 * the cohort minus the allowed set; the URL is narrowed when M39 reported `isNarrowed` OR any patient was
 * dropped. With the `unavailable` sentinel (FAIL-CLOSED): the ENTIRE cohort is excluded — no identifier passes
 * when consent cannot be evaluated. An empty cohort is never narrowed.
 */
export function decideConsentNarrowing(
  patientIds: readonly string[],
  evaluation: ConsentEvaluation,
): ConsentNarrowingDecision {
  if (patientIds.length === 0) {
    return { excludedPatientIds: [], isConsentNarrowed: false, reason: null };
  }

  // FAIL-CLOSED: exclude every candidate identifier when M39 could not be consulted.
  if (evaluation.kind === "unavailable") {
    return {
      excludedPatientIds: [...patientIds],
      isConsentNarrowed: true,
      reason: CONSENT_UNAVAILABLE_REASON,
    };
  }

  const allowed = new Set(evaluation.allowedPatientIds);
  const excludedPatientIds = patientIds.filter((id) => !allowed.has(id));
  const isConsentNarrowed = evaluation.isNarrowed || excludedPatientIds.length > 0;
  return {
    excludedPatientIds,
    isConsentNarrowed,
    reason: isConsentNarrowed ? (evaluation.reason ?? "consent_narrowed") : null,
  };
}

/** The narrowed URL + the narrowing posture (carried into `audit-writer.ts` + the `m33.drilldown.emitted` event). */
export interface ConsentNarrowingResult {
  readonly url: string;
  readonly isConsentNarrowed: boolean;
  readonly reason: string | null;
  readonly excludedPatientIds: readonly string[];
}

/** The ports the narrowing shell composes over — just the M39 consent evaluator (bound to the live seam at P2C;
 *  a fail-closed thunk until then, which this shell catches into the `unavailable` → maximal-narrow path). */
export interface ConsentNarrowingPorts {
  readonly consent: Pick<ReportingConsentConsumer, "evaluateForReporting">;
}

/**
 * Narrow a candidate drilldown URL for M39 consent (W-R-05 steps 5–7). Resolves the consent port over the
 * cohort, mapping ANY thrown error (unbound/down) to the `unavailable` sentinel so {@link decideConsentNarrowing}
 * narrows maximally — fail-closed, never widening. When narrowed, appends `consentNarrowed=true` (+
 * `excludePatientIds` when a specific set is excluded). An empty cohort returns the URL unchanged.
 */
export async function narrowDrilldownForConsent(
  input: {
    readonly organizationId: string;
    readonly actorMembershipId: string;
    readonly patientIds: readonly string[];
    readonly url: string;
  },
  ports: ConsentNarrowingPorts,
): Promise<ConsentNarrowingResult> {
  let evaluation: ConsentEvaluation;
  if (input.patientIds.length === 0) {
    evaluation = { kind: "evaluated", allowedPatientIds: [], isNarrowed: false, reason: null };
  } else {
    try {
      const res = await ports.consent.evaluateForReporting({
        organizationId: input.organizationId,
        actorMembershipId: input.actorMembershipId,
        patientIds: input.patientIds,
      });
      evaluation = {
        kind: "evaluated",
        allowedPatientIds: res.allowedPatientIds,
        isNarrowed: res.isNarrowed,
        reason: res.reason,
      };
    } catch {
      // ★ FAIL-CLOSED: M39 unbound/down/errored — never surface un-narrowed identifiers; narrow maximally.
      evaluation = { kind: "unavailable" };
    }
  }

  const decision = decideConsentNarrowing(input.patientIds, evaluation);
  if (!decision.isConsentNarrowed) {
    return { url: input.url, isConsentNarrowed: false, reason: null, excludedPatientIds: [] };
  }

  const url = appendQueryParams(input.url, {
    consentNarrowed: "true",
    excludePatientIds: decision.excludedPatientIds.join(","),
  });
  return {
    url,
    isConsentNarrowed: true,
    reason: decision.reason,
    excludedPatientIds: decision.excludedPatientIds,
  };
}
