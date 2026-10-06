// apps/backend/src/modules/16-bereavement/lifecycle/outreach-encounter.ts — GAP-049 (D15). Completing an
// outreach records WHAT HAPPENED on the scheduled touchpoint; two facts must be verified server-side rather
// than trusted from the body: the kind is the kind the row was scheduled as, and an in-person visit's
// `sourceEncounterId` is a real, signed `bereavement_contact` encounter of THIS patient (M8, via seam).
import type { BereavementEncounterReader, BereavementOutreachKind } from "@wardenx/types";
import { BereavementStateError, require_ } from "./errors";

/** The completion's kind must equal the stored outreach kind (a visit cannot be logged as a phone call). */
export function assertCompletionKindMatchesOutreach(
  storedKind: BereavementOutreachKind | string,
  inputKind: BereavementOutreachKind | string,
): void {
  require_(
    storedKind === inputKind,
    "OUTREACH_KIND_MISMATCH",
    `this outreach was scheduled as ${storedKind}; it cannot be completed as ${inputKind}`,
  );
}

const INVALID =
  "the source encounter could not be verified as a signed bereavement_contact encounter for this patient";

/**
 * Resolve `encounterId` through M8's BereavementEncounterReader: it must exist in the tenant, be a
 * `bereavement_contact` encounter, be signed, and document the plan's patient. Anything else — including an
 * unbound/erroring seam — is refused with 422 (fail closed).
 */
export async function verifySourceEncounter(input: {
  readonly reader: BereavementEncounterReader;
  readonly organizationId: string;
  readonly patientId: string;
  readonly encounterId: string;
}): Promise<void> {
  let facts: Awaited<ReturnType<BereavementEncounterReader["getBereavementEncounterFacts"]>>;
  try {
    facts = await input.reader.getBereavementEncounterFacts({
      organizationId: input.organizationId,
      encounterId: input.encounterId,
    });
  } catch {
    throw new BereavementStateError("SOURCE_ENCOUNTER_INVALID", INVALID);
  }
  require_(
    facts !== null &&
      facts.patientId === input.patientId &&
      facts.isBereavementContact &&
      facts.isSigned,
    "SOURCE_ENCOUNTER_INVALID",
    INVALID,
  );
}
