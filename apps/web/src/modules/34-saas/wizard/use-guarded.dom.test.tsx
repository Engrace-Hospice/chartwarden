// @vitest-environment jsdom
// A panel's handlers are called with `void`: anything that throws inside one must say so on screen instead of rejecting silently and
// leaving the page looking idle.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useGuarded } from "./use-guarded";

function Harness(): JSX.Element {
  const { guard, notice } = useGuarded();
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void guard(async () => {
            throw new Error("digest failed");
          })
        }
      >
        Break
      </button>
      <button type="button" onClick={() => void guard(async () => undefined)}>
        Work
      </button>
      {notice}
    </div>
  );
}

afterEach(cleanup);

describe("useGuarded", () => {
  it("says so on screen when the work throws, and clears the notice when the next run succeeds", async () => {
    render(<Harness />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Break" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Something went wrong before this finished",
    );
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
