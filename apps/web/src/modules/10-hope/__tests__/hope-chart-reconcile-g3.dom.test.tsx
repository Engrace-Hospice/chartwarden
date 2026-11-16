// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  clientFor,
  item,
  ok,
  renderWorkspace,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

// The reconcile dialog against the REAL assessment screen. The dialog (hope-chart-reconcile-g2) is tested with a mock parent,
// and a mock parent can say "saved" for a save the real one refused. Here the answer save is the screen's own saveAnswer, so
// "HOPE now uses the chart's number" / "saved in HOPE" is only ever shown for an answer the server confirmed, and a typed
// number is never written to the chart behind a HOPE save that did not land.

const HOPE_MBI = "1EG4TE5MK73";
const CHART_MBI = "9AA9AA9AA99";
const TYPED_MBI = "1AA1AA1AA11";
const ANSWERS = "/api/v1/hope/assessments/{id}/answers";
const PAYERS = "/api/v1/patients/{id}/payers";
const UNCONFIRMED = "Could not confirm that the HOPE answer was saved";

const coverage = {
  id: "pp-1",
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

const medicareWorkspace = () =>
  workspace({
    sections: [
      {
        code: "A",
        label: "Administrative",
        items: [
          item({
            itemCode: "A0600B",
            label: "Patient Medicare number",
            cmsItemTypeCode: "Text",
            value: HOPE_MBI,
            source: "user",
            state: "answered",
            options: [{ valueCode: "Text", label: "Medicare number", sortOrder: 1 }],
          }),
        ],
      },
    ],
  });

/** What the answer save can come back as when it did not land. */
const refusedByServer = {
  data: undefined,
  error: { error: { code: "VALIDATION_FAILED", message: "That value is not allowed." } },
  response: new Response(null, { status: 422 }),
};
const staleVersion = {
  data: undefined,
  error: { error: { code: "CONFLICT", message: "version is stale" } },
  response: new Response(null, { status: 409 }),
};
const emptyGatewayReply = {
  data: undefined,
  error: undefined,
  response: new Response(null, { status: 503 }),
};
const SAVED = ok({ assessmentId: "hope-1", version: 5, answers: [] });

async function openReconcile(patch: () => unknown) {
  const client = clientFor({ workspace: medicareWorkspace(), payers: [coverage] });
  (client.PATCH as ReturnType<typeof vi.fn>).mockImplementation(async () => patch());
  renderWorkspace(client);
  fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
  const dialog = screen.getByRole("dialog", { name: "Reconcile Medicare number" });
  return { client, dialog };
}

const useChartButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /Use the chart's number in HOPE|Saving/ });

describe("Reconcile dialog on the real assessment screen: the HOPE answer save", () => {
  useStubbedLocalStorage();

  it("says HOPE now uses the chart's number once the server has confirmed the answer", async () => {
    const { client, dialog } = await openReconcile(() => SAVED);
    fireEvent.click(useChartButton(dialog));
    expect(
      await within(dialog).findByText("HOPE now uses the chart's Medicare number."),
    ).toBeTruthy();
    expect(client.PATCH).toHaveBeenCalledWith(
      ANSWERS,
      expect.objectContaining({
        body: expect.objectContaining({
          changes: [{ itemCode: "A0600B", action: "set", value: CHART_MBI }],
        }),
      }),
    );
  });

  it.each([
    ["a refusal the server explained (422)", () => refusedByServer],
    ["a stale version (409)", () => staleVersion],
    ["an empty 503 with no body", () => emptyGatewayReply],
    [
      "a request that is rejected",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])(
    "does not say HOPE uses the chart's number when the save came back as %s",
    async (_name, patch) => {
      const { dialog } = await openReconcile(patch);
      fireEvent.click(useChartButton(dialog));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(UNCONFIRMED);
      expect(within(dialog).queryByText(/HOPE now uses/)).toBeNull();
      // The failure took focus, and the button is the retry.
      expect(document.activeElement).toBe(alert);
      expect((useChartButton(dialog) as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it("confirms on the retry after a save that did not land", async () => {
    const replies = [emptyGatewayReply, SAVED];
    const { client, dialog } = await openReconcile(() => replies.shift());
    fireEvent.click(useChartButton(dialog));
    await within(dialog).findByRole("alert");
    fireEvent.click(useChartButton(dialog));
    expect(
      await within(dialog).findByText("HOPE now uses the chart's Medicare number."),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(
      vi
        .mocked(client.PATCH as ReturnType<typeof vi.fn>)
        .mock.calls.filter(([path]) => path === ANSWERS),
    ).toHaveLength(2);
  });
});

describe("Reconcile dialog on the real assessment screen: a number typed from the member card", () => {
  useStubbedLocalStorage();

  const saveTyped = (dialog: HTMLElement) => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Correct Medicare number" }), {
      target: { value: TYPED_MBI },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the correct number" }));
  };
  const chartWrites = (client: Awaited<ReturnType<typeof openReconcile>>["client"]) =>
    vi
      .mocked(client.POST as ReturnType<typeof vi.fn>)
      .mock.calls.filter(([path]) => path === PAYERS);

  it("does not write the chart, or call the pair saved, when the HOPE save did not land", async () => {
    const { client, dialog } = await openReconcile(() => emptyGatewayReply);
    saveTyped(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(UNCONFIRMED);
    expect(alert.textContent).not.toContain("Saved in HOPE");
    expect(chartWrites(client)).toHaveLength(0);
    expect(within(dialog).queryByText(/is saved in HOPE/)).toBeNull();
    expect(
      (within(dialog).getByRole("button", { name: "Save the correct number" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("writes the chart only after the HOPE save is confirmed, and then says both are saved", async () => {
    const { client, dialog } = await openReconcile(() => SAVED);
    saveTyped(dialog);
    expect(
      await within(dialog).findByText("The Medicare number is saved in HOPE and on the chart."),
    ).toBeTruthy();
    await waitFor(() => expect(chartWrites(client)).toHaveLength(1));
  });
});
