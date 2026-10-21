// @chartwarden/bereavement — D3/D17 factor DERIVATION from cross-module evidence (M16-T04).
//
// `rubric.ts` (M16-T01) scores an already-resolved 8-factor vector. This module is the step before it: the
// deterministic, reproducible mapping from what M15 / M9 / the M16 roster actually said into that vector.
// It is the half a CMS surveyor re-runs — AI Governance §17 requires the tier be reproducible from the
// captured feature vector, and the vector is only reproducible if the DERIVATION is too.
//
// The three binding rules this module encodes (all of them about the difference between `false` and
// `unknown`, which D17 exists to keep honest):
//
//   1. MSW KNOWABILITY. `MswRiskFactorReader` returns POSITIVE findings only — an absent factor is
//      ambiguous between "the MSW assessed this and documented it negative" and "nobody ever asked".
//      The discriminator is whether a psychosocial assessment happened at all: if it did, an unlisted
//      domain is a documented negative (`false`); if it did not, every MSW-derived domain is `unknown`.
//      That is exactly the §7.3 (MSW present → `ambivalentRelationship=false`) vs §7.17 (no MSW →
//      five `unknown`s) split, and it is why `assessed` is a separate input from `factors`.
//
//   2. REDACTION IS NOT ABSENCE. §7.13: when the caller holds no 42 CFR Part 2 disclosure, M15's SQL
//      filter removes the SUD findings before M16 ever sees them. Scoring that as `false` would let a
//      permission boundary silently LOWER a grieving survivor's risk tier. A redacted category always
//      resolves `unknown` and is named in `redactedCategories`, so the surveyor reconstruction in §7.13
//      can explain why the score moved between two readers of the same plan.
//
//   3. ONE PPS READING IS NOT A TRAJECTORY. §7.17's contrived vector has a single admission PPS and
//      still answers `suddenUnexpectedDeath='unknown'`. Sudden-vs-expected is a claim about a SLOPE, so
//      it needs two comparable captures; anything less is unknowable, not benign.
//
// PURE — no IO, `@chartwarden/types`-only. The seam resolution that FEEDS this lives in the M16 service layer
// (`apps/backend/src/modules/16-bereavement/risk/extract.ts`).

import type {
  BereavementFactorValue,
  BereavementRiskFactorInputs,
  BereavementRiskFactorName,
  MswRiskFactor,
  ScaleSeriesPoint,
} from "@chartwarden/types";

// ── The M15 MSW vocabulary → the 8 D17 rubric slots ──────────────────────────────────────────────────

/**
 * M15's `MswRiskFactor.factor` is free text authored on a `discipline_assessment` — M15 EXPOSES factors and
 * deliberately never scores them (M15 §1.2), so the vocabulary → rubric mapping is M16's to own. Keys are
 * normalized by {@link normalizeMswFactor}; the canonical spellings are the ones §7.3 uses, with the
 * synonyms MSW templates in the field actually produce.
 *
 * A factor that maps to NOTHING is not an error and not a silent drop — §7.3's worked example names
 * `age_over_80`, which D17's locked 8-factor vector has no slot for. Unmapped names come back in
 * {@link DerivedRiskFactors.unmappedMswFactors} so the counselor UI and the survey view can still show the
 * MSW finding, without it leaking into a weight it was never assigned.
 */
export const MSW_FACTOR_ALIASES: Readonly<Record<string, BereavementRiskFactorName>> = {
  ambivalent_relationship: "ambivalentRelationship",
  conflicted_relationship: "ambivalentRelationship",
  estranged_relationship: "ambivalentRelationship",

  sudden_unexpected_death: "suddenUnexpectedDeath",
  unexpected_death: "suddenUnexpectedDeath",
  traumatic_death: "suddenUnexpectedDeath",

  prior_unresolved_loss: "priorUnresolvedLoss",
  prior_loss: "priorUnresolvedLoss",
  unresolved_grief: "priorUnresolvedLoss",
  multiple_recent_losses: "priorUnresolvedLoss",

  mental_health_history: "preExistingMentalHealth",
  pre_existing_mental_health: "preExistingMentalHealth",
  psychiatric_history: "preExistingMentalHealth",
  depression_history: "preExistingMentalHealth",
  anxiety_history: "preExistingMentalHealth",
  suicidal_ideation_history: "preExistingMentalHealth",

  social_isolation: "socialIsolation",
  sole_caregiver_isolation: "socialIsolation",
  limited_support_system: "socialIsolation",
  lives_alone: "socialIsolation",

  financial_strain: "financialStrain",
  financial_hardship: "financialStrain",
  housing_instability: "financialStrain",
  food_insecurity: "financialStrain",

  primary_caregiver_role: "primaryCaregiverRole",
  primary_caregiver: "primaryCaregiverRole",
  sole_caregiver: "primaryCaregiverRole",
  caregiver_burden: "primaryCaregiverRole",

  active_substance_use: "activeSubstanceUse",
  substance_use: "activeSubstanceUse",
  substance_use_disorder: "activeSubstanceUse",
  alcohol_use_disorder: "activeSubstanceUse",
  opioid_use_disorder: "activeSubstanceUse",
};

/** The §7.13 disclosure category whose M15-side SQL filter forces `activeSubstanceUse` to `unknown`. */
export const SUD_REDACTION_CATEGORY = "sud" as const;

/** The rubric slot 42 CFR Part 2 redaction makes unknowable (the ONLY slot M15's SUD filter can empty). */
export const SUD_GATED_FACTOR: BereavementRiskFactorName = "activeSubstanceUse";

/** Normalize an M15 factor string to the {@link MSW_FACTOR_ALIASES} key shape: lowercase, every run of
 *  non-alphanumerics collapsed to a single `_`, no leading/trailing `_`. */
export function normalizeMswFactor(factor: string): string {
  return factor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ── The M9 PPS trajectory rule (`suddenUnexpectedDeath`) ─────────────────────────────────────────────

/** A PPS at or below this on the last pre-death reading means the trajectory ALREADY described an actively
 *  dying patient — the death was expected however short the stay (§7.3's "expected per M9 PPS trajectory"). */
export const PPS_IMMINENT_DEATH_CEILING = 30 as const;

/** A drop of at least this many PPS points across the pre-death window is a documented decline, so the death
 *  was foreseeable even if the final reading was not itself in the imminent band. */
export const PPS_EXPECTED_DECLINE_DELTA = 20 as const;

/** Two comparable captures are the floor for any slope claim (§7.17 — one admission reading is `unknown`). */
export const PPS_TRAJECTORY_MIN_POINTS = 2 as const;

/**
 * D3 `suddenUnexpectedDeath` from the M9 PPS series over the pre-death window. Ordered by `capturedAt`
 * ascending; points with a null score are not comparable and are dropped before the count is taken.
 *
 * Deliberately fails to `unknown` rather than to `true`: "we could not see the decline" is not evidence the
 * death was sudden, and the 0.15 weight this factor carries is the second-heaviest in the rubric.
 */
export function suddenUnexpectedDeathFromPps(
  points: readonly ScaleSeriesPoint[] | null,
): BereavementFactorValue {
  if (points === null) return "unknown";
  const scored = points
    .filter((p): p is ScaleSeriesPoint & { score: number } => typeof p.score === "number")
    .slice()
    .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
  if (scored.length < PPS_TRAJECTORY_MIN_POINTS) return "unknown";

  const first = scored[0]!;
  const latest = scored[scored.length - 1]!;
  if (latest.score <= PPS_IMMINENT_DEATH_CEILING) return false;
  if (first.score - latest.score >= PPS_EXPECTED_DECLINE_DELTA) return false;
  return true;
}

// ── The M16 roster proxies (`primaryCaregiverRole`, `socialIsolation`) ───────────────────────────────

/** §7.17 — an enrolled roster of at least this size is documented support, so `socialIsolation` is `false`.
 *  Below it the roster is only a proxy, and it yields to any MSW finding (see {@link deriveRiskFactors}). */
export const SOCIAL_SUPPORT_ROSTER_FLOOR = 2 as const;

/** What the M16 roster (M16's OWN `bereaved_contact` rows, seeded from M5 at §7.2) knows about a survivor.
 *  `null` on either member means the roster has not been seeded yet — never "no". */
export interface BereavementRosterEvidence {
  /** This survivor was the decedent's primary caregiver (the M5 `patient_caregiver.is_primary` seed). */
  readonly isPrimaryCaregiver: boolean | null;
  /** How many survivors are enrolled on the plan, this one included. */
  readonly enrolledSurvivorCount: number | null;
}

// ── The evidence bundle + the derivation ─────────────────────────────────────────────────────────────

/** Everything the derivation reads. Every member is a plain value the service layer already resolved, so
 *  the derivation itself stays pure and a surveyor can replay it from the captured `risk_factors_jsonb`. */
export interface BereavementRiskEvidence {
  /**
   * Rule 1's discriminator: did an M15 MSW psychosocial assessment happen for this admission at all?
   * `true` makes an unlisted psychosocial domain a documented negative; `false` makes it `unknown`.
   */
  readonly mswAssessed: boolean;
  /** The POSITIVE psychosocial findings M15's `MswRiskFactorReader` returned (already SUD-filtered by M15). */
  readonly mswFactors: readonly MswRiskFactor[];
  /** The M9 `ScaleSeriesProvider` PPS points over the pre-death window; `null` when M9 was unreadable. */
  readonly ppsPoints: readonly ScaleSeriesPoint[] | null;
  readonly roster: BereavementRosterEvidence;
  /**
   * Rule 2: whether the reader held a 42 CFR Part 2 disclosure. `false` means M15's SQL filter already
   * removed any SUD finding, so `activeSubstanceUse` cannot be scored — not that there was none.
   */
  readonly sudDisclosureAllowed: boolean;
}

/** The derivation's result: the vector `computeBereavementRiskScore` consumes, plus the provenance the
 *  §7.13 survey reconstruction and the counselor UI need. */
export interface DerivedRiskFactors {
  readonly factors: BereavementRiskFactorInputs;
  /** §7.13 — the disclosure categories filtered out upstream of this score. Empty when nothing was hidden. */
  readonly redactedCategories: readonly string[];
  /** MSW findings with no D17 rubric slot (e.g. §7.3's `age_over_80`) — surfaced, never weighted. */
  readonly unmappedMswFactors: readonly string[];
}

/** The MSW-sourced slots: the ones rule 1's knowability discriminator governs. `suddenUnexpectedDeath` is
 *  M9's, and the two roster slots have their own ladder, so none of the three are listed here. */
const MSW_SOURCED_FACTORS: readonly BereavementRiskFactorName[] = [
  "ambivalentRelationship",
  "priorUnresolvedLoss",
  "preExistingMentalHealth",
  "financialStrain",
  "activeSubstanceUse",
];

/**
 * D3/D17 — derive the 8-factor vector from cross-module evidence.
 *
 * Per-slot resolution ladder:
 *   · the 5 MSW-sourced slots  → MSW positive ⇒ `true`; else rule 1 (`mswAssessed ? false : 'unknown'`),
 *                                with `activeSubstanceUse` forced to `unknown` under rule 2;
 *   · `suddenUnexpectedDeath`  → an MSW positive (the clinician SAW it) outranks the PPS slope; otherwise
 *                                rule 3 over the M9 series, falling back to rule 1 when M9 is silent;
 *   · `socialIsolation`        → MSW positive ⇒ `true`; MSW assessed-and-silent ⇒ `false`; else the roster
 *                                headcount proxy (§7.17); else `unknown`;
 *   · `primaryCaregiverRole`   → the roster IS authoritative here (it carries the M5 caregiver link), so it
 *                                leads; MSW is the fallback; else `unknown`.
 */
export function deriveRiskFactors(evidence: BereavementRiskEvidence): DerivedRiskFactors {
  const positives = new Set<BereavementRiskFactorName>();
  const unmapped: string[] = [];
  for (const finding of evidence.mswFactors) {
    const slot = MSW_FACTOR_ALIASES[normalizeMswFactor(finding.factor)];
    if (slot) positives.add(slot);
    else unmapped.push(finding.factor);
  }

  /** Rule 1 applied to one MSW-sourced slot. */
  const fromMsw = (name: BereavementRiskFactorName): BereavementFactorValue =>
    positives.has(name) ? true : evidence.mswAssessed ? false : "unknown";

  const factors: BereavementRiskFactorInputs = {
    ambivalentRelationship: fromMsw("ambivalentRelationship"),
    // An MSW who documented the death as traumatic outranks any slope M9 can draw.
    suddenUnexpectedDeath: positives.has("suddenUnexpectedDeath")
      ? true
      : withMswFallback(suddenUnexpectedDeathFromPps(evidence.ppsPoints), evidence.mswAssessed),
    priorUnresolvedLoss: fromMsw("priorUnresolvedLoss"),
    preExistingMentalHealth: fromMsw("preExistingMentalHealth"),
    socialIsolation: positives.has("socialIsolation")
      ? true
      : evidence.mswAssessed
        ? false
        : socialIsolationFromRoster(evidence.roster),
    financialStrain: fromMsw("financialStrain"),
    primaryCaregiverRole:
      evidence.roster.isPrimaryCaregiver !== null
        ? evidence.roster.isPrimaryCaregiver
        : fromMsw("primaryCaregiverRole"),
    // Rule 2 — a redacted category is unknowable, never absent.
    activeSubstanceUse: evidence.sudDisclosureAllowed ? fromMsw("activeSubstanceUse") : "unknown",
  };

  return {
    factors,
    redactedCategories: evidence.sudDisclosureAllowed ? [] : [SUD_REDACTION_CATEGORY],
    unmappedMswFactors: unmapped,
  };
}

/** An `unknown` from M9 still gets rule 1's second chance: an MSW that assessed the death circumstances and
 *  documented nothing traumatic is a documented negative. Without an MSW it stays `unknown`. */
function withMswFallback(
  fromPps: BereavementFactorValue,
  mswAssessed: boolean,
): BereavementFactorValue {
  if (fromPps !== "unknown") return fromPps;
  return mswAssessed ? false : "unknown";
}

/** §7.17's roster proxy, used only when no MSW assessment exists to speak to isolation directly. */
function socialIsolationFromRoster(roster: BereavementRosterEvidence): BereavementFactorValue {
  if (roster.enrolledSurvivorCount === null) return "unknown";
  return roster.enrolledSurvivorCount < SOCIAL_SUPPORT_ROSTER_FLOOR;
}
