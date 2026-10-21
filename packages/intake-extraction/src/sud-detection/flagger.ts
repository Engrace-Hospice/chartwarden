// @chartwarden/intake-extraction — the deterministic SUD pattern flagger (F-237; M22 §7.4 W4 / D8, 42 CFR Part 2).
//
// Runs over the Docling text blocks of every page of an intake batch and returns each indicator it finds,
// with the page and the BLOCK's box, so the review UI can show the reviewer exactly why a page was flagged.
// It is the always-on half of DocLens SUD detection: it needs no AI capability, no tenant opt-in and no
// network, so a tenant with AI off still gets Part 2 indicators flagged before anything reaches a chart.
// (The optional `doclens_sud_detect` model pass ADDS indicators it can ground; it never removes these.)
//
// WHAT IT LOOKS FOR (W4 step 1): medication-assisted-treatment drugs, ICD-10 F10–F19 codes (F17, tobacco,
// excluded — 42 CFR §2.11 excludes tobacco and caffeine from "substance use disorder"), SUD diagnosis
// wording, substance-use social history, and SUD treatment-setting wording.
//
// IT IS DELIBERATELY HIGH-RECALL. A hospice med list carrying methadone for PAIN is flagged; that is the
// spec's own worked false positive (W4 acceptance #2), and the reviewer's "reject" exists for it. A
// detector that tried to infer intent from a dose would be deciding a Part 2 question no rule can see.
// Negation ("denies alcohol abuse") suppresses diagnosis/social-history wording only — a medication on a
// list is never negated by nearby text.
//
// The returned `term` is PHI (a Part 2 indicator on a named patient). Callers store it only encrypted and
// never log it; rule ids and categories are PHI-free.

import type { SudSuggestedKind } from "./domain";

/** The ruleset version recorded on the batch (`sud_detector_ref`) so a later rule change is traceable. */
export const SUD_RULESET_VERSION = "rules:v1";

/** The categories an indicator can carry (`suggestedSudKind`), the §1.1 set plus treatment setting. */
export type SudIndicatorCategory = SudSuggestedKind | "treatment_setting";

export interface SudTextBlock {
  readonly text: string;
  /** `[left, top, right, bottom]`, top-left origin, page units (Docling's). */
  readonly bbox: readonly [number, number, number, number];
}

export interface SudPageInput {
  readonly page: number;
  readonly blocks: readonly SudTextBlock[];
}

export interface SudIndicator {
  readonly page: number;
  readonly category: SudIndicatorCategory;
  /** PHI-free rule id, e.g. `med:buprenorphine`, `dx:icd10-f1x`. */
  readonly ruleId: string;
  /** The matched text, verbatim. PHI — store encrypted, never log. */
  readonly term: string;
  readonly bbox: readonly [number, number, number, number];
}

interface SudRule {
  readonly id: string;
  readonly category: SudIndicatorCategory;
  readonly pattern: RegExp;
  /** Diagnosis/social wording can be negated ("denies …"); a medication cannot. */
  readonly negatable: boolean;
}

const SUBSTANCE =
  "(?:alcohol|opioid|opiate|heroin|cocaine|cannabis|marijuana|stimulant|amphetamine|methamphetamine|sedative|benzodiazepine|hallucinogen|inhalant|substance|polysubstance|drug)";

/** v1 rules. Case-insensitive unless the rule is an abbreviation (matched upper-case only). */
export const SUD_RULES: readonly SudRule[] = [
  // ── medication-assisted treatment (§2.31: "methadone/buprenorphine/naltrexone in a med list") ──
  {
    id: "med:methadone",
    category: "medication",
    pattern: /\b(?:methadone|methadose|dolophine|diskets)\b/gi,
    negatable: false,
  },
  {
    id: "med:buprenorphine",
    category: "medication",
    pattern: /\b(?:buprenorphine|suboxone|subutex|zubsolv|sublocade|brixadi|bunavail)\b/gi,
    negatable: false,
  },
  {
    id: "med:naltrexone",
    category: "medication",
    pattern: /\b(?:naltrexone|vivitrol|revia)\b/gi,
    negatable: false,
  },
  {
    id: "med:aud-pharmacotherapy",
    category: "medication",
    pattern: /\b(?:disulfiram|antabuse|acamprosate|campral)\b/gi,
    negatable: false,
  },
  {
    id: "med:lofexidine",
    category: "medication",
    pattern: /\b(?:lofexidine|lucemyra)\b/gi,
    negatable: false,
  },
  // ── diagnosis ──
  {
    // F10–F16, F18, F19 with a decimal subcode (a bare "F10" is too often a form or room number).
    id: "dx:icd10-f1x",
    category: "diagnosis",
    pattern: /\bF1[0-689]\.[0-9][0-9A-Z]{0,3}\b/g,
    negatable: true,
  },
  {
    id: "dx:use-disorder",
    category: "diagnosis",
    pattern: new RegExp(
      `\\b${SUBSTANCE}\\s+(?:use\\s+disorder|dependence|dependency|addiction)\\b`,
      "gi",
    ),
    negatable: true,
  },
  {
    id: "dx:alcoholism",
    category: "diagnosis",
    pattern: /\b(?:alcoholism|alcoholic\s+(?:cirrhosis|hepatitis|liver\s+disease))\b/gi,
    negatable: true,
  },
  {
    id: "dx:withdrawal",
    category: "diagnosis",
    pattern: /\b(?:(?:alcohol|opioid|opiate|benzodiazepine)\s+withdrawal|delirium\s+tremens)\b/gi,
    negatable: true,
  },
  {
    id: "dx:abbreviation",
    category: "diagnosis",
    pattern: /\b(?:OUD|SUD|AUD|IVDU|IVDA)\b/g,
    negatable: true,
  },
  // ── social history ──
  {
    id: "sh:abuse",
    category: "social_history",
    pattern: new RegExp(`\\b${SUBSTANCE}\\s+(?:abuse|misuse)\\b`, "gi"),
    negatable: true,
  },
  {
    id: "sh:injection-use",
    category: "social_history",
    pattern: /\b(?:iv|intravenous|injection)\s+drug\s+use\b/gi,
    negatable: true,
  },
  {
    id: "sh:illicit",
    category: "social_history",
    pattern: /\b(?:heroin|crack\s+cocaine|cocaine\s+use|methamphetamine\s+use)\b/gi,
    negatable: true,
  },
  {
    id: "sh:history-of-use",
    category: "social_history",
    pattern: new RegExp(
      `\\bhistory\\s+of\\s+${SUBSTANCE}\\s+(?:use|abuse|misuse)\\b|\\b${SUBSTANCE}\\s+overdose\\b`,
      "gi",
    ),
    negatable: true,
  },
  {
    id: "sh:recovery",
    category: "social_history",
    pattern:
      /\b(?:alcoholics\s+anonymous|narcotics\s+anonymous|sober\s+since|in\s+recovery\s+from)\b/gi,
    negatable: true,
  },
  // ── treatment setting ──
  {
    id: "tx:mat",
    category: "treatment_setting",
    pattern:
      /\b(?:medication[-\s]assisted\s+treatment|opioid\s+treatment\s+program|methadone\s+(?:clinic|program|maintenance))\b/gi,
    negatable: false,
  },
  {
    id: "tx:mat-abbreviation",
    category: "treatment_setting",
    pattern: /\bMAT\b/g,
    negatable: false,
  },
  {
    id: "tx:program",
    category: "treatment_setting",
    pattern:
      /\b(?:detox(?:ification)?\s+(?:center|unit|program|facility)|(?:substance|drug|alcohol)\s+(?:abuse|use)\s+(?:treatment|program|counsel(?:ing|or))|addiction\s+(?:treatment|medicine|center|services|program)|chemical\s+dependency|sober\s+living)\b/gi,
    negatable: false,
  },
];

/** A negation cue in the text immediately BEFORE a match, within the same block. */
const NEGATION = /\b(?:denies|denied|deny|no|not|negative\s+for|without|never|none)\b[^.;:]*$/i;
const NEGATION_WINDOW = 48;

function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - NEGATION_WINDOW), index);
  return NEGATION.test(before);
}

/**
 * Every SUD indicator on every page, in page then block order. One indicator per (page, rule, block):
 * the same drug named twice in one line is one piece of evidence, not two.
 */
export function detectSudIndicators(pages: readonly SudPageInput[]): SudIndicator[] {
  const out: SudIndicator[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const rule of SUD_RULES) {
        rule.pattern.lastIndex = 0;
        for (const m of block.text.matchAll(rule.pattern)) {
          if (rule.negatable && isNegated(block.text, m.index ?? 0)) continue;
          out.push({
            page: page.page,
            category: rule.category,
            ruleId: rule.id,
            term: m[0],
            bbox: block.bbox,
          });
          break; // one per (rule, block)
        }
      }
    }
  }
  return out;
}

/** The most frequent category among indicators (ties → the earlier §1.1 category). */
export function dominantSudCategory(indicators: readonly SudIndicator[]): SudIndicatorCategory {
  const order: SudIndicatorCategory[] = [
    "medication",
    "diagnosis",
    "social_history",
    "treatment_setting",
  ];
  const counts = new Map<SudIndicatorCategory, number>();
  for (const i of indicators) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  let best: SudIndicatorCategory = "medication";
  let bestCount = -1;
  for (const c of order) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/**
 * F-238 — does this ONE attested line name a medication-assisted-treatment drug (any `medication`-category
 * rule: methadone, buprenorphine, naltrexone, disulfiram/acamprosate, lofexidine)? The DocLens clinical
 * writeback planner keeps such a line out of every chart writeback unless the batch's SUD detection was
 * REJECTED as a false positive by a reviewer (42 CFR Part 2: a Part 2 record does not leave review evidence
 * without a consent decision nobody has made on this path). A medication is never negated, so no negation
 * window applies. Pure; the matched term is not returned (it is PHI).
 */
export function lineNamesSudTreatmentMedication(text: string): boolean {
  for (const rule of SUD_RULES) {
    if (rule.category !== "medication") continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
    if (re.test(text)) return true;
  }
  return false;
}
