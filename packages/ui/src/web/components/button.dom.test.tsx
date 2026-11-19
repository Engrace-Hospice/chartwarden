// @vitest-environment jsdom
// The kit Button: a native button that never submits a form by accident, announces a running action, and lets a
// caller keep a button focusable while it is busy (aria-disabled + aria-busy) without the kit overwriting that state.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button";

afterEach(cleanup);

describe("Button", () => {
  it("is a type=button by default so it never submits a surrounding form", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("button");
  });

  it("disables itself and announces busy while loading", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: /save/i });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps a caller's aria-busy when the button is not loading", () => {
    render(
      <Button aria-busy aria-disabled>
        Try again
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Try again" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("sets no aria-busy when it is neither loading nor asked to", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("aria-busy")).toBe(false);
  });
});
