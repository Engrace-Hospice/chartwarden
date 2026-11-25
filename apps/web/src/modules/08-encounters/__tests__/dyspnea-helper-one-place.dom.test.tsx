// @vitest-environment jsdom
// "One statement, one place" for the dyspnea helper, the twin of pain-helper-one-place.dom.test.tsx. The admission RN template offers the
// dyspnea statements in BOTH Symptom Management and Baseline Symptoms. The flat menu already locks a statement recorded in the other
// section ("Already recorded in ..."); the helper's rows must too, or moving the impact statement leaves entries behind in the first
// section and the helper can be filled in both, so the note states dyspnea twice. Sections and statements are shaped like the admission
// template's; values are invented.
import {
  DYSPNEA_ASSESSMENT_CODES as D,
  DYSPNEA_STATEMENT_CODE as IMPACT,
  DYSPNEA_SLOTS as S,
} from "@chartwarden/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createDraftEditors } from "../compose/draft-editors";
import { StatementMenu } from "../compose/statement-menu";
import type { DraftSections, MenuEntry, TemplateSection, TemplateView } from "../encounters-api";

const dyspneaScore = { kind: "integer", min: 0, max: 10, label: "Dyspnea intensity (0–10)" };

const entry = (
  code: string,
  label: string,
  slots: string[],
  slotSpecs: Record<string, unknown> = {},
): MenuEntry =>
  ({
    code,
    label,
    category: "symptom_impact",
    bodySystem: null,
    slots,
    slotSpecs,
    exclusiveGroup: null,
  }) as MenuEntry;

const dyspneaEntries = (): MenuEntry[] => [
  entry(IMPACT, "Symptom impact: dyspnea limiting function", ["ambulation_distance"]),
  entry(D.score, "Dyspnea assessment: intensity", [S.score], { [S.score]: dyspneaScore }),
  entry(D.onset, "Dyspnea assessment: onset", [S.onset]),
];

const section = (sectionId: string, heading: string): TemplateSection =>
  ({
    sectionId,
    heading,
    required: false,
    allowedCategories: ["symptom_impact"],
    entries: dyspneaEntries(),
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

const impactCheckbox = (): HTMLElement =>
  screen.getByRole("checkbox", { name: /dyspnea limiting function/ });

afterEach(cleanup);

describe("the dyspnea helper on the admission RN template", () => {
  it("locks a helper row already recorded in the other section, and leaves the others to fill", async () => {
    const user = userEvent.setup();
    render(<Harness openSectionId="symptom_management" />);

    // Record dyspnea in Symptom Management: the impact statement, then a helper row.
    await user.click(impactCheckbox());
    await user.type(screen.getByLabelText("Intensity (0 to 10)"), "6");
    // Move the impact statement to Baseline Symptoms: unticked here, which leaves the helper row behind.
    await user.click(impactCheckbox());
    expect(recorded().symptom_management).toEqual([D.score]);

    await user.click(screen.getByRole("button", { name: "Open Baseline Symptoms" }));
    await user.click(impactCheckbox());

    // The helper shows in Baseline Symptoms, but the row recorded elsewhere is locked and says where.
    const intensity = screen.getByLabelText("Intensity (0 to 10)");
    expect(intensity).toBeDisabled();
    expect(intensity).toHaveValue(null);
    expect(screen.getByText("Already recorded in Symptom Management")).toBeInTheDocument();
    // The note is tied to the disabled control, so a screen reader reads where the value lives.
    expect(intensity).toHaveAccessibleDescription(/Already recorded in Symptom Management/);
    expect(screen.getByLabelText("Onset")).toBeEnabled();
    expect(screen.getByLabelText("Onset")).not.toHaveAccessibleDescription(/Already recorded in/);

    // Nothing typed into a locked row can reach the draft; a free row still records here.
    await user.type(intensity, "9");
    await user.type(screen.getByLabelText("Onset"), "two days ago");
    expect(recorded()).toEqual({
      symptom_management: [D.score],
      baseline_symptoms: [IMPACT, D.onset],
    });
  });

  it("describes a locked free-text row by where it is recorded", async () => {
    const user = userEvent.setup();
    render(<Harness openSectionId="symptom_management" />);

    await user.click(impactCheckbox());
    await user.type(screen.getByLabelText("Onset"), "two days ago");
    await user.click(impactCheckbox());
    await user.click(screen.getByRole("button", { name: "Open Baseline Symptoms" }));
    await user.click(impactCheckbox());

    const onset = screen.getByLabelText("Onset");
    expect(onset).toBeDisabled();
    expect(onset).toHaveAccessibleDescription("Already recorded in Symptom Management");
  });

  it("does not lock a row in the section that holds it", async () => {
    const user = userEvent.setup();
    render(<Harness openSectionId="symptom_management" />);

    await user.click(impactCheckbox());
    await user.type(screen.getByLabelText("Intensity (0 to 10)"), "6");

    expect(screen.getByLabelText("Intensity (0 to 10)")).toBeEnabled();
    expect(screen.queryByText(/Already recorded in/)).toBeNull();
    // The flat menu's own lock is unchanged: the other section's impact statement shows it after the move.
    await user.click(screen.getByRole("button", { name: "Open Baseline Symptoms" }));
    const baseline = impactCheckbox();
    expect(baseline).toBeDisabled();
    expect(
      within(baseline.closest("label") as HTMLElement).getByText(
        "Already recorded in Symptom Management",
      ),
    ).toBeInTheDocument();
  });
});
