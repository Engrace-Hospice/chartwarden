// @vitest-environment jsdom
// The composer's plan picker for a social-work or chaplain visit (ADR-0114 S4b, VN-D60, VN-D63): the goals and interventions of the discipline's plan, each
// kept in this visit or left out, one idempotent toggle per box. The server decides everything (what the viewer is handed, Part 2, who may change it); the
// picker shows the list, sends the one change and takes the server's answer. Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  props: { readonly editable?: boolean; readonly onChanged?: () => void } = {},
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
      expect(screen.queryByText("Goals")).not.toBeInTheDocument();
      expect(screen.queryByText(/Plan of care for this visit/)).not.toBeInTheDocument();
    },
  );

  it("shows nothing for an empty plan", async () => {
    elements = [];
    mount();
    await waitFor(() => expect(reads()).toHaveLength(1));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Plan of care for this visit/)).not.toBeInTheDocument();
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
