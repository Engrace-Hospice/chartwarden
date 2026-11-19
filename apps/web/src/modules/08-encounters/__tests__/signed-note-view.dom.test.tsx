// @vitest-environment jsdom
// The signed note, section by section (ADR-0114 VN-D30). A withheld section is a labelled block that is never styled as the clinician's
// words and never empty; an amended section says so with its date and opens every version; no screen reads the legacy string when the
// structured view is there.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalDocumentationView, NoteHistory } from "../signed-note-model";
import { SignedNoteView } from "../signed-note-view";

afterEach(cleanup);

const section = (
  sectionId: string | null,
  over: Partial<FinalDocumentationView["sections"][number]> = {},
): FinalDocumentationView["sections"][number] => ({
  sectionId,
  text: `Text of ${sectionId}.`,
  withheld: false,
  amendedByAddendumId: null,
  signedAt: "2026-10-01T10:00:00Z",
  ...over,
});

const PART2 = /Protected by 42 CFR Part 2/;

describe("a note read section by section", () => {
  it("shows each sealed section under its heading with its text", () => {
    render(
      <SignedNoteView
        view={{ withheld: false, sections: [section("pain"), section("vitals_review")] }}
        history={null}
        fallbackText="legacy"
      />,
    );
    const pain = screen.getByRole("region", { name: "Pain" });
    expect(within(pain).getByText("Text of pain.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Vitals review" })).toBeInTheDocument();
    expect(screen.queryByText("legacy")).toBeNull();
  });

  it("shows a pin with no sealed rows as one block, with no heading of its own", () => {
    render(
      <SignedNoteView
        view={{ withheld: false, sections: [section(null, { text: "The whole narrative." })] }}
        history={null}
        fallbackText="legacy"
      />,
    );
    expect(screen.getByText("The whole narrative.")).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("falls back to the legacy text only when the API sent no structured view", () => {
    const { rerender } = render(
      <SignedNoteView view={undefined} history={undefined} fallbackText="Legacy narrative." />,
    );
    expect(screen.getByText("Legacy narrative.")).toBeInTheDocument();
    rerender(<SignedNoteView view={null} history={null} fallbackText="Nothing assembled." />);
    expect(screen.getByText("Nothing assembled.")).toBeInTheDocument();
  });
});

describe("withheld text", () => {
  it("is a labelled block for the section, with no text and no copy affordance", () => {
    render(
      <SignedNoteView
        view={{
          withheld: false,
          sections: [section("pain"), section("sud", { text: null, withheld: true })],
        }}
        history={null}
        fallbackText="legacy"
      />,
    );
    const sud = screen.getByRole("region", { name: "Sud" });
    const block = within(sud).getByRole("note");
    expect(within(block).getByText("Withheld")).toBeInTheDocument();
    expect(within(block).getByText(PART2)).toBeInTheDocument();
    expect(within(sud).queryByRole("button")).toBeNull();
    // The clinician's section next to it is still plain text.
    expect(within(screen.getByRole("region", { name: "Pain" })).queryByRole("note")).toBeNull();
  });

  it("is one labelled block for a whole withheld note, never an empty note", () => {
    render(
      <SignedNoteView view={{ withheld: true, sections: [] }} history={null} fallbackText="" />,
    );
    const block = screen.getByRole("note");
    expect(within(block).getByText("Withheld")).toBeInTheDocument();
    expect(within(block).getByText(/does not include this note/)).toBeInTheDocument();
  });

  it("never renders a section with neither text nor a withheld flag as an empty block", () => {
    render(
      <SignedNoteView
        view={{ withheld: false, sections: [section("pain", { text: null })] }}
        history={null}
        fallbackText="legacy"
      />,
    );
    expect(screen.getByText("No text is recorded for this section.")).toBeInTheDocument();
  });

  it("has no axe violations with a withheld section and a history open", async () => {
    const { container } = render(
      <SignedNoteView
        view={{
          withheld: false,
          sections: [
            section("sud", { text: null, withheld: true }),
            section("pain", { amendedByAddendumId: "add-1", signedAt: "2026-10-02T09:30:00Z" }),
          ],
        }}
        history={{
          sections: [
            {
              sectionId: "pain",
              versions: [
                {
                  kind: "original",
                  addendumId: null,
                  authoredByMembershipId: "mem-1",
                  signedAt: "2026-10-01T10:00:00Z",
                  text: null,
                  withheld: true,
                  current: false,
                },
                {
                  kind: "amendment",
                  addendumId: "add-1",
                  authoredByMembershipId: "mem-2",
                  signedAt: "2026-10-02T09:30:00Z",
                  text: "After.",
                  withheld: false,
                  current: true,
                },
              ],
            },
          ],
        }}
        fallbackText="legacy"
      />,
    );
    // The history is opened first: axe sees the versions a reader sees.
    for (const summary of container.querySelectorAll("summary")) summary.click();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("an amended section", () => {
  const history: NoteHistory = {
    sections: [
      {
        sectionId: "pain",
        versions: [
          {
            kind: "original",
            addendumId: null,
            authoredByMembershipId: "mem-author",
            signedAt: "2026-10-01T10:00:00Z",
            text: "Pain controlled.",
            withheld: false,
            current: false,
          },
          {
            kind: "amendment",
            addendumId: "add-1",
            authoredByMembershipId: "mem-amender",
            signedAt: "2026-10-02T09:30:00Z",
            text: "Pain controlled, new breakthrough pain.",
            withheld: false,
            current: false,
          },
          {
            kind: "amendment",
            addendumId: "add-2",
            authoredByMembershipId: "mem-withheld",
            signedAt: "2026-10-03T08:00:00Z",
            text: null,
            withheld: true,
            current: true,
          },
        ],
      },
    ],
  };
  const amendedView: FinalDocumentationView = {
    withheld: false,
    sections: [
      section("pain", {
        text: "Latest.",
        amendedByAddendumId: "add-2",
        signedAt: "2026-10-03T08:00:00Z",
      }),
      section("plan"),
    ],
  };

  it("shows an Amended badge with the date of the latest version, on that section only", () => {
    render(<SignedNoteView view={amendedView} history={history} fallbackText="legacy" />);
    const pain = screen.getByRole("region", { name: "Pain" });
    const head = within(pain).getByRole("heading", { name: "Pain" }).parentElement as HTMLElement;
    expect(within(head).getByText("Amended")).toBeInTheDocument();
    expect(within(head).getByText("2026-10-03 08:00")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Plan" })).queryByText("Amended")).toBeNull();
  });

  it("opens the history: original and every amendment, the current one marked, withheld versions labelled", async () => {
    const user = userEvent.setup();
    render(<SignedNoteView view={amendedView} history={history} fallbackText="legacy" />);
    const pain = screen.getByRole("region", { name: "Pain" });
    await user.click(within(pain).getByText("Version history (3 versions)"));
    const versions = within(pain).getAllByRole("listitem");
    expect(versions).toHaveLength(3);
    expect(within(versions[0] as HTMLElement).getByText("Original")).toBeInTheDocument();
    expect(within(versions[0] as HTMLElement).getByText("mem-author")).toBeInTheDocument();
    expect(within(versions[0] as HTMLElement).getByText("2026-10-01 10:00")).toBeInTheDocument();
    expect(within(versions[0] as HTMLElement).getByText("Pain controlled.")).toBeInTheDocument();
    expect(within(versions[0] as HTMLElement).queryByText("Current")).toBeNull();
    expect(within(versions[1] as HTMLElement).getByText("Amendment")).toBeInTheDocument();
    expect(within(versions[1] as HTMLElement).getByText("mem-amender")).toBeInTheDocument();
    const last = versions[2] as HTMLElement;
    expect(within(last).getByText("Current")).toBeInTheDocument();
    expect(within(last).getByText("Withheld")).toBeInTheDocument();
    expect(within(last).getByText(PART2)).toBeInTheDocument();
  });

  it("says the earlier versions are not available when no history came for an amended section", () => {
    render(<SignedNoteView view={amendedView} history={null} fallbackText="legacy" />);
    expect(screen.getByText("Earlier versions are not available.")).toBeInTheDocument();
  });
});
