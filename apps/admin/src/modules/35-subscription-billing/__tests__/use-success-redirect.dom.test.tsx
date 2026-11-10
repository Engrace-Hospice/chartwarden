// apps/admin/src/modules/35-subscription-billing — the shared "write succeeded" step: lock, toast, replace-navigate, once, and
// never navigate for a page that is already gone. (The four screens' own flows are in double-submit.dom.test.tsx.)
import { ToastProvider } from "@chartwarden/ui";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useSuccessRedirect } from "../use-success-redirect";

afterEach(cleanup);

function Probe(): null {
  return null;
}

function Where(): JSX.Element {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <output data-testid="where" data-confirmation={location.state?.confirmation}>
      {type} {location.pathname}
    </output>
  );
}

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <StrictMode>
      <ToastProvider>
        <MemoryRouter initialEntries={["/form"]}>
          {children}
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </StrictMode>
  );
}

describe("useSuccessRedirect", () => {
  it("locks, toasts and replace-navigates once, even when finish is called twice, under StrictMode", () => {
    const { result } = renderHook(() => useSuccessRedirect(), { wrapper });
    expect(result.current.done).toBe(false);
    act(() => {
      result.current.finish("/next", "Saved.");
      result.current.finish("/next", "Saved.");
    });
    expect(result.current.done).toBe(true);
    expect(screen.getByTestId("where").textContent).toBe("REPLACE /next");
    expect(screen.getAllByText("Saved.")).toHaveLength(1);
    // The destination can keep showing it once the toast is gone.
    expect(screen.getByTestId("where").getAttribute("data-confirmation")).toBe("Saved.");
  });

  it("toasts but does not navigate when the page unmounted before the write landed", () => {
    let finish: (to: string, message: string) => void = () => undefined;
    function Screen(): JSX.Element {
      finish = useSuccessRedirect().finish;
      return <Probe />;
    }
    function Host({ show }: { show: boolean }): JSX.Element {
      return (
        <ToastProvider>
          <MemoryRouter initialEntries={["/form"]}>
            {show ? <Screen /> : null}
            <Where />
          </MemoryRouter>
        </ToastProvider>
      );
    }
    const { rerender } = render(<Host show />);
    rerender(<Host show={false} />);
    act(() => finish("/next", "Saved after leaving."));
    expect(screen.getByTestId("where").textContent).toBe("POP /form");
    expect(screen.getByText("Saved after leaving.")).toBeTruthy();
  });
});
