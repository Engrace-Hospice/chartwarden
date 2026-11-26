import type { MedicaidEraObservation } from "./medicaid-era-observation";

/** Replay verdict for one transaction set. `conflict` outranks `exact`, which outranks `possible`. */
export type MedicaidEraDuplicateDecision = "none" | "exact" | "possible" | "conflict";

const RANK: Readonly<Record<MedicaidEraDuplicateDecision, number>> = {
  none: 0,
  possible: 1,
  exact: 2,
  conflict: 3,
};

/** CLP02 = 22: the payer reverses a claim it paid before, under that claim's own control numbers. */
const REVERSAL_STATUS_CODE = 22;

export function strictestDuplicate(
  ...decisions: readonly MedicaidEraDuplicateDecision[]
): MedicaidEraDuplicateDecision {
  return decisions.reduce((worst, next) => (RANK[next] > RANK[worst] ? next : worst), "none");
}

/**
 * Everything a set carries except its transmission control numbers (ISA13, GS06 and ST02 differ on every replay), so a
 * reused trace number with any other difference (payment, claim, claim or provider-level adjustment) is a conflict.
 */
const contentKey = ({ source, claims, providerAdjustments }: MedicaidEraObservation): string =>
  JSON.stringify([
    {
      ...source,
      interchangeControlNumber: null,
      functionalGroupControlNumber: null,
      transactionSetControlNumber: null,
    },
    claims,
    providerAdjustments,
  ]);

/** What one set exposes to the replay rules, computed once per set. */
interface ReplayFacts {
  readonly trace: string | null;
  readonly content: string;
  readonly paymentCents: number | null;
  /** Payer claim control numbers and patient control numbers, tagged so a reversal only ever repeats a reversal. */
  readonly icns: ReadonlySet<string>;
  readonly pcns: ReadonlySet<string>;
  /** Payment date and payee, which a claimless set has no control number to stand in for. */
  readonly paymentContext: string;
  /** Provider adjustment reason and reference pairs; filled only for a set with no claim (a claimless set has no PCN or ICN). */
  readonly claimlessAdjustments: ReadonlySet<string>;
}

function replayFacts(observation: MedicaidEraObservation): ReplayFacts {
  const controlNumbers = (
    pick: (claim: MedicaidEraObservation["claims"][number]) => string | null,
  ) =>
    new Set(
      observation.claims.flatMap((claim) => {
        const value = pick(claim);
        return value
          ? [`${claim.statusCode === REVERSAL_STATUS_CODE ? "reversal" : "payment"}:${value}`]
          : [];
      }),
    );
  return {
    trace: observation.source.traceNumber,
    content: contentKey(observation),
    paymentCents: observation.source.paymentCents,
    icns: controlNumbers((claim) => claim.payerClaimControlNumber),
    pcns: controlNumbers((claim) => claim.patientControlNumber),
    paymentContext: JSON.stringify([
      observation.source.paymentDate,
      observation.source.payee.identifier,
      observation.source.payee.taxIdentifier,
    ]),
    claimlessAdjustments: new Set(
      observation.claims.length > 0
        ? []
        : observation.providerAdjustments.map(({ reason, reference }) =>
            JSON.stringify([reason, reference]),
          ),
    ),
  };
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].some((value) => b.has(value));

function relation(earlier: ReplayFacts, later: ReplayFacts): MedicaidEraDuplicateDecision {
  if (earlier.trace !== null && earlier.trace === later.trace)
    return earlier.content === later.content ? "exact" : "conflict";
  // Equal payments alone prove nothing: a hospice flat per-diem pays many different claims the same amount, and equal
  // zero-dollar sets are routine (denials). A repeated nonzero payment only counts for the same patient control number.
  const repeatsPayment =
    later.paymentCents !== null &&
    later.paymentCents > 0 &&
    later.paymentCents === earlier.paymentCents &&
    intersects(earlier.pcns, later.pcns);
  // A provider-adjustment-only set has no PCN or ICN, so it repeats when the same payment, date and payee carry a shared
  // adjustment reason and reference (a zero payment counts: the adjustment is what would be posted twice).
  const repeatsClaimlessSet =
    later.paymentCents !== null &&
    later.paymentCents === earlier.paymentCents &&
    later.paymentContext === earlier.paymentContext &&
    intersects(earlier.claimlessAdjustments, later.claimlessAdjustments);
  return intersects(earlier.icns, later.icns) || repeatsPayment || repeatsClaimlessSet
    ? "possible"
    : "none";
}

/** Keys under which two sets could be related: a trace number, a payer or patient claim control number, or (claimless) a provider adjustment. */
const lookupKeys = (facts: ReplayFacts): readonly string[] => [
  ...(facts.trace === null ? [] : [`trace:${facts.trace}`]),
  ...[...facts.icns].map((value) => `icn:${value}`),
  ...[...facts.pcns].map((value) => `pcn:${value}`),
  ...[...facts.claimlessAdjustments].map((value) => `plb:${value}`),
];

/**
 * Replay inside ONE artifact: the reader port only knows previously staged files, so two sets in a single interchange
 * that repeat a trace number, or a payer claim control number, or a nonzero payment for the same patient control number,
 * or (a set with no claim loops) the same payment, date, payee and provider adjustment reason and reference, are
 * classified here. The first set is the original and later repeats are held; a reused trace number with different
 * content is a conflict for both. A reversal repeats its original's control numbers by design, so a reversal and a
 * payment never count as replays of each other.
 *
 * Each set is indexed once; only sets that share a key with an earlier one are compared, so the scan is linear in the
 * number of claims plus the number of related pairs.
 */
export function classifyIntraArtifactDuplicates(
  observations: readonly MedicaidEraObservation[],
): readonly MedicaidEraDuplicateDecision[] {
  const facts = observations.map(replayFacts);
  const decisions: MedicaidEraDuplicateDecision[] = observations.map(() => "none");
  const earlierSetsByKey = new Map<string, number[]>();
  for (const [later, laterFacts] of facts.entries()) {
    const keys = lookupKeys(laterFacts);
    const related = new Set(keys.flatMap((key) => earlierSetsByKey.get(key) ?? []));
    for (const earlier of related) {
      const verdict = relation(facts[earlier]!, laterFacts);
      decisions[later] = strictestDuplicate(decisions[later]!, verdict);
      if (verdict === "conflict") decisions[earlier] = "conflict";
    }
    for (const key of keys) {
      const sets = earlierSetsByKey.get(key);
      if (sets) sets.push(later);
      else earlierSetsByKey.set(key, [later]);
    }
  }
  return decisions;
}
