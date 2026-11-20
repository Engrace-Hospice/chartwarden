// @vitest-environment jsdom
// The retry beside a failed read keeps keyboard focus while the read is out, and says so in a status region that was already on the page
// (S1 React review): a button that turns `disabled` on press drops focus to the page, and a region mounted with its text is not announced.
// Synthetic data only.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmendmentReview } from "../amendment-review";
import { DraftUnavailable } from "../draft-summary";
import type { DraftLoad, NoteDraft } from "../use-note-draft";

afterEach(cleanup);

describe("the retry of the composer's draft strip", () => {
  it("stays focusable, says it is working, and sends nothing more while the read is out", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<DraftUnavailable retrying={false} onRetry={onRetry} />);
    const status = document.querySelector("output.wx-row-sub") as HTMLOutputElement;
    expect(status.textContent).toBe("");
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<DraftUnavailable retrying onRetry={onRetry} />);
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveFocus();
    expect(status.textContent).toMatch(/reading/i);
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<DraftUnavailable retrying={false} onRetry={onRetry} />);
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(status.textContent).toBe("");
  });
});

describe("the retry of an amendment's review", () => {
  const unavailable = (
    refreshing: boolean,
    reload: () => Promise<DraftLoad | null>,
  ): NoteDraft => ({
    load: { status: "unavailable" },
    busySectionId: null,
    notes: {},
    refreshing,
    reload,
    resolve: vi.fn(async () => false),
  });
  const named = "addendum 1 of 1, opened 2026-10-01 10:00";

  it("stays focusable and sends nothing more while the draft is read again", async () => {
    const user = userEvent.setup();
    const reload = vi.fn(async () => null);
    const view = (refreshing: boolean) => (
      <AmendmentReview
        addendumId="add-1"
        addendumName="addendum 1 of 1, opened 2026-10-01 10:00"
        sectionIds={["pain"]}
        draft={unavailable(refreshing, reload)}
      />
    );
    const { rerender } = render(view(false));
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
    rerender(view(true));
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveFocus();
    await user.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The retry goes when the sections load. The region that held it is still there: focus goes to it, and it says what happened in a
  // status that was already on the page (a region mounted with its text is not announced).
  it("moves focus to the region and says the sections loaded, once the retry succeeds", async () => {
    const user = userEvent.setup();
    const loaded: DraftLoad = {
      status: "ready",
      draft: {
        encounterId: "enc-1",
        patientId: "patient-1",
        templateKey: "routine_visit:rn",
        asOf: "2026-10-01T23:59:59.999Z",
        sections: [
          {
            sectionId: "pain",
            state: "unresolved",
            text: "Redrafted pain.",
            contentHash: "hash-pain",
            corpusVersion: "2026.1.0",
            part2Derived: false,
            origins: ["vitals"],
          },
        ],
      },
    };
    let failAgain: () => void = () => undefined;
    function Host() {
      const [load, setLoad] = useState<DraftLoad>({ status: "unavailable" });
      failAgain = () => setLoad({ status: "unavailable" });
      const draft: NoteDraft = {
        load,
        busySectionId: null,
        notes: {},
        refreshing: false,
        reload: async () => {
          setLoad(loaded);
          return loaded;
        },
        resolve: vi.fn(async () => false),
      };
      return (
        <AmendmentReview
          addendumId="add-1"
          addendumName={named}
          sectionIds={["pain"]}
          draft={draft}
        />
      );
    }
    render(<Host />);
    const region = screen.getByRole("region", { name: /^Amended sections/ });
    // The region's own status (its last child), not the retry's, which goes with it.
    const status = region.lastElementChild as HTMLOutputElement;
    expect(status.tagName).toBe("OUTPUT");
    expect(status).toBeEmptyDOMElement();
    const retry = within(region).getByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(await within(region).findByText("Redrafted pain.")).toBeInTheDocument();
    expect(retry).not.toBeInTheDocument();
    await waitFor(() => expect(region).toHaveFocus());
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent(/The amended sections loaded/);
    // A later read fails: what the last retry said must not sit beside the new failure.
    act(() => failAgain());
    expect(status).toBeEmptyDOMElement();
  });

  it("leaves focus alone when the retry is answered with a draft that still cannot be read", async () => {
    const user = userEvent.setup();
    const still: DraftLoad = { status: "unavailable" };
    const reload = vi.fn(async () => still);
    render(
      <AmendmentReview
        addendumId="add-1"
        addendumName={named}
        sectionIds={["pain"]}
        draft={unavailable(false, reload)}
      />,
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(retry).toHaveFocus();
  });
});
