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

// A section withheld from the reader keeps its place and nothing else: no id, no name, no date, no amendment (S1, ADR-0114).
const withheldSection = (over: Partial<FinalDocumentationView["sections"][number]> = {}) =>
  section(null, { text: null, withheld: true, signedAt: null, ...over });

describe("withheld text", () => {
  it("keeps its place under a generic heading that names no section, with no id to link to and no copy affordance", () => {
    const { container } = render(
      <SignedNoteView
        view={{
          withheld: false,
          sections: [section("pain"), withheldSection(), section("plan")],
        }}
        history={null}
        fallbackText="legacy"
      />,
    );
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Pain",
      "Withheld section",
      "Plan",
    ]);
    const heading = screen.getByRole("heading", { name: "Withheld section" });
    expect(heading).not.toHaveAttribute("id");
    // Only the two readable sections can be linked to; the withheld one has no anchor and is no landmark.
    expect(Array.from(container.querySelectorAll("[id]")).map((el) => el.id)).toEqual([
      "note-section-pain",
      "note-section-plan",
    ]);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"))).toEqual([
      "note-section-pain",
      "note-section-plan",
    ]);
    const block = heading.closest(".wx-note-section") as HTMLElement;
    expect(within(block).getByRole("note")).toBeInTheDocument();
    expect(within(block).getByText("Withheld")).toBeInTheDocument();
    expect(within(block).getByText(PART2)).toBeInTheDocument();
    expect(within(block).queryByRole("button")).toBeNull();
    expect(within(block).queryByText("Amended")).toBeNull();
    expect(block.querySelector("time")).toBeNull();
    // The clinician's section next to it is still plain text.
    expect(within(screen.getByRole("region", { name: "Pain" })).queryByRole("note")).toBeNull();
  });

  it("gives two withheld sections the same generic heading and tells them apart by nothing", () => {
    render(
      <SignedNoteView
        view={{ withheld: false, sections: [withheldSection(), withheldSection()] }}
        history={null}
        fallbackText="legacy"
      />,
    );
    expect(screen.getAllByRole("heading", { name: "Withheld section" })).toHaveLength(2);
    expect(screen.getAllByRole("note")).toHaveLength(2);
  });

  it("names nothing and carries no amendment even when an older server still sent the id and the addendum", () => {
    const { container } = render(
      <SignedNoteView
        view={{
          withheld: false,
          sections: [
            section("sud_screening", {
              text: null,
              withheld: true,
              amendedByAddendumId: "add-1",
              signedAt: "2026-10-02T09:30:00Z",
            }),
          ],
        }}
        history={{
          sections: [{ sectionId: "sud_screening", versions: [] }],
        }}
        fallbackText="legacy"
      />,
    );
    expect(container.textContent).not.toMatch(/sud|screening/i);
    expect(container.querySelector("[id]")).toBeNull();
    expect(screen.queryByText("Amended")).toBeNull();
    expect(screen.queryByText(/Version history/)).toBeNull();
    expect(container.querySelector("time")).toBeNull();
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
            withheldSection(),
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
                  cosignStatus: null,
                },
                {
                  kind: "amendment",
                  addendumId: "add-1",
                  authoredByMembershipId: "mem-2",
                  signedAt: "2026-10-02T09:30:00Z",
                  text: "After.",
                  withheld: false,
                  current: true,
                  cosignStatus: "not_required",
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
            cosignStatus: null,
          },
          {
            kind: "amendment",
            addendumId: "add-1",
            authoredByMembershipId: "mem-amender",
            signedAt: "2026-10-02T09:30:00Z",
            text: "Pain controlled, new breakthrough pain.",
            withheld: false,
            current: false,
            cosignStatus: "not_required",
          },
          {
            kind: "amendment",
            addendumId: "add-2",
            authoredByMembershipId: "mem-withheld",
            signedAt: "2026-10-03T08:00:00Z",
            text: null,
            withheld: true,
            current: true,
            cosignStatus: "not_required",
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

  // The API leaves out a section group that has a withheld version, and sends null when none is left.
  it("says so, with no empty disclosure, when the history lists no section or a section with no version", () => {
    const { rerender } = render(
      <SignedNoteView view={amendedView} history={{ sections: [] }} fallbackText="legacy" />,
    );
    expect(screen.getByText("Earlier versions are not available.")).toBeInTheDocument();
    expect(screen.queryByText(/Version history/)).toBeNull();
    rerender(
      <SignedNoteView
        view={amendedView}
        history={{ sections: [{ sectionId: "pain", versions: [] }] }}
        fallbackText="legacy"
      />,
    );
    expect(screen.getByText("Earlier versions are not available.")).toBeInTheDocument();
    expect(screen.queryByText(/Version history/)).toBeNull();
  });

  it("opens the history of the amended section that has one, and says so for the one the API left out", async () => {
    const user = userEvent.setup();
    const twoAmended: FinalDocumentationView = {
      withheld: false,
      sections: [
        section("pain", { amendedByAddendumId: "add-2", signedAt: "2026-10-03T08:00:00Z" }),
        withheldSection(),
        section("plan", { amendedByAddendumId: "add-1", signedAt: "2026-10-02T09:30:00Z" }),
      ],
    };
    const shorter: NoteHistory = {
      sections: history.sections.filter((s) => s.sectionId === "pain"),
    };
    render(<SignedNoteView view={twoAmended} history={shorter} fallbackText="legacy" />);
    const pain = screen.getByRole("region", { name: "Pain" });
    await user.click(within(pain).getByText("Version history (3 versions)"));
    expect(within(pain).getAllByRole("listitem")).toHaveLength(3);
    const plan = screen.getByRole("region", { name: "Plan" });
    expect(within(plan).getByText("Earlier versions are not available.")).toBeInTheDocument();
    expect(within(plan).queryByText(/Version history/)).toBeNull();
    // The withheld section between them adds no hole, no heading of its own history and no badge.
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Pain",
      "Withheld section",
      "Plan",
    ]);
    expect(screen.getAllByText("Amended")).toHaveLength(2);
  });
});

describe("the cosignature of each amendment version, in words", () => {
  const version = (
    addendumId: string | null,
    cosignStatus: NoteHistory["sections"][number]["versions"][number]["cosignStatus"],
    over: Partial<NoteHistory["sections"][number]["versions"][number]> = {},
  ): NoteHistory["sections"][number]["versions"][number] => ({
    kind: addendumId === null ? "original" : "amendment",
    addendumId,
    authoredByMembershipId: "mem-1",
    signedAt: "2026-10-02T09:30:00Z",
    text: `Text of ${addendumId ?? "original"}.`,
    withheld: false,
    current: false,
    cosignStatus,
    ...over,
  });
  const view: FinalDocumentationView = {
    withheld: false,
    sections: [section("pain", { amendedByAddendumId: "add-4" })],
  };
  const openVersions = async (versions: NoteHistory["sections"][number]["versions"]) => {
    const user = userEvent.setup();
    render(
      <SignedNoteView
        view={view}
        history={{ sections: [{ sectionId: "pain", versions }] }}
        fallbackText="legacy"
      />,
    );
    const pain = screen.getByRole("region", { name: "Pain" });
    await user.click(within(pain).getByText(/Version history/));
    return within(pain).getAllByRole("listitem");
  };

  it("says pending cosignature, cosigned and released on the amendment that has each", async () => {
    const rows = await openVersions([
      version(null, null),
      version("add-1", "pending"),
      version("add-2", "cosigned"),
      version("add-3", "released"),
    ]);
    expect(within(rows[1] as HTMLElement).getByText("Pending cosignature")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Cosigned")).toBeInTheDocument();
    expect(
      within(rows[3] as HTMLElement).getByText("Released by a supervisor"),
    ).toBeInTheDocument();
  });

  it("says nothing for the original, a cosignature that was not required, or one the API did not state", async () => {
    const rows = await openVersions([
      version(null, null),
      version("add-1", "not_required"),
      version("add-2", null),
    ]);
    for (const row of rows) {
      expect(row.querySelector(".wx-status-pill")).toBeNull();
    }
    expect(screen.queryByText(/cosign/i)).toBeNull();
  });

  it("states the cosignature of a withheld amendment without showing any of its text", async () => {
    const rows = await openVersions([
      version(null, null),
      version("add-1", "pending", { text: null, withheld: true }),
    ]);
    const withheld = rows[1] as HTMLElement;
    expect(within(withheld).getByText("Pending cosignature")).toBeInTheDocument();
    expect(within(withheld).getByText(PART2)).toBeInTheDocument();
    expect(withheld.textContent).not.toMatch(/Text of add-1/);
  });

  it("has no axe violations with the statuses showing", async () => {
    await openVersions([version(null, null), version("add-1", "pending")]);
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});
