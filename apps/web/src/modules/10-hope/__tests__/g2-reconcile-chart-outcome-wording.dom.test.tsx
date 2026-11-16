// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChartPayer, ChartReconcileDialog } from "../hope-chart-reconcile";

// "Saved in HOPE, but not on the chart." is a definite claim: it is said only when the chart write was REFUSED. A chart write
// that got no usable answer (a rejection, a timeout, an empty or faulting 5xx) may have landed, so the dialog says the HOPE
// half was saved and lets the unconfirmed words speak for the chart half.

afterEach(cleanup);

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const HOPE_MBI = "1EG4TE5MK73";
const CHART_MBI = "9AA9AA9AA99";
const TYPED_MBI = "1AA1AA1AA11";

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
const empty = (status: number): Reply => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});
const refused = (status: number, code: string, message: string): Reply => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});

function renderDialog(post: () => Promise<Reply>) {
  const onUseChart = vi.fn(async () => undefined);
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ POST: vi.fn(post) } as unknown as ApiClient}>
        <ChartReconcileDialog
          itemCode="A0600B"
          hopeValue={HOPE_MBI}
          chart={{ value: CHART_MBI, source: "coverage", coverage }}
          patientId={PATIENT}
          payers={[coverage]}
          admissionDate="2026-10-04"
          canEditHope
          onUseChart={onUseChart}
          onChartUpdated={async () => undefined}
          onClose={() => undefined}
        />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { onUseChart };
}

async function saveTypedNumber(): Promise<string> {
  fireEvent.change(screen.getByRole("textbox", { name: "Correct Medicare number" }), {
    target: { value: TYPED_MBI },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save the correct number|Saving/ }));
  return (await screen.findByRole("alert")).textContent ?? "";
}

describe("the member-card save, when HOPE was saved and the chart write failed", () => {
  it.each([
    [
      "the request is rejected",
      async (): Promise<Reply> => {
        throw new TypeError("Failed to fetch");
      },
    ],
    ["an empty 502 comes back", async () => empty(502)],
    ["an empty 504 comes back", async () => empty(504)],
    [
      "the server answers with a fault of its own",
      async () => refused(500, "INTERNAL", "stack trace and table names"),
    ],
  ])("does not say the number is not on the chart when %s", async (_name, post) => {
    const { onUseChart } = renderDialog(post);

    const words = await saveTypedNumber();

    expect(onUseChart).toHaveBeenCalledWith(TYPED_MBI);
    expect(words).toContain("Saved in HOPE.");
    expect(words).not.toContain("not on the chart");
    expect(words).toMatch(/could not be confirmed|Could not confirm/);
  });

  it("says the number is not on the chart when the chart write was refused", async () => {
    renderDialog(async () => refused(403, "FORBIDDEN", "You may not edit this patient."));

    const words = await saveTypedNumber();

    expect(words).toContain("Saved in HOPE, but not on the chart.");
    expect(words).toContain("You may not edit this patient.");
  });

  it("says the number is not on the chart when the chart write was refused with no body", async () => {
    renderDialog(async () => empty(403));

    const words = await saveTypedNumber();

    expect(words).toContain("Saved in HOPE, but not on the chart.");
  });
});
