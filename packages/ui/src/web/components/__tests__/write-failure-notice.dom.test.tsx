// @vitest-environment jsdom
// A refusal is announced once and is valid markup: one alert per notice holding the sentence and its detail lines, the Re-verify link and
// the earlier-step link beside it, and how long to wait when the server said.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { OpsFailure } from "../../../core/ops-write/ops-error";
import { WriteFailureNotice } from "../write-failure-notice";

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
const show = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("WriteFailureNotice", () => {
  it("lists a coded conflict's details inside the one alert, outside any paragraph", () => {
    const { container } = show(
      <WriteFailureNotice
        failure={failure({
          kind: "conflict",
          status: 409,
          message: "Refused.",
          details: [{ field: "x", code: "C", message: "an earlier step is open" }],
        })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(alert).getByText("Refused.")).toBeTruthy();
    expect(within(alert).getByText("an earlier step is open")).toBeTruthy();
    expect(container.querySelectorAll("p ul, p div, p a")).toHaveLength(0);
  });

  it("shows the lane's own detail lines, or none", () => {
    const { rerender } = show(
      <WriteFailureNotice failure={failure({})} detailLines={["Every required step is done"]} />,
    );
    expect(screen.getByText("Every required step is done")).toBeTruthy();
    rerender(
      <MemoryRouter>
        <WriteFailureNotice
          failure={failure({
            kind: "conflict",
            details: [{ field: "x", code: "C", message: "hidden" }],
          })}
          detailLines={null}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it("offers Re-verify for a stale sign-in and runs the stash first", () => {
    const stash = vi.fn();
    show(
      <WriteFailureNotice failure={failure({ kind: "step-up", status: 403 })} onReverify={stash} />,
    );
    screen.getByRole("link", { name: "Re-verify" }).click();
    expect(stash).toHaveBeenCalledTimes(1);
  });

  it("links the earlier step a locked refusal names, in the lane's own route", () => {
    show(
      <WriteFailureNotice
        failure={failure({ kind: "locked", blockedBy: "baa_executed" })}
        blockedStepLink={(key) => <a href={`/steps/${key}`}>Go to {key}</a>}
      />,
    );
    expect(screen.getByRole("link", { name: "Go to baa_executed" })).toBeTruthy();
  });

  it("says how long to wait when the server asked, and quotes a reference only for a failure that is not the person's", () => {
    show(
      <WriteFailureNotice
        failure={failure({ kind: "unavailable", correlationId: "corr-9", retryAfterSeconds: 30 })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Reference: corr-9.");
    expect(screen.getByRole("alert").textContent).toContain("Try again in about 30 seconds.");
  });

  it("says details need attention, not the server's sentence, when fields carry the refusal", () => {
    show(
      <WriteFailureNotice
        failure={failure({ kind: "validation", fieldErrors: { secret: "no" } })}
      />,
    );
    expect(screen.getByText("Some details need attention.")).toBeTruthy();
  });
});
