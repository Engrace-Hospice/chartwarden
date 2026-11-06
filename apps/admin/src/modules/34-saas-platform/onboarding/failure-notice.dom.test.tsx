// @vitest-environment jsdom
// A refusal is announced once and is valid markup: one alert per notice, and no list, link or block inside a paragraph.
import type { OpsFailure } from "@chartwarden/ui";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FailureNotice } from "./failure-notice";

const failure = (over: Partial<OpsFailure>): OpsFailure => ({
  kind: "unknown",
  code: null,
  status: 500,
  message: "That did not work.",
  fieldErrors: {},
  details: [],
  current: null,
  blockedBy: null,
  correlationId: null,
  ...over,
});
const show = (f: OpsFailure) =>
  render(
    <MemoryRouter>
      <FailureNotice failure={f} orgSlug="cedar" />
    </MemoryRouter>,
  );

describe("FailureNotice", () => {
  it("a conflict with details is ONE alert, the details a list outside any paragraph", () => {
    const { container } = show(
      failure({
        kind: "conflict",
        status: 409,
        message: "Approval was refused.",
        details: [
          {
            field: "baaExecuted",
            code: "GUARD",
            message: "the latest platform BAA must be executed",
          },
        ],
      }),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(container).getByText("the latest platform BAA must be executed")).toBeTruthy();
    expect(container.querySelectorAll("p ul, p div, p a")).toHaveLength(0);
  });

  it("a step-up refusal is one alert with the Re-verify link beside it, not inside it", () => {
    const { container } = show(
      failure({ kind: "step-up", status: 403, message: "Re-verify first." }),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Re-verify/ })).toBeTruthy();
    expect(container.querySelectorAll("p a")).toHaveLength(0);
  });

  it("an out-of-order refusal is one alert with the link to the earlier step", () => {
    const { container } = show(
      failure({
        kind: "locked",
        status: 409,
        message: "An earlier step is not finished.",
        blockedBy: "baa_executed",
      }),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Go to baa_executed" })).toBeTruthy();
    expect(container.querySelectorAll("p a")).toHaveLength(0);
  });
});
