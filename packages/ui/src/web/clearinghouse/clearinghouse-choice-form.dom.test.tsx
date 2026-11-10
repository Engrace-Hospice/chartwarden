// @vitest-environment jsdom
// The shared choice form: the operator's wording by default, a lane's own through `copy`, and a submit that keeps focus (aria-disabled, not
// disabled) while a write runs, so a second press is dropped and the focused control never vanishes.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BLANK_CHOICE, ChoiceFormCard } from "./clearinghouse-choice-form";
import type { ClearinghouseSharedView } from "./clearinghouse-model";

const NOTHING_CHOSEN: ClearinghouseSharedView = {
  vendor: null,
  mode: null,
  status: null,
  source: "none",
  hasSecret: false,
  verifiableBy: null,
  verification: null,
  lastTest: null,
  baaRequired: false,
  baa: null,
  activatedAt: null,
  version: null,
  updatedAt: null,
};
const CONTEXT = { tenantStatus: "onboarding", hasContract: false };

function show(over: Partial<React.ComponentProps<typeof ChoiceFormCard>> = {}) {
  const onContinue = vi.fn();
  render(
    <ChoiceFormCard
      view={NOTHING_CHOSEN}
      form={BLANK_CHOICE}
      secret=""
      errors={{}}
      context={CONTEXT}
      onChange={() => undefined}
      onSecret={() => undefined}
      onCancel={() => undefined}
      onContinue={onContinue}
      {...over}
    />,
  );
  return { onContinue };
}

describe("ChoiceFormCard copy and busy", () => {
  it("keeps the operator's hints, submit label and (for outside) consequence by default", () => {
    show({ form: { ...BLANK_CHOICE, vendor: "outside" } });
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByText(/ChartWarden will transmit nothing for this tenant/)).toBeTruthy();
  });

  it("shows a lane's own consequence for any vendor, its credential hint and its submit label", () => {
    show({
      copy: {
        consequence: "Your credential is sealed under your own key.",
        secretNeededHint: "Write-only. Sealed under your organization's key.",
        submitLabel: "Save choice",
      },
    });
    expect(screen.getByText("Your credential is sealed under your own key.")).toBeTruthy();
    expect(screen.getByText("Write-only. Sealed under your organization's key.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save choice" })).toBeTruthy();
  });

  it("keeps the submit focusable while busy and drops a second press", () => {
    const { onContinue } = show({ busy: true });
    const submit = screen.getByRole("button", { name: "Continue" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    submit.focus();
    fireEvent.submit(screen.getByRole("form", { name: "Clearinghouse choice" }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(submit);
  });

  it("submits when not busy", () => {
    const { onContinue } = show();
    fireEvent.submit(screen.getByRole("form", { name: "Clearinghouse choice" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("asks password managers to leave the credential alone", () => {
    show();
    const secret = screen.getByLabelText("Vendor credential");
    expect(secret.getAttribute("type")).toBe("password");
    expect(secret.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(secret.getAttribute("data-lpignore")).toBe("true");
    expect(secret.getAttribute("data-bwignore")).not.toBeNull();
    expect(secret.getAttribute("autocapitalize")).toBe("off");
    expect(secret.getAttribute("spellcheck")).toBe("false");
  });
});
