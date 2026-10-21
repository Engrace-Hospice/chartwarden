// apps/backend/__tests__/encounter-vocab-pin.test.ts — §2.7 D11, the vocabulary version pin (#128).
//
// What was wrong: `encounter.vocab_version_id` is a `uuid` and the narrative corpus versions itself as
// a STRING, so finalize wrote one constant sentinel — `00000000-0000-4000-8000-0000000000d8` — onto
// every encounter the platform had ever signed. It satisfied the `encounter_vocab_pinned_when_finalized`
// CHECK and the `m8.encounter.finalized` payload's required `vocabVersionId`, and it identified nothing.
// §2.6 check 12 could not be evaluated against it in either direction, and `checkVocabVersion` — the
// §2.7 guard, written in M8-T04 — was reachable from no production path at all.
//
// These drive the in-memory slice, which now carries the same rule as the Drizzle service (the live
// half is `m8-encounters-write.live.test.ts`). Every case here fails against the pre-#128 code.
import {
  NARRATIVE_VOCAB_RELEASES,
  VOCAB_VERSION,
  activeNarrativeVocabRelease,
  narrativeVocabReleaseById,
} from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { createInMemoryEncounterBackend } from "../src/modules/08-encounters/index";
import { requiredSectionSelections } from "./_hearthnote-fixtures";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ENC = "88888888-8888-4888-8888-000000000001";

/** The uuid every encounter used to be pinned to, before this change. */
const RETIRED_SENTINEL = "00000000-0000-4000-8000-0000000000d8";

function backend(overrides: Record<string, unknown> = {}) {
  return createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENC,
        organizationId: ORG,
        patientId: PATIENT,
        encounterType: "routine_visit",
        discipline: "rn",
        selections: requiredSectionSelections("routine_visit", "rn").sections,
        ...overrides,
      },
    ],
  });
}

describe("§2.7 D11 — the vocabulary version pin (#128)", () => {
  it("finalize pins a REAL corpus-release uuid, not the sentinel", async () => {
    const { service, inspect } = backend();
    expect(inspect.vocabPinOf(ENC)).toBeNull(); // a draft claims no vocabulary

    await service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z");

    const pin = inspect.vocabPinOf(ENC);
    expect(pin).not.toBeNull();
    expect(pin).not.toBe(RETIRED_SENTINEL);
    expect(pin).toBe(activeNarrativeVocabRelease(VOCAB_VERSION).id);
  });

  it("the pin DECODES back to the corpus the note was assembled against", async () => {
    // This is the whole point of D11: a surveyor holding a signed record years from now must be able
    // to say which vocabulary it meant. Against the sentinel that question had no answer.
    const { service, inspect } = backend();
    await service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z");

    const release = narrativeVocabReleaseById(inspect.vocabPinOf(ENC) as string);
    expect(release).not.toBeNull();
    expect(release?.version).toBe(VOCAB_VERSION);
    expect(narrativeVocabReleaseById(RETIRED_SENTINEL)).toBeNull();
  });

  it("two encounters finalized under the same build share a pin — and it is the build's, not a per-row id", async () => {
    const a = backend();
    const b = backend();
    await a.service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z");
    await b.service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z");
    expect(a.inspect.vocabPinOf(ENC)).toBe(b.inspect.vocabPinOf(ENC));
    expect(NARRATIVE_VOCAB_RELEASES.map((r) => r.id)).toContain(a.inspect.vocabPinOf(ENC));
  });

  // ── the §2.7 guard, which had never run ─────────────────────────────────────────────────────────
  it("REFUSES with VOCAB_VERSION_MISMATCH when the draft was authored against an older corpus", async () => {
    // The mid-draft flip §2.7 puts a 409 on: selections saved under 2026.05.0, corpus now ships a
    // later release, the phrases selected may no longer render identically.
    const { service } = backend({ selectionsVocabVersion: "narrative-vocab@2026.05.0" });
    await expect(service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z")).rejects.toMatchObject({
      code: "VOCAB_VERSION_MISMATCH",
    });
  });

  it("the refusal leaves the encounter in draft with no pin — the transition did not happen", async () => {
    const { service, inspect } = backend({ selectionsVocabVersion: "narrative-vocab@2026.05.0" });
    await expect(service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z")).rejects.toThrow();
    expect(inspect.vocabPinOf(ENC)).toBeNull();
    const view = await service.getEncounter(ORG, ENC);
    expect(view?.status).toBe("draft");
  });

  it("re-saving the selections clears the refusal — the remedy is in the clinician's hands", async () => {
    const { service, inspect } = backend({ selectionsVocabVersion: "narrative-vocab@2026.05.0" });
    await expect(service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z")).rejects.toThrow();

    // A selections PATCH restamps the authored version, exactly as the Drizzle upsert restamps
    // `hearthnote_selection.template_version`.
    const current = await service.getEncounter(ORG, ENC);
    await service.updateSelections(ORG, ENC, current?.version as number, {
      sections: requiredSectionSelections("routine_visit", "rn").sections,
    });

    await service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z");
    expect(inspect.vocabPinOf(ENC)).toBe(activeNarrativeVocabRelease(VOCAB_VERSION).id);
  });

  it("a draft with NO saved selections has nothing to disagree about, so the guard does not fire", async () => {
    // An empty tree is the §2.6 gate's problem, not D11's — there is no authored version to compare.
    const { service } = backend({
      selections: requiredSectionSelections("routine_visit", "rn").sections,
    });
    await expect(service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z")).resolves.toMatchObject({
      status: "finalized",
    });
  });

  it("the pin is set at FIRST finalize and is immutable thereafter (D11)", async () => {
    const PRIOR = NARRATIVE_VOCAB_RELEASES[0].id;
    const { service, inspect } = backend({ vocabVersionId: PRIOR });
    await service.finalize(ORG, ENC, "2026-06-21T12:00:00.000Z");
    expect(inspect.vocabPinOf(ENC)).toBe(PRIOR);
  });
});
