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
});
