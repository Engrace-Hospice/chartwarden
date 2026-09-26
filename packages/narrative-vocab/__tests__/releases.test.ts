// The D11 release registry (#128). These are small assertions guarding a large claim: that the uuid on
// a signed encounter still names the corpus that encounter was assembled against, years later.
import { describe, expect, it } from "vitest";
import {
  NARRATIVE_VOCAB_RELEASES,
  UnregisteredNarrativeVocabRelease,
  VOCAB_VERSION,
  activeNarrativeVocabRelease,
  narrativeVocabReleaseById,
} from "../src/index";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("narrative-vocab D11 release registry (#128)", () => {
  // THE DRIFT GUARD. Bumping VOCAB_VERSION without appending a release row is the one mistake that
  // reintroduces the sentinel: finalize would throw for every encounter, or (with a fallback, which is
  // why there isn't one) pin a stale id. This test is what makes that a red build rather than an
  // outage.
  it("VOCAB_VERSION has a registered release", () => {
    expect(() => activeNarrativeVocabRelease(VOCAB_VERSION)).not.toThrow();
    expect(activeNarrativeVocabRelease(VOCAB_VERSION).version).toBe(VOCAB_VERSION);
  });

  it("every release id is a well-formed uuid", () => {
    for (const r of NARRATIVE_VOCAB_RELEASES) expect(r.id).toMatch(UUID_RE);
  });

  it("ids and versions are both unique — a reused id would merge two corpora on every historical read", () => {
    const ids = NARRATIVE_VOCAB_RELEASES.map((r) => r.id);
    const versions = NARRATIVE_VOCAB_RELEASES.map((r) => r.version);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("no release carries the retired sentinel uuid", () => {
    // `VOCAB_VERSION_SENTINEL` — the one constant every encounter used to be pinned to. If it ever
    // reappears as a release id, every historical sentinel row silently becomes 'a real pin'.
    const RETIRED_SENTINEL = "00000000-0000-4000-8000-0000000000d8";
    expect(NARRATIVE_VOCAB_RELEASES.some((r) => r.id === RETIRED_SENTINEL)).toBe(false);
  });

  it("an unregistered version REFUSES rather than falling back to a placeholder", () => {
    expect(() => activeNarrativeVocabRelease("narrative-vocab@9999.99.9")).toThrow(
      UnregisteredNarrativeVocabRelease,
    );
  });

  it("a pin decodes back to its release, and an unknown pin decodes to null (never a guess)", () => {
    const active = activeNarrativeVocabRelease(VOCAB_VERSION);
    expect(narrativeVocabReleaseById(active.id)).toEqual(active);
    expect(narrativeVocabReleaseById("00000000-0000-4000-8000-0000000000d8")).toBeNull();
  });

  it("releasedOn is an ISO date on every row", () => {
    for (const r of NARRATIVE_VOCAB_RELEASES) expect(r.releasedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
