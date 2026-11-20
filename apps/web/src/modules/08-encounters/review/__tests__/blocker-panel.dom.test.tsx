// WF09 WP3 — the blocker panel: only what the server last said. T07 (a missing required section is an actionable blocker), T10
// (finalized is not signed), T13 (no false-ready badge), T33 (what nothing decides is never shown as passed), T34 (AI review is off, so
// no AI affordance), a 503 or garbage answer, an unknown code, axe and the keyboard order. Synthetic data only.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockerPanel } from "../blocker-panel";
import {
  type GateAttempt,
  type Refusal,
  connectionLostAttempt,
  parseRefusal,
} from "../refusal-model";
import { recordRemedyLabel } from "../remedy-route";

afterEach(cleanup);

const headingOf = (sectionId: string): string =>
  ({ assessment: "Assessment", vitals_review: "Vital Signs Review", plan: "Plan" })[sectionId] ??
  sectionId;

const refused = (input: unknown, moment: "finalize" | "sign" = "finalize"): GateAttempt => ({
  state: "refused",
  refusal: parseRefusal(input, moment, headingOf),
});

const gateFailed = (details: unknown): GateAttempt =>
  refused({ status: 422, code: "COMPLIANCE_GATE_FAILED", message: "m", details });

const TWO_FAILURES = [
  { field: "assessment", code: "MISSING_SECTION", message: "m" },
  { field: "bp", code: "MISSING_VITAL", message: "m" },
];

const FINALIZE_COPY =
  "Finalize runs the server checks; if they pass the note is finalized and its text is frozen. It is not signed.";
const SIGN_COPY = "Signing runs the server checks again; if they pass the note is signed.";

const refusedSignGate = (): GateAttempt =>
  refused(
    {
      status: 422,
      code: "COMPLIANCE_GATE_FAILED",
      message: "m",
      details: [{ field: "assessment", code: "MISSING_SECTION", message: "m" }],
    },
    "sign",
  );

function renderPanel(
  attempt: GateAttempt,
  handlers: { onRemedy?: () => void; onRetry?: () => void } = {},
) {
  return render(
    <BlockerPanel
      attempt={attempt}
      onRemedy={handlers.onRemedy ?? (() => undefined)}
      onRetry={handlers.onRetry}
      id="visit-complete"
    />,
  );
}

const panel = () => screen.getByRole("region", { name: "Finalize and sign checks" });
/** A group's list, named by its heading: everything a group says about its checks is inside it. */
const group = (name: string) => within(panel()).getByRole("list", { name });

describe("not checked yet (T13)", () => {
  it("says nothing has been checked, lists what the server will check, and shows no verdict", () => {
    renderPanel({ state: "none" });
    expect(within(panel()).getByText("Not checked yet")).toBeInTheDocument();
    expect(within(panel()).getByText(FINALIZE_COPY)).toBeInTheDocument();
    const finalize = group("Checked when you finalize");
    for (const title of [
      "Required sections",
      "Required vitals",
      "Required scales",
      "Care-plan review",
      "Vocabulary version",
      "Drafted sections",
    ]) {
      expect(within(finalize).getByText(title)).toBeInTheDocument();
    }
  });

  it("carries no ready badge, no tick, no pass wording and no count of anything complete", () => {
    renderPanel({ state: "none" });
    const text = panel().textContent ?? "";
    expect(text).not.toMatch(/✓|✔|\bready\b|\bpassed\b|\bcomplete\b|all clear/i);
    expect(text).not.toMatch(/\d+ of \d+/);
    expect(within(panel()).queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps a conditional check's condition beside it, so silence is not read as a pass", () => {
    renderPanel({ state: "none" });
    const finalize = group("Checked when you finalize");
    expect(within(finalize).getByText(/Only for recertification visits/)).toBeInTheDocument();
    expect(
      within(finalize).getByText(/Only when the patient has an active care plan/),
    ).toBeInTheDocument();
  });
});

describe("blocked (T07)", () => {
  it("lists each failure with what, why and a remedy button, and says how many", () => {
    renderPanel(gateFailed(TWO_FAILURES));
    expect(within(panel()).getByText("Blocked: 2 items to fix")).toBeInTheDocument();
    const rows = within(panel())
      .getAllByRole("listitem")
      .filter((row) => row.dataset.blocker !== undefined);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Assessment has no entry")).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByText(/template requires this section/i),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText("Blood pressure is not recorded"),
    ).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByRole("button", { name: "Go to Assessment" }),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByRole("button", { name: "Open visit vitals" }),
    ).toBeInTheDocument();
  });

  it("says the note was not finalized and froze nothing", () => {
    renderPanel(gateFailed(TWO_FAILURES));
    expect(
      within(panel()).getByText(/The note was not finalized\. Nothing was frozen or signed\./),
    ).toBeInTheDocument();
  });

  it("moves focus to the field the remedy names", async () => {
    const user = userEvent.setup();
    function Host() {
      const [target, setTarget] = useState("none");
      // A host holds the attempt in state: a new object is a new answer from the server.
      const [attempt] = useState(() =>
        gateFailed([{ field: "assessment", code: "MISSING_SECTION", message: "m" }]),
      );
      return (
        <>
          <label>
            Assessment text
            <textarea id="field-assessment" />
          </label>
          <BlockerPanel
            attempt={attempt}
            onRemedy={(t) => {
              setTarget(t.kind);
              if (t.kind === "section") document.getElementById(`field-${t.sectionId}`)?.focus();
            }}
          />
          <output>{target}</output>
        </>
      );
    }
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "Go to Assessment" }));
    expect(screen.getByLabelText("Assessment text")).toHaveFocus();
  });

  it("lets a screen relabel a remedy it can only partly honour, without changing the target", async () => {
    const user = userEvent.setup();
    const onRemedy = vi.fn();
    render(
      <BlockerPanel
        attempt={refused({
          status: 409,
          code: "VOCAB_VERSION_MISMATCH",
          message: "m",
          details: undefined,
        })}
        onRemedy={onRemedy}
        remedyLabel={recordRemedyLabel}
      />,
    );
    expect(screen.queryByRole("button", { name: "Save the selections again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open the composer" }));
    expect(onRemedy).toHaveBeenCalledWith({ kind: "save_selections" });
  });

  it("hands the host the target of the blocker that was chosen", async () => {
    const user = userEvent.setup();
    const onRemedy = vi.fn();
    renderPanel(gateFailed(TWO_FAILURES), { onRemedy });
    await user.click(screen.getByRole("button", { name: "Open visit vitals" }));
    expect(onRemedy).toHaveBeenCalledWith({ kind: "vitals", vital: "bp" });
  });

  it("says the other gate checks did not list a failure, that some are not evaluated, and which later steps were not reached, only for a gate failure", () => {
    const { unmount } = renderPanel(gateFailed(TWO_FAILURES));
    expect(
      within(panel()).getByText(
        /The other checks in the finalize gate did not list a failure in this attempt; some checks are not evaluated \(see below\)\. Checks that run after the gate \(complete selections, vocabulary version, your edited note text\) were not reached\./,
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryByText(/reported no failure/)).toBeNull();
    unmount();
    renderPanel(
      refused({ status: 409, code: "VOCAB_VERSION_MISMATCH", message: "m", details: undefined }),
    );
    expect(within(panel()).queryByText(/did not list a failure/)).toBeNull();
  });

  it("names, after a refused sign, what runs after the gate and was never reached (the cosigner, the face-to-face record, delivery and times)", () => {
    renderPanel(refusedSignGate());
    expect(
      within(panel()).getByText(
        /The other checks in the sign gate did not list a failure in this attempt; some checks are not evaluated \(see below\)\. Checks that run after the gate \(the RN cosigner, the face-to-face record, the visit delivery and times\) were not reached\./,
      ),
    ).toBeInTheDocument();
  });

  it("shows a code it does not know as a row with the open-the-note remedy, not nothing", () => {
    renderPanel(gateFailed([{ code: "A_FUTURE_CHECK", message: "The server says this." }]));
    expect(within(panel()).getByText("The server reported a problem")).toBeInTheDocument();
    expect(within(panel()).getByText("The server says this.")).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Open the note" })).toBeInTheDocument();
  });

  it("shows one generic row for an answer that listed nothing readable", () => {
    renderPanel(gateFailed("garbled"));
    expect(within(panel()).getByText(/It did not list what to fix/)).toBeInTheDocument();
  });

  it("gives advice and no button when only another person can fix it", () => {
    renderPanel(
      refused(
        { status: 422, code: "NO_ELIGIBLE_COSIGNER", message: "m", details: undefined },
        "sign",
      ),
    );
    expect(within(panel()).getByText("No RN is available to cosign")).toBeInTheDocument();
    expect(within(panel()).queryAllByRole("button")).toHaveLength(0);
  });

  it("says a refused sign was not signed", () => {
    renderPanel(
      refused({ status: 403, code: "STEP_UP_REQUIRED", message: "m", details: undefined }, "sign"),
    );
    expect(within(panel()).getByText(/The note was not signed\./)).toBeInTheDocument();
  });
});

describe("unavailable", () => {
  it("says a 503 in fixed words, never the server's message, and offers a retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderPanel(
      refused({
        status: 503,
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        message: "care plan reader failed: ECONNREFUSED 10.0.0.5:5432",
        details: undefined,
      }),
      { onRetry },
    );
    expect(within(panel()).getByText("Unavailable")).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        "The server could not run its checks right now, so the note was not finalized. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(panel().textContent).not.toContain("ECONNREFUSED");
    await user.click(within(panel()).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says a dropped connection leaves the result unknown", () => {
    renderPanel(refused({ status: null, code: null, message: "m", details: undefined }));
    expect(
      within(panel()).getByText(/The connection was interrupted before the server answered/),
    ).toBeInTheDocument();
  });

  it("offers no retry when the host gave none", () => {
    renderPanel(
      refused({
        status: 503,
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        message: "m",
        details: undefined,
      }),
    );
    expect(within(panel()).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("does not say the note was not finalized after an error that does not say whether it changed, and offers no retry", () => {
    for (const status of [500, 502, 504]) {
      cleanup();
      renderPanel(refused({ status, code: null, message: "m", details: undefined }), {
        onRetry: () => undefined,
      });
      expect(within(panel()).getByText("Unavailable")).toBeInTheDocument();
      expect(
        within(panel()).getByText(
          "The server answered with an error that does not say whether the note changed, so the result is not known. Reload the note to see its status.",
        ),
      ).toBeInTheDocument();
      expect(panel().textContent).not.toMatch(/was not finalized/);
      expect(within(panel()).queryByRole("button", { name: "Try again" })).toBeNull();
    }
  });

  it("says a sign refused for rate limiting was not signed, and offers the retry", () => {
    renderPanel(refused({ status: 429, code: "X", message: "m", details: undefined }, "sign"), {
      onRetry: () => undefined,
    });
    expect(
      within(panel()).getByText(
        "The server could not run its checks right now, so the note was not signed. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("a refusal that says nothing about the note's state", () => {
  const MOVED = { status: 409, code: "ILLEGAL_TRANSITION", message: "m", details: undefined };

  it("does not say the note was not finalized when the note already moved on, and says the screen read it again", () => {
    renderPanel(refused(MOVED));
    expect(within(panel()).getByText("Refused: the note changed elsewhere")).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        "The server refused this request. This screen has read the note again and shows its current status.",
      ),
    ).toBeInTheDocument();
    expect(panel().textContent).not.toMatch(/was not finalized|Nothing was frozen|was not signed/);
    expect(within(panel()).queryAllByRole("button")).toHaveLength(0);
  });

  it("says only that the server refused, and to reload, for a code it does not know", () => {
    renderPanel(
      refused({ status: 409, code: "A_FUTURE_REFUSAL", message: "Odd.", details: undefined }),
    );
    expect(
      within(panel()).getByText(
        "The server refused this request. Reload to see the note's current status.",
      ),
    ).toBeInTheDocument();
    expect(panel().textContent).not.toMatch(/was not finalized|Nothing was frozen/);
  });
});

describe("a refused sign", () => {
  it("says what a sign does, not what a finalize does, and does not list the finalize checks", () => {
    for (const refusal of [
      refusedSignGate(),
      refused(
        { status: 503, code: "COMPLIANCE_GATE_UNAVAILABLE", message: "m", details: undefined },
        "sign",
      ),
    ]) {
      cleanup();
      renderPanel(refusal);
      expect(within(panel()).getByText(SIGN_COPY)).toBeInTheDocument();
      expect(within(panel()).queryByText(FINALIZE_COPY)).toBeNull();
      expect(within(panel()).queryByRole("list", { name: "Checked when you finalize" })).toBeNull();
      expect(group("Checked when you sign")).toBeInTheDocument();
    }
  });

  it("still lists the finalize checks after a finalize the server could not decide", () => {
    renderPanel(
      refused({
        status: 503,
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        message: "m",
        details: undefined,
      }),
    );
    expect(within(panel()).getByText(FINALIZE_COPY)).toBeInTheDocument();
    expect(group("Checked when you finalize")).toBeInTheDocument();
  });
});

describe("finalized, not signed (T10)", () => {
  it("says the note is finalized, its text frozen and that it is not signed", () => {
    renderPanel({ state: "finalized" });
    expect(within(panel()).getByText("Finalized, not signed")).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        "The server finalized this note and its text is frozen. It is not signed. Signing is a separate step.",
      ),
    ).toBeInTheDocument();
  });

  it("makes no claim that the note is signed, ready to sign or cleared", () => {
    renderPanel({ state: "finalized" });
    const text = panel().textContent ?? "";
    expect(text).not.toMatch(/ready to sign|has been signed|is signed|cleared|✓/i);
    expect(within(panel()).queryByText(/^Signed$/)).toBeNull();
  });

  it("still lists what is checked when you sign and what is not checked at all", () => {
    renderPanel({ state: "finalized" });
    expect(group("Checked when you sign")).toBeInTheDocument();
    expect(group("Not checked by ChartWarden")).toBeInTheDocument();
    expect(within(panel()).getByText(/runs the gate again when you sign/i)).toBeInTheDocument();
  });
});

describe("what is checked at sign and what is not checked (T33, T34)", () => {
  const states: readonly [string, GateAttempt][] = [
    ["not checked yet", { state: "none" }],
    ["running", { state: "running" }],
    ["blocked", gateFailed(TWO_FAILURES)],
    ["unavailable", refused({ status: 503, code: "X", message: "m", details: undefined })],
    ["finalized", { state: "finalized" }],
  ];

  it.each(states)("lists the sign checks in every state (%s)", (_name, attempt) => {
    renderPanel(attempt);
    const sign = group("Checked when you sign");
    for (const title of ["Recent sign-in", "RN cosigner", "Face-to-face record"]) {
      expect(within(sign).getByText(title)).toBeInTheDocument();
    }
  });

  it("lists the late-entry check with the finalize checks, saying the reason is judged then and the override at sign", () => {
    renderPanel({ state: "none" });
    const finalize = group("Checked when you finalize");
    expect(within(finalize).getByText("Late entry")).toBeInTheDocument();
    expect(
      within(finalize).getByText(/when you finalize, before the other checks/),
    ).toBeInTheDocument();
    expect(
      within(finalize).getByText(/more than 1 calendar day after the visit date/),
    ).toBeInTheDocument();
    expect(within(finalize).getByText(/At sign, a note more than 3 days late/)).toBeInTheDocument();
    expect(within(group("Checked when you sign")).queryByText("Late entry")).toBeNull();
  });

  it.each(states)(
    "states that HOPE items, AI review and the acknowledgment are not checked (%s)",
    (_name, attempt) => {
      renderPanel(attempt);
      const unchecked = group("Not checked by ChartWarden");
      expect(within(unchecked).getByText("Required HOPE items")).toBeInTheDocument();
      expect(
        within(unchecked).getByText(
          /Not checked\. ChartWarden cannot tell which note carries a HOPE timepoint/,
        ),
      ).toBeInTheDocument();
      expect(within(unchecked).getByText("AI review decisions")).toBeInTheDocument();
      expect(
        within(unchecked).getByText(/AI enhancement of the note is not available/),
      ).toBeInTheDocument();
      expect(within(unchecked).getByText("Acknowledgment recording")).toBeInTheDocument();
      expect(
        within(unchecked).getByText(/server does not record this acknowledgment/),
      ).toBeInTheDocument();
    },
  );

  it.each(states)(
    "never calls what nothing decides passed, attested or verified (%s)",
    (_name, attempt) => {
      renderPanel(attempt);
      const unchecked = group("Not checked by ChartWarden").textContent ?? "";
      expect(unchecked).not.toMatch(/passed|attested|verified|✓|complete|ready/i);
    },
  );

  it.each(states)(
    "offers no AI affordance and nothing to act on among what is not checked (%s)",
    (_name, attempt) => {
      renderPanel(attempt);
      expect(within(group("Not checked by ChartWarden")).queryAllByRole("button")).toHaveLength(0);
      expect(within(group("Not checked by ChartWarden")).queryAllByRole("link")).toHaveLength(0);
      expect(
        within(panel()).queryByRole("button", { name: /\bAI\b|enhance|layer|suggest|summar/i }),
      ).toBeNull();
    },
  );
});

describe("accessibility", () => {
  it("is a labelled region whose result changes are announced politely", () => {
    renderPanel({ state: "none" });
    expect(panel()).toBeInTheDocument();
    const status = within(panel()).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Not checked yet");
  });

  it("is described by its status line, so focus on the panel reads what it last said", () => {
    renderPanel({ state: "finalized" });
    expect(panel()).toHaveAccessibleDescription(/Finalized, not signed/);
  });

  it("announces a new result in the same live region", () => {
    const { rerender } = renderPanel({ state: "none" });
    const status = within(panel()).getByRole("status");
    rerender(<BlockerPanel attempt={gateFailed(TWO_FAILURES)} onRemedy={() => undefined} />);
    expect(within(panel()).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Blocked: 2 items to fix");
  });

  it("marks the panel busy while the server is checking", () => {
    renderPanel({ state: "running" });
    expect(panel()).toHaveAttribute("aria-busy", "true");
    expect(within(panel()).getByRole("status")).toHaveTextContent(
      "Finalizing: waiting for the server",
    );
  });

  it("takes the anchor the visit workspace gives it, and can be focused when that step is jumped to", () => {
    renderPanel({ state: "none" });
    expect(panel()).toHaveAttribute("id", "visit-complete");
    expect(panel()).toHaveAttribute("tabindex", "-1");
  });

  it.each([
    ["not checked yet", { state: "none" } as GateAttempt],
    ["blocked", gateFailed(TWO_FAILURES)],
    ["unavailable", refused({ status: 503, code: "X", message: "m", details: undefined })],
    ["finalized", { state: "finalized" } as GateAttempt],
  ])("has no axe violations (%s)", async (_name, attempt) => {
    const { container } = renderPanel(attempt);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("focus and keyboard order", () => {
  it("moves focus to the first blocker when a finalize comes back blocked", () => {
    const { rerender } = renderPanel({ state: "running" });
    expect(document.body).toHaveFocus();
    act(() => {
      rerender(<BlockerPanel attempt={gateFailed(TWO_FAILURES)} onRemedy={() => undefined} />);
    });
    const first = within(panel())
      .getAllByRole("listitem")
      .find((row) => row.dataset.blocker !== undefined);
    expect(first).toHaveFocus();
  });

  it("moves focus again when a second attempt is blocked", () => {
    const { rerender } = renderPanel(gateFailed(TWO_FAILURES));
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      rerender(<BlockerPanel attempt={gateFailed(TWO_FAILURES)} onRemedy={() => undefined} />);
    });
    const first = within(panel())
      .getAllByRole("listitem")
      .find((row) => row.dataset.blocker !== undefined);
    expect(first).toHaveFocus();
  });

  it("tabs from the first blocker to its remedy, then the next blocker's remedy, and nowhere else in the panel", async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel({ state: "running" });
    act(() => {
      rerender(<BlockerPanel attempt={gateFailed(TWO_FAILURES)} onRemedy={() => undefined} />);
    });
    await user.tab();
    expect(screen.getByRole("button", { name: "Go to Assessment" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Open visit vitals" })).toHaveFocus();
    await user.tab();
    expect(panel().contains(document.activeElement)).toBe(false);
  });

  it("takes focus itself when the server could not decide, so the failure is not left below the fold", () => {
    const { rerender } = renderPanel({ state: "running" });
    expect(document.body).toHaveFocus();
    act(() => {
      rerender(
        <BlockerPanel
          attempt={refused({
            status: 503,
            code: "COMPLIANCE_GATE_UNAVAILABLE",
            message: "m",
            details: undefined,
          })}
          onRemedy={() => undefined}
        />,
      );
    });
    expect(panel()).toHaveFocus();
  });

  it("takes focus itself when the connection was lost, and again for a second such answer", () => {
    const { rerender } = renderPanel({ state: "running" });
    act(() => {
      rerender(
        <BlockerPanel attempt={connectionLostAttempt("finalize")} onRemedy={() => undefined} />,
      );
    });
    expect(panel()).toHaveFocus();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      rerender(
        <BlockerPanel attempt={connectionLostAttempt("finalize")} onRemedy={() => undefined} />,
      );
    });
    expect(panel()).toHaveFocus();
  });

  it("does not take focus for a state that is not a failure", () => {
    const { rerender } = renderPanel({ state: "none" });
    act(() => {
      rerender(<BlockerPanel attempt={{ state: "finalized" }} onRemedy={() => undefined} />);
    });
    expect(document.body).toHaveFocus();
  });
});

describe("a screen that keeps focus elsewhere", () => {
  it("does not take focus while takeFocus is off, and takes it once it turns on", () => {
    const attempt = gateFailed(TWO_FAILURES);
    const { rerender } = render(
      <BlockerPanel attempt={attempt} onRemedy={() => undefined} takeFocus={false} />,
    );
    expect(document.body).toHaveFocus();
    act(() => {
      rerender(<BlockerPanel attempt={attempt} onRemedy={() => undefined} takeFocus={true} />);
    });
    const first = within(panel())
      .getAllByRole("listitem")
      .find((row) => row.dataset.blocker !== undefined);
    expect(first).toHaveFocus();
  });

  it("says a refused sign is the server's last answer, as a refused finalize is", () => {
    renderPanel(
      refused(
        { status: 422, code: "NO_ELIGIBLE_COSIGNER", message: "m", details: undefined },
        "sign",
      ),
    );
    expect(
      within(panel()).getByText(
        /The note was not signed\. This is the server's last answer: sign again to check again\./,
      ),
    ).toBeInTheDocument();
    cleanup();
    renderPanel(gateFailed(TWO_FAILURES));
    expect(
      within(panel()).getByText(
        /This is the server's last answer: finalize again to check again\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("robustness", () => {
  it("renders a refusal object it was handed that is not one of its own, without throwing", () => {
    const refusal = {
      outcome: "blocked",
      moment: "finalize",
      code: "X",
      gateRanInFull: false,
      decidedBeforeWrite: false,
      blockers: [],
    } as Refusal;
    renderPanel({ state: "refused", refusal });
    expect(
      within(panel()).getByText("Blocked: the server did not list what to fix"),
    ).toBeInTheDocument();
  });
});
