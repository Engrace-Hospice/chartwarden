// @vitest-environment jsdom
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, type vi } from "vitest";
import { CONFLICT_FIELD_ERROR } from "../hope-save-status";
import {
  SESSION,
  assessment,
  clientFor,
  item,
  ok,
  renderWorkspace,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

// Group g1. The chart numbers a failed read could not give are unknown, not absent; the reconcile dialog must not be told
// HOPE saved an answer the server refused; and an autosave nobody answered is "could not confirm", not "not saved".

const workspaceWith = (value: string) =>
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
            value,
            source: "user",
            state: "answered",
            options: [{ valueCode: "Text", label: "Medicare number", sortOrder: 1 }],
          }),
        ],
      },
    ],
  });
const coverage = {
  id: "pp-1",
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

const emptyReply = (status: number) => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});
const refusal = (status: number, code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});

type Get = (path: string, init?: unknown) => Promise<unknown>;
/** Lets `answer` take over some GETs (return undefined to leave a path to the standard double). */
function overrideGet(client: ApiClient, answer: Get): void {
  const get = client.GET as unknown as ReturnType<typeof vi.fn>;
  const standard = get.getMockImplementation() as Get;
  get.mockImplementation(async (path: string, init?: unknown) => {
    const own = await answer(path, init);
    return own === undefined ? standard(path, init) : own;
  });
}

describe("The chart numbers behind the A0600B note", () => {
  useStubbedLocalStorage();

  it("does not say the number is missing from a chart whose coverage could not be read", async () => {
    const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
    overrideGet(client, async (path) => (path.endsWith("/payers") ? emptyReply(502) : undefined));
    renderWorkspace(client);
    expect(
      await screen.findByText(/Could not check this against the patient's chart/),
    ).toBeTruthy();
    expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
    // No Reconcile: its "add it to the chart" would file a coverage row blind to the rows already there.
    expect(screen.queryByRole("button", { name: "Reconcile…" })).toBeNull();
  });

  it("does not either when the identifiers read is refused or rejected", async () => {
    const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73") });
    overrideGet(client, async (path) => {
      if (path.endsWith("/identifiers")) throw new TypeError("Failed to fetch");
      return undefined;
    });
    renderWorkspace(client);
    expect(
      await screen.findByText(/Could not check this against the patient's chart/),
    ).toBeTruthy();
    expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
  });

  it("keeps the chart it knew, and says so in the dialog, when the re-read after a chart write fails", async () => {
    const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
    let payerReads = 0;
    overrideGet(client, async (path) =>
      path.endsWith("/payers") && ++payerReads > 1 ? emptyReply(502) : undefined,
    );
    renderWorkspace(client);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    fireEvent.click(screen.getByRole("button", { name: "Update the chart" }));
    expect(await screen.findByText(/could not be refreshed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    // The chart's number is still the one on screen: a failed re-read is not an empty chart.
    expect(await screen.findByText(/Differs from the chart \(…AA99\)/)).toBeTruthy();
    expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
  });
});

describe("Reconcile: use the chart's number in HOPE, when the save does not land", () => {
  useStubbedLocalStorage();

  async function useChartsNumber(client: ApiClient) {
    renderWorkspace(client);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    fireEvent.click(screen.getByRole("button", { name: "Use the chart's number in HOPE" }));
    return screen.getByRole("dialog", { name: "Reconcile Medicare number" });
  }
  const patchOf = (client: ApiClient) => client.PATCH as unknown as ReturnType<typeof vi.fn>;

  const UNCONFIRMED = /Could not confirm that the HOPE answer was saved/;
  // A refusal or a stale page applied nothing, so the dialog shows its reason (g1-reconcile-definite-refusal.dom.test.tsx); only a save with
  // no usable answer may have landed and is "could not confirm".
  it.each([
    [
      "a stale version (409)",
      async () => refusal(409, "M10_VERSION_CONFLICT", "Changed."),
      CONFLICT_FIELD_ERROR,
    ],
    ["a refusal (422)", async () => refusal(422, "VALIDATION_FAILED", "No."), "No."],
    ["a non-OK reply with no body", async () => emptyReply(502), UNCONFIRMED],
    ["a rejected request", () => Promise.reject(new TypeError("offline")), UNCONFIRMED],
  ])("does not say HOPE now uses the chart's number after %s", async (_name, answer, words) => {
    const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
    patchOf(client).mockImplementationOnce(answer);
    const dialog = await useChartsNumber(client);
    expect(await within(dialog).findByText(words)).toBeTruthy();
    expect(within(dialog).queryByText(/HOPE now uses/)).toBeNull();
    // Not stuck busy: the clinician can press it again.
    await waitFor(() =>
      expect(
        (
          within(dialog).getByRole("button", {
            name: "Use the chart's number in HOPE",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("still says it when the save landed", async () => {
    const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
    const dialog = await useChartsNumber(client);
    expect(
      await within(dialog).findByText(/HOPE now uses the chart's Medicare number/),
    ).toBeTruthy();
  });

  it("does not say it either when the record is no longer a draft", async () => {
    const signed = {
      id: "hope-1",
      admissionId: "adm-1",
      patientId: "patient-1",
      rfaKind: "01_admission",
      status: "signed",
      targetDate: "2026-09-08T00:00:00.000Z",
      authorDiscipline: "RN",
      j2051MaxSeverity: null,
      j2051TriggerFired: false,
      wasLate: false,
      signedAt: "2026-09-08T14:00:00.000Z",
      signedBy: null,
      correctsAssessmentId: null,
      supersededByAssessmentId: null,
      snapshot: null,
      regulatory: { specVersionId: "spec-1", isc: "HA" },
      version: 4,
    };
    // A signed record offers no "use the chart's number" (it changes through a correction): nothing can send the save.
    const client = clientFor({
      assessment: signed,
      workspace: workspaceWith("1EG4TE5MK73"),
      payers: [coverage],
    });
    renderWorkspace(client);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    expect(screen.queryByRole("button", { name: "Use the chart's number in HOPE" })).toBeNull();
    expect(patchOf(client)).not.toHaveBeenCalled();
  });
});

describe("Autosave failure wording", () => {
  useStubbedLocalStorage();

  async function answerCpr(client: ApiClient) {
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));
  }
  const patchOf = (client: ApiClient) => client.PATCH as unknown as ReturnType<typeof vi.fn>;

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline"))],
    ["a non-OK reply with no body", async () => emptyReply(502)],
  ])(
    "says it could not confirm the save, not that it did not happen, for %s",
    async (_name, answer) => {
      const client = clientFor();
      patchOf(client).mockImplementationOnce(answer);
      await answerCpr(client);
      expect(await screen.findByText(/Could not confirm that this answer was saved/)).toBeTruthy();
      expect(screen.queryByText(/This answer was not saved/)).toBeNull();
    },
  );

  it("shows the server's own words for a refusal that is not about the value", async () => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(422, "M10_ADMISSION_NOT_ACTIVE", "This admission is no longer active."),
    );
    await answerCpr(client);
    expect(await screen.findByText("This admission is no longer active.")).toBeTruthy();
    expect(screen.queryByText(/Check the value/)).toBeNull();
  });

  it("treats a busy record as retryable, not as a stale page: no reload banner", async () => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(
        409,
        "M10_RECORD_BUSY",
        "The record is busy. This step was not applied; send it again.",
      ),
    );
    await answerCpr(client);
    expect(await screen.findByText(/The record is busy/)).toBeTruthy();
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Reload/ })).toBeNull();
    // And sending it again works (the page was never stale: the same version goes out).
    patchOf(client).mockImplementationOnce(async () => ok({ assessmentId: "hope-1", version: 5 }));
    fireEvent.click(screen.getByLabelText("No"));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(2));
  });

  it("still treats a stale version as a conflict", async () => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(409, "M10_VERSION_CONFLICT", "Changed."),
    );
    await answerCpr(client);
    expect((await screen.findAllByText(/changed elsewhere/)).length).toBeGreaterThan(0);
  });
});

describe("Confirming the HUV completion date on a busy record", () => {
  useStubbedLocalStorage();
  const HUV = { ...assessment, rfaKind: "02_huv1" };
  const huvWorkspace = () => {
    const base = workspace();
    return { ...base, assessment: { ...base.assessment, isc: "HUV", rfaKind: "02_huv1" } };
  };
  async function confirmDate(client: ApiClient) {
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
    fireEvent.change(await screen.findByLabelText("Assessment completed on"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm date" }));
  }

  it("is a failed save to send again, not a stale page: no reload banner, no re-read", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    (client.PATCH as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      refusal(
        409,
        "M10_RECORD_BUSY",
        "The record is busy. This step was not applied; send it again.",
      ),
    );
    await confirmDate(client);
    expect(await screen.findByText("Save failed")).toBeTruthy();
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    const workspaceReads = () =>
      (client.GET as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) =>
        String(path).endsWith("/workspace"),
      ).length;
    const readsAtRefusal = workspaceReads();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(workspaceReads()).toBe(readsAtRefusal);
  });

  it("is still the conflict banner for a stale version", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    (client.PATCH as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      refusal(409, "M10_VERSION_CONFLICT", "Changed."),
    );
    await confirmDate(client);
    expect((await screen.findAllByText(/changed elsewhere/)).length).toBeGreaterThan(0);
  });
});
