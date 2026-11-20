// WF09 WP3 — the composer with the review and blocker panels mounted, through the real route. T07 (a required section missing is a blocker
// whose remedy focuses the field), T10 (finalized is not signed), T13 (no ready state before the server has answered), T33 (what nothing
// decides is never shown as checked), the 503 sentence, the late-entry field and its body, and each anchor on the page exactly once.
// The net answers by "METHOD /path", so every assertion about a request reads the recorded call. Synthetic data only.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FINALIZE,
  FORTY,
  checksPanel,
  finalizeCalls,
  firstBlocker,
  mountComposer,
  openSection,
  ready,
  refusal,
  resetWorld,
  reviewPanel,
  world,
} from "./composer-test-harness";

const consoleSpies = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  resetWorld();
  spies = consoleSpies.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("the anchors the visit workspace jumps to", () => {
  it("puts the review anchor on the review panel and the complete anchor on the blocker panel, each once", async () => {
    mountComposer();
    await ready();
    await screen.findByRole("region", { name: "Review note" });
    expect(document.querySelectorAll('[id="visit-review"]')).toHaveLength(1);
    expect(document.querySelectorAll('[id="visit-complete"]')).toHaveLength(1);
    expect(reviewPanel()).toHaveAttribute("id", "visit-review");
    expect(checksPanel()).toHaveAttribute("id", "visit-complete");
    expect(reviewPanel()).toHaveAttribute("tabindex", "-1");
    expect(checksPanel()).toHaveAttribute("tabindex", "-1");
  });
});

describe("before the server has answered (T13, T33)", () => {
  it("says not checked yet, with no ready badge and no count of anything complete", async () => {
    mountComposer();
    await ready();
    await screen.findByRole("region", { name: "Finalize and sign checks" });
    expect(within(checksPanel()).getByText("Not checked yet")).toBeInTheDocument();
    const text = checksPanel().textContent ?? "";
    expect(text).not.toMatch(/✓|\bready\b|\bpassed\b|\bcomplete\b|\d+ of \d+/i);
    expect(screen.queryByText("Required documentation is complete")).toBeNull();
  });

  it("keeps saying not checked yet when every required section has an entry: entries are not a verdict", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await openSection(user, /^Assessment/);
    await user.click(await screen.findByRole("checkbox", { name: /Dyspnea at rest/ }));
    await openSection(user, /^Vital Signs Review/);
    await user.type(screen.getByLabelText("Additional notes"), "Resting comfortably.");

    expect(await screen.findByText("Every required section has an entry")).toBeInTheDocument();
    expect(
      screen.getByText(/the server also checks vitals, scales and the care-plan review/),
    ).toBeInTheDocument();
    expect(within(checksPanel()).getByText("Not checked yet")).toBeInTheDocument();
    expect(finalizeCalls()).toHaveLength(0);
  });

  it("says in words what is checked at sign, and what nothing checks, with no button among the latter", async () => {
    mountComposer();
    await ready();
    const panel = await screen.findByRole("region", { name: "Finalize and sign checks" });
    const unchecked = within(panel).getByRole("list", { name: "Not checked by ChartWarden" });
    expect(
      within(unchecked).getByText(/ChartWarden cannot tell which note carries a HOPE timepoint/),
    ).toBeInTheDocument();
    expect(
      within(unchecked).getByText(/AI enhancement of the note is not available/),
    ).toBeInTheDocument();
    expect(
      within(unchecked).getByText(/server does not record this acknowledgment/),
    ).toBeInTheDocument();
    expect(within(unchecked).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(within(panel).getByRole("list", { name: "Checked when you sign" })).getByText(
        "Recent sign-in",
      ),
    ).toBeInTheDocument();
  });
});

describe("a refused finalize (T07)", () => {
  const MISSING = [
    { field: "assessment", code: "MISSING_SECTION", message: "m" },
    { field: "bp", code: "MISSING_VITAL", message: "m" },
  ];

  async function finalizeRefused(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    mountComposer({ [FINALIZE]: () => refusal(422, "COMPLIANCE_GATE_FAILED", MISSING) });
    await ready();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));
    await within(
      await screen.findByRole("region", { name: "Finalize and sign checks" }),
    ).findByText("Blocked: 2 items to fix");
  }

  it("lists each failure the server named, and says the note was not finalized", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect(within(checksPanel()).getByText("Assessment has no entry")).toBeInTheDocument();
    expect(within(checksPanel()).getByText("Blood pressure is not recorded")).toBeInTheDocument();
    expect(
      within(checksPanel()).getByText(
        /The note was not finalized\. Nothing was frozen or signed\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(checksPanel()).getByText(
        /The other checks in the finalize gate did not list a failure/,
      ),
    ).toBeInTheDocument();
  });

  it("moves focus to the first blocker", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    await waitFor(() => expect(firstBlocker()).toHaveFocus());
  });

  it("is the only live region for the gate's refusal: no banner repeats it", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect(screen.queryByText("Action needed")).toBeNull();
    expect(screen.queryByText(/compliance gate did not pass/i)).toBeNull();
  });

  it("takes the author to the missing section's heading when its remedy is pressed", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    await user.click(within(checksPanel()).getByRole("button", { name: "Go to Assessment" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Assessment", level: 2 })).toHaveFocus(),
    );
  });

  it("opens the visit vitals, and moves focus into them, when the missing vital's remedy is pressed", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect(screen.queryByRole("heading", { name: "Visit vitals" })).toBeNull();
    await user.click(within(checksPanel()).getByRole("button", { name: "Open visit vitals" }));
    const heading = await screen.findByRole("heading", { name: "Visit vitals" });
    await waitFor(() => expect(heading.closest('[tabindex="-1"]')).toHaveFocus());
  });

  it("takes the author to the care plan when the care-plan review is overdue", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () =>
        refusal(422, "COMPLIANCE_GATE_FAILED", [
          { field: "carePlan", code: "CARE_PLAN_REVIEW_OVERDUE", message: "m" },
        ]),
    });
    await ready();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));
    await user.click(await screen.findByRole("button", { name: "Open care plan" }));
    expect(await screen.findByRole("heading", { name: "Care plan screen" })).toBeInTheDocument();
  });

  it("keeps listing a code it does not know, with the open-the-note remedy", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () =>
        refusal(422, "COMPLIANCE_GATE_FAILED", [
          { field: "x", code: "A_FUTURE_CHECK", message: "The server says this." },
        ]),
    });
    await ready();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));
    const panel = await screen.findByRole("region", { name: "Finalize and sign checks" });
    expect(await within(panel).findByText("The server says this.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Open the note" })).toBeInTheDocument();
  });

  it("lists a refusal that is not the gate's in the panel alone: no banner repeats it, and nothing else announces it", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () =>
        refusal(422, "INVALID_SELECTION", [
          { field: "assessment", code: "SLOT_EMPTY", message: "Dependent edema needs a site." },
        ]),
    });
    await ready();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));
    const panel = screen.getByRole("region", { name: "Finalize and sign checks" });
    expect(
      await within(panel).findByText("Assessment: a statement cannot be used as entered"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Dependent edema needs a site.")).toBeInTheDocument();
    expect(screen.queryByText("Action needed")).toBeNull();
    // The panel's own status line is the one live region that says it.
    const live = document.querySelectorAll('[aria-live="polite"]:not(:empty)');
    const saying = [...live].filter((node) => /Blocked: 1 item/.test(node.textContent ?? ""));
    expect(saying).toHaveLength(1);
  });

  it("has no axe violations in the blocked panel or the review panel", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect((await axe.run(checksPanel())).violations).toEqual([]);
    expect((await axe.run(reviewPanel())).violations).toEqual([]);
  });
});

describe("a finalize the server could not decide", () => {
  it("says it in the panel's fixed words, never the server's text, and asks again on Try again", async () => {
    const user = userEvent.setup();
    let answers = 0;
    mountComposer({
      [FINALIZE]: () => {
        answers += 1;
        if (answers === 1) {
          return refusal(
            503,
            "COMPLIANCE_GATE_UNAVAILABLE",
            [],
            "care plan reader failed: ECONNREFUSED 10.0.0.5:5432",
          );
        }
        world.status = "finalized";
        return { body: { status: "finalized", version: 5 } };
      },
    });
    await ready();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));
    const panel = await screen.findByRole("region", { name: "Finalize and sign checks" });
    expect(
      await within(panel).findByText(
        "The server could not run its checks right now, so the note was not finalized. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
    expect(screen.queryByText("Action needed")).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(await within(checksPanel()).findByText("Finalized, not signed")).toBeInTheDocument();
    expect(finalizeCalls()).toHaveLength(2);
  });
});

describe("a finalized note is not a signed one (T10)", () => {
  it("says finalized, not signed, in the panel and the banner, and offers no way to sign here", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));
    expect(await within(checksPanel()).findByText("Finalized, not signed")).toBeInTheDocument();
    expect(
      within(checksPanel()).getByText(
        "The server finalized this note and its text is frozen. It is not signed. Signing is a separate step.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Finalizing is not signing: the note is signed on the encounter record.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to sign-off" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sign/ })).toBeNull();
    expect(checksPanel().textContent ?? "").not.toMatch(
      /ready to sign|has been signed|is signed|✓/i,
    );
  });

  it("shows a note that was already finalized as finalized, not signed, from the server's own status", async () => {
    world.status = "finalized";
    mountComposer();
    await ready();
    expect(
      await within(
        await screen.findByRole("region", { name: "Finalize and sign checks" }),
      ).findByText("Finalized, not signed"),
    ).toBeInTheDocument();
  });

  it("shows neither panel for a note that is already signed", async () => {
    world.status = "signed";
    mountComposer();
    await ready();
    expect(screen.queryByRole("region", { name: "Finalize and sign checks" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Review note" })).toBeNull();
  });
});

describe("a note documented late", () => {
  it("shows the late-entry field once the server asks for a reason, focuses it from the remedy, and sends the reason with the next finalize", async () => {
    const user = userEvent.setup();
    let answers = 0;
    mountComposer({
      [FINALIZE]: () => {
        answers += 1;
        if (answers === 1) return refusal(422, "LATE_ENTRY_REASON_REQUIRED");
        world.status = "finalized";
        return { body: { status: "finalized", version: 5 } };
      },
    });
    await ready();
    expect(screen.queryByLabelText("Late-entry reason")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Finalize note" }));

    await user.click(
      await within(
        await screen.findByRole("region", { name: "Finalize and sign checks" }),
      ).findByRole("button", { name: "Enter the late-entry reason" }),
    );
    const field = screen.getByLabelText("Late-entry reason");
    expect(field).toHaveFocus();
    await user.type(field, FORTY);
    await user.click(screen.getByRole("button", { name: "Finalize note" }));

    await within(checksPanel()).findByText("Finalized, not signed");
    const [first, second] = finalizeCalls();
    expect(first?.body).toEqual({});
    expect(second?.body).toEqual({ lateEntryReason: FORTY });
  });
});

describe("the progress wording says entered, never complete", () => {
  it("counts sections that have an entry and labels the list by entry, with no percentage", async () => {
    mountComposer();
    await ready();
    expect(await screen.findByText("Entry progress")).toBeInTheDocument();
    expect(screen.getByText("0 of 4 sections have an entry")).toBeInTheDocument();
    expect(screen.getByText("required with no entry")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Assessment: Required, no entry" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Plan and Next Visit: No entry" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sections? documented/i)).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
  });
});

describe("the review panel", () => {
  it("shows what the author has entered per section, warns that unsaved changes are on screen only, and edits in place", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    const panel = await screen.findByRole("region", { name: "Review note" });
    expect(within(panel).queryByText(/unsaved changes/i)).toBeNull();

    await openSection(user, /^Assessment/);
    await user.click(await screen.findByRole("checkbox", { name: /Dyspnea at rest/ }));
    expect(
      within(panel).getByText(/You have unsaved changes\. This summary shows what is on screen/),
    ).toBeInTheDocument();
    const rows = within(panel).getAllByRole("listitem");
    const assessment = rows.find(
      (row) => within(row).queryByText("Assessment") !== null,
    ) as HTMLElement;
    expect(within(assessment).getByText("Entered")).toBeInTheDocument();
    expect(within(assessment).getByText("Dyspnea at rest")).toBeInTheDocument();
    expect(within(assessment).getByText(/Entered from selected statements/)).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Edit Vital Signs Review" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Vital Signs Review", level: 2 })).toHaveFocus(),
    );
  });

  it("says where to look for what the composer does not hold, instead of guessing", async () => {
    mountComposer();
    await ready();
    const panel = await screen.findByRole("region", { name: "Review note" });
    expect(
      within(panel).getByText("Open visit vitals to see what is recorded for this visit."),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Open the plan of care to see the linked items."),
    ).toBeInTheDocument();
  });

  it("jumps to the note preview", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await user.click(await screen.findByRole("button", { name: "Go to the note preview" }));
    expect(document.getElementById("visit-note-preview")).toHaveFocus();
  });
});
