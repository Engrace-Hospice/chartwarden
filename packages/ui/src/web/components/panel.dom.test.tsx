// @vitest-environment jsdom
// The kit Panel: a titled surface whose heading level the caller picks (a panel nested under a page <h1> and a
// section <h2> must be an <h3>, or the outline skips a level) and whose body can stack its children.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Panel } from "./panel";

afterEach(cleanup);

describe("Panel", () => {
  it("titles the panel with an h2 by default", () => {
    render(<Panel title="Goals">body</Panel>);
    expect(screen.getByRole("heading", { level: 2, name: "Goals" })).toBeTruthy();
  });

  it.each([2, 3, 4] as const)("renders the title as heading level %i when asked", (level) => {
    render(
      <Panel title="Goals" headingLevel={level}>
        body
      </Panel>,
    );
    expect(screen.getByRole("heading", { level, name: "Goals" })).toBeTruthy();
  });

  it("lays the body out as a flex column when stacked", () => {
    render(
      <Panel title="Goals" stack>
        <p>first</p>
        <p>second</p>
      </Panel>,
    );
    const body = screen.getByText("first").parentElement as HTMLElement;
    expect(body.style.display).toBe("flex");
    expect(body.style.flexDirection).toBe("column");
    expect(body.getAttribute("style")).toContain("gap: var(--space-2)");
  });

  it("leaves the body as plain block flow unless stacked", () => {
    render(
      <Panel title="Goals">
        <p>first</p>
      </Panel>,
    );
    expect((screen.getByText("first").parentElement as HTMLElement).style.display).toBe("");
  });
});
