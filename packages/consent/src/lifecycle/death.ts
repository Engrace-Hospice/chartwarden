// @wardenx/consent — the D13 post-death consent-termination decision (§7.7).
//
// M39-T09 (moved from the backend consumer so the package owns the pure domain). On
// m5.patient.deceased, M39 transitions each active consent that does NOT survive death to `expired`.
// A consent survives death only when (a) it is the post-mortem bereavement consent, or (b) its type
// is survives-death-eligible AND `survives_death=true` at capture. Everything else terminates.
import { CONSENT_TYPE_STRUCTURE, type ConsentTypeKey } from "../interfaces/kinds";

/** True when an active consent of this type terminates on the patient's death (D13). */
export function consentTerminatesOnDeath(typeKey: ConsentTypeKey, survivesDeath: boolean): boolean {
  const s = CONSENT_TYPE_STRUCTURE[typeKey];
  if (s.isPostMortemEligible) return false; // bereavement consent survives
  if (s.survivesDeathEligible && survivesDeath) return false; // explicitly preserved
  return true;
}

/** The ids of the patient's active consents that must transition to `expired` on death (§7.7). */
export function decideDeceasedConsentExpiry(
  consents: readonly {
    id: string;
    typeKey: ConsentTypeKey;
    status: string;
    survivesDeath: boolean;
  }[],
): string[] {
  return consents
    .filter((c) => c.status === "active")
    .filter((c) => consentTerminatesOnDeath(c.typeKey, c.survivesDeath))
    .map((c) => c.id);
}
