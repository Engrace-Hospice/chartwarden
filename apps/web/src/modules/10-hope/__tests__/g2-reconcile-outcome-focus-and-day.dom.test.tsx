// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localToday } from "../hope-api";
import { type ChartPayer, ChartReconcileDialog } from "../hope-chart-reconcile";

// Group g2: the reconcile dialog after a write that worked, and its date default.
//  - The button that was pressed leaves with the options it sat in; the outcome takes focus, so the kit Modal's Escape and Tab
//    (an onKeyDown on the card) still see the keys. Focus on the page behind an aria-modal dialog is the failure.
//  - "Effective from" defaults to the clinician's own day, not the UTC day a US evening has already rolled into tomorrow.

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const HOPE_MBI = "1EG4TE5MK73";
const CHART_MBI = "9AA9AA9AA99";
const coverage: ChartPayer = {
  id: "row-1",
  payerId: "payer-cms",
  rank: 1,
  coverageKind: "medicare_ffs",
  subscriberId: CHART_MBI,
  groupNumber: null,
  binPcn: null,
  current: true,
  effectiveFrom: "2026-10-04",
  effectiveTo: null,
};
type Reply = { data?: unknown; error?: unknown; response?: Response };
const created: Reply = {
  data: { ...coverage, subscriberId: HOPE_MBI },
  error: undefined,
  response: new Response(null, { status: 201 }),
};

const originalZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
  // 02:00 UTC on 15 Nov is 21:00 on 14 Nov in New York: the UTC day and the clinician's day differ.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T02:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
  if (originalZone === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = originalZone;
});

function renderDialog(
  options: {
    chart?: "coverage" | "none";
    admissionDate?: string | null;
    onClose?: () => void;
  } = {},
) {
  const onClose = options.onClose ?? vi.fn();
  const client = {
    POST: vi.fn(async () => created),
    GET: vi.fn(async () => ({
      data: { items: [] },
      response: new Response(null, { status: 200 }),
    })),
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ChartReconcileDialog
          itemCode="A0600B"
          hopeValue={HOPE_MBI}
          chart={
            options.chart === "none" ? null : { value: CHART_MBI, source: "coverage", coverage }
          }
          patientId={PATIENT}
          payers={[coverage]}
          admissionDate={options.admissionDate === undefined ? "2026-10-04" : options.admissionDate}
          canEditHope
          onUseChart={async () => undefined}
          onChartUpdated={async () => undefined}
          onClose={onClose}
        />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { onClose, dialog: screen.getByRole("dialog", { name: "Reconcile Medicare number" }) };
}

describe("the clinician's own day", () => {
  it("is not the UTC day when the two differ (the test's clock and zone)", () => {
    // Guards the test itself: with a zone that cannot be set, the date assertions below would pass for the wrong reason.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-11-15");
    expect(localToday()).toBe("2026-11-14");
  });

  it("is the default 'Effective from' of new coverage when there is no admission date", () => {
    renderDialog({ chart: "none", admissionDate: null });

    expect((screen.getByLabelText("Effective from") as HTMLInputElement).value).toBe("2026-11-14");
  });

  it("still defaults to the admission date when there is one", () => {
    renderDialog({ chart: "none", admissionDate: "2026-10-04" });

    expect((screen.getByLabelText("Effective from") as HTMLInputElement).value).toBe("2026-10-04");
  });
});

describe("after a write that worked", () => {
  const settle = () => act(async () => undefined);

  it("keeps focus inside the dialog after 'Update the chart', so Escape closes it", async () => {
    const { dialog, onClose } = renderDialog();
    const button = screen.getByRole("button", { name: "Update the chart" });
    button.focus();

    fireEvent.click(button);
    await settle();

    const outcome = screen.getByText("The chart's Medicare number is updated.");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(outcome);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus inside the dialog after 'Use the chart's number in HOPE'", async () => {
    const { dialog } = renderDialog();
    const button = screen.getByRole("button", { name: "Use the chart's number in HOPE" });
    button.focus();

    fireEvent.click(button);
    await settle();

    const outcome = screen.getByText("HOPE now uses the chart's Medicare number.");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(outcome);
  });

  it("moves focus to the note after 'Save the correct number' when the dialog stays open to add it to the chart", async () => {
    const { dialog } = renderDialog({ chart: "none" });
    fireEvent.change(screen.getByLabelText("Correct Medicare number"), {
      target: { value: CHART_MBI },
    });
    const button = screen.getByRole("button", { name: "Save the correct number" });
    button.focus();

    fireEvent.click(button);
    await settle();

    const note = screen.getByText("Saved in HOPE. Add it to the patient's chart below.");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(note);
  });

  it("leaves focus where it is while nothing has been written", () => {
    const { dialog } = renderDialog();

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).not.toBe("OUTPUT");
  });
});
