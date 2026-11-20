// WF09 WP3 — the review panel: the server-assembled preview in its slot, and a read-only structured summary of what the author has
// entered, each row with a way back to edit it. It says "entered", never "complete" or "ready". Synthetic data only.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteTarget } from "../note-target";
import { ReviewPanel } from "../review-panel";
import type { NoteSummary } from "../review-summary";

afterEach(cleanup);

const SUMMARY: NoteSummary = {
  sections: [
    {
      sectionId: "chief_concern",
      heading: "Reason for Visit",
      required: true,
      statements: ["Routine scheduled visit"],
      basis: ["selection"],
      hasEntry: true,
      needsDetails: false,
      draftState: null,
      edit: { kind: "section", sectionId: "chief_concern" },
    },
    {
      sectionId: "vitals_review",
      heading: "Vital Signs Review",
      required: true,
      statements: [],
      basis: [],
      hasEntry: false,
      needsDetails: false,
      draftState: null,
      edit: { kind: "section", sectionId: "vitals_review" },
    },
    {
      sectionId: "assessment",
      heading: "Assessment",
      required: true,
      statements: ["Dependent edema"],
      basis: ["selection", "own_text"],
      hasEntry: true,
      needsDetails: true,
      draftState: "needs_reconfirmation",
      edit: { kind: "section", sectionId: "assessment" },
    },
    {
      sectionId: "plan",
      heading: "Plan and Next Visit",
      required: true,
      statements: [],
      basis: ["confirmed_draft"],
      hasEntry: true,
      needsDetails: false,
      draftState: "confirmed",
      edit: { kind: "section", sectionId: "plan" },
    },
    {
      sectionId: "nutrition",
      heading: "Nutrition",
      required: false,
      statements: [],
      basis: [],
      hasEntry: false,
      needsDetails: false,
      draftState: null,
      edit: { kind: "section", sectionId: "nutrition" },
    },
  ],
  findings: [
    {
      id: "vitals",
      label: "Visit vitals",
      status: "unknown",
      detail: "Open visit vitals to see what is recorded for this visit.",
      edit: { kind: "vitals" },
    },
    {
      id: "adl",
      label: "ADLs",
      status: "recorded",
      detail: "A saved ADL record is on this visit.",
      edit: { kind: "section", sectionId: "functional_status" },
    },
    {
      id: "care_plan",
      label: "Care-plan items",
      status: "recorded",
      detail: "2 care-plan items linked",
      edit: { kind: "plan_step" },
    },
  ],
};

const PREVIEW = "Synthetic preview: the patient is seen for a routine visit.";

function renderPanel(
  props: {
    summary?: NoteSummary;
    editable?: boolean;
    unsavedChanges?: boolean;
    onEdit?: (t: NoteTarget) => void;
  } = {},
) {
  return render(
    <ReviewPanel
      summary={props.summary ?? SUMMARY}
      editable={props.editable ?? true}
      unsavedChanges={props.unsavedChanges ?? false}
      onEdit={props.onEdit ?? (() => undefined)}
      id="visit-review"
    >
      <p>{PREVIEW}</p>
    </ReviewPanel>,
  );
}

const panel = () => screen.getByRole("region", { name: "Review note" });
const rowOf = (heading: string) =>
  within(panel())
    .getAllByRole("listitem")
    .find((row) => within(row).queryByText(heading) !== null) as HTMLElement;

describe("the review panel", () => {
  it("is a labelled region at the review anchor, with the preview in its slot", () => {
    renderPanel();
    expect(panel()).toHaveAttribute("id", "visit-review");
    expect(panel()).toHaveAttribute("tabindex", "-1");
    expect(within(panel()).getByText(PREVIEW)).toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { name: "Review note" })).toBeInTheDocument();
  });

  it("says it shows what was entered and that the server decides what can be finalized", () => {
    renderPanel();
    expect(
      within(panel()).getByText(
        /shows what you have entered; the server assembles the note text and decides whether it can be finalized/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows each section with its heading, whether it is required, and its entry state in words", () => {
    renderPanel();
    expect(within(rowOf("Reason for Visit")).getByText("Entered")).toBeInTheDocument();
    expect(
      within(rowOf("Reason for Visit")).getByText("Routine scheduled visit"),
    ).toBeInTheDocument();
    expect(within(rowOf("Vital Signs Review")).getByText("Required, no entry")).toBeInTheDocument();
    expect(within(rowOf("Nutrition")).getByText("No entry")).toBeInTheDocument();
    expect(within(rowOf("Nutrition")).getByText("Optional")).toBeInTheDocument();
    expect(within(rowOf("Assessment")).getByText("Needs details")).toBeInTheDocument();
  });

  it("says what each entry rests on, without repeating the author's own words", () => {
    renderPanel();
    expect(
      within(rowOf("Assessment")).getByText(/selected statements and your own text/i),
    ).toBeInTheDocument();
    expect(
      within(rowOf("Plan and Next Visit")).getByText(/confirmed drafted text/i),
    ).toBeInTheDocument();
  });

  it("shows a drafted section's state", () => {
    renderPanel();
    expect(
      within(rowOf("Assessment")).getByText("Draft: Changed, review again"),
    ).toBeInTheDocument();
    expect(within(rowOf("Plan and Next Visit")).getByText("Draft: Confirmed")).toBeInTheDocument();
  });

  it("lists what was recorded on the visit and says when it cannot show it here", () => {
    renderPanel();
    expect(
      within(rowOf("Visit vitals")).getByText(/Open visit vitals to see what is recorded/),
    ).toBeInTheDocument();
    expect(
      within(rowOf("ADLs")).getByText("A saved ADL record is on this visit."),
    ).toBeInTheDocument();
    expect(
      within(rowOf("Care-plan items")).getByText("2 care-plan items linked"),
    ).toBeInTheDocument();
  });

  it("hands the host the target of the row whose Edit was pressed", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderPanel({ onEdit });
    await user.click(screen.getByRole("button", { name: "Edit Vital Signs Review" }));
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "section", sectionId: "vitals_review" });
    await user.click(screen.getByRole("button", { name: "Edit Visit vitals" }));
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "vitals" });
    await user.click(screen.getByRole("button", { name: "Edit Care-plan items" }));
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "plan_step" });
  });

  it("offers no Edit when the note can no longer be edited", () => {
    renderPanel({ editable: false });
    expect(within(panel()).queryAllByRole("button")).toHaveLength(0);
    expect(within(rowOf("Assessment")).getByText("Needs details")).toBeInTheDocument();
  });

  it("warns that unsaved changes are on screen only", () => {
    renderPanel({ unsavedChanges: true });
    expect(
      within(panel()).getByText(
        /unsaved changes\. This summary shows what is on screen; the server checks only what is saved/i,
      ),
    ).toBeInTheDocument();
  });

  it("has no warning when everything on screen is saved", () => {
    renderPanel();
    expect(within(panel()).queryByText(/unsaved changes/i)).toBeNull();
  });

  it("never says a section is complete, ready, compliant or passed", () => {
    renderPanel();
    const text = (panel().textContent ?? "").replace(PREVIEW, "");
    expect(text).not.toMatch(/\bcomplete\b|\bready\b|compliant|\bpassed\b|all clear|✓|✔/i);
  });

  it("renders without a preview slot, with just the summary", () => {
    render(
      <ReviewPanel
        summary={SUMMARY}
        editable={true}
        unsavedChanges={false}
        onEdit={() => undefined}
      />,
    );
    expect(screen.getByRole("region", { name: "Review note" })).toBeInTheDocument();
    expect(screen.queryByText(PREVIEW)).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = renderPanel({ unsavedChanges: true });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
