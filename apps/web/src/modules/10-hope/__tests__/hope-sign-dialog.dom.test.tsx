// @vitest-environment jsdom
import { HOPE_SIGN_ATTESTATION_STATEMENT } from "@chartwarden/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignDialog } from "../hope-sign-dialog";

const READY_REVIEW = {
  validation: { warningCount: 1, errorCount: 0 },
  readiness: { readyToSign: true },
};

function renderSignDialog(
  overrides: {
    signing?: boolean;
    error?: string | null;
    wordingChanged?: boolean;
    review?: typeof READY_REVIEW;
  } = {},
) {
  const onCancel = vi.fn();
  const onSign = vi.fn();
  const view = render(
    <SignDialog
      review={overrides.review ?? READY_REVIEW}
      title="Complete Admission"
      signing={overrides.signing ?? false}
      error={overrides.error ?? null}
      wordingChanged={overrides.wordingChanged ?? false}
      onCancel={onCancel}
      onSign={onSign}
    />,
  );
  return {
    onCancel,
    onSign,
    rerender: view.rerender,
    dialog: screen.getByRole("dialog", { name: "Complete Admission" }),
  };
}

const NOT_READY_REVIEW = {
  validation: { warningCount: 0, errorCount: 2 },
  readiness: { readyToSign: false },
};

describe("SignDialog", () => {
  describe("what is still missing", () => {
    const hint = (dialog: HTMLElement) => {
      const sign = within(dialog).getByRole("button", { name: "Sign & complete" });
      const id = sign.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      return document.getElementById(id as string) as HTMLElement;
    };

    it("lists it beside the disabled button, which points at the list", () => {
      const { dialog } = renderSignDialog({ review: NOT_READY_REVIEW });
      expect(hint(dialog).textContent).toBe(
        "To sign: resolve the blocking items in the review, tick the attestation.",
      );
    });

    it("says ready only once the attestation is ticked and the review allows signing", () => {
      const { dialog } = renderSignDialog();
      expect(hint(dialog).textContent).toBe("To sign: tick the attestation.");
      fireEvent.click(
        within(dialog).getByRole("checkbox", { name: HOPE_SIGN_ATTESTATION_STATEMENT }),
      );
      expect(hint(dialog).textContent).toBe("Ready to sign.");
      expect(
        (within(dialog).getByRole("button", { name: "Sign & complete" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    it("says to reload when the attestation wording changed", () => {
      const { dialog } = renderSignDialog({ wordingChanged: true });
      expect(hint(dialog).textContent).toContain(
        "reload the page to review the new attestation wording",
      );
    });
  });

  it("has one scrolling region, like the SFV dialog: the card, with nothing inside it that scrolls too", () => {
    const { dialog } = renderSignDialog();
    const scrolling = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
      ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
    );
    expect(scrolling).toEqual([]);
    // The accent strip is drawn inside the content, so the card adds no border that could make it scroll as well.
    expect(dialog.style.borderTop).toBe("");
    expect(dialog.style.padding).toBe("");
  });

  it("labels the checkbox with the attestation wording the audit version names", () => {
    const { dialog } = renderSignDialog();
    const box = within(dialog).getByRole("checkbox", { name: HOPE_SIGN_ATTESTATION_STATEMENT });
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("cannot be cancelled by Cancel or Escape while the signature is in flight", () => {
    const { dialog, onCancel } = renderSignDialog({ signing: true });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.keyDown(dialog, { key: "Escape" });
    for (const scrim of screen.getAllByRole("button", { name: "Close" })) fireEvent.click(scrim);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("is cancelled by Cancel and by Escape when nothing is in flight", () => {
    const { dialog, onCancel } = renderSignDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("announces a refusal once: an alert, without a second live region on top", () => {
    const { dialog } = renderSignDialog({ error: "Your role cannot sign this record." });
    const alert = within(dialog).getByRole("alert");
    expect(alert.textContent).toBe("Your role cannot sign this record.");
    expect(alert.hasAttribute("aria-live")).toBe(false);
  });

  it("cannot sign again once the attestation wording it shows is out of date", () => {
    const { dialog, onSign } = renderSignDialog({
      error: "The attestation wording has changed. Reload the page and review it again.",
      wordingChanged: true,
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: HOPE_SIGN_ATTESTATION_STATEMENT }),
    );
    const sign = within(dialog).getByRole("button", {
      name: "Sign & complete",
    }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.click(sign);
    expect(onSign).not.toHaveBeenCalled();
  });

  it("announces an error that is already known when it opens, without taking focus from the attestation checkbox", () => {
    const { dialog } = renderSignDialog({
      error: "The attestation wording has changed. Reload the page and review it again.",
      wordingChanged: true,
    });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "The attestation wording has changed. Reload the page and review it again.",
    );
    expect(document.activeElement).toBe(
      within(dialog).getByRole("checkbox", { name: HOPE_SIGN_ATTESTATION_STATEMENT }),
    );
  });

  it("moves focus to the attestation checkbox when it opens", () => {
    const { dialog } = renderSignDialog();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("checkbox", { name: HOPE_SIGN_ATTESTATION_STATEMENT }),
    );
  });

  it("moves focus to the refusal when one arrives, so Escape and Tab keep working inside the dialog", () => {
    const { rerender, onCancel } = renderSignDialog({ signing: true });
    rerender(
      <SignDialog
        review={READY_REVIEW}
        title="Complete Admission"
        signing={false}
        error="Your role cannot sign this record."
        wordingChanged={false}
        onCancel={onCancel}
        onSign={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Complete Admission" });
    const alert = within(dialog).getByRole("alert");
    expect(document.activeElement).toBe(alert);
    fireEvent.keyDown(alert, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
