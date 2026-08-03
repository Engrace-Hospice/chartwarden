// apps/backend/src/modules/29-external-interfaces/inbound — LOINC terminology gate (M29-T05, §1 D-terminology).
// Injected over a narrow `LabTerminologyPort` — the M38 `TerminologyProvider` is OPAQUE (`unknown`) in the
// leaf `@wardenx/types` and M29 carries no `38` dependsOn edge (ADR-0005: seam consumers are edge-free), so
// this file defines the minimal port it needs and the T08 boot wiring adapts the real M38 seam to it. Same
// shape as the T04 cascade's injected `PatientReader`: no DB, no clock, a fail-fast contract.
//
// D-terminology (§1, "Clinical Terminology"): every inbound OBX-3 LOINC is validated against the M38 catalog
// as of the observation date. An unknown code does NOT drop the observation — the lab is authoritative for
// the test name even when LOINC mapping lags — it lands with `terminology_validation='unknown_code'` and the
// caller routes an M36 alert to the tenant terminology administrator. Downstream FHIR (M28) + HQRP (M30)
// filter on `='valid'`. M38 unavailable ⇒ fail CLOSED to `unknown_code` (never a false `valid`).
import type { LabTerminologyValidation } from "@wardenx/types";

/** The narrow slice of M38's `TerminologyProvider` the lab gate needs (adapted from the real seam at T08). */
export interface LabTerminologyPort {
  /** Validate a LOINC code as of a date. `exists=false` ⇒ unknown; `deprecated=true` ⇒ retired-but-known. */
  validateLoinc(input: {
    code: string;
    asOfDate: string;
  }): Promise<{ readonly exists: boolean; readonly deprecated?: boolean }>;
}

/** A single OBX-3 code the gate checks (the projection carries more; the gate needs only the code). */
export interface TerminologyCheckInput {
  readonly loincCode: string;
}

/**
 * Classify the observation-level {@link LabTerminologyValidation} across all OBX-3 codes:
 *   unknown_code — any code is absent/empty or the lookup failed (fail-closed),
 *   deprecated   — no unknowns, but at least one code is retired-but-known,
 *   valid        — every code resolves and is current.
 */
export async function classifyObservationTerminology(
  codes: readonly TerminologyCheckInput[],
  asOfDate: string,
  port: LabTerminologyPort,
): Promise<LabTerminologyValidation> {
  let anyUnknown = false;
  let anyDeprecated = false;

  for (const { loincCode } of codes) {
    const code = loincCode.trim();
    if (code === "") {
      anyUnknown = true;
      continue;
    }
    try {
      const result = await port.validateLoinc({ code, asOfDate });
      if (!result.exists) anyUnknown = true;
      else if (result.deprecated) anyDeprecated = true;
    } catch {
      // M38 unavailable — fail closed: treat as unknown (never forge a `valid`).
      anyUnknown = true;
    }
  }

  if (anyUnknown) return "unknown_code";
  if (anyDeprecated) return "deprecated";
  return "valid";
}
