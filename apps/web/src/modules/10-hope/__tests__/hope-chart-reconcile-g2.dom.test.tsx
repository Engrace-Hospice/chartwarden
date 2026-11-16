// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { type ChartPayer, ChartReconcileDialog } from "../hope-chart-reconcile";

// The reconcile dialog's chart write (POST /patients/{id}/payers) must decide success the way every other HOPE write
// does: an empty-bodied non-OK reply is not a success, a rejection frees the dialog, and a stalled request ends.

afterEach(() => {
  vi.useRealTimers();
});

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
const empty = (status: number, error?: ""): Reply => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});

/** A chart write whose reply the test releases by hand. */
function heldPost() {
  let release: (reply: Reply) => void = () => undefined;
  const post = () =>
    new Promise<Reply>((resolve) => {
      release = resolve;
    });
  return { post, release: (reply: Reply) => release(reply) };
}

function renderDialog(
  post: () => Promise<Reply> | Reply,
  options: { onChartUpdated?: () => Promise<void>; onUseChart?: (v: string) => Promise<void> } = {},
) {
  const POST = vi.fn(post);
  const onChartUpdated = vi.fn(options.onChartUpdated ?? (async () => undefined));
  const onUseChart = vi.fn(options.onUseChart ?? (async () => undefined));
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter>
      <ApiClientProvider client={{ POST } as unknown as ApiClient}>
        <ChartReconcileDialog
          itemCode="A0600B"
          hopeValue={HOPE_MBI}
          chart={{ value: CHART_MBI, source: "coverage", coverage }}
          patientId={PATIENT}
          payers={[coverage]}
          admissionDate="2026-10-04"
          canEditHope
          onUseChart={onUseChart}
          onChartUpdated={onChartUpdated}
          onClose={onClose}
        />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { POST, onChartUpdated, onUseChart, onClose, view };
}

const updateChart = () => screen.getByRole("button", { name: /Update the chart|Updating/ });
const cancel = () => screen.getByRole("button", { name: /Cancel|Done/ });

describe("ChartReconcileDialog chart write", () => {
  it("says the chart is updated, and refreshes it, only for a reply that carries the new coverage", async () => {
    const { POST, onChartUpdated } = renderDialog(async () => created);
    fireEvent.click(updateChart());
    expect(await screen.findByText("The chart's Medicare number is updated.")).toBeTruthy();
    expect(POST).toHaveBeenCalledTimes(1);
    expect(onChartUpdated).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty 502 with error undefined", empty(502)],
    ["an empty 503 with error ''", empty(503, "")],
    ["an empty 504", empty(504)],
  ])("does not call %s an update", async (_name, reply) => {
    const { onChartUpdated } = renderDialog(async () => reply);
    fireEvent.click(updateChart());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not confirm");
    expect(screen.queryByText("The chart's Medicare number is updated.")).toBeNull();
    expect(onChartUpdated).not.toHaveBeenCalled();
    // The buttons are the retry: they come back.
    expect((updateChart() as HTMLButtonElement).disabled).toBe(false);
  });

  it("words a bodiless 4xx as a refusal, not as unconfirmed", async () => {
    renderDialog(async () => empty(403));
    fireEvent.click(updateChart());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused the request without saying why");
    expect(alert.textContent).not.toContain("Could not confirm");
  });

  it("shows the server's own words for a refusal it explained", async () => {
    renderDialog(async () => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN", message: "You may not edit this patient's coverage." } },
      response: new Response(null, { status: 403 }),
    }));
    fireEvent.click(updateChart());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You may not edit this patient's coverage.",
    );
  });

  it("says it could not confirm, and frees the dialog, when the request is rejected", async () => {
    const { onChartUpdated } = renderDialog(async () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(updateChart());
    expect((await screen.findByRole("alert")).textContent).toContain("Could not confirm");
    expect((updateChart() as HTMLButtonElement).disabled).toBe(false);
    expect((cancel() as HTMLButtonElement).disabled).toBe(false);
    expect(onChartUpdated).not.toHaveBeenCalled();
  });

  it("is freed after the wait when the request is never answered, and holds Cancel shut until then", async () => {
    renderDialog(() => new Promise<Reply>(() => undefined));
    vi.useFakeTimers();
    fireEvent.click(updateChart());
    expect((updateChart() as HTMLButtonElement).disabled).toBe(true);
    expect((cancel() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
    vi.useRealTimers();
    expect(screen.getByRole("alert").textContent).toContain("Could not confirm");
    expect((updateChart() as HTMLButtonElement).disabled).toBe(false);
    expect((cancel() as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends one request for a double click", async () => {
    const { POST } = renderDialog(() => new Promise<Reply>(() => undefined));
    const button = updateChart();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it("still reports the write as done when only the refresh of the chart summary fails", async () => {
    const { onClose } = renderDialog(async () => created, {
      onChartUpdated: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    fireEvent.click(updateChart());
    const done = await screen.findByText(/The chart's Medicare number is updated\./);
    expect(done.textContent).toContain("could not be refreshed");
    expect((cancel() as HTMLButtonElement).disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus to the failure so Escape and Tab keep working", async () => {
    renderDialog(async () => empty(502));
    fireEvent.click(updateChart());
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
  });

  // React 18 no longer warns about a state update after unmount, so "no console.error" proves nothing here. What a
  // reader can observe is the parent's side: the dialog can be torn down mid-write (the signed-record "Create
  // correction" button stays enabled), and the write that then lands must still tell the parent its chart summary is
  // stale, and must never leave a rejection nobody handles (vitest fails the run on one).
  it("still refreshes the parent's chart summary when the dialog unmounts and the write then lands", async () => {
    const { post, release } = heldPost();
    const { POST, onChartUpdated, view } = renderDialog(post);
    fireEvent.click(updateChart());
    expect(POST).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      release(created);
    });
    expect(onChartUpdated).toHaveBeenCalledTimes(1);
  });

  it("leaves no unhandled rejection when the dialog unmounts and the parent's refresh then fails", async () => {
    const { post, release } = heldPost();
    const { onChartUpdated, view } = renderDialog(post, {
      onChartUpdated: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      fireEvent.click(updateChart());
      view.unmount();
      await act(async () => {
        release(created);
      });
      // Node reports a rejection nobody handled one macrotask after the microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(onChartUpdated).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it("does not refresh the parent when the dialog unmounts and the write then comes back refused", async () => {
    const { post, release } = heldPost();
    const { onChartUpdated, view } = renderDialog(post);
    fireEvent.click(updateChart());
    view.unmount();
    await act(async () => {
      release(empty(502));
    });
    expect(onChartUpdated).not.toHaveBeenCalled();
  });
});

describe("ChartReconcileDialog member-card number", () => {
  const typeCorrect = (value: string) =>
    fireEvent.change(screen.getByRole("textbox", { name: "Correct Medicare number" }), {
      target: { value },
    });
  const saveCorrect = () => screen.getByRole("button", { name: /Save the correct number|Saving/ });

  it("keeps the dialog usable and says HOPE was saved when the chart write is rejected", async () => {
    const { onUseChart } = renderDialog(async () => {
      throw new TypeError("Failed to fetch");
    });
    // The chart holds CHART_MBI and HOPE holds HOPE_MBI: a third number goes to both.
    typeCorrect("1AA1AA1AA11");
    fireEvent.click(saveCorrect());
    const alert = await screen.findByRole("alert");
    expect(onUseChart).toHaveBeenCalledWith("1AA1AA1AA11");
    // A rejected request may have landed, so the words do not say the chart was left alone.
    expect(alert.textContent).toContain("Saved in HOPE.");
    expect(alert.textContent).not.toContain("not on the chart");
    expect(alert.textContent).toContain("Could not confirm");
    expect((saveCorrect() as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not call the pair saved when the chart write came back empty", async () => {
    renderDialog(async () => empty(504));
    typeCorrect("1AA1AA1AA11");
    fireEvent.click(saveCorrect());
    await screen.findByRole("alert");
    expect(screen.queryByText(/is saved in HOPE and on the chart/)).toBeNull();
  });

  it("retries only the chart after HOPE was saved", async () => {
    let attempts = 0;
    const { POST, onUseChart } = renderDialog(async () =>
      attempts++ === 0 ? empty(502) : created,
    );
    typeCorrect("1AA1AA1AA11");
    fireEvent.click(saveCorrect());
    await screen.findByRole("alert");
    fireEvent.click(saveCorrect());
    expect(await screen.findByText("The Medicare number is saved on the chart.")).toBeTruthy();
    expect(POST).toHaveBeenCalledTimes(2);
    expect(onUseChart).toHaveBeenCalledTimes(1);
  });

  it("says it could not confirm the HOPE answer, and frees the dialog, when that save never answers", async () => {
    renderDialog(async () => created, { onUseChart: () => new Promise<void>(() => undefined) });
    typeCorrect("1AA1AA1AA11");
    vi.useFakeTimers();
    fireEvent.click(saveCorrect());
    expect((saveCorrect() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
    vi.useRealTimers();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not confirm");
    expect(alert.textContent).not.toContain("could not be saved");
    expect((saveCorrect() as HTMLButtonElement).disabled).toBe(false);
  });
});
