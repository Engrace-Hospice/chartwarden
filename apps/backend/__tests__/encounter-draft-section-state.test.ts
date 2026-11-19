// S1 PR C2a — `sectionStates` / `unresolvedSections` (VN-D7, VN-D12, design §3.2): which sections still need the
// clinician before signing, decided from the recomputed draft and the stored confirmations.
import { createHash } from "node:crypto";
import { compileDraft } from "@chartwarden/hearthnote";
import type { Draft, DraftInputs } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import {
  type ConfirmationRecord,
  sectionStates,
  unresolvedSections,
} from "../src/modules/08-encounters/drafting/section-state";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CORPUS = "2026.11.0";

const drafted = (sectionId: string, contentHash: string, corpusVersion = CORPUS) =>
  ({
    sectionId,
    state: "drafted",
    text: "Some drafted text.",
    sourceRefs: [{ kind: "vitals", id: "v-1" }],
    part2Derived: false,
    contentHash,
    corpusVersion,
  }) as const;
const empty = (sectionId: string) =>
  ({ sectionId, state: "empty", reason: "nothing_to_draft_from" }) as const;

const draftOf = (...sections: Draft["sections"][number][]): Draft => ({
  templateKey: "routine_visit:rn",
  asOf: "2026-11-18T14:30:00.000Z",
  sections,
});

const confirmation = (over: Partial<ConfirmationRecord> = {}): ConfirmationRecord => ({
  sectionId: "plan",
  resolution: "confirmed",
  contentHash: HASH_A,
  corpusVersion: CORPUS,
  ...over,
});

describe("sectionStates", () => {
  it("marks an empty section not_drafted, even when a confirmation exists for it", () => {
    const states = sectionStates(draftOf(empty("plan")), [confirmation()]);
    expect(states).toEqual([{ sectionId: "plan", state: "not_drafted" }]);
  });

  it("marks a drafted section with no confirmation unresolved", () => {
    expect(sectionStates(draftOf(drafted("plan", HASH_A)), [])).toEqual([
      { sectionId: "plan", state: "unresolved" },
    ]);
  });

  it("marks a drafted section confirmed when hash and corpus match", () => {
    expect(sectionStates(draftOf(drafted("plan", HASH_A)), [confirmation()])).toEqual([
      { sectionId: "plan", state: "confirmed" },
    ]);
  });

  it("marks a drafted section deselected when hash and corpus match", () => {
    const states = sectionStates(draftOf(drafted("plan", HASH_A)), [
      confirmation({ resolution: "deselected" }),
    ]);
    expect(states).toEqual([{ sectionId: "plan", state: "deselected" }]);
  });

  it("needs re-confirmation when the content hash changed", () => {
    const states = sectionStates(draftOf(drafted("plan", HASH_B)), [confirmation()]);
    expect(states).toEqual([{ sectionId: "plan", state: "needs_reconfirmation" }]);
  });

  it("needs re-confirmation after a corpus bump, even with an equal hash", () => {
    const states = sectionStates(draftOf(drafted("plan", HASH_A, "2026.12.0")), [confirmation()]);
    expect(states).toEqual([{ sectionId: "plan", state: "needs_reconfirmation" }]);
  });

  it("needs re-confirmation for a deselected section whose content changed", () => {
    const states = sectionStates(draftOf(drafted("plan", HASH_B)), [
      confirmation({ resolution: "deselected" }),
    ]);
    expect(states).toEqual([{ sectionId: "plan", state: "needs_reconfirmation" }]);
  });

  it("keeps template order and answers one state per draft section", () => {
    const draft = draftOf(
      empty("chief_concern"),
      drafted("vitals_review", HASH_A),
      drafted("plan", HASH_B),
    );
    const states = sectionStates(draft, [confirmation({ sectionId: "vitals_review" })]);
    expect(states.map((s) => [s.sectionId, s.state])).toEqual([
      ["chief_concern", "not_drafted"],
      ["vitals_review", "confirmed"],
      ["plan", "unresolved"],
    ]);
  });

  it("ignores a confirmation for a section the draft does not have", () => {
    const states = sectionStates(draftOf(drafted("plan", HASH_A)), [
      confirmation({ sectionId: "vitals_review" }),
    ]);
    expect(states).toEqual([{ sectionId: "plan", state: "unresolved" }]);
  });

  it("does not mutate the draft or the confirmations", () => {
    const draft = draftOf(drafted("plan", HASH_A));
    const confirmations = [confirmation()];
    const before = JSON.stringify([draft, confirmations]);
    sectionStates(draft, confirmations);
    expect(JSON.stringify([draft, confirmations])).toBe(before);
  });
});

describe("sectionStates over a real compiled draft", () => {
  const deps = {
    sha256Hex: (canonical: string) => createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
  const inputs = (heartRate: number): DraftInputs => ({
    encounterType: "routine_visit",
    discipline: "rn",
    asOf: "2026-11-18T14:30:00.000Z",
    context: { patient: "Patient", serviceDate: "2026-11-18" },
    selection: {
      templateKey: "routine_visit:rn",
      vocabVersion: VOCAB_VERSION,
      encounterType: "routine_visit",
      discipline: "rn",
      sections: [],
    },
    carePlan: null,
    scaleReadings: [],
    vitals: {
      id: "vitals-1",
      recordedAt: "2026-11-18T14:00:00.000Z",
      heartRate,
      sudRelated: false,
    },
    medicationChanges: [],
  });

  const confirmFrom = (draft: Draft): ConfirmationRecord[] =>
    draft.sections.flatMap((s) =>
      s.state === "drafted"
        ? [
            {
              sectionId: s.sectionId,
              resolution: "confirmed" as const,
              contentHash: s.contentHash,
              corpusVersion: s.corpusVersion,
            },
          ]
        : [],
    );

  it("stays confirmed when the same inputs are recomputed", () => {
    const confirmations = confirmFrom(compileDraft(inputs(72), deps));
    const states = sectionStates(compileDraft(inputs(72), deps), confirmations);
    expect(states.find((s) => s.sectionId === "vitals_review")?.state).toBe("confirmed");
  });

  it("goes stale when a source changed after the confirmation", () => {
    const confirmations = confirmFrom(compileDraft(inputs(72), deps));
    const states = sectionStates(compileDraft(inputs(88), deps), confirmations);
    expect(states.find((s) => s.sectionId === "vitals_review")?.state).toBe("needs_reconfirmation");
  });

  it("goes stale when the corpus version differs from the one confirmed against", () => {
    const confirmations = confirmFrom(compileDraft(inputs(72), deps)).map((c) => ({
      ...c,
      corpusVersion: "2025.01.0",
    }));
    const states = sectionStates(compileDraft(inputs(72), deps), confirmations);
    expect(states.find((s) => s.sectionId === "vitals_review")?.state).toBe("needs_reconfirmation");
  });
});

describe("unresolvedSections", () => {
  it("lists unresolved and stale sections with their reason and nothing else", () => {
    const draft = draftOf(
      empty("chief_concern"),
      drafted("vitals_review", HASH_A),
      drafted("assessment", HASH_B),
      drafted("plan", HASH_A),
      drafted("interventions", HASH_A),
    );
    const states = sectionStates(draft, [
      confirmation({ sectionId: "vitals_review" }), // confirmed
      confirmation({ sectionId: "assessment" }), // stale: hash differs
      confirmation({ sectionId: "interventions", resolution: "deselected" }), // deselected
    ]);
    expect(unresolvedSections(states)).toEqual([
      { sectionId: "assessment", reason: "stale" },
      { sectionId: "plan", reason: "unresolved" },
    ]);
  });

  it("is empty when every drafted section is resolved", () => {
    const states = sectionStates(draftOf(empty("plan"), drafted("assessment", HASH_A)), [
      confirmation({ sectionId: "assessment" }),
    ]);
    expect(unresolvedSections(states)).toEqual([]);
  });
});
