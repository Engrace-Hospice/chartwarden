// apps/web/src/modules/15-discipline-care-plans — the aide task frequency vocabulary.
//
// An intervention carries its frequency twice: `frequencyText` (what a person reads) and `frequencyValue`
// (the machine form scheduling reads, `N:unit:per`). The database CHECK
// `discipline_intervention_frequency_value_ck` (migration 0098) accepts only
// `^[0-9]+:(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$`, so a free-typed "3/week" was
// refused at insert. Each preset below pairs one phrase with one code that satisfies that CHECK; the editor
// offers them as two linked selects, so the two fields can never disagree.

export interface FrequencyPreset {
  /** The machine form sent as `frequencyValue`. */
  readonly code: string;
  /** The plain-words phrase sent as `frequencyText`. */
  readonly words: string;
}

export const FREQUENCY_PRESETS: readonly FrequencyPreset[] = [
  { code: "1:visit:day", words: "once daily" },
  { code: "2:visit:day", words: "twice daily" },
  { code: "3:visit:day", words: "three times daily" },
  { code: "1:visit:week", words: "once weekly" },
  { code: "2:visit:week", words: "twice weekly" },
  { code: "3:visit:week", words: "three times weekly" },
  { code: "4:visit:week", words: "four times weekly" },
  { code: "5:visit:week", words: "five times weekly" },
  { code: "1:visit:month", words: "once monthly" },
  { code: "1:prn:prn", words: "as needed (PRN)" },
];

const NONE = { value: "", label: "Select…" } as const;

/** Options for the "Frequency (words)" select; the value is the shared code. */
export const FREQUENCY_WORD_OPTIONS: readonly { value: string; label: string }[] = [
  NONE,
  ...FREQUENCY_PRESETS.map((p) => ({ value: p.code, label: p.words })),
];

/** Options for the "Frequency (coded)" select; the value is the same code the words select carries. */
export const FREQUENCY_CODE_OPTIONS: readonly { value: string; label: string }[] = [
  NONE,
  ...FREQUENCY_PRESETS.map((p) => ({ value: p.code, label: p.code })),
];

/** The preset for a code, or undefined for "nothing chosen" and for any code outside the vocabulary. */
export function frequencyPresetFor(code: string): FrequencyPreset | undefined {
  return FREQUENCY_PRESETS.find((p) => p.code === code);
}
