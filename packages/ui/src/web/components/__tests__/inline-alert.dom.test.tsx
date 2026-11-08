// InlineAlert — the shared flat alert: errors are role="alert", success/info are <output> (role "status").
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineAlert } from "../inline-alert";

describe("InlineAlert", () => {
  it("renders an error as role=alert by default", () => {
    render(<InlineAlert>denial.reopen is not granted</InlineAlert>);
    expect(screen.getByRole("alert").textContent).toBe("denial.reopen is not granted");
  });

  it("renders success as a polite status output, not an alert", () => {
    render(<InlineAlert tone="success">Close: done.</InlineAlert>);
    expect(screen.getByRole("status").textContent).toBe("Close: done.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders info as a status output", () => {
    render(<InlineAlert tone="info">Heads up</InlineAlert>);
    expect(screen.getByRole("status").textContent).toBe("Heads up");
  });

  it("renders warning as a polite status output (advisory, never an alert)", () => {
    render(<InlineAlert tone="warning">Rates differ from the CMS reference</InlineAlert>);
    expect(screen.getByRole("status").textContent).toBe("Rates differ from the CMS reference");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("live={false} renders a plain paragraph with no live-region role, for any tone", () => {
    render(
      <>
        <InlineAlert live={false}>refused</InlineAlert>
        <InlineAlert tone="success" live={false}>
          saved
        </InlineAlert>
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("refused").tagName).toBe("P");
    expect(screen.getByText("saved").tagName).toBe("P");
  });

  it("keeps the same visual style when live={false}", () => {
    render(
      <>
        <InlineAlert>live</InlineAlert>
        <InlineAlert live={false}>quiet</InlineAlert>
      </>,
    );
    expect(screen.getByText("quiet").getAttribute("style")).toBe(
      screen.getByText("live").getAttribute("style"),
    );
  });
});
