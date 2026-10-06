// apps/web/src/shell/hospice-coverage.dom.test.tsx — COP27 (42 CFR 418.24(c)): the shared hospice coverage
// control. A not-covered determination needs a reason (mirrors the server's 422); the section renders the
// current determination and only calls `onSave` with a valid draft.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  COVERAGE_REASON_MAX,
  HospiceCoverageBadge,
  HospiceCoverageSection,
  validateCoverageForm,
} from "./hospice-coverage";

describe("validateCoverageForm", () => {
  it("requires a reason when the item is not covered", () => {
    expect(validateCoverageForm("not_covered_unrelated", "  ")).toMatch(/reason is required/i);
    expect(validateCoverageForm("not_covered_other", "")).toMatch(/reason is required/i);
  });

  it("accepts a covered determination with no reason and a not-covered one with a reason", () => {
    expect(validateCoverageForm("covered_related", "")).toBeNull();
    expect(
      validateCoverageForm("not_covered_unrelated", "Statin for unrelated cholesterol"),
    ).toBeNull();
  });

  it("caps the reason length", () => {
    expect(validateCoverageForm("not_covered_other", "x".repeat(COVERAGE_REASON_MAX + 1))).toMatch(
      /at most/,
    );
  });
});

describe("HospiceCoverageBadge", () => {
  it("renders nothing for a covered row by default and a pill for a not-covered row", () => {
    const { container, rerender } = render(<HospiceCoverageBadge coverage="covered_related" />);
    expect(container.textContent).toBe("");
    rerender(<HospiceCoverageBadge coverage="not_covered_unrelated" />);
    expect(screen.getByText("Not covered — unrelated")).toBeTruthy();
  });
});

describe("HospiceCoverageSection", () => {
  const current = {
    hospiceCoverage: "covered_related" as const,
    coverageReason: null,
    coverageDeterminedAt: null,
    coverageDeterminedBy: null,
  };

  it("shows the presumed-related state and blocks a not-covered save without a reason", async () => {
    const onSave = vi.fn(async () => null);
    render(<HospiceCoverageSection current={current} onSave={onSave} />);
    expect(screen.getByText("Not reviewed — presumed related")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("combobox", { name: /Hospice coverage/ }), {
      target: { value: "not_covered_unrelated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save determination" }));
    expect(await screen.findByText(/reason is required/i)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: /Reason/ }), {
      target: { value: "Treats an unrelated thyroid condition" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save determination" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        hospiceCoverage: "not_covered_unrelated",
        reason: "Treats an unrelated thyroid condition",
      }),
    );
  });

  it("renders a server refusal in place and stays in edit mode", async () => {
    const onSave = vi.fn(async () => "You do not hold the authority this action requires.");
    render(<HospiceCoverageSection current={current} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save determination" }));
    expect(await screen.findByText(/do not hold the authority/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save determination" })).toBeTruthy();
  });
});
