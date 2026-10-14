// ConfirmDialog confirmDisabled: gates only the confirm action; Cancel stays available.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

function renderDialog(props: { confirmDisabled?: boolean; pending?: boolean }) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Sure?"
      confirmLabel="Go"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmDialog confirmDisabled", () => {
  it("disables only Confirm and does not fire it", () => {
    const { onConfirm, onCancel } = renderDialog({ confirmDisabled: true });
    const go = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(onConfirm).not.toHaveBeenCalled();
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("enables Confirm by default", () => {
    const { onConfirm } = renderDialog({});
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
