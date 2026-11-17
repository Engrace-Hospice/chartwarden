// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChartPayer,
  ChartReconcileDialog,
  HopeAnswerNotSavedError,
} from "../hope-chart-reconcile";
import { CONFLICT_FIELD_ERROR } from "../hope-save-status";
import {
  clientFor,
  item,
  ok,
  renderWorkspace,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

// Group g1: the reconcile dialog words a HOPE answer save by what is known of it. A save the server refused (or that was never sent) applied
// nothing, so the dialog shows the server's reason; only a save with no usable answer (offline, a timeout, an empty or faulting 5xx) may
// have landed and is "could not confirm". A refusal is never worded as "could not confirm" (hiding the reason the clinician can act on).

afterEach(cleanup);

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const HOPE_MBI = "1EG4TE5MK73";
const CHART_MBI = "9AA9AA9AA99";
const TYPED_MBI = "1AA1AA1AA11";
const REASON = "That value is not allowed.";
const UNCONFIRMED = "Could not confirm that the HOPE answer was saved";
const PAYERS = "/api/v1/patients/{id}/payers";

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

describe("ChartReconcileDialog: how a rejected HOPE answer save is worded", () => {
  function renderDialog(onUseChart: (value: string) => Promise<void>) {
    const POST = vi.fn(async () => ({
      data: coverage,
      error: undefined,
      response: new Response(null, { status: 201 }),
    }));
    render(
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
            onChartUpdated={async () => undefined}
            onClose={vi.fn()}
          />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    return { POST };
  }
  const useChart = () =>
    screen.getByRole("button", {
      name: /Use the chart's number in HOPE|Saving/,
    }) as HTMLButtonElement;
  const saveTyped = () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Correct Medicare number" }), {
      target: { value: TYPED_MBI },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save the correct number" }));
  };

  it("shows the reason for a definite refusal when using the chart's number, and the button is the retry", async () => {
    renderDialog(async () => {
      throw new HopeAnswerNotSavedError(REASON);
    });
    fireEvent.click(useChart());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(REASON);
    expect(alert.textContent).not.toContain("Could not confirm");
    expect(screen.queryByText(/HOPE now uses/)).toBeNull();
    expect(document.activeElement).toBe(alert);
    expect(useChart().disabled).toBe(false);
  });

  it("shows the reason for a definite refusal of a typed number, and writes nothing to the chart", async () => {
    const { POST } = renderDialog(async () => {
      throw new HopeAnswerNotSavedError(REASON);
    });
    saveTyped();
    expect((await screen.findByRole("alert")).textContent).toBe(REASON);
    expect(POST).not.toHaveBeenCalled();
  });

  it.each([
    ["a rejection", () => new TypeError("Failed to fetch")],
    ["an unknown outcome", () => new Error("The HOPE answer save could not be confirmed.")],
  ])("still says it could not confirm for %s", async (_name, reason) => {
    renderDialog(async () => {
      throw reason();
    });
    fireEvent.click(useChart());
    expect((await screen.findByRole("alert")).textContent).toContain(UNCONFIRMED);
  });
});

describe("the reconcile dialog on the real assessment screen: a refused HOPE answer save", () => {
  useStubbedLocalStorage();

  const ANSWERS = "/api/v1/hope/assessments/{id}/answers";
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
  async function openReconcile(patch: () => unknown) {
    const client = clientFor({ workspace: medicareWorkspace(), payers: [coverage] });
    (client.PATCH as ReturnType<typeof vi.fn>).mockImplementation(async () => patch());
    renderWorkspace(client);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    return { client, dialog: screen.getByRole("dialog", { name: "Reconcile Medicare number" }) };
  }
  const useChart = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: /Use the chart's number in HOPE|Saving/ });

  it("shows the server's reason for a 422 the server explained", async () => {
    const { dialog } = await openReconcile(() => ({
      data: undefined,
      error: { error: { code: "VALIDATION_FAILED", message: REASON } },
      response: new Response(null, { status: 422 }),
    }));
    fireEvent.click(useChart(dialog));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(REASON);
    expect(alert.textContent).not.toContain("Could not confirm");
    expect(within(dialog).queryByText(/HOPE now uses/)).toBeNull();
  });

  it("tells a stale page to reload, in the page's own words, for a 409", async () => {
    const { dialog } = await openReconcile(() => ({
      data: undefined,
      error: { error: { code: "CONFLICT", message: "version is stale" } },
      response: new Response(null, { status: 409 }),
    }));
    fireEvent.click(useChart(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(CONFLICT_FIELD_ERROR);
  });

  it("does not write the chart behind a typed number whose HOPE save was refused, and says why", async () => {
    const { client, dialog } = await openReconcile(() => ({
      data: undefined,
      error: { error: { code: "VALIDATION_FAILED", message: REASON } },
      response: new Response(null, { status: 422 }),
    }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Correct Medicare number" }), {
      target: { value: TYPED_MBI },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the correct number" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(REASON);
    expect(
      vi
        .mocked(client.POST as ReturnType<typeof vi.fn>)
        .mock.calls.filter(([path]) => path === PAYERS),
    ).toHaveLength(0);
  });

  it.each([
    [
      "an empty 503",
      () => ({ data: undefined, error: undefined, response: new Response(null, { status: 503 }) }),
    ],
    [
      "a 500 with a body",
      () => ({
        data: undefined,
        error: { error: { code: "INTERNAL", message: "stack trace" } },
        response: new Response(null, { status: 500 }),
      }),
    ],
  ])(
    "still says it could not confirm for %s, and never shows the server's raw text",
    async (_name, patch) => {
      const { dialog } = await openReconcile(patch);
      fireEvent.click(useChart(dialog));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(UNCONFIRMED);
      expect(alert.textContent).not.toContain("stack trace");
    },
  );

  it("confirms on the retry after a refusal the clinician corrected", async () => {
    const replies = [
      {
        data: undefined,
        error: { error: { code: "VALIDATION_FAILED", message: REASON } },
        response: new Response(null, { status: 422 }),
      },
      ok({ assessmentId: "hope-1", version: 5, answers: [] }),
    ];
    const { client, dialog } = await openReconcile(() => replies.shift());
    fireEvent.click(useChart(dialog));
    await within(dialog).findByRole("alert");
    fireEvent.click(useChart(dialog));
    expect(
      await within(dialog).findByText("HOPE now uses the chart's Medicare number."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        vi
          .mocked(client.PATCH as ReturnType<typeof vi.fn>)
          .mock.calls.filter(([path]) => path === ANSWERS),
      ).toHaveLength(2),
    );
  });
});
