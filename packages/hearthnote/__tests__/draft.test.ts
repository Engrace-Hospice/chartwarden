// packages/hearthnote/__tests__/draft.test.ts — behavior of the pure visit-note draft compiler
// (S1 PR B, ADR-0114): determinism, immutability, the empty-section rule, fail-closed Part 2, content
// hashing, as-of filtering, and input validation.
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Draft,
  type DraftDeps,
  DraftInputError,
  type DraftInputs,
  type DraftSection,
  HearthnoteAssemblyError,
  compileDraft,
  resolveTemplate,
} from "../src/index";
import { DEPS, baseInputs, deepFreeze, reverseKeys } from "./_draft-fixtures";

function section(draft: Draft, id: string): DraftSection {
  const found = draft.sections.find((s) => s.sectionId === id);
  if (found === undefined) throw new Error(`no section '${id}' in the draft`);
  return found;
}

function hashes(draft: Draft): Record<string, string | null> {
  return Object.fromEntries(
    draft.sections.map((s) => [s.sectionId, s.state === "drafted" ? s.contentHash : null]),
  );
}

function part2(draft: Draft, id: string): boolean {
  const s = section(draft, id);
  if (s.state !== "drafted") throw new Error(`section '${id}' is empty`);
  return s.part2Derived;
}

afterEach(() => vi.restoreAllMocks());

describe("determinism", () => {
  it("returns deep-equal, hash-equal output for the same inputs, with no clock or randomness", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("compileDraft must not read the clock");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("compileDraft must not use randomness");
    });
    const a = compileDraft(baseInputs(), DEPS);
    const b = compileDraft(baseInputs(), DEPS);
    expect(b).toEqual(a);
    expect(hashes(b)).toEqual(hashes(a));
  });

  it("does not depend on the key order of the input", () => {
    const a = compileDraft(baseInputs(), DEPS);
    const b = compileDraft(reverseKeys(baseInputs()), DEPS);
    expect(b).toEqual(a);
  });

  it("does not depend on the order sources arrive in", () => {
    const inputs = baseInputs();
    const shuffled: DraftInputs = {
      ...inputs,
      carePlan: inputs.carePlan && {
        goals: [...inputs.carePlan.goals].reverse(),
        interventions: [...inputs.carePlan.interventions].reverse(),
      },
      scaleReadings: [...inputs.scaleReadings].reverse(),
    };
    expect(compileDraft(shuffled, DEPS)).toEqual(compileDraft(inputs, DEPS));
  });
});

describe("immutability", () => {
  it("compiles from deep-frozen inputs without throwing and leaves them unchanged", () => {
    const before = structuredClone(baseInputs());
    const frozen = deepFreeze(baseInputs());
    expect(() => compileDraft(frozen, DEPS)).not.toThrow();
    expect(frozen).toEqual(before);
  });
});

describe("a section with no source stays empty (VN-D9)", () => {
  const EMPTY_KEYS = ["reason", "sectionId", "state"];

  it("carries no text and no default phrase, even when the clinician selected phrases for it", () => {
    const s = section(compileDraft(baseInputs(), DEPS), "chief_concern");
    expect(Object.keys(s).sort()).toEqual(EMPTY_KEYS);
    expect(s).toMatchObject({ state: "empty", reason: "nothing_to_draft_from" });
  });

  it("leaves every section empty when there are no sources at all", () => {
    const draft = compileDraft(
      { ...baseInputs(), carePlan: null, scaleReadings: [], vitals: null, medicationChanges: [] },
      DEPS,
    );
    expect(draft.sections.map((x) => x.sectionId)).toEqual(
      resolveTemplate("routine_visit", "rn")?.sections.map((x) => x.id),
    );
    for (const s of draft.sections) {
      expect(Object.keys(s).sort()).toEqual(EMPTY_KEYS);
    }
  });

  it("treats a care plan with no goals as no source for plan", () => {
    const draft = compileDraft(
      { ...baseInputs(), carePlan: { goals: [], interventions: [] } },
      DEPS,
    );
    expect(section(draft, "plan").state).toBe("empty");
    expect(section(draft, "interventions").state).toBe("drafted"); // medication change still feeds it
  });

  it("treats a vitals record with no values as no source", () => {
    const draft = compileDraft(
      {
        ...baseInputs(),
        vitals: { id: "vitals-empty", recordedAt: "2026-11-18T14:05:00Z", sudRelated: false },
      },
      DEPS,
    );
    expect(section(draft, "vitals_review").state).toBe("empty");
  });

  it("ignores a lone systolic or a temperature without a unit (a partial pair is not a reading)", () => {
    const base = baseInputs();
    const draft = compileDraft(
      {
        ...base,
        vitals: {
          id: "vitals-partial",
          recordedAt: "2026-11-18T14:05:00Z",
          bpSystolic: 118,
          temperature: "98.6",
          sudRelated: false,
        },
      },
      DEPS,
    );
    expect(section(draft, "vitals_review").state).toBe("empty");
  });

  it("does not draft a scale it has no phrase for", () => {
    const base = baseInputs();
    const draft = compileDraft(
      {
        ...base,
        scaleReadings: [
          {
            id: "scale-kps",
            scaleType: "kps",
            value: 40,
            recordedAt: "2026-11-18T14:00:00Z",
            sudRelated: false,
          },
        ],
      },
      DEPS,
    );
    expect(section(draft, "assessment").state).toBe("empty");
    expect(section(draft, "symptom_management").state).toBe("empty");
  });

  it("drops vitals when the template has no vitals section (telephonic)", () => {
    const base = baseInputs();
    const draft = compileDraft(
      {
        ...base,
        encounterType: "telephonic",
        selection: { ...base.selection, templateKey: "telephonic:rn", encounterType: "telephonic" },
      },
      DEPS,
    );
    expect(draft.sections.map((s) => s.sectionId)).not.toContain("vitals_review");
  });
});

describe("Part 2 fails closed", () => {
  it("is false only when every source behind the section is explicitly not SUD-related", () => {
    const draft = compileDraft(baseInputs(), DEPS);
    for (const id of [
      "vitals_review",
      "assessment",
      "symptom_management",
      "interventions",
      "plan",
    ]) {
      expect(part2(draft, id), id).toBe(false);
    }
  });

  it.each([
    ["true", true],
    ["undefined", undefined],
    ["null", null],
    ["the string 'false'", "false"],
    ["0", 0],
  ])("counts a source whose sudRelated is %s as Part 2", (_label, value) => {
    const inputs = baseInputs();
    const vitals = inputs.vitals;
    if (vitals === null) throw new Error("fixture has vitals");
    const draft = compileDraft(
      { ...inputs, vitals: { ...vitals, sudRelated: value as never } },
      DEPS,
    );
    expect(part2(draft, "vitals_review")).toBe(true);
    expect(part2(draft, "plan")).toBe(false); // an unrelated section is unaffected
  });

  it("is true when one source of several is Part 2", () => {
    const inputs = baseInputs();
    const draft = compileDraft(
      {
        ...inputs,
        medicationChanges: inputs.medicationChanges.map((m) => ({ ...m, sudRelated: true })),
      },
      DEPS,
    );
    expect(part2(draft, "interventions")).toBe(true);
  });

  it("is true when a source omits the flag entirely", () => {
    const inputs = baseInputs();
    const goals = (inputs.carePlan?.goals ?? []).map(({ sudRelated: _omitted, ...rest }) => rest);
    const draft = compileDraft(
      { ...inputs, carePlan: { goals, interventions: inputs.carePlan?.interventions ?? [] } },
      DEPS,
    );
    expect(part2(draft, "plan")).toBe(true);
  });

  it("does not let the clinician's own selections change the flag", () => {
    const inputs = baseInputs();
    const plain = compileDraft(inputs, DEPS);
    const withFreeText = compileDraft(
      {
        ...inputs,
        selection: {
          ...inputs.selection,
          sections: [{ sectionId: "plan", entries: [], freeText: "Clinician note." }],
        },
      },
      DEPS,
    );
    expect(part2(withFreeText, "plan")).toBe(part2(plain, "plan"));
  });
});

describe("contentHash", () => {
  /** Each case changes ONE source value and names the one section whose hash must move. */
  const mutations: ReadonlyArray<readonly [string, string, (i: DraftInputs) => DraftInputs]> = [
    [
      "goal text",
      "plan",
      (i) => withGoal(i, { goalText: "Caregiver demonstrates safe transfers" }),
    ],
    [
      "goal progress statement",
      "plan",
      (i) => withGoal(i, { progressStatement: "No change since the last visit" }),
    ],
    ["goal id", "plan", (i) => withGoal(i, { id: "goal-z" })],
    [
      "intervention text",
      "interventions",
      (i) => withIntervention(i, { interventionText: "Teaching on turning schedule" }),
    ],
    ["PPS value", "assessment", (i) => withScale(i, "scale-pps-2", { value: 40 })],
    [
      "PPS previous value",
      "assessment",
      (i) => withScale(i, "scale-pps-2", { previous: { value: 70, recordedOn: "2026-11-10" } }),
    ],
    [
      "PPS previous date",
      "assessment",
      (i) => withScale(i, "scale-pps-2", { previous: { value: 60, recordedOn: "2026-11-09" } }),
    ],
    ["ESAS value", "symptom_management", (i) => withScale(i, "scale-esas-pain", { value: 7 })],
    [
      "ESAS label",
      "symptom_management",
      (i) => withScale(i, "scale-esas-pain", { label: "nausea" }),
    ],
    ["vitals value", "vitals_review", (i) => withVitals(i, { heartRate: 73 })],
    ["vitals source id", "vitals_review", (i) => withVitals(i, { id: "vitals-2" })],
    [
      "medication change kind",
      "interventions",
      (i) => withMedication(i, { change: "discontinued" }),
    ],
    [
      "medication change date",
      "interventions",
      (i) => withMedication(i, { changedOn: "2026-11-13" }),
    ],
    ["medication name", "interventions", (i) => withMedication(i, { drugName: "lorazepam" })],
    ["Part 2 flag", "vitals_review", (i) => withVitals(i, { sudRelated: true })],
    [
      "clinician free text in a drafted section",
      "plan",
      (i) => ({
        ...i,
        selection: {
          ...i.selection,
          sections: [
            ...i.selection.sections,
            { sectionId: "plan", entries: [], freeText: "Discussed with family." },
          ],
        },
      }),
    ],
  ];

  it.each(mutations)("changes with the %s, and only in %s", (_name, sectionId, mutate) => {
    const before = hashes(compileDraft(baseInputs(), DEPS));
    const after = hashes(compileDraft(mutate(baseInputs()), DEPS));
    for (const id of Object.keys(before)) {
      if (id === sectionId) expect(after[id], id).not.toBe(before[id]);
      else expect(after[id], id).toBe(before[id]);
    }
  });

  it("is a 64-character lowercase hex digest", () => {
    const s = section(compileDraft(baseInputs(), DEPS), "plan");
    expect(s.state === "drafted" && s.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same for the same text under key reordering of the input", () => {
    expect(hashes(compileDraft(reverseKeys(baseInputs()), DEPS))).toEqual(
      hashes(compileDraft(baseInputs(), DEPS)),
    );
  });

  it("stamps each drafted section with the active corpus version", () => {
    for (const s of compileDraft(baseInputs(), DEPS).sections) {
      if (s.state === "drafted") expect(s.corpusVersion).toBe(VOCAB_VERSION);
    }
  });

  it("refuses a hash function that does not return a SHA-256 hex digest", () => {
    const bad: DraftDeps = { sha256Hex: () => "not-a-digest" };
    expect(() => compileDraft(baseInputs(), bad)).toThrow(DraftInputError);
  });
});

describe("changes since the last visit come from structured fields only (VN-D6)", () => {
  it("never renders text carried on a previous reading or on the inputs", () => {
    const inputs = baseInputs();
    const smuggled = {
      ...inputs,
      priorNoteText: "COPIED FROM LAST NOTE",
      scaleReadings: inputs.scaleReadings.map((r) =>
        r.previous ? { ...r, previous: { ...r.previous, text: "COPIED FROM LAST NOTE" } } : r,
      ),
    };
    const rendered = JSON.stringify(compileDraft(smuggled as DraftInputs, DEPS));
    expect(rendered).not.toContain("COPIED FROM LAST NOTE");
  });

  it("states direction from the numbers: up, down, unchanged, or no earlier reading", () => {
    const base = baseInputs();
    const read = (value: number, previous: number | null) =>
      compileDraft(
        {
          ...base,
          scaleReadings: [
            {
              id: "scale-pps-x",
              scaleType: "pps",
              value,
              recordedAt: "2026-11-18T14:10:00Z",
              previous: previous === null ? null : { value: previous, recordedOn: "2026-11-10" },
              sudRelated: false,
            },
          ],
          selection: { ...base.selection, sections: [] },
        },
        DEPS,
      );
    const text = (d: Draft) => {
      const s = section(d, "assessment");
      return s.state === "drafted" ? s.text : "";
    };
    expect(text(read(60, 50))).toBe("PPS 60%, up from 50% on 2026-11-10.");
    expect(text(read(50, 60))).toBe("PPS 50%, down from 60% on 2026-11-10.");
    expect(text(read(50, 50))).toBe("PPS 50%, unchanged from 50% on 2026-11-10.");
    expect(text(read(50, null))).toBe("PPS 50%, no earlier reading recorded.");
  });
});

describe("as-of the visit time (VN-D11)", () => {
  it("excludes a source recorded after asOf and keeps one recorded exactly at asOf", () => {
    const inputs = baseInputs();
    const vitals = inputs.vitals;
    if (vitals === null) throw new Error("fixture has vitals");
    const late = compileDraft(
      { ...inputs, vitals: { ...vitals, recordedAt: "2026-11-18T14:30:01Z" } },
      DEPS,
    );
    expect(section(late, "vitals_review").state).toBe("empty");
    const exact = compileDraft(
      { ...inputs, vitals: { ...vitals, recordedAt: "2026-11-18T14:30:00Z" } },
      DEPS,
    );
    expect(section(exact, "vitals_review").state).toBe("drafted");
  });

  it("compares instants, not strings, so a zone offset is honoured", () => {
    const inputs = baseInputs();
    const vitals = inputs.vitals;
    if (vitals === null) throw new Error("fixture has vitals");
    // 09:45-05:00 is 14:45Z, after the 14:30Z visit time.
    const draft = compileDraft(
      { ...inputs, vitals: { ...vitals, recordedAt: "2026-11-18T09:45:00-05:00" } },
      DEPS,
    );
    expect(section(draft, "vitals_review").state).toBe("empty");
  });

  it("excludes a medication change and a scale reading made after asOf", () => {
    const inputs = baseInputs();
    const draft = compileDraft(
      {
        ...inputs,
        scaleReadings: inputs.scaleReadings.map((r) => ({
          ...r,
          recordedAt: "2026-11-19T08:00:00Z",
        })),
        medicationChanges: inputs.medicationChanges.map((m) => ({
          ...m,
          changedAt: "2026-11-19T08:00:00Z",
        })),
        carePlan: null,
      },
      DEPS,
    );
    expect(section(draft, "assessment").state).toBe("empty");
    expect(section(draft, "symptom_management").state).toBe("empty");
    expect(section(draft, "interventions").state).toBe("empty");
  });
});

describe("input validation", () => {
  it("rejects an asOf that is not an ISO instant with a zone", () => {
    expect(() => compileDraft({ ...baseInputs(), asOf: "2026-11-18T14:30:00" }, DEPS)).toThrow(
      DraftInputError,
    );
    expect(() => compileDraft({ ...baseInputs(), asOf: "yesterday" }, DEPS)).toThrow(
      DraftInputError,
    );
  });

  it("rejects an ESAS-r reading with no label", () => {
    const inputs = baseInputs();
    const readings = inputs.scaleReadings.map((r) =>
      r.scaleType === "esas_r" ? { ...r, label: "" } : r,
    );
    expect(() => compileDraft({ ...inputs, scaleReadings: readings }, DEPS)).toThrow(
      DraftInputError,
    );
  });

  it("rejects a non-finite scale value and a malformed previous date", () => {
    const inputs = baseInputs();
    const bad = (patch: object) =>
      compileDraft(
        { ...inputs, scaleReadings: [{ ...inputs.scaleReadings[0], ...patch } as never] },
        DEPS,
      );
    expect(() => bad({ value: Number.NaN })).toThrow(DraftInputError);
    expect(() => bad({ previous: { value: 60, recordedOn: "10 Nov" } })).toThrow(DraftInputError);
  });

  it("rejects a date that matches the pattern but is not on the calendar (it would compile into a sentence with a valid hash)", () => {
    const inputs = baseInputs();
    const withPrevious = (recordedOn: string) =>
      compileDraft(
        {
          ...inputs,
          scaleReadings: [
            { ...inputs.scaleReadings[0], previous: { value: 60, recordedOn } } as never,
          ],
        },
        DEPS,
      );
    for (const impossible of ["2026-13-45", "2026-02-30", "2026-00-10", "2026-11-31"]) {
      expect(() => withPrevious(impossible), impossible).toThrow(DraftInputError);
    }
    expect(() =>
      compileDraft(
        {
          ...inputs,
          medicationChanges: [{ ...inputs.medicationChanges[0], changedOn: "2026-13-45" } as never],
        },
        DEPS,
      ),
    ).toThrow(DraftInputError);
    expect(() => withPrevious("2028-02-29")).not.toThrow();
  });

  it("rejects an unknown temperature unit and a non-numeric temperature", () => {
    const inputs = baseInputs();
    const vitals = inputs.vitals;
    if (vitals === null) throw new Error("fixture has vitals");
    expect(() =>
      compileDraft({ ...inputs, vitals: { ...vitals, temperatureUnit: "k" as never } }, DEPS),
    ).toThrow(DraftInputError);
    expect(() =>
      compileDraft({ ...inputs, vitals: { ...vitals, temperature: "warm" } }, DEPS),
    ).toThrow(DraftInputError);
  });

  it("rejects a blank goal, intervention or drug name", () => {
    const inputs = baseInputs();
    expect(() =>
      compileDraft(
        {
          ...inputs,
          carePlan: {
            goals: [{ id: "g", goalText: " . ", progressStatement: null, sudRelated: false }],
            interventions: [],
          },
        },
        DEPS,
      ),
    ).toThrow(DraftInputError);
    expect(() =>
      compileDraft(
        { ...inputs, medicationChanges: [{ ...inputs.medicationChanges[0], drugName: "  " }] },
        DEPS,
      ),
    ).toThrow(DraftInputError);
  });

  it("raises the assembler's typed errors for an illegal pair or a stale selection", () => {
    const base = baseInputs();
    const code = (inputs: DraftInputs): string => {
      try {
        compileDraft(inputs, DEPS);
      } catch (e) {
        return e instanceof HearthnoteAssemblyError ? e.code : "OTHER";
      }
      return "NONE";
    };
    expect(code({ ...base, encounterType: "face_to_face" })).toBe("TEMPLATE_KEY_MISMATCH");
    expect(
      code({
        ...base,
        encounterType: "face_to_face",
        selection: {
          ...base.selection,
          templateKey: "face_to_face:rn",
          encounterType: "face_to_face",
        },
      }),
    ).toBe("TEMPLATE_NOT_FOUND");
    expect(
      code({
        ...base,
        selection: { ...base.selection, vocabVersion: "narrative-vocab@2026.06.0" },
      }),
    ).toBe("VOCAB_VERSION_MISMATCH");
  });
});

describe("wording", () => {
  it("resolves every slot: no ${...} placeholder survives in drafted text", () => {
    for (const s of compileDraft(baseInputs(), DEPS).sections) {
      if (s.state === "drafted") expect(s.text).not.toMatch(/\$\{/);
    }
  });

  it("emits NFC text with LF newlines", () => {
    const inputs = baseInputs();
    const goals = (inputs.carePlan?.goals ?? []).map((g) => ({
      ...g,
      goalText: "Café visit\r\nplanned",
    }));
    const draft = compileDraft({ ...inputs, carePlan: { goals, interventions: [] } }, DEPS);
    const plan = section(draft, "plan");
    if (plan.state !== "drafted") throw new Error("plan should be drafted");
    expect(plan.text).toContain("Café visit\nplanned");
    expect(plan.text).not.toContain("\r");
  });
});

// ── fixture mutators (each returns a new object; the fixtures are never edited in place) ────────────
function withGoal(i: DraftInputs, patch: object): DraftInputs {
  const goals = (i.carePlan?.goals ?? []).map((g) => (g.id === "goal-b" ? { ...g, ...patch } : g));
  return { ...i, carePlan: { goals, interventions: i.carePlan?.interventions ?? [] } };
}

function withIntervention(i: DraftInputs, patch: object): DraftInputs {
  const interventions = (i.carePlan?.interventions ?? []).map((x) => ({ ...x, ...patch }));
  return { ...i, carePlan: { goals: i.carePlan?.goals ?? [], interventions } };
}

function withScale(i: DraftInputs, id: string, patch: object): DraftInputs {
  return {
    ...i,
    scaleReadings: i.scaleReadings.map((r) => (r.id === id ? ({ ...r, ...patch } as typeof r) : r)),
  };
}

function withVitals(i: DraftInputs, patch: object): DraftInputs {
  return { ...i, vitals: i.vitals === null ? null : { ...i.vitals, ...patch } };
}

function withMedication(i: DraftInputs, patch: object): DraftInputs {
  return {
    ...i,
    medicationChanges: i.medicationChanges.map((m) => ({ ...m, ...patch }) as typeof m),
  };
}

describe("the recorded findings of the assembly are not the draft's sources", () => {
  it("does not state the recorded vitals a second time beside the vitals source", () => {
    const plain = compileDraft(baseInputs(), DEPS);
    const withRecorded = compileDraft(
      {
        ...baseInputs(),
        context: { ...baseInputs().context, recordedVitals: { heartRate: 72, spo2: 98 } },
      },
      DEPS,
    );
    expect(hashes(withRecorded)).toEqual(hashes(plain));
  });
});
