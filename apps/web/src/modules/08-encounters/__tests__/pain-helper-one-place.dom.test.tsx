// @vitest-environment jsdom
// "One statement, one place" for the pain helper. The admission RN template offers the pain statements in BOTH Symptom Management and
// Baseline Symptoms. The flat menu already locks a statement recorded in the other section ("Already recorded in ..."); the helper's rows
// must too, or moving the pain statement leaves entries behind in the first section and the helper can be filled in both, so the note
// states pain twice. Sections and statements are shaped like the admission template's; values are invented.
import { PAIN_ASSESSMENT_CODES as C } from "@chartwarden/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createDraftEditors } from "../compose/draft-editors";
import { StatementMenu } from "../compose/statement-menu";
import type { DraftSections, MenuEntry, TemplateSection, TemplateView } from "../encounters-api";

const LIMITING = "nv.sym.pain_uncontrolled";
const CONTROLLED = "nv.sym.pain_controlled";
const painScore = { kind: "integer", min: 0, max: 10, label: "Pain score (0-10)" };

const entry = (
  code: string,
  label: string,
  slots: string[] = [],
  slotSpecs: Record<string, unknown> = {},
  exclusiveGroup: string | null = null,
): MenuEntry =>
  ({
    code,
    label,
    category: "symptom_impact",
    bodySystem: null,
    slots,
    slotSpecs,
    exclusiveGroup,
  }) as MenuEntry;

const painEntries = (): MenuEntry[] => [
  entry(
    CONTROLLED,
    "Symptom impact: pain controlled",
    ["pain_score"],
    { pain_score: painScore },
    "pain-status",
  ),
  entry(
    LIMITING,
    "Symptom impact: pain limiting function",
    ["pain_score"],
    { pain_score: painScore },
    "pain-status",
  ),
  entry(C.location, "Pain assessment: location", ["pain_location"]),
  entry(C.character, "Pain assessment: character", ["pain_character"]),
];

const section = (sectionId: string, heading: string): TemplateSection =>
  ({
    sectionId,
    heading,
    required: false,
    allowedCategories: ["symptom_impact"],
    entries: painEntries(),
    recordedPanel: null,
  }) as TemplateSection;

const SYMPTOM_MANAGEMENT = section("symptom_management", "Symptom Management");
const BASELINE = section("baseline_symptoms", "Baseline Symptoms");
const TEMPLATE = {
  encounterId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  templateKey: "admission_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "admission_visit",
  discipline: "rn",
  sections: [SYMPTOM_MANAGEMENT, BASELINE],
} as unknown as TemplateView;

/** The open section's menu with a working draft, as the composer wires it. */
function Harness({ openSectionId }: { readonly openSectionId: string }): JSX.Element {
  const [draft, setDraft] = useState<DraftSections>({});
  const { toggleEntry, chooseOne, setSlot } = createDraftEditors(TEMPLATE, draft, setDraft);
  const [open, setOpen] = useState(openSectionId);
  const active = TEMPLATE.sections.find((s) => s.sectionId === open) as TemplateSection;
  return (
    <div>
      {TEMPLATE.sections.map((s) => (
        <button key={s.sectionId} type="button" onClick={() => setOpen(s.sectionId)}>
          Open {s.heading}
        </button>
      ))}
      <StatementMenu
        section={active}
        sections={TEMPLATE.sections}
        draft={draft}
        disabled={false}
        discipline="rn"
        encounterType="admission_visit"
        suggestion={null}
        selectionsDirty={false}
        reasonIsFall={false}
        fallLink={{ choices: null, linked: null, value: null, onChange: () => undefined }}
        onChooseOne={chooseOne}
        onToggleEntry={toggleEntry}
        onSetSlot={setSlot}
        onOpenPlan={() => undefined}
      />
      <output data-testid="draft">
        {JSON.stringify(
          Object.fromEntries(
            Object.entries(draft).map(([id, s]) => [id, s.entries.map((e) => e.code)]),
          ),
        )}
      </output>
    </div>
  );
}

const recorded = (): Record<string, string[]> =>
  JSON.parse(screen.getByTestId("draft").textContent ?? "{}") as Record<string, string[]>;

afterEach(cleanup);

describe("the pain helper on the admission RN template", () => {
  it("locks a helper row already recorded in the other section, and leaves the others to fill", async () => {
    const user = userEvent.setup();
    render(<Harness openSectionId="symptom_management" />);

    // Record pain in Symptom Management: the statement, then a helper row.
    await user.click(screen.getByRole("checkbox", { name: /pain limiting function/ }));
    await user.type(screen.getByRole("textbox", { name: "Location" }), "left hip");
    // Move the pain statement to Baseline Symptoms: unticked here, which leaves the helper row behind.
    await user.click(screen.getByRole("checkbox", { name: /pain limiting function/ }));
    expect(recorded().symptom_management).toEqual([C.location]);

    await user.click(screen.getByRole("button", { name: "Open Baseline Symptoms" }));
    await user.click(screen.getByRole("checkbox", { name: /pain limiting function/ }));

    // The helper shows in Baseline Symptoms, but the row recorded elsewhere is locked and says where.
    const location = screen.getByRole("textbox", { name: "Location" });
    expect(location).toBeDisabled();
    expect(screen.getByText("Already recorded in Symptom Management")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Character" })).toBeEnabled();

    // Nothing typed into a locked row can reach the draft; a free row still records here.
    await user.type(location, "right knee");
    await user.type(screen.getByRole("textbox", { name: "Character" }), "aching");
    expect(recorded()).toEqual({
      symptom_management: [C.location],
      baseline_symptoms: [LIMITING, C.character],
    });
  });

  it("does not lock a row in the section that holds it", async () => {
    const user = userEvent.setup();
    render(<Harness openSectionId="symptom_management" />);

    await user.click(screen.getByRole("checkbox", { name: /pain limiting function/ }));
    await user.type(screen.getByRole("textbox", { name: "Location" }), "left hip");

    expect(screen.getByRole("textbox", { name: "Location" })).toBeEnabled();
    expect(screen.queryByText(/Already recorded in/)).toBeNull();
    // The flat menu's own lock is unchanged: the other section's pain statement shows it after the move.
    await user.click(screen.getByRole("button", { name: "Open Baseline Symptoms" }));
    const baseline = screen.getByRole("checkbox", { name: /pain limiting function/ });
    expect(baseline).toBeDisabled();
    expect(
      within(baseline.closest("label") as HTMLElement).getByText(
        "Already recorded in Symptom Management",
      ),
    ).toBeInTheDocument();
  });
});
