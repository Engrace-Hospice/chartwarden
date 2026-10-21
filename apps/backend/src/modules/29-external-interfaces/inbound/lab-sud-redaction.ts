// apps/backend/src/modules/29-external-interfaces/inbound — SUD ingress redaction gate (M29-T05, §7.3 D15).
// Injected over narrow ports — the M39 `ConsentEvaluator` is OPAQUE in the leaf `@chartwarden/types` and M29
// carries no `39`/`38` dependsOn edge (ADR-0005: seam consumers are edge-free), so this file defines the
// minimal `LabConsentPort` + reuses `LabTerminologyPort` and the T08 boot wiring adapts the real M39/M38
// seams. PURE over its injected ports — no DB, no clock.
//
// D15 (42 CFR Part 2, default-ON): a SUD-classified inbound lab (urine drug screen panel, opioid metabolite,
// …) is persisted UNDER redaction unless the patient has explicit SUD-disclosure consent as of the
// observation date. The two-step gate:
//   1. Is ANY OBX-3 LOINC in the SUD-test class? (M38 `classifyLoinc().categories` includes the SUD class.)
//   2. If yes, ask M39 `evaluateForIngressRedaction(patientId, 'lab_sud', asOf)`. allowDisclosure=false
//      (absent / unknown / unauthorized) ⇒ redact. M38/M39 unavailable ⇒ fail SAFE (redact).
// An UNMATCHED lab (no patient_id) is NOT redacted here — there is no patient context for a consent check;
// the SUD gate re-runs at manual-bind time (T08), when the patient is known.
import { XI_SUD_INGRESS_DATA_CLASS } from "@chartwarden/types";
import type { LabTerminologyPort } from "./lab-terminology";

/** The narrow slice of M38's `TerminologyProvider` the SUD gate needs (LOINC → category classification). */
export interface LabSudTerminologyPort extends LabTerminologyPort {
  /** Return the LOINC's category tags as of a date; the SUD-test class marks a 42 CFR Part 2 result. */
  classifyLoinc(input: {
    code: string;
    asOfDate: string;
    /** GAP-086 — lets the provider include the tenant's own SUD-test extension codes. */
    organizationId?: string;
  }): Promise<{ readonly categories: readonly string[] }>;
}

/** The narrow slice of M39's `ConsentEvaluator` the SUD gate needs (§4.3 `evaluateForIngressRedaction`). */
export interface LabConsentPort {
  evaluateForIngressRedaction(input: {
    /** GAP-086 — the tenant the consent is evaluated in (the real M39 evaluator is org-explicit). */
    organizationId?: string;
    patientId: string;
    dataClass: string;
    asOf: string;
  }): Promise<{ readonly allowDisclosure: boolean }>;
}

/** The LOINC category tag M38 stamps on a 42 CFR Part 2 SUD-test code. */
const SUD_TEST_CATEGORY = "sud_test";

export interface LabSudDecision {
  /** True when at least one OBX-3 LOINC is in the SUD-test class. */
  readonly sudDetected: boolean;
  /** True when the observation must be persisted under redaction (D15 default-on). */
  readonly redact: boolean;
}

export interface LabSudInput {
  /** GAP-086 — forwarded to the consent port; the real evaluator requires it. */
  readonly organizationId?: string;
  /** The matched patient (null ⇒ unmatched; no redaction here, deferred to bind-time). */
  readonly patientId: string | null;
  readonly loincCodes: readonly string[];
  /** The observation date (`asOf` for both the M38 classification and the M39 consent evaluation). */
  readonly asOf: string;
}

export interface LabSudDeps {
  readonly consent: LabConsentPort;
  readonly terminology: LabSudTerminologyPort;
}

/** Decide whether an inbound lab is persisted under SUD redaction (D15). */
export async function decideLabSudRedaction(
  input: LabSudInput,
  deps: LabSudDeps,
): Promise<LabSudDecision> {
  // Unmatched — no patient context; the bind-time gate (T08) applies redaction once the patient is known.
  if (!input.patientId) return { sudDetected: false, redact: false };

  let sudDetected = false;
  for (const raw of input.loincCodes) {
    const code = raw.trim();
    if (code === "") continue;
    try {
      const { categories } = await deps.terminology.classifyLoinc({
        code,
        asOfDate: input.asOf,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      });
      if (categories.includes(SUD_TEST_CATEGORY)) {
        sudDetected = true;
        break;
      }
    } catch {
      // M38 unavailable — fail safe: treat as SUD-class and redact.
      sudDetected = true;
      break;
    }
  }

  if (!sudDetected) return { sudDetected: false, redact: false };

  try {
    const decision = await deps.consent.evaluateForIngressRedaction({
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      patientId: input.patientId,
      dataClass: XI_SUD_INGRESS_DATA_CLASS,
      asOf: input.asOf,
    });
    return { sudDetected: true, redact: !decision.allowDisclosure };
  } catch {
    // M39 unavailable — fail safe: redact.
    return { sudDetected: true, redact: true };
  }
}
