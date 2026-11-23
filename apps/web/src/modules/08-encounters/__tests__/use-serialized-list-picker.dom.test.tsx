// @vitest-environment jsdom
// What the composer list pickers share (`useSerializedListPicker`, hosted here by the discipline plan picker, whose own suite is unchanged): a re-read after the
// server's list changed elsewhere that fails is said, not hidden behind a list that may be out of date; a change whose outcome is unknown tells the caller; and a
// change that lands after the picker left the screen touches nothing. (The quiet re-read after a clear, which keeps the list, is in the IDG picker's change suite.)
// Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerDisciplinePlanPicker } from "../composer-discipline-plan-picker";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GOAL = "dddddddd-4444-4444-8444-dddddddddd01";
const BASE = `/api/v1/encounters/${ENC}/discipline-plan-elements`;

let calls: Call[];
beforeEach(() => {
  calls = [];
});
afterEach(cleanup);

const view = () => ({
  patientId: PATIENT,
  elements: [{ elementId: GOAL, kind: "goal", text: "Name two ways to cope", kept: true }],
});
const reads = (): Call[] => calls.filter((c) => c.method === "GET");

function mount(over: Record<string, Responder> = {}) {
  const routes: Record<string, Responder> = {
    [`GET ${BASE}`]: () => ({ body: view() }),
    [`PUT ${BASE}/${GOAL}`]: () => ({ body: view() }),
    ...over,
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  const onChanged = vi.fn();
  const ui = (revision: number) => (
    <ApiClientProvider client={client}>
      <ComposerDisciplinePlanPicker
        encounterId={ENC}
        discipline="msw"
        editable
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
    unmount: rendered.unmount,
  };
}

describe("a re-read after the server's list changed elsewhere (the revision moved)", () => {
  it("that fails says so and offers Try again: the list on the screen may be out of date, so it is not left as if it were right", async () => {
    let state: "ok" | "failing" | "changed" = "ok";
    const { bump, user } = mount({
      [`GET ${BASE}`]: () => {
        if (state === "failing") return { status: 503, body: { error: {} } };
        const body = view();
        if (state === "changed") body.elements[0] = { ...body.elements[0], kept: false } as never;
        return { body };
      },
    });
    expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeChecked();

    state = "failing";
    bump(1);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    state = "changed";
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("checkbox", { name: /Name two ways to cope/ }),
    ).not.toBeChecked();
  });

  it("that finds no list for the visit any more takes the list off the screen (that is an answer, not a failure)", async () => {
    let gone = false;
    const { bump } = mount({
      [`GET ${BASE}`]: () => (gone ? { status: 404, body: { error: {} } } : { body: view() }),
    });
    await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
    gone = true;
    bump(1);
    await waitFor(() => expect(screen.queryByRole("checkbox")).not.toBeInTheDocument());
  });
});

describe("a change whose outcome is unknown", () => {
  it.each([
    ["a server fault", () => ({ status: 500, body: { error: {} } })],
    [
      "no answer",
      (): never => {
        throw new Error("offline");
      },
    ],
  ])("ending in %s tells the caller, because it may have landed", async (_name, answer) => {
    const { user, onChanged } = mount({ [`PUT ${BASE}/${GOAL}`]: answer });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("ending in a refusal does not tell the caller: nothing changed", async () => {
    const { user, onChanged } = mount({
      [`PUT ${BASE}/${GOAL}`]: () => ({
        status: 409,
        body: { error: { code: "IMMUTABLE_AFTER_SIGN", message: "signed" } },
      }),
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    await screen.findByText(/already signed/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("a change that lands after the picker left the screen", () => {
  it("touches nothing and tells nobody", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, onChanged, unmount } = mount({
      [`PUT ${BASE}/${GOAL}`]: async () => {
        await held;
        return { body: view() };
      },
    });
    await user.click(await screen.findByRole("checkbox", { name: /Name two ways to cope/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    unmount();
    release();
    await act(async () => {
      await held;
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(reads()).toHaveLength(1);
  });
});
