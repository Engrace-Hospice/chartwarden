// The URL-held drawer selection: history stays tidy (one pushed entry per drawer run, popped on close, stamped with its own param),
// a double activation before the router re-renders acts once, and a stale id clears the same way a close does.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type JSX, useState } from "react";
import {
  type InitialEntry,
  RouterProvider,
  createMemoryRouter,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ToastProvider } from "../system/toast";
import { useSelectionParam } from "./use-selection-param";
import { useStaleSelection } from "./use-stale-selection";

afterEach(cleanup);

const LIST = "/list";
const PREVIOUS = "/previous";

function Screen({ param = "flag" }: { param?: string }): JSX.Element {
  const { selectedId, select, close } = useSelectionParam(param);
  const [found, setFound] = useState(true);
  useStaleSelection({ param, ready: true, found, clear: close });
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const press =
    (...ids: string[]) =>
    (): void => {
      for (const id of ids) select(id);
    };
  return (
    <div>
      <button type="button" onClick={press("a")}>
        select a
      </button>
      <button type="button" onClick={press("b")}>
        select b
      </button>
      <button type="button" onClick={press("a", "a")}>
        select a twice
      </button>
      <button type="button" onClick={press("a", "b")}>
        select a then b
      </button>
      <button type="button" onClick={close}>
        close
      </button>
      <button
        type="button"
        onClick={() => {
          close();
          close();
        }}
      >
        close twice
      </button>
      <button type="button" onClick={() => setFound(false)}>
        record vanishes
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        back
      </button>
      <output data-testid="where">{`${pathname}${search}`}</output>
      <output data-testid="selected">{selectedId ?? ""}</output>
    </div>
  );
}

interface Mounted {
  router: ReturnType<typeof createMemoryRouter>;
  /** The router's own `navigate`, unaffected by the deferral. */
  navigate: (to: number) => Promise<void>;
  /** Navigations by delta that the router has been asked for but not yet performed (a browser's `go` is async). */
  deferred: Array<() => Promise<void>>;
}

function mount(entries: InitialEntry[], param?: string, defer = false): Mounted {
  const router = createMemoryRouter([{ path: "*", element: <Screen param={param} /> }], {
    initialEntries: [PREVIOUS, ...entries],
    initialIndex: entries.length,
  });
  const deferred: Mounted["deferred"] = [];
  const navigate = router.navigate.bind(router) as (to: unknown, opts?: unknown) => Promise<void>;
  if (defer) {
    router.navigate = ((to: unknown, opts?: unknown) => {
      if (typeof to !== "number") return navigate(to, opts);
      deferred.push(() => navigate(to));
      return Promise.resolve();
    }) as typeof router.navigate;
  }
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return { router, navigate, deferred };
}

const where = (): string => screen.getByTestId("where").textContent ?? "";
const press = (name: string): void => {
  fireEvent.click(screen.getByRole("button", { name }));
};
const back = async ({ navigate }: Pick<Mounted, "navigate">): Promise<void> => {
  await act(async () => {
    await navigate(-1);
  });
};

describe("useSelectionParam history", () => {
  it("opening pushes one entry stamped with its own param; one Back closes, a second leaves the page", async () => {
    const mounted = mount([LIST]);
    press("select a");
    expect(where()).toBe(`${LIST}?flag=a`);
    expect((mounted.router.state.location.state as { fromSelect?: string }).fromSelect).toBe(
      "flag",
    );
    await back(mounted);
    expect(where()).toBe(LIST);
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });

  it("picking another row replaces the entry, keeping the stamp, so closing still pops straight back", async () => {
    const mounted = mount([LIST]);
    press("select a");
    press("select b");
    expect(where()).toBe(`${LIST}?flag=b`);
    expect((mounted.router.state.location.state as { fromSelect?: string }).fromSelect).toBe(
      "flag",
    );
    press("close");
    await waitFor(() => expect(where()).toBe(LIST));
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });

  it("two selects before the router re-renders add one entry, not two", async () => {
    const mounted = mount([LIST]);
    press("select a twice");
    expect(where()).toBe(`${LIST}?flag=a`);
    await back(mounted);
    expect(where()).toBe(LIST);

    press("select a then b");
    expect(where()).toBe(`${LIST}?flag=b`);
    await back(mounted);
    expect(where()).toBe(LIST);
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });

  it("a double close pops one entry even when the router's go is deferred", async () => {
    const mounted = mount([LIST], "flag", true);
    const { deferred } = mounted;
    press("select a");
    press("close twice");
    expect(deferred).toHaveLength(1);
    await act(async () => {
      for (const go of deferred) await go();
    });
    expect(where()).toBe(LIST);
    // The one entry it popped was the drawer's: the page before the list is still one Back away.
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });

  it("closing works again after a pop completed (the guard re-arms on the next entry)", async () => {
    const { deferred } = mount([LIST], "flag", true);
    press("select a");
    press("close");
    await act(async () => {
      for (const go of deferred.splice(0)) await go();
    });
    press("select b");
    press("close");
    expect(deferred).toHaveLength(1);
  });

  it("an entry pushed for another param is not popped: closing replaces the param instead", async () => {
    const mounted = mount([{ pathname: LIST, search: "?flag=a", state: { fromSelect: "other" } }]);
    press("close");
    await waitFor(() => expect(where()).toBe(LIST));
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });

  it("closing a drawer opened by a link replaces the param and keeps the page's other params", async () => {
    const mounted = mount([`${LIST}?keep=1&flag=a`]);
    press("close");
    await waitFor(() => expect(where()).toBe(`${LIST}?keep=1`));
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });
});

describe("useSelectionParam with useStaleSelection", () => {
  it("a record that vanishes under a drawer this hook pushed pops that entry: one Back reaches the previous page", async () => {
    const mounted = mount([LIST]);
    press("select a");
    press("record vanishes");
    await waitFor(() => expect(where()).toBe(LIST));
    expect(await screen.findByText("That record is no longer in this list.")).toBeTruthy();
    // No duplicate list entry was left behind: the entry the drawer pushed is gone.
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });

  it("a stale deep link is cleared by replacing the param, with the notice", async () => {
    const mounted = mount([`${LIST}?flag=gone&keep=1`]);
    press("record vanishes");
    await waitFor(() => expect(where()).toBe(`${LIST}?keep=1`));
    expect(await screen.findByText("That record is no longer in this list.")).toBeTruthy();
    await back(mounted);
    expect(where()).toBe(PREVIOUS);
  });
});
