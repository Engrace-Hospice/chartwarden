// @wardenx/intake-extraction — the §7.4 W4 SUD pattern flagger (M22-T08, 42 CFR Part 2 §2.31).
//
// PURE rule-based SUD-content detector — the defense-in-depth complement to the M32 `DocLensSudDetector` AI
// capability (§8.5). It runs ALWAYS, even when M32 is deny-stubbed, so the §2.31 SUD signal is never silently
// dropped just because the AI classifier is unavailable. It matches three signal families on the extracted
// candidate values + page text:
//   • MAT / SUD medications by name (methadone, buprenorphine, suboxone, subutex, naltrexone, vivitrol, …);
//   • ICD-10 F10–F19 substance-use-disorder codes;
//   • MAT / SUD terminology ("opioid use disorder", "OUD", "medication-assisted treatment", "substance use", …).
//
// On any hit M22 emits `m22.intake.sud_detected` → M5 creates an INTERIM PrivacyFlag (`source_consent_version=null`,
// D8) and the SUD-flagged extraction is gated by `sud_consent_present` before commit (M22 owns neither the flag nor
// the consent — M5/M39 do). The flagger only RAISES the signal; it never blocks or redacts on its own.

import type { RawCandidate } from "../adapters/seams";

/** A SUD signal raised by the rule-based flagger (mirrors the M32 capability's `SudSignal`, plus what triggered it). */
export interface SudFlag {
  readonly fieldPath: string | null;
  readonly pageNumber: number | null;
  /** The suggested 42 CFR Part 2 SUD kind (the M5 interim-PrivacyFlag hint, never authoritative). */
  readonly sudKind: string;
  /** Which family matched (audit/debug; not PHI). */
  readonly signalFamily: "medication" | "icd10" | "terminology";
  /** The matched token (lowercased, for the reviewer banner; the candidate value itself stays in `value_cipher`). */
  readonly matchedToken: string;
}

/** MAT / SUD medications (42 CFR Part 2 §2.31 — methadone/buprenorphine/naltrexone family + brand names). */
const SUD_MEDICATIONS: readonly { token: string; sudKind: string }[] = [
  { token: "methadone", sudKind: "opioid_use_disorder" },
  { token: "buprenorphine", sudKind: "opioid_use_disorder" },
  { token: "suboxone", sudKind: "opioid_use_disorder" },
  { token: "subutex", sudKind: "opioid_use_disorder" },
  { token: "sublocade", sudKind: "opioid_use_disorder" },
  { token: "naltrexone", sudKind: "substance_use_disorder" },
  { token: "vivitrol", sudKind: "substance_use_disorder" },
  { token: "acamprosate", sudKind: "alcohol_use_disorder" },
  { token: "campral", sudKind: "alcohol_use_disorder" },
  { token: "disulfiram", sudKind: "alcohol_use_disorder" },
  { token: "antabuse", sudKind: "alcohol_use_disorder" },
];

/** MAT / SUD terminology. */
const SUD_TERMS: readonly { token: string; sudKind: string }[] = [
  { token: "opioid use disorder", sudKind: "opioid_use_disorder" },
  { token: "substance use disorder", sudKind: "substance_use_disorder" },
  { token: "substance abuse", sudKind: "substance_use_disorder" },
  { token: "alcohol use disorder", sudKind: "alcohol_use_disorder" },
  { token: "medication-assisted treatment", sudKind: "opioid_use_disorder" },
  { token: "medication assisted treatment", sudKind: "opioid_use_disorder" },
];

/** ICD-10 F10–F19 (mental & behavioural disorders due to psychoactive substance use). */
const ICD10_SUD_RE = /\bF1[0-9](?:\.\d{1,3})?\b/i;

function lc(s: string): string {
  return s.toLowerCase();
}

/** Scan one text blob for SUD signals, attributing each to a field/page. */
function scan(text: string, fieldPath: string | null, pageNumber: number | null): SudFlag[] {
  const hay = lc(text);
  const out: SudFlag[] = [];
  for (const med of SUD_MEDICATIONS) {
    if (hay.includes(med.token)) {
      out.push({ fieldPath, pageNumber, sudKind: med.sudKind, signalFamily: "medication", matchedToken: med.token });
    }
  }
  for (const term of SUD_TERMS) {
    if (hay.includes(term.token)) {
      out.push({ fieldPath, pageNumber, sudKind: term.sudKind, signalFamily: "terminology", matchedToken: term.token });
    }
  }
  const icd = ICD10_SUD_RE.exec(text);
  if (icd) {
    out.push({
      fieldPath,
      pageNumber,
      sudKind: "substance_use_disorder",
      signalFamily: "icd10",
      matchedToken: icd[0].toUpperCase(),
    });
  }
  return out;
}

export interface FlagSudInput {
  readonly candidates: readonly Pick<RawCandidate, "fieldPath" | "value" | "code" | "sourcePage">[];
  readonly pages: readonly { pageNumber: number; text: string }[];
}

/** Run the §7.4 W4 rule-based SUD flagger over a batch's candidates + page text. Returns one {@link SudFlag} per
 * distinct (field/page, sudKind, family, token) hit. An empty array means no SUD content matched (not "no SUD"). */
export function flagSud(input: FlagSudInput): readonly SudFlag[] {
  const flags: SudFlag[] = [];
  for (const c of input.candidates) {
    flags.push(...scan(c.value, c.fieldPath, c.sourcePage));
    if (c.code) flags.push(...scan(c.code, c.fieldPath, c.sourcePage));
  }
  for (const p of input.pages) {
    flags.push(...scan(p.text, null, p.pageNumber));
  }
  // De-duplicate identical signals (same field/page, kind, family, token).
  const seen = new Set<string>();
  const deduped: SudFlag[] = [];
  for (const flag of flags) {
    const key = `${flag.fieldPath ?? ""}|${flag.pageNumber ?? ""}|${flag.sudKind}|${flag.signalFamily}|${flag.matchedToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(flag);
  }
  return deduped;
}

/** True if any SUD signal was raised (the boolean gate the §7.4 W4 `m22.intake.sud_detected` emit keys on). */
export function hasSudContent(flags: readonly SudFlag[]): boolean {
  return flags.length > 0;
}
