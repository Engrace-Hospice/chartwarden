// @vitest-environment jsdom
// The composer's IDG action item picker (ADR-0114 S5b): changing the choice. One change at a time, the keyboard, what a refused change says and where the focus
// goes, clearing, and the order of reads and changes. What the picker shows is in composer-idg-action-item-picker.dom.test.tsx. Synthetic data only.
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLEARED_WORDS,
  ITEM_1,
  ITEM_2,
  LINK,
  LIST,
  applyLink,
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

describe("choosing", () => {
  it("choosing another item sends the one change, takes the server's list, says it saved and tells the composer", async () => {
    const { user, onChanged } = mount();
    await user.click(await screen.findByRole("radio", { name: planUpdate }));

    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
    expect(radio(referral)).not.toBeChecked();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({ actionItemId: ITEM_2 });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Follow-up item saved.");
  });

  it("'No follow-up item' clears the link, says no item is linked now, and reads the list again because the clear's own answer is not the list", async () => {
    const { user, onChanged } = mount();
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));

    await waitFor(() => expect(radio("No follow-up item")).toBeChecked());
    expect(puts()[0]?.body).toEqual({ actionItemId: null });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(CLEARED_WORDS);
    // the answer to a clear carries no items; the items still on offer stay on offer
    expect(radio(referral)).not.toBeChecked();
    expect(radio(planUpdate)).not.toBeChecked();
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(screen.queryByText(/no open IDG action item/)).not.toBeInTheDocument();
  });

  it("a clear shows the list without the link at once, while the re-read is still out: no empty-panel flash, and the focus stays on the radio pressed", async () => {
    const reread = gate();
    let readCount = 0;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        readCount += 1;
        const snapshot = view();
        if (readCount === 2) await reread.promise;
        return { body: snapshot };
      },
    });
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    // the re-read has not answered: what is on the screen is the picker's own picture of the cleared list
    expect(screen.queryByText(/no open IDG action item/)).not.toBeInTheDocument();
    expect(radio("No follow-up item")).toBeChecked();
    expect(radio(referral)).not.toBeChecked();
    expect(radio(planUpdate)).toBeInTheDocument();
    expect(radio("No follow-up item")).toHaveFocus();
    reread.open();
    await settled();
    expect(radio("No follow-up item")).toBeChecked();
    expect(radio("No follow-up item")).toHaveFocus();
  });

  it("clearing a closed linked item takes it off the list at once, while the re-read is still out, and after it", async () => {
    world.items = world.items.map((item) =>
      item.actionItemId === ITEM_1 ? { ...item, status: "auto_closed" } : item,
    );
    const reread = gate();
    let readCount = 0;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        readCount += 1;
        const snapshot = view();
        if (readCount === 2) await reread.promise;
        return { body: snapshot };
      },
      [`PUT ${LINK}`]: (call) => {
        world.items = world.items.filter((item) => item.actionItemId !== ITEM_1);
        return applyLink(call);
      },
    });
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(screen.queryByRole("radio", { name: referral })).toBeNull();
    expect(radio("No follow-up item")).toBeChecked();
    expect(radio(planUpdate)).toBeInTheDocument();
    reread.open();
    await settled();
    expect(screen.queryByRole("radio", { name: referral })).toBeNull();
    expect(radio(planUpdate)).toBeInTheDocument();
  });

  it("a clear that leaves the list read again but unreadable keeps the list on the screen", async () => {
    let readCount = 0;
    const { user } = mount({
      [`GET ${LIST}`]: () => {
        readCount += 1;
        return readCount === 1 ? { body: view() } : { status: 503, body: { error: {} } };
      },
    });
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    await settled();
    expect(radio("No follow-up item")).toBeChecked();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it("takes one change at a time: a second press while one is saving is ignored, and says so", async () => {
    const hold = gate();
    const { user } = mount({
      [`PUT ${LINK}`]: async (call) => {
        await hold.promise;
        return applyLink(call);
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await user.click(radio("No follow-up item"));

    expect(puts()).toHaveLength(1);
    expect(screen.getByText(/Saving the change/)).toBeInTheDocument();
    hold.open();
    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
    expect(screen.queryByText(/Saving the change/)).not.toBeInTheDocument();
  });

  it("while a change is saved the pressed radio stays focused and focusable, says it is waiting and why, and acts again after", async () => {
    const hold = gate();
    const { user } = mount({
      [`PUT ${LINK}`]: async (call) => {
        await hold.promise;
        return applyLink(call);
      },
    });
    const target = await screen.findByRole("radio", { name: planUpdate });
    // the live region is on the page, and silent, before anything is saved (one that mounts with its text is not announced)
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await user.click(target);

    await waitFor(() => expect(target).toHaveAttribute("aria-disabled", "true"));
    expect(target).not.toBeDisabled();
    expect(target).toHaveFocus();
    expect(target).toHaveAccessibleDescription(/saving/i);
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    hold.open();
    await waitFor(() => expect(target).toBeChecked());
    expect(target).not.toHaveAttribute("aria-disabled");
    expect(target).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("saved");
  });

  it("puts the reason for a waiting radio after the list, so no row moves under the pointer while it saves", async () => {
    const hold = gate();
    const { user } = mount({
      [`PUT ${LINK}`]: async (call) => {
        await hold.promise;
        return applyLink(call);
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    const reason = await screen.findByText(/Saving the change/);
    for (const choice of [referral, planUpdate, "No follow-up item"]) {
      expect(
        radio(choice).compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    hold.open();
    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
  });

  it("an answer that empties the list says nothing is left to choose, with the focus on the panel", async () => {
    const { user } = mount({
      [`PUT ${LINK}`]: () => {
        world.items = [];
        return { body: view() };
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/no open IDG action item/)).toBeInTheDocument();
    expect(panel()).toHaveFocus();
  });
});

describe("the keyboard", () => {
  it("the arrow keys move the focus round the group and choose nothing", async () => {
    const { user, onChanged } = mount();
    const first = await screen.findByRole("radio", { name: referral });
    first.focus();

    await user.keyboard("{ArrowDown}");
    expect(radio(planUpdate)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(radio("No follow-up item")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(radio(referral)).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(radio("No follow-up item")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(radio(planUpdate)).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(radio("No follow-up item")).toHaveFocus();

    await settled();
    expect(puts()).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
    // nothing was checked on the way: the choice is still the item the visit is linked to
    expect(radio(referral)).toBeChecked();
    expect(radio("No follow-up item")).not.toBeChecked();
  });

  it("Space on the focused radio chooses it", async () => {
    const { user } = mount();
    const first = await screen.findByRole("radio", { name: referral });
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(puts()).toHaveLength(0);
    await user.keyboard(" ");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ actionItemId: ITEM_2 });
    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
    expect(radio(planUpdate)).toHaveFocus();
  });

  it("Enter on the focused radio chooses it", async () => {
    const { user } = mount();
    const first = await screen.findByRole("radio", { name: referral });
    first.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(radio("No follow-up item")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ actionItemId: null });
  });

  it("Enter on the radio that is already chosen sends nothing", async () => {
    const { user } = mount();
    const first = await screen.findByRole("radio", { name: referral });
    first.focus();
    await user.keyboard("{Enter}");
    await settled();
    expect(puts()).toHaveLength(0);
  });
});

describe("a change the server did not take", () => {
  it("the cap on changes is said in the picker's words, the choice stays where the server has it and the composer is not told", async () => {
    const { user, onChanged } = mount({
      [`PUT ${LINK}`]: refusal(409, "IDG_ACTION_ITEM_LINK_LIMIT"),
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(
      await screen.findByText(/as many changes to its IDG follow-up item as it can hold/),
    ).toBeVisible();
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(radio(referral)).toBeChecked();
    expect(radio(planUpdate)).not.toBeChecked();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("an item that is no longer handed to the viewer says so, reads the list again and drops it, with the focus on the panel", async () => {
    const { user } = mount({
      [`PUT ${LINK}`]: () => {
        world.items = world.items.filter((item) => item.actionItemId !== ITEM_2);
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/no longer available to you/)).toBeVisible();
    await waitFor(() => expect(reads()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("radio", { name: planUpdate })).toBeNull());
    expect(radio(referral)).toBeChecked();
    expect(panel()).toHaveFocus();
  });

  it("a refused change whose radio is still there leaves the focus on that radio", async () => {
    const { user } = mount({ [`PUT ${LINK}`]: refusal(409, "IDG_ACTION_ITEM_LINK_LIMIT") });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    await settled();
    expect(radio(planUpdate)).toHaveFocus();
  });

  it("an item that was withdrawn, and the last one, leaves nothing to choose: the refusal stays on the page and the panel has the focus", async () => {
    const { user } = mount({
      [`PUT ${LINK}`]: () => {
        world.items = [];
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/no open IDG action item/)).toBeInTheDocument();
    expect(screen.getByText(/no longer available to you/)).toBeVisible();
    expect(panel()).toHaveFocus();
  });

  it.each([
    [404, "NOT_FOUND"],
    [422, "UNKNOWN_TEMPLATE_SECTION"],
  ])(
    "a refused change whose re-read answers %s (no list for this visit now) says so, keeps the refusal and puts the focus on the panel, not on the page",
    async (status, code) => {
      let gone = false;
      const { user } = mount({
        [`GET ${LIST}`]: (call) => (gone ? refusal(status, code)(call) : { body: view() }),
        [`PUT ${LINK}`]: () => {
          gone = true;
          return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
        },
      });
      await user.click(await screen.findByRole("radio", { name: planUpdate }));
      expect(await screen.findByText(/no IDG action items to show for this visit/)).toBeVisible();
      expect(screen.getByText(/no longer available to you/)).toBeVisible();
      expect(panel()).toHaveFocus();
      expect(panel()).toHaveAccessibleDescription(/no IDG action items to show/);
    },
  );

  it("a role that lost idg.act says so, then the re-read shows the calm note with the focus on the panel", async () => {
    let lost = false;
    const { user } = mount({
      [`GET ${LIST}`]: () => (lost ? noIdgAct() : { body: view() }),
      [`PUT ${LINK}`]: () => {
        lost = true;
        return noIdgAct();
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(
      await screen.findByText(/this section is not drafted. Document it in the note below/),
    ).toBeVisible();
    expect(panel()).toHaveFocus();
    expect(screen.queryByRole("radio")).toBeNull();
    // the note is calm: the refusal that led here is not repeated beside it as an error
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/so nothing was changed/)).toBeNull();
    // clearing needs no key, so the way out is on the panel
    expect(screen.getByRole("button", { name: "Clear the follow-up item" })).toBeVisible();
  });

  it("a clear from the no-key panel is sent, announced, read again, and leaves the focus on the button that was pressed", async () => {
    const { user, onChanged } = mount({ [`GET ${LIST}`]: noIdgAct });
    const clear = await screen.findByRole("button", { name: "Clear the follow-up item" });
    await user.click(clear);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ actionItemId: null });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(screen.getByRole("status")).toHaveTextContent(CLEARED_WORDS);
    expect(screen.getByText(/role cannot work with IDG action items/)).toBeVisible();
    expect(clear).toHaveFocus();
  });

  it.each([
    ["a server fault", () => ({ status: 500, body: { error: {} } }), /service is unavailable/, 1],
    ["a signed note", refusal(409, "IMMUTABLE_AFTER_SIGN"), /already signed/, 0],
    ["an item that is gone (404)", refusal(404, "NOT_FOUND"), /no longer available to you/, 0],
  ])(
    "a clear from the no-key panel that ends in %s is said beside the note, not swallowed",
    async (_name, answer, words, composerTold) => {
      const { user, onChanged } = mount({ [`GET ${LIST}`]: noIdgAct, [`PUT ${LINK}`]: answer });
      await user.click(await screen.findByRole("button", { name: "Clear the follow-up item" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(words);
      // the note is still there, and so is the way to try again
      expect(screen.getByText(/role cannot work with IDG action items/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Clear the follow-up item" })).toBeVisible();
      // only a change whose outcome is unknown (a fault) may have landed
      expect(onChanged).toHaveBeenCalledTimes(composerTold);
    },
  );

  it("a clear from the no-key panel that gets no answer at all is said too, and tells the composer (it may have landed)", async () => {
    const { user, onChanged } = mount({
      [`GET ${LIST}`]: noIdgAct,
      [`PUT ${LINK}`]: (): never => {
        throw new Error("offline");
      },
    });
    await user.click(await screen.findByRole("button", { name: "Clear the follow-up item" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach the server/);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("a failed clear from the empty panel is said there too", async () => {
    world.items = [];
    const { user } = mount({ [`PUT ${LINK}`]: refusal(409, "IMMUTABLE_AFTER_SIGN") });
    await user.click(await screen.findByRole("button", { name: "Clear the follow-up item" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already signed/);
  });

  it("a 403 that is not about the key is said in the shared words (the code is matched, not the message)", async () => {
    const { user } = mount({
      [`PUT ${LINK}`]: refusal(403, "FORBIDDEN", "requires permission 'idg.act'"),
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/do not have access to do that on this note/)).toBeVisible();
    expect(screen.queryByText(/role cannot work with IDG action items/)).not.toBeInTheDocument();
  });

  it("the missing key on a link is said in the picker's words", async () => {
    const { user } = mount({ [`PUT ${LINK}`]: noIdgAct });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(
      await screen.findByText(/role cannot work with IDG action items, so nothing was changed/),
    ).toBeVisible();
  });

  it("a signed note says it is signed", async () => {
    const { user } = mount({ [`PUT ${LINK}`]: refusal(409, "IMMUTABLE_AFTER_SIGN") });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/already signed/)).toBeVisible();
  });

  it("a note that is not an IDG follow-up is said in the picker's own words, not the addendum's", async () => {
    const { user } = mount({ [`PUT ${LINK}`]: refusal(422, "UNKNOWN_TEMPLATE_SECTION") });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/not drafted from an IDG action item/)).toBeVisible();
    expect(screen.queryByText(/addendum/i)).not.toBeInTheDocument();
  });

  it("an answer that is not a list is not taken as the change: it says so and reads the list again", async () => {
    const { user, onChanged } = mount({ [`PUT ${LINK}`]: () => ({ body: {} }) });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/could not confirm the change/i)).toBeInTheDocument();
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refusal whose re-read fails too stays on the retry panel, which says the change was not saved until a retry succeeds", async () => {
    let readsSoFar = 0;
    let healthy = false;
    const { user } = mount({
      [`GET ${LIST}`]: () => {
        readsSoFar += 1;
        return readsSoFar === 1 || healthy
          ? { body: view() }
          : { status: 503, body: { error: {} } };
      },
      [`PUT ${LINK}`]: refusal(404, "NOT_FOUND"),
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/no longer available to you/)).toBeVisible();
    expect(panel()).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Still could not load the IDG action items/)).toBeVisible();
    expect(screen.getByText(/no longer available to you/)).toBeVisible();
    healthy = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("radio", { name: referral });
    expect(screen.queryByText(/no longer available to you/)).toBeNull();
  });

  it("a later change cleans the refusal off the page", async () => {
    let refuse = true;
    const { user } = mount({
      [`PUT ${LINK}`]: (call) =>
        refuse ? refusal(409, "IDG_ACTION_ITEM_LINK_LIMIT")(call) : applyLink(call),
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await screen.findByText(/as many changes/);
    refuse = false;
    await waitFor(() => expect(reads()).toHaveLength(2));
    await user.click(radio(planUpdate));
    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
    expect(screen.queryByText(/as many changes/)).toBeNull();
  });
});

describe("the draft is told when the link may have changed under the person", () => {
  it.each([
    ["a server fault (500)", () => ({ status: 500, body: { error: {} } })],
    [
      "no answer at all",
      (): never => {
        throw new Error("offline");
      },
    ],
  ])(
    "a change that ends in %s may have landed, so the composer re-reads the draft",
    async (_name, answer) => {
      const { user, onChanged } = mount({ [`PUT ${LINK}`]: answer });
      await user.click(await screen.findByRole("radio", { name: planUpdate }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
      await waitFor(() => expect(reads()).toHaveLength(2));
      expect(radio(referral)).toBeChecked();
    },
  );

  it("a refused change whose re-read finds a different item linked (another session changed it) tells the composer once", async () => {
    const { user, onChanged } = mount({
      [`PUT ${LINK}`]: () => {
        // another session linked the second item meanwhile, and this change was then refused
        world.items = world.items.map((item) => ({
          ...item,
          linked: item.actionItemId === ITEM_2,
        }));
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    await settled();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("a refused change whose re-read finds the same item linked does not tell the composer", async () => {
    const { user, onChanged } = mount({
      [`PUT ${LINK}`]: refusal(409, "IDG_ACTION_ITEM_LINK_LIMIT"),
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    await settled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("the list is never older than the change just made", () => {
  it("a re-read that began before a later change committed and answers after it is dropped, and the list is read once more", async () => {
    const staleRead = gate();
    let readCount = 0;
    let refuse = true;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        readCount += 1;
        const snapshot = view();
        // the re-read after the refused change is held: it will answer after the next change
        if (readCount === 2) await staleRead.promise;
        return { body: snapshot };
      },
      [`PUT ${LINK}`]: (call) =>
        refuse ? refusal(409, "IDG_ACTION_ITEM_LINK_LIMIT")(call) : applyLink(call),
    });
    const target = await screen.findByRole("radio", { name: planUpdate });
    await user.click(target);
    await waitFor(() => expect(reads()).toHaveLength(2));
    refuse = false;
    await user.click(target);
    await waitFor(() => expect(target).toBeChecked());
    staleRead.open();
    await waitFor(() => expect(reads()).toHaveLength(3));
    await settled();
    expect(radio(planUpdate)).toBeChecked();
    expect(radio(referral)).not.toBeChecked();
  });

  it("a re-read that answers while the next change is still being saved is held back, and read again once that change has settled", async () => {
    const staleRead = gate();
    const hold = gate();
    let readCount = 0;
    let refuse = true;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        readCount += 1;
        const snapshot = view();
        if (readCount === 2) await staleRead.promise;
        return { body: snapshot };
      },
      [`PUT ${LINK}`]: async (call) => {
        if (refuse) return refusal(409, "IDG_ACTION_ITEM_LINK_LIMIT")(call);
        await hold.promise;
        return applyLink(call);
      },
    });
    const target = await screen.findByRole("radio", { name: planUpdate });
    await user.click(target);
    await waitFor(() => expect(reads()).toHaveLength(2));
    refuse = false;
    await user.click(target);
    await waitFor(() => expect(target).toHaveAttribute("aria-disabled", "true"));
    // the re-read answers with the old list while the change is in flight
    staleRead.open();
    await settled();
    expect(reads()).toHaveLength(2);
    expect(radio(referral)).toBeChecked();
    hold.open();
    await waitFor(() => expect(reads()).toHaveLength(3));
    await waitFor(() => expect(radio(planUpdate)).toBeChecked());
    expect(radio(referral)).not.toBeChecked();
  });

  it("a change whose answer lands after the picker left the screen touches nothing and tells nobody", async () => {
    const hold = gate();
    const { user, onChanged, unmount } = mount({
      [`PUT ${LINK}`]: async (call) => {
        await hold.promise;
        return applyLink(call);
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    unmount();
    hold.open();
    await act(async () => {
      await hold.promise;
    });
    await settled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(reads()).toHaveLength(1);
  });
});

describe("the re-read after a clear is quiet, and only that one", () => {
  it("a clear's slow re-read does not leave its quiet pass behind for a later read: a later change refused, then a read that fails, is said", async () => {
    const reread = gate();
    const secondChange = gate();
    let getCount = 0;
    let putCount = 0;
    const { user } = mount({
      [`GET ${LIST}`]: async () => {
        getCount += 1;
        const snapshot = view();
        if (getCount === 2) await reread.promise;
        if (getCount >= 3) return { status: 503, body: { error: {} } };
        return { body: snapshot };
      },
      [`PUT ${LINK}`]: async (call) => {
        putCount += 1;
        if (putCount === 1) return applyLink(call);
        await secondChange.promise;
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    // the clear: its re-read is out and slow
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    // the author picks the second item before it answers, and that change is still being saved when the slow re-read answers (it is dropped)
    await user.click(radio(planUpdate));
    await waitFor(() => expect(puts()).toHaveLength(2));
    reread.open();
    await settled();
    secondChange.open();
    // the change is refused and the list read again; that read fails: it is said, with the way to try again, not hidden behind a list that may be out of date
    expect(await screen.findByText(/could not be loaded/)).toBeVisible();
    expect(screen.getByText(/no longer available to you/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it.each([
    ["a role without the key (403)", noIdgAct, /role cannot work with IDG action items/],
    [
      "a visit with no list (404)",
      refusal(404, "NOT_FOUND"),
      /no IDG action items to show for this visit/,
    ],
    [
      "a visit with no list (422)",
      refusal(422, "UNKNOWN_TEMPLATE_SECTION"),
      /no IDG action items to show for this visit/,
    ],
  ])(
    "a clear whose re-read answers %s keeps the panel, says so in a note, keeps what was announced and puts the focus on the panel",
    async (_name, answer, words) => {
      let cleared = false;
      const { user } = mount({
        [`GET ${LIST}`]: (call) => (cleared ? answer(call) : { body: view() }),
        [`PUT ${LINK}`]: (call) => {
          cleared = true;
          return applyLink(call);
        },
      });
      await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
      expect(await screen.findByText(words)).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(CLEARED_WORDS);
      expect(panel()).toHaveFocus();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("a clear that leaves nothing listed (the only item was the linked, closed one) keeps the note when its re-read fails, as it keeps a list that has items", async () => {
    world.items = [{ ...world.items[0], status: "auto_closed" } as (typeof world.items)[number]];
    let cleared = false;
    const { user } = mount({
      [`GET ${LIST}`]: () => (cleared ? { status: 503, body: { error: {} } } : { body: view() }),
      [`PUT ${LINK}`]: (call) => {
        cleared = true;
        world.items = [];
        return applyLink(call);
      },
    });
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
    expect(await screen.findByText(/no open IDG action item assigned to you/)).toBeVisible();
    await waitFor(() => expect(reads()).toHaveLength(2));
    await settled();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.getByText(/no open IDG action item assigned to you/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(CLEARED_WORDS);
  });

  it("a clear from the no-key panel whose re-read fails keeps the note rather than replacing it with a failure", async () => {
    let cleared = false;
    const { user } = mount({
      [`GET ${LIST}`]: () => (cleared ? { status: 503, body: { error: {} } } : noIdgAct()),
      [`PUT ${LINK}`]: (call) => {
        cleared = true;
        return applyLink(call);
      },
    });
    await user.click(await screen.findByRole("button", { name: "Clear the follow-up item" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    await settled();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.getByText(/role cannot work with IDG action items/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(CLEARED_WORDS);
  });
});

describe("what a clear says", () => {
  it("says no item is linked now, which is true whether or not one was, and still tells the composer (the answer does not say whether anything changed)", async () => {
    world.items = world.items.map((item) => ({ ...item, linked: false }));
    const { user, onChanged } = mount();
    await user.click(await screen.findByRole("button", { name: "Clear the follow-up item" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent(CLEARED_WORDS);
    expect(screen.getByRole("status")).not.toHaveTextContent(/cleared/i);
  });
});
