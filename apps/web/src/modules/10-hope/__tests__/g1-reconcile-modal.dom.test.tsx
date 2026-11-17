// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type ChartPayer, ChartReconcileDialog } from "../hope-chart-reconcile";

// Group g1: the reconcile dialog is a real modal: focus enters it, Tab stays inside it, Escape closes it (except while a write
// is out, which closing would hide), and focus goes back to the button that opened it.

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const coverage: ChartPayer = {
  id: "row-1",
  payerId: "payer-cms",
  rank: 1,
  coverageKind: "medicare_ffs",
  subscriberId: "9AA9AA9AA99",
  groupNumber: null,
  binPcn: null,
  current: true,
  effectiveFrom: "2026-10-04",
  effectiveTo: null,
};
type Reply = { data?: unknown; error?: unknown; response?: Response };

function Host({ post }: { post: () => Promise<Reply> }) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <ApiClientProvider client={{ POST: vi.fn(post) } as unknown as ApiClient}>
        <button type="button" onClick={() => setOpen(true)}>
          Reconcile…
        </button>
        <button type="button">Behind the dialog</button>
        {open ? (
          <ChartReconcileDialog
            itemCode="A0600B"
            hopeValue="1EG4TE5MK73"
            chart={{ value: "9AA9AA9AA99", source: "coverage", coverage }}
            patientId={PATIENT}
            payers={[coverage]}
            admissionDate="2026-10-04"
            canEditHope
            onUseChart={async () => undefined}
            onChartUpdated={async () => undefined}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </ApiClientProvider>
    </MemoryRouter>
  );
}

function open(post: () => Promise<Reply> = async () => ({})) {
  render(<Host post={post} />);
  const trigger = screen.getByRole("button", { name: "Reconcile…" });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Reconcile Medicare number" }) };
}

describe("the reconcile dialog as a modal", () => {
  it("is a modal dialog and takes focus inside it when it opens", () => {
    const { dialog } = open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the dialog, wrapping from its last control to its first", () => {
    const { dialog } = open();
    const controls = within(dialog)
      .getAllByRole("button")
      .filter((b) => !(b as HTMLButtonElement).disabled);
    const last = controls[controls.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Behind the dialog" }),
    );
    expect(document.activeElement).toBe(controls[0]);
  });

  it("closes on Escape and gives focus back to the button that opened it", () => {
    const { trigger, dialog } = open();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not close on Escape while a write is out", () => {
    const { dialog } = open(() => new Promise<Reply>(() => undefined));
    fireEvent.click(within(dialog).getByRole("button", { name: "Update the chart" }));
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Updating…" }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Reconcile Medicare number" })).toBeTruthy();
  });

  it("does not close on a click on the scrim", () => {
    const { dialog } = open();
    fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
    expect(dialog.isConnected).toBe(true);
  });
});
