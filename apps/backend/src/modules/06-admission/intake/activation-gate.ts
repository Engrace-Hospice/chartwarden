// apps/backend/src/modules/06-admission/intake/activation-gate.ts — M6-T07 the R-AC-01 admission
// activation gate (§7.2 W-AD-05; screen §5.2.5). PURE: given the period-1 bundle facts, decide
// whether `POST /admissions/:id/activate` (route 14) may proceed and, if not, WHICH preconditions are
// unmet (the §4.2.2 `412 PRECONDITION_FAILED { missing }` codes). One function is the single source of
// truth for BOTH the server-side gate (`activateAdmission`) and the read-back checklist on the
// admission aggregate (route 10), so the §5.2.5 UI checklist and the server can never diverge (§7.2
// "Done means" — the gate is verified by re-fetch after out-of-band mutation).

/** The §4.2.2 precondition codes the activation gate reports as unmet. */
export type ActivationGap = "election_signed" | "nor_acknowledged" | "cti_signed" | "attending_signed";

/** Period-1 bundle facts the gate decides over (loaded org-scoped; never from client input). */
export interface ActivationFacts {
  /** The benefit-period sequence being activated; the attending signature gates period 1 only (D3). */
  readonly periodSequence: number;
  readonly electionSigned: boolean;
  readonly norAcknowledged: boolean;
  readonly ctiHospiceMdSigned: boolean;
  readonly ctiAttendingSigned: boolean;
}

/** The gate verdict: `ready` to activate, plus the ordered list of still-missing preconditions. */
export interface ActivationGate {
  readonly ready: boolean;
  readonly missing: readonly ActivationGap[];
}

/**
 * R-AC-01 — an admission activates only when, for period 1: the election statement is signed, the NOR
 * is acknowledged, and the CTI is signed by the hospice medical director. The attending-physician CTI
 * signature is required for **period 1 only** (D3); periods ≥2 do not gate on it. The order of
 * `missing` matches the §5.2.5 checklist top-to-bottom so the UI can render server truth verbatim.
 */
export function computeActivationGate(facts: ActivationFacts): ActivationGate {
  const missing: ActivationGap[] = [];
  if (!facts.electionSigned) missing.push("election_signed");
  if (!facts.norAcknowledged) missing.push("nor_acknowledged");
  if (!facts.ctiHospiceMdSigned) missing.push("cti_signed");
  if (facts.periodSequence === 1 && !facts.ctiAttendingSigned) missing.push("attending_signed");
  return { ready: missing.length === 0, missing };
}
