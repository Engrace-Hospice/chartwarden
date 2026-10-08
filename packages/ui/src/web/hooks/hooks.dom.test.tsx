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
import { type JSX, StrictMode, useRef, useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
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
