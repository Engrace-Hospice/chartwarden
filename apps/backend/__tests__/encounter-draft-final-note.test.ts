// S1 PR C2b2 - the text of a signed note built from the confirmed draft and the clinician's own selections (VN-D7, design 3.2 "Sign"),
// and the sealed per-section rows that must equal it. Pure: fake seams, in-memory store, a reversible fake seal; no database.
import { type SelectionState, assembleLayer1, resolveTemplate } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { type ComputedDraft, computeDraft } from "../src/modules/08-encounters/drafting/compute";
import { finalNoteOf } from "../src/modules/08-encounters/drafting/final-note";
import {
  type ConfirmationRecord,
  sectionStates,
} from "../src/modules/08-encounters/drafting/section-state";
import { sealedSectionRows } from "../src/modules/08-encounters/drafting/signed-sections";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import { NOW, carePlan, change, fakePorts, viewer } from "./_encounter-draft-fixtures";
import { draftEncounterRow } from "./_encounter-draft-memory-store";

const encounter = draftEncounterRow();
const OWN_PLAN = "Family meeting arranged.";
const OWN_CHIEF = "Routine visit per care plan.";

const selection = (over: Partial<SelectionState> = {}): SelectionState => ({
  templateKey: "routine_visit:rn",
  vocabVersion: VOCAB_VERSION,
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    { sectionId: "chief_concern", entries: [], freeText: OWN_CHIEF },
    { sectionId: "assessment", entries: [{ code: "nv.cv.stable" }] },
    { sectionId: "plan", entries: [], freeText: OWN_PLAN },
  ],
  ...over,
});

/** The care plan has a goal (-> `plan`) and an intervention (-> `interventions`); one medication change -> `interventions`. */
async function draftOf(sel: SelectionState = selection()): Promise<ComputedDraft> {
  const ports = fakePorts({
    carePlanAsOf: async () => carePlan(),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a", isSudTreatment: true }),
    ],
    previousSignedVisitAt: async () => new Date("2026-11-10T15:00:00.000Z"),
    loadSelection: async () => ({
      selection: sel,
      context: { patient: "Patient", serviceDate: "2026-11-18" },
    }),
    part2DisclosureAllowed: async () => true,
  });
  return computeDraft(ports, encounter, viewer(), NOW);
}

const hashOf = (computed: ComputedDraft, sectionId: string) => {
  const section = computed.draft.sections.find((s) => s.sectionId === sectionId);
  if (section?.state !== "drafted") throw new Error(`section ${sectionId} is not drafted`);
  return section;
};

const resolution = (
  computed: ComputedDraft,
  sectionId: string,
  how: "confirmed" | "deselected",
): ConfirmationRecord => {
  const section = hashOf(computed, sectionId);
  return {
    sectionId,
    resolution: how,
    contentHash: section.contentHash,
    corpusVersion: section.corpusVersion,
  };
};

const statesOf = (computed: ComputedDraft, confirmations: readonly ConfirmationRecord[]) =>
  sectionStates(computed.draft, confirmations);

const blockOf = (note: ReturnType<typeof finalNoteOf>, sectionId: string) =>
  note.sections.find((s) => s.sectionId === sectionId);

describe("finalNoteOf: what the signed note says", () => {
  it("a confirmed section carries the confirmed draft text, drafted sentences and the clinician's own words", async () => {
    const computed = await draftOf();
    const plan = hashOf(computed, "plan");
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    expect(blockOf(note, "plan")?.text).toBe(`Plan and Next Visit\n${plan.text}`);
    expect(plan.text).toContain(OWN_PLAN);
    expect(plan.text).toContain("Pain controlled at an acceptable level");
  });

  it("a deselected section keeps the clinician's own words and none of the drafted sentences", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "deselected"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    expect(blockOf(note, "plan")?.text).toBe(`Plan and Next Visit\n${OWN_PLAN}`);
    expect(note.narrative).not.toContain("Pain controlled at an acceptable level");
  });

  it("a deselected section with nothing of the clinician's own contributes no block at all", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "deselected"),
      ]),
    );
    expect(blockOf(note, "interventions")).toBeUndefined();
    expect(note.narrative).not.toContain("Repositioning schedule review");
    expect(note.narrative).not.toContain("Morphine sulfate");
  });

  it("the note is Part 2 derived exactly when a confirmed section carries the compiler's fail-closed flag (what the pin records)", async () => {
    const computed = await draftOf(); // `interventions` holds a SUD medication change, so the compiler flags it
    const confirmedBoth = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    expect(blockOf(confirmedBoth, "interventions")?.part2Derived).toBe(true);
    expect(confirmedBoth.part2Derived).toBe(true);
    // Deselected, the SUD-derived sentences are in neither the text nor the flag.
    const deselected = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "deselected"),
      ]),
    );
    expect(deselected.part2Derived).toBe(false);
  });

  it("a section that was not drafted is the clinician's selections as Layer 1 renders them", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    expect(blockOf(note, "chief_concern")?.text).toBe(`Reason for Visit\n${OWN_CHIEF}`);
    expect(blockOf(note, "chief_concern")?.sourceRefs).toEqual([]);
    expect(blockOf(note, "chief_concern")?.part2Derived).toBe(false);
  });

  it("the sections are in template order with consecutive positions, and the narrative is the blocks joined by a blank line", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    const template = resolveTemplate("routine_visit", "rn");
    const order = template?.sections.map((s) => s.id) ?? [];
    const ids = note.sections.map((s) => s.sectionId);
    expect(ids).toEqual(order.filter((id) => ids.includes(id)));
    expect(note.sections.map((s) => s.position)).toEqual(note.sections.map((_, i) => i));
    expect(note.narrative).toBe(note.sections.map((s) => s.text).join("\n\n"));
  });

  it("a confirmed section keeps its source ids and kinds and its fail-closed Part 2 flag; text never leaks into the refs", async () => {
    const computed = await draftOf();
    const interventions = hashOf(computed, "interventions");
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    const block = blockOf(note, "interventions");
    expect(block?.sourceRefs).toEqual(interventions.sourceRefs);
    expect(block?.part2Derived).toBe(true); // the SUD-treatment medication change
    expect(JSON.stringify(block?.sourceRefs)).not.toContain("Morphine");
  });

  it("a deselected section is no longer derived from any source, so it is not Part 2 and carries no source ids", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "deselected"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    const block = blockOf(note, "plan");
    expect(block?.sourceRefs).toEqual([]);
    expect(block?.part2Derived).toBe(false);
  });

  it("with nothing drafted the note is exactly what Layer 1 assembles from the selections", async () => {
    const ports = fakePorts({
      loadSelection: async () => ({
        selection: selection(),
        context: { patient: "Patient", serviceDate: "2026-11-18" },
      }),
    });
    const computed = await computeDraft(ports, encounter, viewer(), NOW);
    const note = finalNoteOf(computed, statesOf(computed, []));
    const template = resolveTemplate("routine_visit", "rn");
    if (template === undefined) throw new Error("no template");
    expect(note.narrative).toBe(assembleLayer1(template, selection(), computed.context).narrative);
  });

  it("refuses a section that is unresolved or no longer matches its confirmation, naming it", async () => {
    const computed = await draftOf();
    const unresolved = statesOf(computed, [resolution(computed, "plan", "confirmed")]);
    expect(() => finalNoteOf(computed, unresolved)).toThrow(
      expect.objectContaining({ code: "DRAFT_SECTION_STALE" }),
    );
    const stale = statesOf(computed, [
      { ...resolution(computed, "plan", "confirmed"), contentHash: "0".repeat(64) },
      resolution(computed, "interventions", "confirmed"),
    ]);
    try {
      finalNoteOf(computed, stale);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EncounterStateError);
      expect((error as EncounterStateError).details?.map((d) => d.field)).toEqual(["plan"]);
    }
  });
});

describe("sealedSectionRows: the rows are the note, sealed", () => {
  const seal = async (text: string) => `sealed:${Buffer.from(text).toString("base64url")}`;
  const unseal = (cipher: string) =>
    Buffer.from(cipher.replace(/^sealed:/, ""), "base64url").toString();

  it("concatenating the unsealed rows in order reproduces the narrative", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "deselected"),
      ]),
    );
    const rows = await sealedSectionRows(note, seal);
    const ordered = [...rows].sort((a, b) => a.position - b.position);
    expect(ordered.map((r) => unseal(r.textCipher)).join("\n\n")).toBe(note.narrative);
    expect(rows.map((r) => r.position)).toEqual(note.sections.map((s) => s.position));
  });

  it("each row hashes the text it seals, and holds ids and kinds only", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    const rows = await sealedSectionRows(note, seal);
    for (const row of rows) {
      const { createHash } = await import("node:crypto");
      expect(row.contentHash).toBe(
        createHash("sha256").update(unseal(row.textCipher), "utf8").digest("hex"),
      );
      expect(row.textCipher).not.toContain("Repositioning");
      for (const ref of row.sourceRefs) expect(Object.keys(ref).sort()).toEqual(["id", "kind"]);
    }
    expect(rows.find((r) => r.sectionId === "interventions")?.part2Derived).toBe(true);
    expect(rows.find((r) => r.sectionId === "chief_concern")?.part2Derived).toBe(false);
  });

  it("a seal that fails fails the whole set: no partial rows", async () => {
    const computed = await draftOf();
    const note = finalNoteOf(
      computed,
      statesOf(computed, [
        resolution(computed, "plan", "confirmed"),
        resolution(computed, "interventions", "confirmed"),
      ]),
    );
    let calls = 0;
    const flaky = async (text: string) => {
      calls += 1;
      if (calls === 2) throw new Error("the key ring is unreachable");
      return seal(text);
    };
    await expect(sealedSectionRows(note, flaky)).rejects.toThrow("the key ring is unreachable");
  });
});
