// @chartwarden/terminology — platform seed corpus (M38-T08, spec §3.9, §7.8).
//
// The typed, deterministic source of truth a seed runner inserts into `code_system`, `value_set`,
// and `value_set_member` at Phase-1 bootstrap. Kept as pure data in the package (the same place the
// resolution/expansion engines live) so it can be unit-asserted without live infra and reused by
// the boot slice. CPT stays unreachable until D4: the catalog is keyed by {@link CodeSystemId}
// (§7.8), so no CPT row can be added here without first widening the enum.

import type { ExpansionMember } from "../interfaces/kinds";
import type { InMemoryTerminologySeed } from "../provider";

export {
  PLATFORM_CODE_SYSTEMS,
  type PlatformCodeSystemSeed,
  type CodeSystemLicenseSource,
} from "./code-systems";
export { PLATFORM_VALUE_SETS, type PlatformValueSetSeed } from "./value-sets";
export {
  PLATFORM_VALUE_SET_MEMBERS,
  type PlatformValueSetMemberSeed,
} from "./value-set-members";

export {
  SUD_TEST_LOINC_ENTRIES,
  SUD_TEST_LOINC_VALUE_SET_ID,
  type SudTestLoincEntry,
} from "./sud-test-loinc";

import { PLATFORM_VALUE_SET_MEMBERS } from "./value-set-members";
import { PLATFORM_VALUE_SETS } from "./value-sets";

/** Canonical FHIR-style url for a platform value set (§7.9 metadata). */
export function platformValueSetUrl(valueSetId: string): string {
  return `urn:chartwarden:valueset:${valueSetId}`;
}

/**
 * Project the seed corpus into the {@link InMemoryTerminologySeed} the boot-slice store consumes —
 * the curated value-set members (as platform `ExpansionMember`s) plus each value set's canonical
 * url. Lets the in-memory provider answer `expand`/`isMemberOf`/`asFhirValueSet` against the real
 * seed without the Drizzle store, and gives the integration test a faithful end-to-end path.
 */
export function toInMemorySeed(): InMemoryTerminologySeed {
  const valueSetMembers: ReadonlyArray<{ valueSetId: string } & ExpansionMember> =
    PLATFORM_VALUE_SET_MEMBERS.map((m) => ({
      valueSetId: m.valueSetId,
      systemId: m.systemId,
      code: m.code,
      display: m.display,
      annotations: { source: "platform" },
    }));

  const valueSetUrls: Record<string, string> = {};
  for (const vs of PLATFORM_VALUE_SETS) valueSetUrls[vs.id] = platformValueSetUrl(vs.id);

  return { valueSetMembers, valueSetUrls };
}
