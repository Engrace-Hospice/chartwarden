// The shared list/drawer hooks: drawer focus + Escape, debounced filters, newest-response-wins, stale ?param links.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  type JSX,
  StrictMode,
  createRef,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interactiveRowProps } from "../system/interactive-row";
import { ToastProvider } from "../system/toast";
import { useDebouncedValue } from "./use-debounced-value";
import { useDisclosureDismiss } from "./use-disclosure-dismiss";
import { useDrawerA11y } from "./use-drawer-a11y";
import { useOffCanvasNav } from "./use-off-canvas-nav";
import { useRequestGuard } from "./use-request-guard";
import { useStaleSelection } from "./use-stale-selection";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type RowMarker = "class" | "pressed" | "current";

/** How a list marks its open row: the kit's `tr.is-selected`, `aria-pressed` (interactiveRowProps), `aria-current`, (the `[role=row]` forms are covered by the grid below). */
function markSelected(marker: RowMarker, selected: boolean): Record<string, unknown> {
  if (marker === "class") return { className: selected ? "is-selected" : undefined };
  if (marker === "pressed") return { role: "button", "aria-pressed": selected };
  return { "aria-current": selected ? "true" : undefined };
}

interface RowsHandle {
  select: (id: string | null) => void;
}

function RowDrawer({ onClose }: { onClose?: () => void }): JSX.Element {
  const props = useDrawerA11y<HTMLElement>(onClose ?? (() => undefined));
  return (
    <aside aria-label="Detail" {...props}>
      <button type="button">act</button>
    </aside>
  );
}

/** A list with a drawer per selected row, like the admin list screens: the open row is marked per `rowMarker`. */
const RowsWithDrawer = forwardRef<RowsHandle, { rowMarker?: RowMarker }>(function RowsWithDrawer(
  { rowMarker = "class" },
  handle,
): JSX.Element {
  const [id, setId] = useState<string | null>(null);
  useImperativeHandle(handle, () => ({ select: setId }), []);
  return (
    <div>
      <input aria-label="filter" />
      <table>
        <tbody>
          {["a", "b"].map((row) => (
            <tr
              key={row}
              aria-label={`row ${row}`}
              tabIndex={0}
              onClick={() => setId(row)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setId(row);
              }}
              {...markSelected(rowMarker, id === row)}
            >
              <td>{row}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {id ? <RowDrawer key={id} onClose={() => setId(null)} /> : null}
    </div>
  );
});

/** A div grid whose open row is `[role=row]` + aria-pressed / aria-current. */
const GridWithDrawer = forwardRef<RowsHandle, { attr: "aria-pressed" | "aria-current" }>(
  function GridWithDrawer({ attr }, handle): JSX.Element {
    const [id, setId] = useState<string | null>(null);
    useImperativeHandle(handle, () => ({ select: setId }), []);
    return (
      <div>
        {/* biome-ignore lint/a11y/useSemanticElements: the point is the `[role=row]` selector, which a real <table> never exercises */}
        <div role="grid" aria-label="grid">
          <div
            role="row"
            aria-label="grid row a"
            tabIndex={0}
            {...{ [attr]: id === "a" ? "true" : "false" }}
          />
        </div>
        {id ? <RowDrawer key={id} onClose={() => setId(null)} /> : null}
      </div>
    );
  },
);

interface RowsRemountHandle extends RowsHandle {
  remount: () => void;
  /** Closes the drawer but leaves the row marked selected (the drawer's own Close, with the selection kept). */
  closeDrawer: () => void;
}

/** A list that can re-render every row into a new element (a refetch), with or without `data-row-id` on the rows. */
const RemountingList = forwardRef<RowsRemountHandle, { withRowIds: boolean }>(
  function RemountingList({ withRowIds }, handle): JSX.Element {
    const [id, setId] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(true);
    const [generation, setGeneration] = useState(0);
    useImperativeHandle(
      handle,
      () => ({
        select: (next) => {
          setId(next);
          setDrawerOpen(true);
        },
        remount: () => setGeneration((g) => g + 1),
        closeDrawer: () => setDrawerOpen(false),
      }),
      [],
    );
    return (
      <div className="wx-list-drawer">
        <table>
          <tbody>
            {["a", "b"].map((row) => (
              <tr
                key={`${generation}-${row}`}
                aria-label={`row ${row}`}
                {...interactiveRowProps(
                  () => setId(row),
                  id === row,
                  false,
                  withRowIds ? row : undefined,
                )}
              >
                <td>{row}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {id && drawerOpen ? <RowDrawer key={id} onClose={() => setId(null)} /> : null}
      </div>
    );
  },
);

function Host({ onClose }: { onClose: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open ? (
        <Drawer
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Drawer({ onClose }: { onClose: () => void }): JSX.Element {
  const props = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside aria-label="Detail" {...props}>
      <input aria-label="note" />
      <select aria-label="kind">
        <option>a</option>
      </select>
      <button type="button">act</button>
    </aside>
  );
}

describe("useDrawerA11y", () => {
  it("moves focus into the drawer, closes on Escape and returns focus to the opener", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("complementary", { name: "Detail" });
    expect(document.activeElement).toBe(drawer);
    fireEvent.keyDown(screen.getByRole("button", { name: "act" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves Escape to a text field or select so a half-typed edit is not thrown away", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.keyDown(screen.getByLabelText("note"), { key: "Escape" });
    fireEvent.keyDown(screen.getByLabelText("kind"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

interface RowsHandle {
  select: (id: string | null) => void;
}

describe("useDrawerA11y when the drawer is stacked under the list", () => {
  const originalMatchMedia = window.matchMedia;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();
  /** Mirrors list-chrome.css: at <=1280px `.wx-list-drawer.has-drawer` is one column. */
  const setStacked = (stacked: boolean): void => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: stacked && query === "(max-width: 1280px)",
      media: query,
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    scrollIntoView.mockClear();
  });

  it("brings the drawer into view on open, and the opener back into view on close", () => {
    Element.prototype.scrollIntoView = scrollIntoView;
    setStacked(true);
    render(<Host onClose={() => undefined} />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("complementary", { name: "Detail" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(drawer);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.keyDown(screen.getByRole("button", { name: "act" }), { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    expect(scrollIntoView.mock.contexts[1]).toBe(opener);
  });

  it("does not scroll when the drawer sits beside the list", () => {
    Element.prototype.scrollIntoView = scrollIntoView;
    setStacked(false);
    render(<Host onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("useDrawerA11y focus hand-off", () => {
  const mountRows = (rowMarker?: RowMarker): RowsHandle => {
    const handle = createRef<RowsHandle>();
    render(<RowsWithDrawer ref={handle} rowMarker={rowMarker} />);
    return { select: (id) => act(() => handle.current?.select(id)) };
  };

  it("hands focus to the selected row when the drawer opened with nothing focused (a deep link)", () => {
    const { select } = mountRows();
    expect(document.activeElement).toBe(document.body);
    select("a");
    const drawer = screen.getByRole("complementary", { name: "Detail" });
    expect(document.activeElement).toBe(drawer);
    select(null);
    expect(document.activeElement).toBe(screen.getByRole("row", { name: "row a" }));
  });

  it("does nothing harmful when the opener left the page and no row is selected", () => {
    function Opener(): JSX.Element {
      const [open, setOpen] = useState(false);
      const [openerShown, setOpenerShown] = useState(true);
      return (
        <div>
          {openerShown ? (
            <button type="button" onClick={() => setOpen(true)}>
              open
            </button>
          ) : null}
          <button type="button" onClick={() => setOpenerShown(false)}>
            hide opener
          </button>
          {open ? <RowDrawer onClose={() => setOpen(false)} /> : null}
        </div>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "hide opener" }));
    expect(() =>
      fireEvent.keyDown(screen.getByRole("complementary", { name: "Detail" }), { key: "Escape" }),
    ).not.toThrow();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus from a text field outside the drawer", () => {
    const { select } = mountRows();
    const filter = screen.getByLabelText("filter");
    filter.focus();
    select("a");
    expect(screen.getByRole("complementary", { name: "Detail" })).toBeTruthy();
    expect(document.activeElement).toBe(filter);
    select(null);
    expect(document.activeElement).toBe(filter);
  });

  it("still takes focus from a button or checkbox outside the drawer", () => {
    const { select } = mountRows();
    const row = screen.getByRole("row", { name: "row a" });
    row.focus();
    select("a");
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
  });

  it("after Back/Forward between two records, the next drawer's opener is its own row, not the previous one", () => {
    const { select } = mountRows();
    const rowA = screen.getByRole("row", { name: "row a" });
    const rowB = screen.getByRole("row", { name: "row b" });
    rowA.focus();
    fireEvent.click(rowA);
    rowB.focus();
    fireEvent.click(rowB);
    // Focus sits inside B's drawer when the URL moves back to A: B's drawer unmounts, focus falls to the body.
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    select("a");
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    select(null);
    expect(document.activeElement).toBe(rowA);
    expect(document.activeElement).not.toBe(rowB);
  });
});

describe("useDrawerA11y selected-row lookup", () => {
  const openAndClose = (select: (id: string | null) => void): void => {
    select("a");
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    select(null);
  };

  it.each(["pressed", "current"] as const)(
    "finds the open row marked %s (not only tr.is-selected) when the drawer opened with nothing focused",
    (marker) => {
      const handle = createRef<RowsHandle>();
      render(<RowsWithDrawer ref={handle} rowMarker={marker} />);
      openAndClose((id) => act(() => handle.current?.select(id)));
      expect(document.activeElement).toBe(screen.getByLabelText("row a"));
    },
  );

  it("finds a [role=row] grid row marked aria-pressed or aria-current", () => {
    for (const attr of ["aria-pressed", "aria-current"] as const) {
      const handle = createRef<RowsHandle>();
      render(<GridWithDrawer ref={handle} attr={attr} />);
      openAndClose((id) => act(() => handle.current?.select(id)));
      expect(document.activeElement).toBe(screen.getByLabelText("grid row a"));
      cleanup();
    }
  });

  it("looks only inside its own list: another list's selected row never takes focus", () => {
    const handle = createRef<RowsHandle>();
    render(
      <>
        <table>
          <tbody>
            <tr aria-label="other list row" tabIndex={0} className="is-selected">
              <td>x</td>
            </tr>
          </tbody>
        </table>
        <RowsWithDrawer ref={handle} />
      </>,
    );
    handle.current && act(() => handle.current?.select("a"));
    // Nothing was focused when the drawer opened: the opener is this list's row a, not the other list's selected row.
    act(() => handle.current?.select(null));
    expect(document.activeElement).toBe(screen.getByLabelText("row a"));
    expect(document.activeElement).not.toBe(screen.getByLabelText("other list row"));
  });

  it("does not move focus into a different page's list when the drawer's list is gone (a route change)", () => {
    function Routes(): JSX.Element {
      const [page, setPage] = useState<"list" | "other">("list");
      return (
        <div>
          <button type="button" onClick={() => setPage("other")}>
            go
          </button>
          {page === "list" ? (
            <div className="wx-list-drawer">
              <table>
                <tbody>
                  <tr aria-label="row a" className="is-selected" tabIndex={0}>
                    <td>a</td>
                  </tr>
                </tbody>
              </table>
              <KeyedDrawer />
            </div>
          ) : (
            <table>
              <tbody>
                <tr aria-label="new page row" className="is-selected" tabIndex={0}>
                  <td>n</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      );
    }
    function KeyedDrawer(): JSX.Element {
      const props = useDrawerA11y<HTMLElement>(() => undefined);
      return <aside aria-label="Detail" {...props} />;
    }
    render(<Routes />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByLabelText("new page row")).toBeTruthy();
    expect(document.activeElement).not.toBe(screen.getByLabelText("new page row"));
  });

  it("returns focus to the opener's row after the list re-rendered it, found again by data-row-id", () => {
    const handle = createRef<RowsRemountHandle>();
    render(<RemountingList ref={handle} withRowIds />);
    const original = screen.getByLabelText("row a");
    original.focus();
    fireEvent.click(original);
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    // The list re-renders into new elements (a refetch): the opener is now a detached node.
    act(() => handle.current?.remount());
    const replaced = screen.getByLabelText("row a");
    expect(replaced).not.toBe(original);
    expect(original.isConnected).toBe(false);
    act(() => handle.current?.select(null));
    expect(document.activeElement).toBe(replaced);
  });

  it("does not hand focus back to the old row when the selection moved on and the list re-rendered (ids tell the rows apart)", () => {
    const handle = createRef<RowsRemountHandle>();
    render(<RemountingList ref={handle} withRowIds />);
    fireEvent.click(screen.getByLabelText("row a"));
    act(() => handle.current?.remount());
    // Row b is picked: row a's keyed drawer unmounts while row b is the open row.
    const rowB = screen.getByLabelText("row b");
    rowB.focus();
    fireEvent.click(rowB);
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    act(() => handle.current?.select(null));
    expect(document.activeElement).toBe(screen.getByLabelText("row b"));
  });

  it("falls back to the selected row when the re-rendered rows carry no id", () => {
    const handle = createRef<RowsRemountHandle>();
    render(<RemountingList ref={handle} withRowIds={false} />);
    const original = screen.getByLabelText("row a");
    original.focus();
    fireEvent.click(original);
    act(() => handle.current?.remount());
    const replaced = screen.getByLabelText("row a");
    act(() => handle.current?.closeDrawer());
    // Row a is still marked selected when the drawer closes, so it stands in for the opener the re-render replaced.
    expect(document.activeElement).toBe(replaced);
  });

  it("a native select outside the drawer does not keep focus (only text entry does)", () => {
    function WithSelect(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <select aria-label="status" onChange={() => setOpen(true)}>
            <option>a</option>
            <option>b</option>
          </select>
          {open ? <KeyedDrawer /> : null}
        </div>
      );
    }
    function KeyedDrawer(): JSX.Element {
      const props = useDrawerA11y<HTMLElement>(() => undefined);
      return <aside aria-label="Detail" {...props} />;
    }
    render(<WithSelect />);
    const select = screen.getByLabelText("status");
    select.focus();
    fireEvent.change(select, { target: { value: "b" } });
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
  });

  it.each([
    ["a textarea", <textarea key="t" aria-label="typing" />],
    ["a search input", <input key="s" type="search" aria-label="typing" />],
    // jsdom has no `isContentEditable`, so mark the attribute the hook reads.
    [
      "a contenteditable region",
      <div
        key="c"
        contentEditable
        suppressContentEditableWarning
        aria-label="typing"
        role="textbox"
        tabIndex={0}
      />,
    ],
  ])("leaves focus in %s outside the drawer", (_name, field) => {
    function WithField(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          {field}
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          {open ? <KeyedDrawer /> : null}
        </div>
      );
    }
    function KeyedDrawer(): JSX.Element {
      const props = useDrawerA11y<HTMLElement>(() => undefined);
      return <aside aria-label="Detail" {...props} />;
    }
    render(<WithField />);
    const typing = screen.getByLabelText("typing");
    typing.focus();
    // Open the drawer without moving focus off the field (as a debounced filter result would).
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("complementary", { name: "Detail" })).toBeTruthy();
    expect(document.activeElement).toBe(typing);
  });

  it("under StrictMode's mount, unmount, mount the drawer still takes focus and Escape returns it to the opener", () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Host onClose={onClose} />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("complementary", { name: "Detail" });
    expect(document.activeElement).toBe(drawer);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("under StrictMode a deep-linked drawer still hands focus to the selected row on close", () => {
    const handle = createRef<RowsHandle>();
    render(
      <StrictMode>
        <RowsWithDrawer ref={handle} />
      </StrictMode>,
    );
    act(() => handle.current?.select("a"));
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Detail" }));
    act(() => handle.current?.select(null));
    expect(document.activeElement).toBe(screen.getByLabelText("row a"));
  });
});

describe("useDebouncedValue", () => {
  it("follows the source only after it has been still for the delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "" },
    });
    rerender({ v: "s" });
    rerender({ v: "su" });
    rerender({ v: "sun" });
    expect(result.current).toBe("");
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe("");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("sun");
  });
});

describe("useRequestGuard", () => {
  it("only the newest request is current, and none is after unmount", () => {
    const { result, unmount } = renderHook(() => useRequestGuard());
    const first = result.current();
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    unmount();
    expect(second()).toBe(false);
  });
});

function Where(): JSX.Element {
  const { search } = useLocation();
  return <div data-testid="where">{search}</div>;
}

function Stale(props: { ready: boolean; found: boolean }): JSX.Element {
  useStaleSelection({ param: "tenant", ignore: ["new"], ...props });
  return <Where />;
}

function mountStale(entry: string, props: { ready: boolean; found: boolean }): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Stale {...props} />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("useStaleSelection", () => {
  it("clears a param whose record is not in the loaded list and says so", async () => {
    mountStale("/tenants?tenant=gone&keep=1", { ready: true, found: false });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?keep=1"));
    expect(await screen.findByText("That record is no longer in this list.")).toBeTruthy();
  });

  it("does nothing before the load has completed, when the record is found, or for an ignored value", () => {
    mountStale("/tenants?tenant=gone", { ready: false, found: false });
    expect(screen.getByTestId("where").textContent).toBe("?tenant=gone");
    cleanup();
    mountStale("/tenants?tenant=here", { ready: true, found: true });
    expect(screen.getByTestId("where").textContent).toBe("?tenant=here");
    cleanup();
    mountStale("/tenants?tenant=new", { ready: true, found: false });
    expect(screen.getByTestId("where").textContent).toBe("?tenant=new");
  });
});

function Popover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDisclosureDismiss(open, () => setOpen(false), container, trigger);
  return (
    <div>
      <div ref={container}>
        <button type="button" ref={trigger} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          menu
        </button>
        {open ? <button type="button">inside</button> : null}
      </div>
      <button type="button">outside</button>
    </div>
  );
}

describe("useDisclosureDismiss", () => {
  it("closes on Escape with focus back on the trigger, and on a press outside", () => {
    render(<Popover />);
    const trigger = screen.getByRole("button", { name: "menu" });
    fireEvent.click(trigger);
    screen.getByRole("button", { name: "inside" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "inside" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "inside" }));
    expect(screen.getByRole("button", { name: "inside" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("button", { name: "inside" })).toBeNull();
  });
});

function Nav(): JSX.Element {
  const { navOpen, setNavOpen, sidebarRef, toggleRef } = useOffCanvasNav();
  return (
    <div>
      <button type="button" ref={toggleRef} onClick={() => setNavOpen((o) => !o)}>
        toggle
      </button>
      <aside ref={sidebarRef} data-open={navOpen}>
        <a href="/first">first</a>
      </aside>
    </div>
  );
}

describe("useOffCanvasNav", () => {
  it("focuses the first link on open, and Escape closes it back to the toggle", async () => {
    render(<Nav />);
    const toggle = screen.getByRole("button", { name: "toggle" });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("link", { name: "first" })),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });
});

describe("review regressions", () => {
  it("useRequestGuard still guards after StrictMode's mount/cleanup/mount", () => {
    const { result } = renderHook(() => useRequestGuard(), { wrapper: StrictMode });
    const first = result.current();
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("a drawer the user has edited does not close on Escape from a button (the Close button still works)", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.input(screen.getByLabelText("note"), { target: { value: "half-typed" } });
    fireEvent.keyDown(screen.getByRole("button", { name: "act" }), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("complementary", { name: "Detail" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closing a drawer does not pull focus back when the user already moved it (switching rows)", () => {
    function Rows(): JSX.Element {
      const [id, setId] = useState<string | null>(null);
      return (
        <div>
          <button type="button" onClick={() => setId("a")}>
            row a
          </button>
          <button type="button" onClick={() => setId("b")}>
            row b
          </button>
          {id ? <KeyedDrawer key={id} /> : null}
        </div>
      );
    }
    function KeyedDrawer(): JSX.Element {
      const props = useDrawerA11y<HTMLElement>(() => undefined);
      return <aside aria-label="Detail" {...props} />;
    }
    render(<Rows />);
    const a = screen.getByRole("button", { name: "row a" });
    const b = screen.getByRole("button", { name: "row b" });
    a.focus();
    fireEvent.click(a);
    b.focus();
    fireEvent.click(b);
    expect(document.activeElement).not.toBe(a);
  });

  it("useOffCanvasNav does not focus the toggle on first render, and a link-activated close focuses main instead of the toggle", async () => {
    function NavWithMain(): JSX.Element {
      const main = useRef<HTMLElement>(null);
      const { setNavOpen, closeForNavigation, sidebarRef, toggleRef } = useOffCanvasNav(
        () => main.current,
      );
      return (
        <div>
          <button type="button" ref={toggleRef} onClick={() => setNavOpen((o) => !o)}>
            toggle
          </button>
          <aside ref={sidebarRef}>
            <a
              href="/first"
              onClick={(e) => {
                e.preventDefault();
                closeForNavigation();
              }}
            >
              first
            </a>
          </aside>
          <main ref={main} tabIndex={-1}>
            page
          </main>
        </div>
      );
    }
    render(<NavWithMain />);
    expect(document.activeElement).toBe(document.body);
    const toggle = screen.getByRole("button", { name: "toggle" });
    fireEvent.click(toggle);
    const link = await screen.findByRole("link", { name: "first" });
    await waitFor(() => expect(document.activeElement).toBe(link));
    fireEvent.click(link);
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("main")));
    expect(document.activeElement).not.toBe(toggle);
  });

  it("useStaleSelection shows its notice once under StrictMode", async () => {
    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={["/tenants?tenant=gone"]}>
            <Stale ready found={false} />
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
    expect(screen.getAllByText("That record is no longer in this list.")).toHaveLength(1);
  });
});
