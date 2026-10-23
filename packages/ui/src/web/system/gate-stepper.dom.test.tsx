// Audit F-041: a completed step is marked by its check icon, never struck through (that reads as removed).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GateStepper } from "./guardrail";

describe("GateStepper", () => {
  it("does not strike through completed steps", () => {
    render(
      <GateStepper
        items={[
          { id: "a", label: "Incident", status: "complete" },
          { id: "b", label: "Details", status: "in-progress" },
        ]}
      />,
    );
    expect(screen.getByText("Incident").style.textDecoration).not.toContain("line-through");
  });
});
