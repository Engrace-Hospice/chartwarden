// @wardenx/hope — the server-authoritative J2051 trigger evaluator (M10-T03; §2.3, §4.3, D4). PURE,
// IO-free, deterministic — the §9.1 ≥95%-coverage target. The recording service (M10-T06) calls
// `evaluateJ2051Trigger` over the typed `data.J.J2051` payload and writes the SERVER's verdict to
// `hope_assessment.j2051_max_severity` / `j2051_trigger_fired`, IGNORING any client-supplied trigger flag
// (D4 — a misconfigured client must never suppress the trigger). When the trigger fires, the service
// creates exactly one `symptom_follow_up_visit` per source assessment (D4) via `planSfvCreation` in
// `../sfv/sfv.ts`.
//
// The full Section-J TypeBox (`packages/hope/src/sections/J/schema.ts`) lands with the per-section
// modules (M10-T04); T03 evaluates over a minimal structural input shape so the trigger logic is testable
// now and the route TypeBox adapts to it later (the field is `J2051.entries`, mirroring §4.3).
import { J2051_SEVERITY_ORDER, type J2051Severity } from "@wardenx/types";

/** One per-symptom severity reading from the §4.3 `J2051.entries` array (the CMS symptom-impact items).
 * `symptomCode` is the closed CMS list at the route boundary; the evaluator treats it as an opaque label
 * (it ranks on `severity` only). */
export interface J2051SymptomReading {
  readonly symptomCode: string;
  readonly severity: J2051Severity;
}

/** The minimal J2051 input the evaluator consumes (the route's `data.J.J2051`, §4.3). */
export interface J2051Reading {
  readonly entries: readonly J2051SymptomReading[];
}

/** The server-authoritative J2051 verdict (D4): the max severity across all symptoms, whether the 2-day
 * SFV trigger fires (any symptom ≥ `moderate`), and the per-symptom list that crossed the threshold (the
 * SFV's `data.symptoms_addressed`, and the §4.9 alert's `triggeringSymptoms`). */
export interface J2051Verdict {
  readonly maxSeverity: J2051Severity;
  readonly triggerFired: boolean;
  readonly contributingSymptoms: readonly J2051SymptomReading[];
}

/** Rank index of a severity in the CMS order (`none`=0 … `severe`=3). */
const rank = (s: J2051Severity): number => J2051_SEVERITY_ORDER.indexOf(s);

/** The §2.3 / D4 trigger threshold: `moderate` (rank 2) or higher fires the SFV obligation. */
const TRIGGER_THRESHOLD_RANK = J2051_SEVERITY_ORDER.indexOf("moderate");

/**
 * §2.3 / §4.3 / D4 — compute the server-authoritative J2051 verdict from the typed symptom readings. The
 * trigger fires when ANY symptom is `moderate` or `severe`; exactly one SFV is created per source
 * assessment regardless of how many symptoms cross (the caller enforces one-per-source). An empty
 * `entries` array (no symptoms screened) yields `none` / no trigger. Deterministic: no IO, no clock.
 */
export function evaluateJ2051Trigger(reading: J2051Reading): J2051Verdict {
  const maxRank = reading.entries.reduce((max, e) => Math.max(max, rank(e.severity)), 0);
  const maxSeverity = J2051_SEVERITY_ORDER[maxRank] ?? "none";
  return {
    maxSeverity,
    triggerFired: maxRank >= TRIGGER_THRESHOLD_RANK,
    contributingSymptoms: reading.entries.filter((e) => rank(e.severity) >= TRIGGER_THRESHOLD_RANK),
  };
}
