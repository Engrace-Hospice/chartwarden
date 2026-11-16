// apps/web/src/modules/10-hope — the submission detail shows items/findings and RECORDS the CMS result.
// Asserts on recorded fetch calls (see submission-generate.dom.test.tsx) so a handler wired to nothing fails.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SubmissionDetail } from "./submission-detail";

const SUB = "33333333-cccc-4ccc-8ccc-333333333333";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const P1 = "bbbbbbbb-0000-4000-8000-000000000001";
const P2 = "bbbbbbbb-0000-4000-8000-000000000002";
const CORR = "aaaaaaaa-0000-4000-8000-0000000000c1";

let calls: string[] = [];
let posted: Record<string, unknown>[] = [];
let detail: Record<string, unknown>;
let resultFailure: { status: number; body: unknown } | null = null;
let cancelFailure: { status: number; body: unknown } | null = null;
/** Makes the detail read, or the mark-uploaded write, answer with this instead (`body: null`: an empty reply). */
let detailReadFailure: { status: number; body: unknown } | null = null;
let markUploadedFailure: { status: number; body: unknown } | null = null;
/** Once the mark-uploaded write has succeeded, the detail read that follows it answers with an empty 502. */
let breakReadAfterMarkUploaded = false;

const baseDetail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SUB,
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q3",
  status: "exported",
  itemCount: 2,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
  acceptedAt: null,
  resultImportedAt: null,
  resultReportReference: null,
  items: [item(A1, P1, "01_admission", "pending"), item(A2, P2, "05_discharge", "pending")],
  findings: [],
  ...over,
});

function item(
  assessmentId: string,
  patientId: string,
  rfaKind: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `i-${assessmentId}`,
    assessmentId,
    patientId,
    rfaKind,
    assessmentStatus: "signed",
    status,
    iqiesRecordId: null,
    processedAt: null,
    resolution: null,
    correctionAssessmentId: null,
    ...extra,
  };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && path === `/api/v1/hope/submissions/${SUB}/results`) {
    const raw = request ? await request.clone().text() : String(init?.body ?? "");
    posted.push(JSON.parse(raw) as Record<string, unknown>);
    if (resultFailure?.status === -1) throw new TypeError("network down");
    if (resultFailure) return json(resultFailure.status, resultFailure.body);
    detail = baseDetail({
      status: "partially_accepted",
      resultImportedAt: "2026-10-01T10:00:00Z",
      resultReportReference: "FVR-1",
    });
    return json(200, detail);
  }
  if (method === "POST" && path === `/api/v1/hope/submissions/${SUB}/cancel`) {
    const raw = request ? await request.clone().text() : String(init?.body ?? "");
    const body = JSON.parse(raw) as Record<string, unknown>;
    posted.push(body);
    if (cancelFailure) return json(cancelFailure.status, cancelFailure.body);
    detail = baseDetail({
      status: "cancelled",
      cancelledAt: "2026-10-01T10:00:00Z",
      cancelReasonCode: body.reasonCode,
      packageFilename: "p.zip",
      items: [item(A1, P1, "01_admission", "cancelled"), item(A2, P2, "05_discharge", "cancelled")],
    });
    return json(200, detail);
  }
  if (method === "POST" && path === `/api/v1/hope/submissions/${SUB}/mark-uploaded`) {
    if (markUploadedFailure)
      return markUploadedFailure.body === null
        ? new Response(null, { status: markUploadedFailure.status })
        : json(markUploadedFailure.status, markUploadedFailure.body);
    detail = baseDetail({ status: "submitted_pending_result", packageFilename: "p.zip" });
    if (breakReadAfterMarkUploaded) detailReadFailure = { status: 502, body: null };
    return json(200, detail);
  }
  if (path === `/api/v1/hope/submissions/${SUB}`) {
    if (detailReadFailure)
      return detailReadFailure.body === null
        ? new Response(null, { status: detailReadFailure.status })
        : json(detailReadFailure.status, detailReadFailure.body);
    return json(200, detail);
  }
  if (path === `/api/v1/patients/${P1}`)
    return json(200, { firstName: "Ada", lastName: "Lovelace" });
  if (path === `/api/v1/patients/${P2}`)
    return json(200, { firstName: "Alan", lastName: "Turing" });
  return json(404, { message: `unstubbed ${method} ${path}` });
}

function mount(permissions: string[]) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "o",
          membershipId: "m",
          roles: ["compliance_officer"],
          permissions,
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[`/hope/submissions/${SUB}`]}>
            <Routes>
              <Route path="/hope/submissions/:id" element={<SubmissionDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const MANAGE = ["hope.submission.manage"];
beforeEach(() => {
  calls = [];
  posted = [];
  resultFailure = null;
  cancelFailure = null;
  detailReadFailure = null;
  markUploadedFailure = null;
  breakReadAfterMarkUploaded = false;
  detail = baseDetail();
});
afterEach(() => undefined);

describe("submission detail items and findings", () => {
  it("renders items with names, links, badges, correction links and ordered findings", async () => {
    detail = baseDetail({
      status: "partially_accepted",
      resultImportedAt: "2026-10-01T10:00:00Z",
      items: [
        item(A1, P1, "01_admission", "rejected", { resolution: "needs_correction" }),
        item(A2, P2, "05_discharge", "rejected", {
          resolution: "correction_in_progress",
          correctionAssessmentId: CORR,
        }),
      ],
      findings: [
        {
          id: "f1",
          assessmentId: A2,
          severity: "warning",
          code: "W1",
          itemCode: "A0100",
          message: "soft",
        },
        {
          id: "f2",
          assessmentId: A1,
          severity: "error",
          code: "-3010",
          itemCode: "J2051",
          message: "hard",
        },
      ],
    });
    mount(MANAGE);
    expect(await screen.findByText("Lovelace, Ada")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lovelace, Ada" }).getAttribute("href")).toBe(
      `/patients/${P1}/hope`,
    );
    expect(
      screen.getByRole("link", { name: /^Correct this assessment/ }).getAttribute("href"),
    ).toBe(`/hope/assessments/${A1}`);
    expect(screen.getByRole("link", { name: /^Open correction/ }).getAttribute("href")).toBe(
      `/hope/assessments/${CORR}`,
    );
    const rows = screen.getAllByRole("row");
    const findingRows = rows.filter((r) => /hard|soft/.test(r.textContent ?? ""));
    expect(findingRows[0]?.textContent).toContain("hard");
    expect(findingRows[1]?.textContent).toContain("soft");
    expect(screen.queryByRole("button", { name: "Record CMS result" })).toBeNull();
  });

  it("says awaiting before a result and 'No findings recorded.' after", async () => {
    const { unmount } = mount(MANAGE);
    expect(await screen.findByText("Awaiting CMS result.")).toBeTruthy();
    unmount();
    detail = baseDetail({ status: "accepted", resultImportedAt: "2026-10-01T10:00:00Z" });
    mount(MANAGE);
    expect(await screen.findByText("No findings recorded.")).toBeTruthy();
  });

  it("hides Record CMS result without permission or when packaged", async () => {
    const { unmount } = mount([]);
    await screen.findByText("Records in this batch");
    expect(screen.queryByRole("button", { name: "Record CMS result" })).toBeNull();
    unmount();
    detail = baseDetail({ status: "packaged" });
    mount(MANAGE);
    await screen.findByText("Records in this batch");
    expect(screen.queryByRole("button", { name: "Record CMS result" })).toBeNull();
  });
});

describe("the submission read", () => {
  it.each([
    ["an empty-bodied 502", { status: 502, body: null }],
    ["a 503 with an empty error body", { status: 503, body: "" }],
  ])(
    "shows it could not be loaded, not a spinner that never ends, for %s",
    async (_name, failure) => {
      detailReadFailure = failure;
      mount(MANAGE);
      expect(await screen.findByText("Could not load the HOPE submission.")).toBeTruthy();
      expect(screen.queryByText("Loading")).toBeNull();
    },
  );

  it("keeps the submission on screen, and says the refresh failed, when the re-read after an action is an empty 502", async () => {
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    breakReadAfterMarkUploaded = true; // the write succeeds; the re-read that follows it has no body
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    fireEvent.click(screen.getByRole("button", { name: "Mark uploaded" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: mark uploaded to CMS" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not refresh the HOPE submission.",
    );
    expect(screen.getAllByText("Lovelace, Ada").length).toBeGreaterThan(0);
  });
});

describe("record CMS result", () => {
  async function openDialog() {
    mount(MANAGE);
    await screen.findAllByText("Lovelace, Ada");
    fireEvent.click(screen.getByRole("button", { name: "Record CMS result" }));
    return await screen.findByRole("dialog");
  }

  it("sends the exact body after confirmation, refreshes and closes", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("Report reference (optional)"), {
      target: { value: "FVR-1" },
    });
    fireEvent.change(
      within(dialog).getByLabelText("Outcome for Lovelace, Ada — Admission, row 1"),
      {
        target: { value: "rejected" },
      },
    );
    fireEvent.change(
      within(dialog).getByLabelText("CMS code for Lovelace, Ada — Admission, row 1"),
      {
        target: { value: "-3010" },
      },
    );
    fireEvent.change(
      within(dialog).getByLabelText("Message for Lovelace, Ada — Admission, row 1"),
      {
        target: { value: "bad item" },
      },
    );
    fireEvent.change(within(dialog).getByLabelText("Outcome for Turing, Alan — Discharge, row 2"), {
      target: { value: "accepted" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    expect(posted).toHaveLength(0);
    expect(within(dialog).getByText(/changes the batch status/)).toBeTruthy();
    expect(within(dialog).getByText("Report reference: FVR-1")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Record this result?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      reportReference: "FVR-1",
      results: [
        { assessmentId: A1, status: "rejected", code: "-3010", message: "bad item" },
        { assessmentId: A2, status: "accepted" },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("FVR-1")).toBeTruthy();
  });

  it("pastes a CSV report to pre-fill the form", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Paste CMS report/), {
      target: { value: `assessmentId,status,code,message\n${A2},rejected,E5,nope\nzzz,accepted,,` },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import pasted report" }));
    expect(
      (
        within(dialog).getByLabelText(
          "Outcome for Turing, Alan — Discharge, row 2",
        ) as HTMLSelectElement
      ).value,
    ).toBe("rejected");
    expect(within(dialog).getByText(/Imported 1 of 2/)).toBeTruthy();
  });

  it("shows the server's nested 409 message inline and stays open", async () => {
    resultFailure = {
      status: 409,
      body: {
        error: {
          code: "M10_SUBMISSION_RESULT_ALREADY_RECORDED",
          message: "Result already recorded.",
        },
      },
    };
    const dialog = await openDialog();
    for (const who of ["Lovelace, Ada — Admission, row 1", "Turing, Alan — Discharge, row 2"])
      fireEvent.change(within(dialog).getByLabelText(`Outcome for ${who}`), {
        target: { value: "accepted" },
      });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Result already recorded.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("never defaults an outcome: Review stays disabled until every record is set", async () => {
    const dialog = await openDialog();
    const review = within(dialog).getByRole("button", {
      name: "Review and record",
    }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(within(dialog).getByText(/2 remaining/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Paste CMS report/), {
      target: { value: `assessmentId,status\n${A2},rejected` },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import pasted report" }));
    expect(review.disabled).toBe(true); // partial paste leaves the other record unset
    expect(within(dialog).getByText(/1 remaining/)).toBeTruthy();
  });

  it("keeps the worst outcome when a pasted report has several rows for one record", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Paste CMS report/), {
      target: {
        value: `assessmentId,status,code\n${A2},rejected,E1\n${A2},warning,W2`,
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import pasted report" }));
    expect(
      (
        within(dialog).getByLabelText(
          "Outcome for Turing, Alan — Discharge, row 2",
        ) as HTMLSelectElement
      ).value,
    ).toBe("rejected");
  });
  const outcomeSelect = (dialog: HTMLElement, who: string) =>
    within(dialog).getByLabelText(`Outcome for ${who}`);

  it("closes a clean form immediately on Escape", async () => {
    const clean = await openDialog();
    fireEvent.keyDown(clean, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks before discarding dirty input on Escape", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Paste CMS report/), { target: { value: "x" } });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(dialog).getByText("Discard changes?")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("moves focus confirm <-> discard", async () => {
    const dialog = await openDialog();
    for (const who of ["Lovelace, Ada — Admission, row 1", "Turing, Alan — Discharge, row 2"])
      fireEvent.change(outcomeSelect(dialog, who), { target: { value: "accepted" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    expect(document.activeElement?.textContent).toBe("Record this result?");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(document.activeElement?.textContent).toBe("Discard changes?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(document.activeElement?.textContent).toBe("Record this result?");
  });

  it("says the result may not be recorded and reloads on a network failure", async () => {
    resultFailure = { status: -1, body: null };
    const dialog = await openDialog();
    for (const who of ["Lovelace, Ada — Admission, row 1", "Turing, Alan — Discharge, row 2"])
      fireEvent.change(outcomeSelect(dialog, who), { target: { value: "accepted" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    const before = calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The result may not have been recorded; refresh to check.",
    );
    await waitFor(() =>
      expect(calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length).toBe(
        before + 1,
      ),
    );
  });

  it("confirms discard on Escape with dirty data (keep editing / discard)", async () => {
    const dialog = await openDialog();
    fireEvent.change(outcomeSelect(dialog, "Turing, Alan — Discharge, row 2"), {
      target: { value: "rejected" },
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(dialog).getByText("Discard changes?")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Discard changes?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(
      (outcomeSelect(dialog, "Turing, Alan — Discharge, row 2") as HTMLSelectElement).value,
    ).toBe("rejected");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows and sends a pasted item code through an editable Item column", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Paste CMS report/), {
      target: { value: `assessmentId,status,code,itemCode\n${A2},rejected,E5,J2051` },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import pasted report" }));
    const itemInput = within(dialog).getByLabelText(
      "Item for Turing, Alan — Discharge, row 2",
    ) as HTMLInputElement;
    expect(itemInput.value).toBe("J2051");
    fireEvent.change(outcomeSelect(dialog, "Lovelace, Ada — Admission, row 1"), {
      target: { value: "accepted" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.results).toContainEqual({
      assessmentId: A2,
      status: "rejected",
      code: "E5",
      itemCode: "J2051",
    });
  });

  it("refreshes the page on a 409 and keeps the message visible", async () => {
    resultFailure = { status: 409, body: { error: { message: "Result already recorded." } } };
    const dialog = await openDialog();
    for (const who of ["Lovelace, Ada — Admission, row 1", "Turing, Alan — Discharge, row 2"])
      fireEvent.change(outcomeSelect(dialog, who), { target: { value: "accepted" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    const before = calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Result already recorded.");
    await waitFor(() =>
      expect(calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length).toBe(
        before + 1,
      ),
    );
  });

  it("asks only for items still awaiting a verdict: a settled item is not offered and not sent", async () => {
    detail = baseDetail({
      status: "in_flight",
      items: [item(A1, P1, "01_admission", "accepted"), item(A2, P2, "05_discharge", "pending")],
    });
    const dialog = await openDialog();
    expect(within(dialog).queryByLabelText(/Outcome for Lovelace, Ada/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/Outcome for Turing, Alan/), {
      target: { value: "rejected" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm and record" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.results).toEqual([{ assessmentId: A2, status: "rejected" }]);
  });

  it("gives identical-looking records unique accessible names", async () => {
    detail = baseDetail({
      items: [item(A1, P1, "01_admission", "pending"), item(A2, P1, "01_admission", "pending")],
    });
    const dialog = await openDialog();
    expect(
      within(dialog).getByLabelText("Outcome for Lovelace, Ada — Admission, row 1"),
    ).toBeTruthy();
    expect(
      within(dialog).getByLabelText("Outcome for Lovelace, Ada — Admission, row 2"),
    ).toBeTruthy();
  });
});

describe("mark uploaded", () => {
  it("needs a second, explicit click before writing", async () => {
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    fireEvent.click(screen.getByRole("button", { name: "Mark uploaded" }));
    expect(calls.some((c) => c.endsWith("/mark-uploaded"))).toBe(false);
    expect(document.activeElement?.textContent).toBe("Confirm: mark uploaded to CMS");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement?.textContent).toBe("Mark uploaded");
    fireEvent.click(screen.getByRole("button", { name: "Mark uploaded" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.activeElement?.textContent).toBe("Mark uploaded");
    fireEvent.click(screen.getByRole("button", { name: "Mark uploaded" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: mark uploaded to CMS" }));
    await waitFor(() => expect(calls.some((c) => c.endsWith("/mark-uploaded"))).toBe(true));
  });

  it.each([
    ["an empty-bodied 502", { status: 502, body: null }],
    ["a 503 with an empty error body", { status: 503, body: "" }],
  ])("says it could not confirm, never nothing, when the write gets %s", async (_name, failure) => {
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    markUploadedFailure = failure;
    fireEvent.click(screen.getByRole("button", { name: "Mark uploaded" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: mark uploaded to CMS" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not confirm that the package was marked uploaded",
    );
  });

  it("shows the server's own reason when it refuses", async () => {
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    markUploadedFailure = {
      status: 409,
      body: { error: { code: "CONFLICT", message: "Already marked uploaded." } },
    };
    fireEvent.click(screen.getByRole("button", { name: "Mark uploaded" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: mark uploaded to CMS" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Already marked uploaded.");
  });

  it("labels a finding link with no matching item", async () => {
    detail = baseDetail({
      findings: [
        {
          id: "f9",
          assessmentId: "cccccccc-0000-4000-8000-000000000009",
          severity: "error",
          code: "E",
          itemCode: null,
          message: "m",
        },
      ],
    });
    mount(MANAGE);
    expect(await screen.findByRole("link", { name: "View assessment cccccccc" })).toBeTruthy();
  });
});

describe("R-08 cancel a package that was never uploaded", () => {
  const cancelButton = () => screen.queryByRole("button", { name: "Cancel package" });

  it("offers Cancel package only to a manager, and only before the batch was marked uploaded", async () => {
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    const { unmount } = mount([]);
    await screen.findByText("Records in this batch");
    expect(cancelButton()).toBeNull(); // no hope.submission.manage
    unmount();

    for (const status of ["submitted_pending_result", "accepted", "rejected", "cancelled"]) {
      detail = baseDetail({ status, packageFilename: "p.zip" });
      const view = mount(MANAGE);
      await screen.findByText("Records in this batch");
      expect(cancelButton(), `status ${status}`).toBeNull();
      view.unmount();
    }

    for (const status of ["packaged", "exported"]) {
      detail = baseDetail({ status, packageFilename: "p.zip" });
      const view = mount(MANAGE);
      await screen.findByText("Records in this batch");
      expect(cancelButton(), `status ${status}`).not.toBeNull();
      view.unmount();
    }
  });

  it("asks for a reason first, writes the exact body only on confirm, then shows the cancelled batch", async () => {
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    fireEvent.click(screen.getByRole("button", { name: "Cancel package" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel HOPE package" });
    expect(calls.some((c) => c.endsWith("/cancel"))).toBe(false);

    // No default reason: confirming is disabled until one is chosen from the fixed list.
    const confirm = within(dialog).getByRole("button", { name: "Cancel package" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const reason = within(dialog).getByLabelText(/Reason/) as HTMLSelectElement;
    expect([...reason.options].map((o) => o.value)).toEqual([
      "",
      "package_lost",
      "never_uploaded",
      "generated_in_error",
      "other",
    ]);
    fireEvent.change(reason, { target: { value: "package_lost" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(posted).toEqual([{ reasonCode: "package_lost" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Package lost/)).toBeTruthy();
    expect(screen.getByText(/must not be uploaded to CMS/)).toBeTruthy();
    // A cancelled package cannot be downloaded, marked uploaded or cancelled again from the page.
    expect(cancelButton()).toBeNull();
    expect(screen.queryByRole("button", { name: "Download ZIP" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark uploaded" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record CMS result" })).toBeNull();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  });

  it("keeping the package closes the dialog without writing", async () => {
    detail = baseDetail({ status: "exported", packageFilename: "p.zip" });
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    fireEvent.click(screen.getByRole("button", { name: "Cancel package" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep package" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toHaveLength(0);
    expect(cancelButton()).not.toBeNull();
  });

  it("shows the server's own 409 reason inline, stays open, and refreshes the batch", async () => {
    cancelFailure = {
      status: 409,
      body: {
        error: {
          code: "M10_SUBMISSION_CANCEL_NOT_ALLOWED",
          message: "Submission is submitted_pending_result; it was already marked uploaded.",
        },
      },
    };
    detail = baseDetail({ status: "packaged", packageFilename: "p.zip" });
    mount(MANAGE);
    await screen.findByText("Lovelace, Ada");
    const loadsBefore = calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length;
    fireEvent.click(screen.getByRole("button", { name: "Cancel package" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "other" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel package" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Submission is submitted_pending_result; it was already marked uploaded.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    // 409 means the batch changed under the user: the page reloads so it stops offering the action.
    await waitFor(() =>
      expect(
        calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length,
      ).toBeGreaterThan(loadsBefore),
    );
  });
});
