// @vitest-environment jsdom
// ReasonDialog: the one prompt every platform write goes through: say why, then confirm. It judges the reason the way the server
// does, hands back the NORMALISED text, shows what the server said when it refused, and (for a pinned action) shows the record the
// operator is acting on and says so when that record changed since they read it.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { REASON_RULES } from "../../core/ops-write/reason";
import { ReasonDialog, type ReasonDialogProps } from "./reason-dialog";

function renderDialog(props: Partial<ReasonDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ReasonDialog
      open
      title="Approve go-live"
      rule={REASON_RULES.decision}
      confirmLabel="Approve"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}
const reasonBox = () => screen.getByLabelText(/reason/i);
const type = (text: string) => fireEvent.change(reasonBox(), { target: { value: text } });

describe("ReasonDialog", () => {
  it("is a named dialog that says the reason is recorded and visible to the tenant", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Approve go-live" })).toBeTruthy();
    expect(screen.getByText(/visible to the tenant/i)).toBeTruthy();
  });

  it("refuses a short reason, says why, and does not confirm", () => {
    const { onConfirm } = renderDialog();
    type("abcd     ");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("alert").textContent).toMatch(/at least 8/);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms with the normalised reason", () => {
    const { onConfirm } = renderDialog();
    type("  ticket   CHG-4521\n approved  ");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onConfirm).toHaveBeenCalledWith("ticket CHG-4521 approved");
  });

  it("cancels", () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal and keeps the reason the operator typed", () => {
    renderDialog({ error: "A different operator must approve." });
    expect(screen.getByRole("alert").textContent).toContain("A different operator must approve.");
  });

  it("shows a server field error on the reason box", () => {
    renderDialog({ fieldError: "evidenceNote looks like a patient identifier" });
    expect(screen.getByText(/looks like a patient identifier/)).toBeTruthy();
  });

  it("is busy: both actions are disabled and the label says it is working", () => {
    renderDialog({ busy: true });
    expect((screen.getByRole("button", { name: /Working/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("lists the record the operator is acting on (a pinned action)", () => {
    renderDialog({
      record: [
        { label: "Filed on", value: "2026-11-10" },
        { label: "Recorded at", value: "2026-11-11T09:00:00.000Z" },
      ],
    });
    expect(screen.getByText("Filed on")).toBeTruthy();
    expect(screen.getByText("2026-11-11T09:00:00.000Z")).toBeTruthy();
  });

  it("says the record changed since it was read, and asks again", () => {
    renderDialog({
      stale: true,
      record: [{ label: "Recorded at", value: "2026-11-12T10:30:00.000Z" }],
      confirmLabel: "Withdraw",
    });
    expect(screen.getByText(/changed since you opened it/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm .*updated record/i })).toBeTruthy();
  });

  it("renders nothing while closed", () => {
    const { container } = render(
      <ReasonDialog
        open={false}
        title="x"
        rule={REASON_RULES.decision}
        confirmLabel="Go"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
