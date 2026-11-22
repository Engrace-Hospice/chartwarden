// @vitest-environment jsdom
// The composer's plan picker for a social-work or chaplain visit (ADR-0114 S4b, VN-D60, VN-D63): the goals and interventions of the discipline's plan, each
// kept in this visit or left out, one idempotent toggle per box. The server decides everything (what the viewer is handed, Part 2, who may change it); the
// picker shows the list, sends the one change and takes the server's answer. Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerDisciplinePlanPicker } from "../composer-discipline-plan-picker";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GOAL_1 = "dddddddd-4444-4444-8444-dddddddddd01";
const GOAL_2 = "dddddddd-4444-4444-8444-dddddddddd02";
const IV_1 = "eeeeeeee-5555-4555-8555-eeeeeeeeee01";
const BASE = `/api/v1/encounters/${ENC}/discipline-plan-elements`;

interface Element {
  elementId: string;
  kind: "goal" | "intervention";
  text: string;
  kept: boolean;
}
const initial = (): Element[] => [
  { elementId: GOAL_1, kind: "goal", text: "Name two ways to cope", kept: true },
  { elementId: GOAL_2, kind: "goal", text: "Write a letter to the family", kept: false },
  { elementId: IV_1, kind: "intervention", text: "Supportive counselling, weekly", kept: true },
];
let elements: Element[];
let calls: Call[];

beforeEach(() => {
  elements = initial();
  calls = [];
});
afterEach(cleanup);

const view = () => ({ patientId: PATIENT, elements });
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

/** The server's answer to a toggle: the list with that one element changed. */
const applyToggle: Responder = (call) => {
  const id = call.path.split("/").at(-1);
  const included = (call.body as { included: boolean }).included;
  elements = elements.map((e) => (e.elementId === id ? { ...e, kept: included } : e));
  return { body: view() };
};

function mount(
  over: Record<string, Responder> = {},
  props: {
    readonly editable?: boolean;
    readonly onChanged?: () => void;
    readonly discipline?: string;
  } = {},
) {
  const routes: Record<string, Responder> = {
    [`GET ${BASE}`]: () => ({ body: view() }),
    ...Object.fromEntries([GOAL_1, GOAL_2, IV_1].map((id) => [`PUT ${BASE}/${id}`, applyToggle])),
    ...over,
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  const onChanged = props.onChanged ?? vi.fn();
  const ui = (revision: number) => (
    <ApiClientProvider client={client}>
      <ComposerDisciplinePlanPicker
        encounterId={ENC}
        discipline={props.discipline ?? "msw"}
        editable={props.editable ?? true}
        revision={revision}
        onChanged={onChanged}
      />
    </ApiClientProvider>
  );
  const rendered = render(ui(0));
  return {
    user: userEvent.setup(),
    onChanged,
    bump: (revision: number) => rendered.rerender(ui(revision)),
  };
}

const box = (label: RegExp) => screen.getByRole("checkbox", { name: label });
/** Lets the answer that was just recorded be rendered (a panel that is absent must be absent after it, not before it). */
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("the plan list", () => {
  it("shows each goal and intervention with a box ticked when this visit keeps it", async () => {
    mount();
    expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeChecked();
    expect(box(/Write a letter to the family/)).not.toBeChecked();
    expect(box(/Supportive counselling, weekly/)).toBeChecked();
    expect(screen.getByText("Goals")).toBeInTheDocument();
    expect(screen.getByText("Interventions")).toBeInTheDocument();
  });

  it("says the plan itself is never changed", async () => {
    mount();
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    expect(screen.getByText(/The plan itself is never changed/)).toBeInTheDocument();
  });

  it.each([403, 404, 422])(
    "shows nothing for a visit the server has no plan list for (%s)",
    async (status) => {
      mount({ [`GET ${BASE}`]: () => ({ status, body: { error: { code: "X" } } }) });
      await waitFor(() => expect(reads()).toHaveLength(1));
      await settled();
      // not an error panel either: this visit simply has no plan list for the viewer
      expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
      expect(screen.queryByText("Goals")).not.toBeInTheDocument();
      expect(screen.queryByText(/plan for this visit/)).not.toBeInTheDocument();
    },
  );

  it("shows nothing for an empty plan", async () => {
    elements = [];
    mount();
    await waitFor(() => expect(reads()).toHaveLength(1));
    await settled();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/plan for this visit/)).not.toBeInTheDocument();
  });

  it("says so, and offers a retry, when the list could not be loaded (and the note is not affected)", async () => {
    let healthy = false;
    const { user } = mount({
      [`GET ${BASE}`]: () => (healthy ? { body: view() } : { status: 500, body: { error: {} } }),
    });
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/documentation is not affected/i)).toBeInTheDocument();

    healthy = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeChecked();
  });

  it("reads the list again when a draft section was resolved (the revision moves)", async () => {
    const { bump } = mount();
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    elements = elements.map((e) => ({ ...e, kept: false }));
    bump(1);
    await waitFor(() => expect(box(/Name two ways to cope/)).not.toBeChecked());
    expect(reads()).toHaveLength(2);
  });
});

describe("keeping and leaving out", () => {
  it("unticking a kept goal sends the one change, takes the server's list and tells the composer", async () => {
    const { user, onChanged } = mount();
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));

    await waitFor(() => expect(box(/Name two ways to cope/)).not.toBeChecked());
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.path).toBe(`${BASE}/${GOAL_1}`);
    expect(puts()[0]?.body).toEqual({ included: false });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("ticking a left-out goal asks for it to be kept", async () => {
    const { user } = mount();
    await user.click(await screen.findByRole("checkbox", { name: /Write a letter to the family/ }));

    await waitFor(() => expect(box(/Write a letter to the family/)).toBeChecked());
    expect(puts()[0]?.body).toEqual({ included: true });
  });

  it("works on an intervention as on a goal", async () => {
    const { user } = mount();
    await user.click(await screen.findByRole("checkbox", { name: /Supportive counselling/ }));
    await waitFor(() => expect(box(/Supportive counselling/)).not.toBeChecked());
    expect(puts()[0]?.path).toBe(`${BASE}/${IV_1}`);
  });

  it("takes one change at a time: a second press while one is saving is ignored, and says so", async () => {
    const hold = gate();
    const { user } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: async (call) => {
        await hold.promise;
        return applyToggle(call);
      },
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    await user.click(box(/Write a letter to the family/));

    expect(puts()).toHaveLength(1);
    expect(screen.getByText(/Saving the change/)).toBeInTheDocument();
    hold.open();
    await waitFor(() => expect(box(/Name two ways to cope/)).not.toBeChecked());
    expect(screen.queryByText(/Saving the change/)).not.toBeInTheDocument();
  });

  it("keeps the box where the server left it and says why when the change is refused", async () => {
    const { user, onChanged } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: () => ({
        status: 409,
        body: { error: { code: "IMMUTABLE_AFTER_SIGN", message: "signed" } },
      }),
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));

    expect(await screen.findByText(/already signed/)).toBeInTheDocument();
    expect(box(/Name two ways to cope/)).toBeChecked();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("cannot be changed when the note is no longer a draft, and says why beside the boxes", async () => {
    mount({}, { editable: false });
    const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    expect(goal).toBeDisabled();
    expect(screen.getByText(/can change only while the note is a draft/i)).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });
});

describe("naming, so the discipline's plan is not mistaken for the care plan", () => {
  it.each([
    ["msw", "Social work plan for this visit"],
    ["chaplain", "Spiritual care plan for this visit"],
  ])("a %s visit's panel is called %s", async (discipline, title) => {
    mount({}, { discipline });
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    expect(screen.getByRole("group", { name: title })).toBeInTheDocument();
  });
});

describe("a box that is waiting (the keyboard user keeps their place)", () => {
  it("while a change is saved the pressed box stays focused and focusable, says it is waiting and why, and acts again after", async () => {
    const hold = gate();
    const { user } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: async (call) => {
        await hold.promise;
        return applyToggle(call);
      },
    });
    const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    // the live region is on the page, and silent, before anything is saved (one that mounts with its text is not announced)
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await user.click(goal);

    await waitFor(() => expect(goal).toHaveAttribute("aria-disabled", "true"));
    expect(goal).not.toBeDisabled();
    expect(goal).toHaveFocus();
    expect(goal).toHaveAccessibleDescription(/saving/i);
    // a live region that was already there says it, for a reader who cannot see the box
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    hold.open();
    await waitFor(() => expect(goal).not.toBeChecked());
    expect(goal).not.toHaveAttribute("aria-disabled");
    expect(goal).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("a note that is no longer a draft disables the boxes, and the reason is their accessible description", async () => {
    mount({}, { editable: false });
    const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    expect(goal).toBeDisabled();
    expect(goal).toHaveAccessibleDescription(/only while the note is a draft/i);
  });
});

describe("the list is never older than the change just made", () => {
  it("a read that began before the change committed and answers after it is dropped, and the list is read once more", async () => {
    const staleRead = gate();
    let readCount = 0;
    const { user, bump } = mount({
      [`GET ${BASE}`]: async () => {
        readCount += 1;
        const snapshot = view();
        if (readCount === 2) await staleRead.promise;
        return { body: snapshot };
      },
    });
    const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    // A draft resolve moved the revision: the list is read again, and that read is served before the change below commits.
    bump(1);
    await waitFor(() => expect(reads()).toHaveLength(2));
    await user.click(goal);
    await waitFor(() => expect(goal).not.toBeChecked());
    staleRead.open();
    await waitFor(() => expect(reads()).toHaveLength(3));
    await settled();
    expect(goal).not.toBeChecked();
  });

  it("a revision that moves while a change is being saved is read once the change has settled, and shows the server's list", async () => {
    const hold = gate();
    const { user, bump } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: async (call) => {
        await hold.promise;
        return applyToggle(call);
      },
    });
    const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    await user.click(goal);
    await waitFor(() => expect(goal).toHaveAttribute("aria-disabled", "true"));
    bump(1);
    await waitFor(() => expect(reads()).toHaveLength(2));
    hold.open();
    await waitFor(() => expect(reads()).toHaveLength(3));
    await waitFor(() => expect(goal).not.toBeChecked());
    expect(goal).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the list it knows on screen while it is read again (no flicker to an empty panel)", async () => {
    const reread = gate();
    let readCount = 0;
    const { bump } = mount({
      [`GET ${BASE}`]: async () => {
        readCount += 1;
        if (readCount === 2) await reread.promise;
        return { body: view() };
      },
    });
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    bump(1);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(box(/Name two ways to cope/)).toBeEnabled();
    reread.open();
    await settled();
    expect(box(/Name two ways to cope/)).toBeChecked();
  });
});

describe("a change the server did not take", () => {
  it("a refused change reads the list again, so a box never stays where the server no longer has it", async () => {
    const { user } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: () => {
        elements = elements.filter((e) => e.elementId !== GOAL_1);
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    expect(await screen.findByText(/no longer in this visit's plan/)).toBeInTheDocument();
    await waitFor(() => expect(reads()).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: /Name two ways to cope/ })).toBeNull(),
    );
  });

  it("a note that is not drafted from a plan is said in the picker's own words, not the addendum's", async () => {
    const { user } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: () => ({
        status: 422,
        body: { error: { code: "UNKNOWN_TEMPLATE_SECTION", message: "x" } },
      }),
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    expect(await screen.findByText(/not drafted from a plan/)).toBeInTheDocument();
    expect(screen.queryByText(/addendum/i)).not.toBeInTheDocument();
  });

  it("an answer that is not a list is not taken as the change: it says so and reads the list again", async () => {
    const { user, onChanged } = mount({ [`PUT ${BASE}/${GOAL_1}`]: () => ({ body: {} }) });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    expect(await screen.findByText(/could not confirm the change/i)).toBeInTheDocument();
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("a retry keeps the keyboard user's place", () => {
  it("keeps the panel (and the focused button) while it reads again, then puts focus on the plan panel when the list loads", async () => {
    let healthy = false;
    const reread = gate();
    const { user } = mount({
      [`GET ${BASE}`]: async () => {
        if (!healthy) return { status: 500, body: { error: {} } };
        await reread.promise;
        return { body: view() };
      },
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    healthy = true;
    await user.click(retry);
    // still the same button, waiting, focused: not unmounted for a blank "loading" panel
    expect(screen.getByRole("button", { name: /Trying again/ })).toHaveFocus();
    reread.open();
    expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeChecked();
    expect(screen.getByRole("group", { name: "Social work plan for this visit" })).toHaveFocus();
  });

  it("says it is still failing when a retry fails again, in the region that was already on the page", async () => {
    const { user } = mount({ [`GET ${BASE}`]: () => ({ status: 500, body: { error: {} } }) });
    const retry = await screen.findByRole("button", { name: "Try again" });
    const first = screen.getByText(/could not be loaded/).closest("output");
    await user.click(retry);
    expect(await screen.findByText(/Still could not load the plan items/)).toBeInTheDocument();
    expect(screen.getByText(/Still could not load/).closest("output")).toBe(first);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does not run a second read when the waiting button is pressed again", async () => {
    const hold = gate();
    let healthy = false;
    const { user } = mount({
      [`GET ${BASE}`]: async () => {
        if (!healthy) return { status: 500, body: { error: {} } };
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
    await user.click(waiting);
    hold.open();
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    expect(reads()).toHaveLength(2);
  });

  it.each([
    ["an empty plan", () => ({ body: { patientId: PATIENT, elements: [] } })],
    ["a plan the viewer may not read (403)", () => ({ status: 403, body: { error: {} } })],
    ["a visit with no plan list (404)", () => ({ status: 404, body: { error: {} } })],
    ["a note not drafted from a plan (422)", () => ({ status: 422, body: { error: {} } })],
  ])(
    "a retry that finds nothing to show says so and keeps the focus on the panel, not on a button that is gone (%s)",
    async (_name, answer) => {
      let failing = true;
      const { user } = mount({
        [`GET ${BASE}`]: () => (failing ? { status: 500, body: { error: {} } } : answer()),
      });
      const retry = await screen.findByRole("button", { name: "Try again" });
      retry.focus();
      failing = false;
      await user.click(retry);
      expect(await screen.findByText(/no plan items to show for this visit/i)).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Social work plan for this visit" })).toHaveFocus();
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    },
  );

  it("does not take the focus when the person moved on while the retry was reading", async () => {
    const hold = gate();
    let healthy = false;
    const { user } = mount({
      [`GET ${BASE}`]: async () => {
        if (!healthy) return { status: 500, body: { error: {} } };
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
      await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
      expect(elsewhere).toHaveFocus();
    } finally {
      elsewhere.remove();
    }
  });

  it("a retry that failed leaves no claim on the focus: a later read that loads does not pull it to the panel", async () => {
    let healthy = false;
    const { user, bump } = mount({
      [`GET ${BASE}`]: () => (healthy ? { body: view() } : { status: 500, body: { error: {} } }),
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    await user.click(retry);
    await screen.findByText(/Still could not load/);
    // the person moves on; the list becomes readable later (a draft resolve moved the revision)
    (document.activeElement as HTMLElement | null)?.blur();
    healthy = true;
    bump(1);
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    expect(
      screen.getByRole("group", { name: "Social work plan for this visit" }),
    ).not.toHaveFocus();
  });
});

describe("a refused change that leaves nothing to show", () => {
  it("keeps the refusal on the page and says there is nothing left, with the focus on the panel", async () => {
    const { user } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: () => {
        elements = [];
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      },
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    expect(await screen.findByText(/no plan items to show for this visit/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer in this visit's plan/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Social work plan for this visit" })).toHaveFocus();
  });
});

describe("the layout under a saving box", () => {
  it("puts the reason for a waiting box after the lists, so no row moves under the pointer while it saves", async () => {
    const hold = gate();
    const { user } = mount({
      [`PUT ${BASE}/${GOAL_1}`]: async (call) => {
        await hold.promise;
        return applyToggle(call);
      },
    });
    const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    await user.click(goal);
    const reason = await screen.findByText(/Saving the change/);
    // document order: every box comes before the reason, so nothing above a box appears or disappears
    for (const label of [/Name two ways to cope/, /Write a letter/, /Supportive counselling/]) {
      expect(
        box(label).compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    hold.open();
    await waitFor(() => expect(goal).not.toBeChecked());
  });
});

describe("accessibility", () => {
  it("has no axe violations on the plan panel, with its fieldsets, legends and live region", async () => {
    mount();
    const group = await screen.findByRole("group", { name: "Social work plan for this visit" });
    const results = await axe.run(group);
    expect(results.violations).toEqual([]);
  }, 60_000);
});
