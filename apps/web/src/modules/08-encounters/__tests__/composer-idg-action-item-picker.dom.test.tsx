// @vitest-environment jsdom
// The composer's IDG action item picker for an IDG follow-up visit (ADR-0114 S5b, VN-D64 to VN-D67): what it shows. The author chooses the ONE IDG action item the
// visit follows up, or none. The server decides everything (what the viewer is handed, the `idg.act` key, Part 2, who may change it, the cap); the picker shows the
// list, sends the one change and takes the server's answer. It shows facts (meeting date, decision, due date, status) and never an item's title. Changing the
// choice, the keyboard and the order of reads are in composer-idg-action-item-picker.change.dom.test.tsx. Synthetic data only.
import { ApiClientProvider, createApiClient, formatDateOnly } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposerIdgActionItemPicker } from "../composer-idg-action-item-picker";
import { makeFetch } from "./closure-test-harness";
import {
  ENC,
  ITEM_1,
  LIST,
  PATIENT,
  TITLE,
  gate,
  mount,
  noIdgAct,
  panel,
  planUpdate,
  puts,
  radio,
  reads,
  referral,
  refusal,
  resetWorld,
  settled,
  view,
  world,
} from "./idg-picker-test-support";

beforeEach(resetWorld);
afterEach(cleanup);

/**
 * The accessible name of a row: the parts as a sentence, the first ended by a stop and the rest by commas. jsdom puts a space round every inline span that a
 * browser does not, so each stop is matched with optional spaces either side.
 */
const sentence = (parts: readonly string[]): RegExp =>
  new RegExp(
    `^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*[.,]\\s*")}$`,
  );

describe("the item list", () => {
  it("shows each item as one choice with its decision, meeting date, due date and status in words, the linked one checked", async () => {
    mount();
    expect(await screen.findByRole("radio", { name: referral })).toBeChecked();
    expect(radio(planUpdate)).not.toBeChecked();
    expect(radio("No follow-up item")).not.toBeChecked();
    // the name is the decision, then the facts read as a sentence: a reader is given stops and commas, never the dot that separates them for the eye
    expect(radio(referral)).toHaveAccessibleName(
      sentence([
        "Decision: a referral",
        `Meeting ${formatDateOnly("2026-11-10")}`,
        `Due ${formatDateOnly("2026-11-17")}`,
        "Open",
      ]),
    );
    expect(radio(planUpdate)).toHaveAccessibleName(
      sentence([
        "Decision: an update to the plan of care",
        `Meeting ${formatDateOnly("2026-11-03")}`,
        "No due date",
        "In progress",
      ]),
    );
    expect(radio(referral).getAttribute("aria-label")).toBeNull();
    // the dot is on the page for the eye, and not in what a reader is given
    expect((radio(referral) as HTMLInputElement).labels?.[0]?.textContent).toContain("·");
    expect(screen.queryByRole("radio", { name: /·/ })).toBeNull();
  });

  it("checks 'No follow-up item' when nothing is linked", async () => {
    world.items = world.items.map((item) => ({ ...item, linked: false }));
    mount();
    expect(await screen.findByRole("radio", { name: "No follow-up item" })).toBeChecked();
    expect(radio(referral)).not.toBeChecked();
  });

  it("is one group of radios, and the group is described by the panel's own description", async () => {
    mount();
    await screen.findByRole("radio", { name: referral });
    const names = screen.getAllByRole("radio").map((r) => r.getAttribute("name"));
    expect(new Set(names).size).toBe(1);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(panel()).toHaveAccessibleDescription(
      /Choose the one IDG action item this visit follows up/,
    );
  });

  it("gives two pickers on one page their own ids and their own radio group", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: makeFetch({ [`GET ${LIST}`]: () => ({ body: view() }) }, world.calls),
    });
    render(
      <ApiClientProvider client={client}>
        <ComposerIdgActionItemPicker encounterId={ENC} editable onChanged={() => undefined} />
        <ComposerIdgActionItemPicker encounterId={ENC} editable onChanged={() => undefined} />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(6));
    const radios = screen.getAllByRole("radio");
    expect(new Set(radios.map((r) => r.id)).size).toBe(6);
    expect(new Set(radios.map((r) => r.getAttribute("name"))).size).toBe(2);
  });

  it("never shows an item's title or an id, whatever the answer carries", async () => {
    mount();
    await screen.findByRole("radio", { name: referral });
    expect(document.body.textContent).not.toContain("SYNTHETIC-DECOY");
    expect(document.body.textContent).not.toContain(ITEM_1);
    expect(document.body.textContent).not.toContain(PATIENT);
  });

  it("shows nothing while the first read is out", async () => {
    const hold = gate();
    const { onChanged } = mount({
      [`GET ${LIST}`]: async () => {
        await hold.promise;
        return { body: view() };
      },
    });
    await waitFor(() => expect(reads()).toHaveLength(1));
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    hold.open();
    await screen.findByRole("radio", { name: referral });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("says there is no item to choose, and that the section is documented below, when the list is empty", async () => {
    world.items = [];
    mount();
    expect(
      await screen.findByText(/no open IDG action item assigned to you for this patient/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This section is not drafted. Document it in the note below/),
    ).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("an item's status, in words", () => {
  it.each([
    ["open", "Open"],
    ["in_progress", "In progress"],
    ["completed", "Closed (completed)"],
    ["cancelled", "Closed (cancelled)"],
    ["auto_closed", "Closed (automatically)"],
  ])("%s reads %s", async (status, words) => {
    world.items = world.items.map((item) =>
      item.actionItemId === ITEM_1 ? { ...item, status } : item,
    );
    mount();
    const row = await screen.findByRole("radio", { name: referral });
    expect(row).toHaveAccessibleName(new RegExp(`, ${words.replace(/[()]/g, "\\$&")}$`));
  });

  it("says that a linked item M14 has closed is closed, keeps it checked and says the section still states it", async () => {
    world.items = world.items.map((item) =>
      item.actionItemId === ITEM_1 ? { ...item, status: "auto_closed" } : item,
    );
    mount();
    expect(await screen.findByRole("radio", { name: referral })).toBeChecked();
    expect(screen.getByText(/Closed \(automatically\)/)).toBeVisible();
    expect(screen.getByText(/The item this visit follows up is closed/)).toBeVisible();
    expect(screen.getByText(/The drafted section still states it/)).toBeVisible();
  });

  it("does not say an open item is closed", async () => {
    mount();
    await screen.findByRole("radio", { name: referral });
    expect(screen.queryByText(/is closed/)).not.toBeInTheDocument();
  });

  it("never renders a blank status: one this screen does not know says so", async () => {
    world.items = world.items.map((item) =>
      item.actionItemId === ITEM_1 ? { ...item, status: "on_hold" } : item,
    );
    mount();
    const row = await screen.findByRole("radio", { name: referral });
    expect(row).toHaveAccessibleName(/, Status unknown$/);
  });
});

describe("a role without the idg.act key", () => {
  it("gets a calm note that the section is not drafted and is documented below, not an error and not a retry", async () => {
    mount({ [`GET ${LIST}`]: noIdgAct });
    expect(await screen.findByText(/role cannot work with IDG action items/)).toBeVisible();
    expect(
      screen.getByText(/this section is not drafted. Document it in the note below/),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try again/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it("is described by that note, for the reader the focus moves to", async () => {
    mount({ [`GET ${LIST}`]: noIdgAct });
    await screen.findByText(/role cannot work with IDG action items/);
    expect(panel()).toHaveAccessibleDescription(/role cannot work with IDG action items/);
  });

  it("is matched on the refusal's code, not on its message: a 403 that names the key in words only is a visit with no list", async () => {
    mount({
      [`GET ${LIST}`]: refusal(403, "FORBIDDEN", "requires permission 'idg.act'"),
    });
    await waitFor(() => expect(reads()).toHaveLength(1));
    await settled();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByText(/role cannot work with IDG action items/)).not.toBeInTheDocument();
  });

  it("offers to clear the follow-up item (clearing needs no key) to an author, and not to a read-only note", async () => {
    mount({ [`GET ${LIST}`]: noIdgAct });
    expect(await screen.findByRole("button", { name: "Clear the follow-up item" })).toBeVisible();
    cleanup();
    mount({ [`GET ${LIST}`]: noIdgAct }, { editable: false });
    await screen.findByText(/role cannot work with IDG action items/);
    expect(screen.queryByRole("button", { name: "Clear the follow-up item" })).toBeNull();
  });
});

describe("a visit the server has no list for", () => {
  it.each([
    ["a 404 (the draft switch is off, or not the viewer's visit)", 404],
    ["a 422 (not an IDG follow-up visit)", 422],
    ["a 403 that is not about the key", 403],
  ])("shows nothing for %s", async (_name, status) => {
    mount({ [`GET ${LIST}`]: refusal(status, "X", "no") });
    await waitFor(() => expect(reads()).toHaveLength(1));
    await settled();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });
});

describe("a list that could not be read", () => {
  it("says so, offers a retry (and the note is not affected), and shows the list when the retry succeeds", async () => {
    let healthy = false;
    const { user } = mount({
      [`GET ${LIST}`]: () =>
        healthy
          ? { body: view() }
          : { status: 503, body: { error: { code: "DRAFT_UNAVAILABLE", message: "x" } } },
    });
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/documentation is not affected/i)).toBeInTheDocument();
    healthy = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("radio", { name: referral })).toBeChecked();
  });

  it.each([
    ["not a list", { patientId: PATIENT, items: "none" }],
    [
      "an element with no status",
      {
        patientId: PATIENT,
        items: [
          {
            actionItemId: ITEM_1,
            meetingDate: "2026-11-10",
            decisionLabel: "a referral",
            dueDate: null,
            linked: true,
          },
        ],
      },
    ],
    ["an element that is not an object", { patientId: PATIENT, items: ["x"] }],
    [
      "an element with no id",
      {
        patientId: PATIENT,
        items: [
          {
            meetingDate: "2026-11-10",
            decisionLabel: "a referral",
            dueDate: null,
            status: "open",
            linked: true,
          },
        ],
      },
    ],
  ])("takes an answer that is %s as a failure to read, never a blank row", async (_name, body) => {
    mount({ [`GET ${LIST}`]: () => ({ body }) });
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("keeps the panel (and the focused button) while it reads again, then puts focus on the panel when the list loads", async () => {
    let healthy = false;
    const reread = gate();
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        if (!healthy) return { status: 503, body: { error: {} } };
        await reread.promise;
        return { body: view() };
      },
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    healthy = true;
    await user.click(retry);
    expect(screen.getByRole("button", { name: /Trying again/ })).toHaveFocus();
    reread.open();
    expect(await screen.findByRole("radio", { name: referral })).toBeChecked();
    expect(panel()).toHaveFocus();
  });

  it("counts the attempts in the region that was already on the page, so a retry that fails again is heard", async () => {
    const { user } = mount({ [`GET ${LIST}`]: () => ({ status: 503, body: { error: {} } }) });
    const first = (await screen.findByText(/could not be loaded/)).closest("output");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/Still could not load the IDG action items \(attempt 2\)/),
    ).toBeVisible();
    expect(screen.getByText(/attempt 2/).closest("output")).toBe(first);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/Still could not load the IDG action items \(attempt 3\)/),
    ).toBeVisible();
  });

  it("does not run a second read when the waiting button is pressed again", async () => {
    const hold = gate();
    let healthy = false;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        if (!healthy) return { status: 503, body: { error: {} } };
        await hold.promise;
        return { body: view() };
      },
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    healthy = true;
    await user.click(retry);
    const waiting = screen.getByRole("button", { name: /Trying again/ });
    expect(waiting).toHaveAttribute("aria-disabled", "true");
    await user.click(waiting);
    hold.open();
    await screen.findByRole("radio", { name: referral });
    expect(reads()).toHaveLength(2);
  });

  it.each([
    [
      "an empty list",
      () => ({ body: { patientId: PATIENT, items: [] } }),
      /no open IDG action item/,
    ],
    ["a role without the key", noIdgAct, /role cannot work with IDG action items/],
    [
      "a visit with no list (404)",
      () => ({ status: 404, body: { error: {} } }),
      /no IDG action items to show for this visit/,
    ],
  ])(
    "a retry that finds nothing to choose says so and keeps the focus on the panel, not on a button that is gone (%s)",
    async (_name, answer, words) => {
      let failing = true;
      const { user } = mount({
        [`GET ${LIST}`]: () => (failing ? { status: 503, body: { error: {} } } : answer()),
      });
      const retry = await screen.findByRole("button", { name: "Try again" });
      retry.focus();
      failing = false;
      await user.click(retry);
      expect(await screen.findByText(words)).toBeInTheDocument();
      expect(panel()).toHaveFocus();
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    },
  );

  it("does not take the focus when the person moved on while the retry was reading", async () => {
    const hold = gate();
    let healthy = false;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        if (!healthy) return { status: 503, body: { error: {} } };
        await hold.promise;
        return { body: view() };
      },
    });
    const elsewhere = document.createElement("input");
    elsewhere.setAttribute("aria-label", "Somewhere else");
    document.body.append(elsewhere);
    try {
      const retry = await screen.findByRole("button", { name: "Try again" });
      healthy = true;
      await user.click(retry);
      elsewhere.focus();
      hold.open();
      await screen.findByRole("radio", { name: referral });
      expect(elsewhere).toHaveFocus();
    } finally {
      elsewhere.remove();
    }
  });

  it("offers to clear the follow-up item beside 'Try again' (clearing needs no M14): it sends the clear and says so, and the panel stays", async () => {
    const { user, onChanged } = mount({
      [`GET ${LIST}`]: () => ({ status: 503, body: { error: {} } }),
    });
    await user.click(await screen.findByRole("button", { name: "Clear the follow-up item" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ actionItemId: null });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(screen.getByText("Follow-up item cleared.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does not offer to clear a read-only note's item", async () => {
    mount({ [`GET ${LIST}`]: () => ({ status: 503, body: { error: {} } }) }, { editable: false });
    await screen.findByText(/could not be loaded/);
    expect(screen.queryByRole("button", { name: "Clear the follow-up item" })).toBeNull();
  });
});

describe("a note that is no longer a draft", () => {
  it("shows the chosen item without controls, and says why it cannot change", async () => {
    mount({}, { editable: false });
    expect(await screen.findByText(/Decision: a referral/)).toBeVisible();
    expect(screen.getByText(new RegExp(`Meeting ${formatDateOnly("2026-11-10")}`))).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(/can change only while the note is a draft/)).toBeVisible();
    expect(screen.queryByText(/plan of care/)).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("says no item was chosen when none is linked", async () => {
    world.items = world.items.map((item) => ({ ...item, linked: false }));
    mount({}, { editable: false });
    expect(await screen.findByText("No follow-up item was chosen for this visit.")).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("does not tell a note that cannot be edited to document the section below, whatever the list is", async () => {
    world.items = [];
    mount({}, { editable: false });
    expect(await screen.findByText(/no open IDG action item assigned to you/)).toBeVisible();
    expect(screen.queryByText(/Document it in the note below/)).not.toBeInTheDocument();
    cleanup();
    mount({ [`GET ${LIST}`]: noIdgAct }, { editable: false });
    expect(await screen.findByText(/role cannot work with IDG action items/)).toBeVisible();
    expect(screen.queryByText(/Document it in the note below/)).not.toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("has no axe violations on the picker, with its fieldset, legend, radios and live region", async () => {
    mount();
    await screen.findByRole("radio", { name: referral });
    const results = await axe.run(panel());
    expect(results.violations).toEqual([]);
  }, 60_000);

  it("has no axe violations on a picker whose linked item is closed", async () => {
    world.items = world.items.map((item) =>
      item.actionItemId === ITEM_1 ? { ...item, status: "completed" } : item,
    );
    mount();
    await screen.findByRole("radio", { name: referral });
    const results = await axe.run(panel());
    expect(results.violations).toEqual([]);
  }, 60_000);

  it("has no axe violations on the calm note", async () => {
    mount({ [`GET ${LIST}`]: noIdgAct });
    await screen.findByText(/role cannot work with IDG action items/);
    const results = await axe.run(panel());
    expect(results.violations).toEqual([]);
  }, 60_000);

  it("has no axe violations on the retry panel with its clear button", async () => {
    mount({ [`GET ${LIST}`]: () => ({ status: 503, body: { error: {} } }) });
    await screen.findByText(/could not be loaded/);
    const results = await axe.run(panel());
    expect(results.violations).toEqual([]);
  }, 60_000);
});
