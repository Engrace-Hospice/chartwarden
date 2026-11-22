// @vitest-environment jsdom
// The composer's IDG action item picker for an IDG follow-up visit (ADR-0114 S5b, VN-D64 to VN-D67): the author chooses the ONE open IDG action item the visit
// follows up, or none. The server decides everything (what the viewer is handed, the `idg.read` key, Part 2, who may change it, the cap); the picker shows the
// list, sends the one change and takes the server's answer. It shows facts (meeting date, decision, due date, status) and never an item's title. Synthetic data only.
import { ApiClientProvider, createApiClient, formatDateOnly } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerIdgActionItemPicker } from "../composer-idg-action-item-picker";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ITEM_1 = "dddddddd-4444-4444-8444-dddddddddd01";
const ITEM_2 = "dddddddd-4444-4444-8444-dddddddddd02";
const LIST = `/api/v1/encounters/${ENC}/idg-action-items`;
const LINK = `/api/v1/encounters/${ENC}/idg-action-item`;
const TITLE = "IDG follow-up item";
const DECOY_TITLE = "Call the pharmacy about the SYNTHETIC-DECOY title";

interface Item {
  actionItemId: string;
  meetingDate: string;
  decisionKind: string;
  decisionLabel: string;
  dueDate: string | null;
  status: "open" | "in_progress";
  linked: boolean;
  // Not part of the API: a title that must never reach the screen even if it did arrive.
  title?: string;
}
const initial = (): Item[] => [
  {
    actionItemId: ITEM_1,
    meetingDate: "2026-11-10",
    decisionKind: "referral",
    decisionLabel: "a referral",
    dueDate: "2026-11-17",
    status: "open",
    linked: true,
    title: DECOY_TITLE,
  },
  {
    actionItemId: ITEM_2,
    meetingDate: "2026-11-03",
    decisionKind: "care_plan_update",
    decisionLabel: "an update to the plan of care",
    dueDate: null,
    status: "in_progress",
    linked: false,
  },
];
let items: Item[];
let calls: Call[];

beforeEach(() => {
  items = initial();
  calls = [];
});
afterEach(cleanup);

const view = () => ({ patientId: PATIENT, items });
const puts = (): Call[] => calls.filter((c) => c.method === "PUT");
const reads = (): Call[] => calls.filter((c) => c.method === "GET");

/** A promise a test settles by hand, to hold a request in flight. */
function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The server's answer to a choice: the list with that one item linked (or none, for `null`). */
const applyLink: Responder = (call) => {
  const chosen = (call.body as { actionItemId: string | null }).actionItemId;
  items = items.map((item) => ({ ...item, linked: item.actionItemId === chosen }));
  return { body: view() };
};
const refusal = (status: number, code: string, message = "refused"): Responder => {
  return () => ({ status, body: { error: { code, message } } });
};
const noIdgRead = (): { status: number; body: unknown } => ({
  status: 403,
  body: { error: { code: "FORBIDDEN", message: "requires permission 'idg.read'" } },
});

function mount(
  over: Record<string, Responder> = {},
  props: { readonly editable?: boolean; readonly onChanged?: () => void } = {},
) {
  const routes: Record<string, Responder> = {
    [`GET ${LIST}`]: () => ({ body: view() }),
    [`PUT ${LINK}`]: applyLink,
    ...over,
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  const onChanged = props.onChanged ?? vi.fn();
  render(
    <ApiClientProvider client={client}>
      <ComposerIdgActionItemPicker
        encounterId={ENC}
        editable={props.editable ?? true}
        onChanged={onChanged}
      />
    </ApiClientProvider>,
  );
  return { user: userEvent.setup(), onChanged };
}

const referral = /a referral/;
const planUpdate = /plan of care/;
const radio = (name: RegExp | string) => screen.getByRole("radio", { name });
const panel = () => screen.getByRole("group", { name: TITLE });
/** Lets the answer that was just recorded be rendered (a panel that is absent must be absent after it, not before it). */
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("the item list", () => {
  it("shows each open item as one choice with its meeting date, decision, due date and status, the linked one checked", async () => {
    mount();
    expect(await screen.findByRole("radio", { name: referral })).toBeChecked();
    expect(radio(planUpdate)).not.toBeChecked();
    expect(radio("No follow-up item")).not.toBeChecked();
    expect(radio(referral)).toHaveAccessibleName(
      `Decision: a referral Meeting ${formatDateOnly("2026-11-10")} · Due ${formatDateOnly("2026-11-17")} · Open`,
    );
    expect(radio(planUpdate)).toHaveAccessibleName(
      `Decision: an update to the plan of care Meeting ${formatDateOnly("2026-11-03")} · No due date · In progress`,
    );
  });

  it("checks 'No follow-up item' when nothing is linked", async () => {
    items = items.map((item) => ({ ...item, linked: false }));
    mount();
    expect(await screen.findByRole("radio", { name: "No follow-up item" })).toBeChecked();
    expect(radio(referral)).not.toBeChecked();
  });

  it("is one group of radios, so the arrow keys move between the choices", async () => {
    mount();
    await screen.findByRole("radio", { name: referral });
    const names = screen.getAllByRole("radio").map((r) => r.getAttribute("name"));
    expect(new Set(names).size).toBe(1);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
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
    items = [];
    mount();
    expect(
      await screen.findByText(/no open IDG action item assigned to you for this patient/),
    ).toBeInTheDocument();
    expect(screen.getByText(/section is not drafted: document it in the note below/)).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a role without the idg.read key", () => {
  it("gets a calm note that the section is not drafted and is documented below, not an error and not a retry", async () => {
    mount({ [`GET ${LIST}`]: noIdgRead });
    expect(await screen.findByText(/role cannot see IDG action items/)).toBeVisible();
    expect(
      screen.getByText(/this section is not drafted. Document it in the note below/),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it("is described by that note, for the reader the focus moves to", async () => {
    mount({ [`GET ${LIST}`]: noIdgRead });
    await screen.findByText(/role cannot see IDG action items/);
    expect(panel()).toHaveAccessibleDescription(/role cannot see IDG action items/);
  });
});

describe("a visit the server has no list for", () => {
  it.each([
    ["a 404 (the draft switch is off, or not the viewer's visit)", 404],
    ["a 422 (not an IDG follow-up visit)", 422],
    ["a 403 that does not name idg.read", 403],
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
    healthy = false;
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
    ["a role without the key", noIdgRead, /role cannot see IDG action items/],
    [
      "a visit with no list (404)",
      () => ({ status: 404, body: { error: {} } }),
      /no open IDG action item/,
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
});

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

  it("'No follow-up item' clears the link: it sends null and says it was cleared", async () => {
    const { user, onChanged } = mount();
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));

    await waitFor(() => expect(radio("No follow-up item")).toBeChecked());
    expect(puts()[0]?.body).toEqual({ actionItemId: null });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Follow-up item cleared.");
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

  it("is operable from the keyboard: Space on the focused radio chooses it", async () => {
    const { user } = mount();
    const target = await screen.findByRole("radio", { name: planUpdate });
    target.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ actionItemId: ITEM_2 });
  });

  it("an answer that empties the list says nothing is left to choose, with the focus on the panel", async () => {
    const { user } = mount({
      [`PUT ${LINK}`]: () => {
        items = [];
        return { body: view() };
      },
    });
    await user.click(await screen.findByRole("radio", { name: "No follow-up item" }));
    expect(await screen.findByText(/no open IDG action item/)).toBeInTheDocument();
    expect(panel()).toHaveFocus();
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
        items = items.filter((item) => item.actionItemId !== ITEM_2);
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
    const { user } = mount({ [`PUT ${LINK}`]: refusal(500, "INTERNAL") });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    await settled();
    expect(radio(planUpdate)).toHaveFocus();
  });

  it("an item that was withdrawn, and the last one, leaves nothing to choose: the refusal stays on the page and the panel has the focus", async () => {
    const { user } = mount({
      [`PUT ${LINK}`]: () => {
        items = [];
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/no open IDG action item/)).toBeInTheDocument();
    expect(screen.getByText(/no longer available to you/)).toBeVisible();
    expect(panel()).toHaveFocus();
  });

  it("a role that lost idg.read says so, then the re-read shows the calm note with the focus on the panel", async () => {
    let lost = false;
    const { user } = mount({
      [`GET ${LIST}`]: () => (lost ? noIdgRead() : { body: view() }),
      [`PUT ${LINK}`]: () => {
        lost = true;
        return noIdgRead();
      },
    });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(
      await screen.findByText(/this section is not drafted. Document it in the note below/),
    ).toBeVisible();
    expect(panel()).toHaveFocus();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("a 403 that is not about idg.read is said in the shared words", async () => {
    const { user } = mount({ [`PUT ${LINK}`]: refusal(403, "FORBIDDEN", "not the author") });
    await user.click(await screen.findByRole("radio", { name: planUpdate }));
    expect(await screen.findByText(/do not have access to do that on this note/)).toBeVisible();
    expect(screen.queryByText(/not the author/)).not.toBeInTheDocument();
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
    items = items.map((item) => ({ ...item, linked: false }));
    mount({}, { editable: false });
    expect(await screen.findByText("No follow-up item was chosen for this visit.")).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("has no axe violations on the picker, with its fieldset, legend, radios and live region", async () => {
    mount();
    await screen.findByRole("radio", { name: referral });
    const results = await axe.run(panel());
    expect(results.violations).toEqual([]);
  }, 60_000);

  it("has no axe violations on the calm note", async () => {
    mount({ [`GET ${LIST}`]: noIdgRead });
    await screen.findByText(/role cannot see IDG action items/);
    const results = await axe.run(panel());
    expect(results.violations).toEqual([]);
  }, 60_000);
});
