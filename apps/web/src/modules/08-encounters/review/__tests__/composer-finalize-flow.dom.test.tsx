// WF09 WP3 review fixes — what the composer does around a finalize: where focus goes when the server could not decide, when it said yes,
// and when the note moved on in another tab; that one thing speaks at a time; that a remedy cannot run twice or while the note text is
// being edited; what the typed late-entry reason does to the leave guard; and the `?focus=` the record uses to open the composer at the part
// of the note a blocker names. The net answers by "METHOD /path". Synthetic data only.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  ENC,
  FINALIZE,
  FORTY,
  PATIENT,
  checksPanel,
  finalizeCalls,
  mountComposer,
  ready,
  refusal,
  resetWorld,
  world,
} from "./composer-test-harness";

const PATCH = `PATCH ${BASE}/selections`;
const patchCalls = () => world.calls.filter((c) => `${c.method} ${c.path}` === PATCH);
const encounterReads = () => world.calls.filter((c) => `${c.method} ${c.path}` === `GET ${BASE}`);
const finalizeButton = () => screen.findByRole("button", { name: "Finalize note" });
const UNAVAILABLE = () =>
  refusal(503, "COMPLIANCE_GATE_UNAVAILABLE", [], "care plan reader failed: ECONNREFUSED");

const consoleSpies = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  resetWorld();
  spies = consoleSpies.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("where focus goes after a finalize", () => {
  it("moves focus to the checks panel when the server could not decide, so the failure is not left below the fold (R1)", async () => {
    const user = userEvent.setup();
    mountComposer({ [FINALIZE]: UNAVAILABLE });
    await ready();
    await user.click(await finalizeButton());
    await within(checksPanel()).findByText("Unavailable");
    await waitFor(() => expect(checksPanel()).toHaveFocus());
  });

  it("moves focus to the checks panel when the connection dropped and the note is still a draft (R1)", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () => {
        throw new TypeError("network down");
      },
    });
    await ready();
    await user.click(await finalizeButton());
    await within(
      await screen.findByRole("region", { name: "Finalize and sign checks" }),
    ).findByText("Unavailable");
    await waitFor(() => expect(checksPanel()).toHaveFocus());
  });

  it("moves focus to the checks panel, saying finalized and not signed, after a finalize goes through and the page is read again (R3)", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await user.click(await finalizeButton());
    await within(checksPanel()).findByText("Finalized, not signed");
    await waitFor(() => expect(checksPanel()).toHaveFocus());
    // The panel was rebuilt by the page read, so nothing was announced as a change: focus reads its status with its name.
    expect(checksPanel()).toHaveAccessibleDescription(/Finalized, not signed/);
    expect(encounterReads().length).toBeGreaterThanOrEqual(2);
  });

  it("moves focus to the checks panel when the connection dropped but the server had finalized the note (R3)", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () => {
        world.status = "finalized";
        throw new TypeError("network down");
      },
    });
    await ready();
    await user.click(await finalizeButton());
    await within(
      await screen.findByRole("region", { name: "Finalize and sign checks" }),
    ).findByText("Finalized, not signed");
    await waitFor(() => expect(checksPanel()).toHaveFocus());
  });
});

describe("one announcement at a time", () => {
  it("keeps the save-state line quiet while finalizing, so only the checks panel says it is waiting (R4)", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mountComposer({
      [FINALIZE]: async () => {
        await held;
        world.status = "finalized";
        return { body: { status: "finalized", version: 5 } };
      },
    });
    await ready();
    await user.click(await finalizeButton());
    const saveState = await screen.findByText("Saving and finalizing…");
    expect(saveState).toHaveAttribute("aria-live", "off");
    expect(within(checksPanel()).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(within(checksPanel()).getByRole("status")).toHaveTextContent(
      "Finalizing: waiting for the server",
    );
    release();
    // The page is read again after the finalize, so the panel on screen is a new one.
    await screen.findByText("Finalized, not signed");
    expect(screen.getByText("All changes saved")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the server's own banner for a refusal code the panel does not know (R4)", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () => refusal(422, "VALIDATION_FAILED", [], "the server says something odd"),
    });
    await ready();
    await user.click(await finalizeButton());
    expect(await screen.findByText("Action needed")).toBeInTheDocument();
    // The banner and the panel's generic row both carry the server's sentence: a code the panel cannot word has no better words.
    expect(await screen.findAllByText("the server says something odd")).toHaveLength(2);
  });

  it("shows no banner for a refusal the panel words itself: the panel says it (R4)", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () => refusal(409, "VOCAB_VERSION_MISMATCH", [], "the vocabulary changed"),
    });
    await ready();
    await user.click(await finalizeButton());
    await within(checksPanel()).findByText("Blocked: 1 item to fix");
    expect(screen.queryByText("Action needed")).toBeNull();
    expect(screen.queryByText("the vocabulary changed")).toBeNull();
  });
});

describe("a note that moved on in another tab (C2)", () => {
  it("reads the note again and says the server refused, without claiming the note was not finalized", async () => {
    const user = userEvent.setup();
    mountComposer({
      [FINALIZE]: () => {
        world.status = "finalized";
        return refusal(409, "ILLEGAL_TRANSITION", [], "encounter is finalized");
      },
    });
    await ready();
    await user.click(await finalizeButton());
    const panel = await screen.findByRole("region", { name: "Finalize and sign checks" });
    await within(panel).findByText("Refused: the note changed elsewhere");
    expect(panel.textContent).not.toMatch(/was not finalized|Nothing was frozen/);
    await waitFor(() => expect(encounterReads()).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "Finalize note" })).toBeDisabled();
  });
});

describe("a remedy runs only when its button would (R7, R16)", () => {
  const VOCAB = () => refusal(409, "VOCAB_VERSION_MISMATCH", [], "m");

  it("saves the selections once for two quick presses of 'Save the selections again' (R7)", async () => {
    const user = userEvent.setup();
    let hold: Promise<void> | null = null;
    mountComposer({
      [FINALIZE]: VOCAB,
      [PATCH]: async () => {
        if (hold) await hold;
        return { body: { version: 4, layer1Preview: "Saved." } };
      },
    });
    await ready();
    await user.click(await finalizeButton());
    const remedy = await within(
      await screen.findByRole("region", { name: "Finalize and sign checks" }),
    ).findByRole("button", { name: "Save the selections again" });
    const sentByFinalize = patchCalls().length;
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.click(remedy);
    await user.click(remedy);
    release();
    await waitFor(() => expect(screen.getByText("Draft saved")).toBeInTheDocument());
    expect(patchCalls()).toHaveLength(sentByFinalize + 1);
  });

  it("does not save the selections while the note text is being edited (R7)", async () => {
    const user = userEvent.setup();
    mountComposer({ [FINALIZE]: VOCAB });
    await ready();
    await user.click(await finalizeButton());
    const remedy = await within(
      await screen.findByRole("region", { name: "Finalize and sign checks" }),
    ).findByRole("button", { name: "Save the selections again" });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Apply edit" });
    const before = patchCalls().length;
    await user.click(remedy);
    expect(patchCalls()).toHaveLength(before);
  });

  it("does not finalize again from 'Try again' while the note text is being edited (R16)", async () => {
    const user = userEvent.setup();
    mountComposer({ [FINALIZE]: UNAVAILABLE });
    await ready();
    await user.click(await finalizeButton());
    const retry = await within(
      await screen.findByRole("region", { name: "Finalize and sign checks" }),
    ).findByRole("button", { name: "Try again" });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Apply edit" });
    await user.click(retry);
    expect(finalizeCalls()).toHaveLength(1);
  });
});

describe("a finalize that lost its answer and could not be reconciled (R9)", () => {
  it("does not leave the panel saying it is still finalizing once the note can be read again", async () => {
    const user = userEvent.setup();
    let reads = 0;
    mountComposer({
      [`GET ${BASE}`]: () => {
        reads += 1;
        if (reads === 2) {
          return refusal(503, "NOTE_VIEW_UNAVAILABLE", [], "m");
        }
        return {
          body: {
            id: ENC,
            organizationId: "org-1",
            patientId: PATIENT,
            admissionId: "adm-1",
            visitId: null,
            encounterType: "routine_visit",
            discipline: "rn",
            serviceDate: "2026-11-17",
            status: "draft",
            lateEntryTier: "normal",
            version: 3,
            authoredByUserId: "user-1",
            isF2f: false,
            signedAt: null,
            cosignedAt: null,
          },
        };
      },
      [FINALIZE]: () => {
        throw new TypeError("network down");
      },
    });
    await ready();
    await user.click(await finalizeButton());
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    const panel = await screen.findByRole("region", { name: "Finalize and sign checks" });
    expect(within(panel).queryByText("Finalizing: waiting for the server")).toBeNull();
    expect(panel).toHaveAttribute("aria-busy", "false");
    expect(within(panel).getByText("Unavailable")).toBeInTheDocument();
  });
});

describe("the typed late-entry reason and the leave guard (R12)", () => {
  it("asks before leaving while a late-entry reason is typed and not yet sent", async () => {
    const user = userEvent.setup();
    let answers = 0;
    mountComposer({
      [FINALIZE]: () => {
        answers += 1;
        if (answers === 1) return refusal(422, "LATE_ENTRY_REASON_REQUIRED");
        return refusal(422, "COMPLIANCE_GATE_FAILED", [
          { field: "carePlan", code: "CARE_PLAN_REVIEW_OVERDUE", message: "m" },
        ]);
      },
    });
    await ready();
    await user.click(await finalizeButton());
    await user.click(
      await within(
        await screen.findByRole("region", { name: "Finalize and sign checks" }),
      ).findByRole("button", { name: "Enter the late-entry reason" }),
    );
    await user.type(screen.getByLabelText("Late-entry reason"), FORTY);
    expect(
      screen.getByText("The late-entry reason is sent when you finalize."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await user.click(await screen.findByRole("button", { name: "Open care plan" }));
    expect(
      await screen.findByRole("alertdialog", { name: "Leave without saving?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Care plan screen" })).toBeNull();
  });
});

describe("opening the composer at the part of the note a blocker names (R8)", () => {
  const compose = (query: string): string =>
    `/patients/${PATIENT}/encounters/${ENC}/compose${query}`;

  it("opens the named section and focuses its heading", async () => {
    mountComposer({}, compose("?focus=section%3Aassessment&from=%2Fme%2Fvisits"));
    await ready();
    const heading = await screen.findByRole("heading", { name: "Assessment", level: 2 });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("opens the visit vitals and moves focus into them", async () => {
    mountComposer({}, compose("?focus=vitals"));
    await ready();
    const heading = await screen.findByRole("heading", { name: "Visit vitals" });
    await waitFor(() => expect(heading.closest('[tabindex="-1"]')).toHaveFocus());
  });

  it("goes to the note preview for the note text", async () => {
    mountComposer({}, compose("?focus=note"));
    await ready();
    await waitFor(() => expect(document.getElementById("visit-note-preview")).toHaveFocus());
  });

  it("ignores a value it does not know, and a section the template does not have", async () => {
    for (const query of ["?focus=evil", "?focus=section%3Anope", "?focus=section%3A", "?focus="]) {
      mountComposer({}, compose(query));
      await ready();
      expect(screen.queryByRole("heading", { name: "Visit vitals" })).toBeNull();
      expect(document.body).toHaveFocus();
      cleanup();
    }
  });
});
