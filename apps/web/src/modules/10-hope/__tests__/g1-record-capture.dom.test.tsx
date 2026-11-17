// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Link } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION, ok } from "./workspace-test-kit";

// A holder of the override permission: the server refuses `adminOverride` (403) from anyone else, so the modal offers the control only to
// a session that is not known to lack it (g1-record-override-permission.dom.test.tsx).
const OVERRIDE_SESSION = { ...SESSION, permissions: ["hope.admin.late_deadline_override"] };

// Group g1: the recording modal and the capture workspace. Each case pins a body the server would refuse or mis-file, or a
// read that never ends, so it fails without the matching fix.

afterEach(() => {
  vi.useRealTimers();
});

type Mocked = ReturnType<typeof vi.fn>;
type Sent = { body: Record<string, unknown> };
const sentBody = (post: Mocked): Record<string, unknown> =>
  (post.mock.calls[0] as unknown as [string, Sent])[1].body;

const DAY = 24 * 60 * 60 * 1000;
const windowAt = (opens: number, closes: number, late: number) => {
  const now = Date.now();
  return {
    id: "schedule-7",
    rfaKind: "02_huv1",
    windowOpensAt: new Date(now + opens * DAY).toISOString(),
    windowClosesAt: new Date(now + closes * DAY).toISOString(),
    lateDeadlineAt: new Date(now + late * DAY).toISOString(),
  };
};
/** Closed 3 days ago, late deadline in 10 days: a capture now is a late completion. */
const LATE_WINDOW = () => windowAt(-10, -3, 10);
/** Late deadline passed long ago: a capture now needs the administrative override. */
const EXPIRED_WINDOW = () => windowAt(-30, -20, -10);

function renderRecord(post: Mocked, window: ReturnType<typeof windowAt> | null = null) {
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={OVERRIDE_SESSION}>
      <ApiClientProvider client={client}>
        <HopeRecordModal
          open
          admissionId="adm-1"
          window={window}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </ApiClientProvider>
    </SessionProvider>,
  );
  return screen.getByRole("dialog", { name: "Record HOPE timepoint" });
}
const recordButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Record draft" }) as HTMLButtonElement;
const dataOf = (post: Mocked) =>
  sentBody(post).data as { J: Record<string, unknown>; N: Record<string, unknown> };

describe("g1 recording modal: administrative override (web-k1)", () => {
  it("sends the late-completion reason the server demands with the override", async () => {
    const post = vi.fn(async () => ok({ id: "created-1" }));
    const dialog = renderRecord(post, EXPIRED_WINDOW());
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /administrative override/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Justification/ }), {
      target: { value: "The visit was completed on time; the entry was delayed by an outage." },
    });
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post).adminOverride).toBe(true);
    expect(sentBody(post).lateCompletionReasonCode).toBe("admin_override");
  });

  it("sends no late reason past the deadline when the override is not ticked", async () => {
    const post = vi.fn(async () => ok({ id: "created-2" }));
    const dialog = renderRecord(post, EXPIRED_WINDOW());
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post)).not.toHaveProperty("lateCompletionReasonCode");
  });
});

describe("g1 recording modal: the visit date (web-k2)", () => {
  const visit = (dialog: HTMLElement) =>
    within(dialog).getByLabelText("Visit date & time") as HTMLInputElement;

  it("survives a visit date with a five-digit year, blocks recording and says why", () => {
    const dialog = renderRecord(vi.fn());
    fireEvent.change(visit(dialog), { target: { value: "20261-11-15T10:30" } });
    expect(within(dialog).getByRole("alert").textContent).toContain("valid visit date");
    expect(recordButton(dialog).disabled).toBe(true);
    fireEvent.change(visit(dialog), { target: { value: "2026-11-15T10:30" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(recordButton(dialog).disabled).toBe(false);
  });

  it("blocks recording, and says why, when the date is cleared", () => {
    const dialog = renderRecord(vi.fn());
    fireEvent.change(visit(dialog), { target: { value: "" } });
    expect(within(dialog).getByRole("alert").textContent).toContain("valid visit date");
    expect(recordButton(dialog).disabled).toBe(true);
  });
});

describe("g1 recording modal: values of controls that are hidden again (web-k3)", () => {
  it("does not send pain or dyspnea characteristics once the screen is unticked", async () => {
    const post = vi.fn(async () => ok({ id: "created-3" }));
    const dialog = renderRecord(post);
    for (const [screen_, label, text] of [
      ["J2030 — screened for pain", "Pain characteristics", "stabbing"],
      ["J2050 — screened for shortness of breath", "Dyspnea characteristics", "on exertion"],
    ] as const) {
      fireEvent.click(within(dialog).getByLabelText(screen_));
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value: text } });
      fireEvent.click(within(dialog).getByLabelText(screen_));
    }
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(dataOf(post).J.J2030).toEqual({ screened: "no" });
    expect(dataOf(post).J.J2050).toEqual({ screened: "no" });
  });

  it("still sends the characteristics while the screen is ticked", async () => {
    const post = vi.fn(async () => ok({ id: "created-4" }));
    const dialog = renderRecord(post);
    fireEvent.click(within(dialog).getByLabelText("J2030 — screened for pain"));
    fireEvent.change(within(dialog).getByLabelText("Pain characteristics"), {
      target: { value: "stabbing" },
    });
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(dataOf(post).J.J2030).toEqual({ screened: "yes", characteristics: "stabbing" });
  });

  it("does not send a contraindication once a scheduled bowel regimen is ticked", async () => {
    const post = vi.fn(async () => ok({ id: "created-5" }));
    const dialog = renderRecord(post);
    fireEvent.click(within(dialog).getByLabelText("Opioid prescribed for pain"));
    fireEvent.change(within(dialog).getByLabelText("Bowel regimen contraindication"), {
      target: { value: "bowel obstruction" },
    });
    fireEvent.click(within(dialog).getByLabelText("Scheduled bowel regimen in place"));
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(dataOf(post).N).toEqual({ opioidPrescribed: true, scheduledBowelRegimen: true });
  });

  it("sends neither the regimen nor a contraindication once the opioid is unticked", async () => {
    const post = vi.fn(async () => ok({ id: "created-6" }));
    const dialog = renderRecord(post);
    const opioid = within(dialog).getByLabelText("Opioid prescribed for pain");
    fireEvent.click(opioid);
    fireEvent.click(within(dialog).getByLabelText("Scheduled bowel regimen in place"));
    fireEvent.click(opioid);
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(dataOf(post).N).toEqual({ opioidPrescribed: false, scheduledBowelRegimen: false });
  });

  it("sends a contraindication while it is the visible answer", async () => {
    const post = vi.fn(async () => ok({ id: "created-7" }));
    const dialog = renderRecord(post);
    fireEvent.click(within(dialog).getByLabelText("Opioid prescribed for pain"));
    fireEvent.change(within(dialog).getByLabelText("Bowel regimen contraindication"), {
      target: { value: "bowel obstruction" },
    });
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(dataOf(post).N).toEqual({
      opioidPrescribed: true,
      scheduledBowelRegimen: false,
      bowelRegimenContraindication: "bowel obstruction",
    });
  });
});

describe("g1 recording modal: nothing the clinician did not choose is attested (web-k4)", () => {
  it("makes the clinician choose the late-completion reason, and sends that one", async () => {
    const post = vi.fn(async () => ok({ id: "created-8" }));
    const dialog = renderRecord(post, LATE_WINDOW());
    const reason = within(dialog).getByLabelText("Late completion reason") as HTMLSelectElement;
    expect(reason.value).toBe("");
    expect(recordButton(dialog).disabled).toBe(true);
    fireEvent.click(recordButton(dialog));
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: "hospitalization" } });
    expect(recordButton(dialog).disabled).toBe(false);
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post).lateCompletionReasonCode).toBe("hospitalization");
  });

  it("asks again, rather than reusing the last choice, when the dialog is reopened", () => {
    const client = { GET: vi.fn(), POST: vi.fn() } as unknown as ApiClient;
    const tree = (open: boolean) => (
      <SessionProvider session={SESSION}>
        <ApiClientProvider client={client}>
          <HopeRecordModal
            open={open}
            admissionId="adm-1"
            window={LATE_WINDOW()}
            onClose={vi.fn()}
            onDone={vi.fn()}
          />
        </ApiClientProvider>
      </SessionProvider>
    );
    const view = render(tree(true));
    fireEvent.change(screen.getByLabelText("Late completion reason"), {
      target: { value: "refused" },
    });
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect((screen.getByLabelText("Late completion reason") as HTMLSelectElement).value).toBe("");
  });

  it("makes the clinician choose the discharge reason, and sends that one", async () => {
    const post = vi.fn(async () => ok({ id: "created-9" }));
    const dialog = renderRecord(post);
    fireEvent.change(within(dialog).getByLabelText("Reason for assessment"), {
      target: { value: "05_discharge" },
    });
    const reason = within(dialog).getByLabelText("Discharge reason") as HTMLSelectElement;
    expect(reason.value).toBe("");
    expect(recordButton(dialog).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "death" } });
    expect(recordButton(dialog).disabled).toBe(false);
    fireEvent.click(recordButton(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post).dischargeReason).toBe("death");
    expect(sentBody(post).data).not.toHaveProperty("Q");
  });
});

// ── the capture workspace ─────────────────────────────────────────────────────────────────────────────

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timepoint = (kind: string, status: string) => ({
  kind,
  status,
  windowStart: "2026-09-02T00:00:00.000Z",
  windowEnd: "2026-09-11T23:59:59.999Z",
  lateDeadline: "2026-09-18T23:59:59.999Z",
  assessmentId: null,
});
function workflow(huv1 = "open", huv2 = "upcoming", discharge = "not_applicable") {
  return {
    admissionId,
    patientId: "patient-1",
    admissionStatus: "active",
    admissionAt: "2026-08-27T00:00:00.000Z",
    admissionAssessment: { ...timepoint("01_admission", "completed"), assessmentId: "assess-adm" },
    huv1: timepoint("02_huv1", huv1),
    huv2: timepoint("03_huv2", huv2),
    sfvs: [],
    dischargeAssessment: timepoint("05_discharge", discharge),
  };
}

function Probe(): JSX.Element {
  return <output aria-label="location">{useLocation().pathname}</output>;
}
const HUV1 = `/admissions/${admissionId}/hope/timepoints/02_huv1`;
const HUV2 = `/admissions/${admissionId}/hope/timepoints/03_huv2`;

function renderCapture(client: ApiClient, path = HUV1) {
  return render(
    <SessionProvider session={SESSION}>
      <MemoryRouter initialEntries={[path]}>
        <ApiClientProvider client={client}>
          <Link to={HUV1}>to huv1</Link>
          <Link to={HUV2}>to huv2</Link>
          <Routes>
            <Route
              path="/admissions/:admissionId/hope/timepoints/:kind"
              element={<HopeTimepointCapture />}
            />
            <Route path="/hope/assessments/:id" element={<Probe />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}
const createButton = () =>
  screen.getByRole("button", { name: /Create HOPE draft|Recording/ }) as HTMLButtonElement;

describe("g1 capture workspace: the target date (web-k5)", () => {
  const target = () => screen.getByLabelText("Target date/time") as HTMLInputElement;
  const clientWith = (post: Mocked) =>
    ({ GET: vi.fn(async () => ok(workflow())), POST: post }) as unknown as ApiClient;

  it.each([
    ["cleared", ""],
    ["a five-digit year", "20261-11-15T10:30"],
  ])("records nothing, and says why, when the date is %s", async (_name, value) => {
    const post = vi.fn(async () => ok({ id: "draft-1" }));
    renderCapture(clientWith(post));
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.change(target(), { target: { value } });
    expect(screen.getByRole("alert").textContent).toContain("valid target date");
    expect(target().required).toBe(true);
    expect(createButton().disabled).toBe(true);
    fireEvent.submit(target().closest("form") as HTMLFormElement);
    expect(post).not.toHaveBeenCalled();
  });

  it("sends the date the clinician entered, not now", async () => {
    const post = vi.fn(async () => ok({ id: "draft-2" }));
    renderCapture(clientWith(post));
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.change(target(), { target: { value: "2026-09-05T08:15" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post).targetDate).toBe(new Date("2026-09-05T08:15").toISOString());
  });
});

describe("g1 capture workspace: values of hidden or unchosen controls", () => {
  it("does not send a late reason for an item that is not late (the route's item changed under it)", async () => {
    const post = vi.fn(async () => ok({ id: "draft-3" }));
    const client = {
      GET: vi.fn(async () => ok(workflow("late", "open"))),
      POST: post,
    } as unknown as ApiClient;
    renderCapture(client);
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.change(screen.getByLabelText("Late completion reason"), {
      target: { value: "refused" },
    });
    fireEvent.click(screen.getByRole("link", { name: "to huv2" }));
    await screen.findByRole("heading", { name: "HUV2 Assessment" });
    expect(screen.queryByLabelText("Late completion reason")).toBeNull();
    fireEvent.click(createButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post).rfaKind).toBe("03_huv2");
    expect(sentBody(post).lateCompletionReasonCode).toBeUndefined();
  });

  it("makes the clinician choose the discharge reason, and sends that one", async () => {
    const post = vi.fn(async () => ok({ id: "draft-4" }));
    const client = {
      GET: vi.fn(async () => ok(workflow("completed", "completed", "open"))),
      POST: post,
    } as unknown as ApiClient;
    renderCapture(client, `/admissions/${admissionId}/hope/timepoints/05_discharge`);
    await screen.findByRole("heading", { name: "Discharge Assessment" });
    const reason = screen.getByLabelText("Discharge reason") as HTMLSelectElement;
    expect(reason.value).toBe("");
    expect(createButton().disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "death" } });
    expect(createButton().disabled).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody(post).dischargeReason).toBe("death");
  });
});

describe("g1 capture workspace: the workflow read (web-k6)", () => {
  const RETRY = { name: "Retry" } as const;
  /** The patient-name lookup also reads once the workflow shows, so count only the workflow read. */
  const workflowReads = (get: Mocked) =>
    get.mock.calls.filter(([path]) => path === "/api/v1/admissions/{admissionId}/hope").length;

  async function expectRetryable(get: Mocked): Promise<void> {
    const retry = await screen.findByRole("button", RETRY);
    expect(screen.getByRole("alert").textContent).toContain("Unable to load HOPE workflow");
    expect(screen.queryByRole("status")).toBeNull();
    get.mockImplementation(async () => ok(workflow()));
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "HUV1 Assessment" })).toBeTruthy();
    expect(workflowReads(get)).toBe(2);
  }

  it("ends in a retryable error, not a spinner or an unhandled rejection, when the request is rejected", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const get = vi.fn(async () => Promise.reject(new TypeError("offline")));
      renderCapture({ GET: get, POST: vi.fn() } as unknown as ApiClient);
      await expectRetryable(get);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("is a failed read, not 'no data', for a gateway reply with no body", async () => {
    const get = vi.fn(async () => ({
      data: undefined,
      error: undefined,
      response: new Response(null, { status: 502 }),
    }));
    renderCapture({ GET: get, POST: vi.fn() } as unknown as ApiClient);
    await expectRetryable(get);
  });

  it("ends in a retryable error when the request is never answered", async () => {
    vi.useFakeTimers();
    const get = vi.fn(() => new Promise(() => undefined));
    renderCapture({ GET: get, POST: vi.fn() } as unknown as ApiClient);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
    vi.useRealTimers();
    await expectRetryable(get);
  });

  it("moves focus to the error, and back to it after a second failure, so the keyboard keeps its place", async () => {
    const get = vi.fn(async () => Promise.reject(new TypeError("offline")));
    renderCapture({ GET: get, POST: vi.fn() } as unknown as ApiClient);
    fireEvent.click(await screen.findByRole("button", RETRY));
    const retryAgain = await screen.findByRole("button", RETRY);
    await waitFor(() => expect(retryAgain.closest("[tabindex='-1']")).toBe(document.activeElement));
    expect(workflowReads(get)).toBe(2);
  });

  it("reads once for a double press of Retry", async () => {
    const get = vi.fn(async () => Promise.reject(new TypeError("offline")));
    renderCapture({ GET: get, POST: vi.fn() } as unknown as ApiClient);
    const retry = await screen.findByRole("button", RETRY);
    fireEvent.click(retry);
    fireEvent.click(retry);
    await screen.findByRole("button", RETRY);
    expect(workflowReads(get)).toBe(2);
  });

  it("offers no retry for a refusal of access", async () => {
    const get = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN" } },
      response: new Response(null, { status: 403 }),
    }));
    renderCapture({ GET: get, POST: vi.fn() } as unknown as ApiClient);
    expect(await screen.findByText(/Your access is limited/)).toBeTruthy();
    expect(screen.queryByRole("button", RETRY)).toBeNull();
  });

  it("shows the admission the clinician is on, not a slow reply for the one they left", async () => {
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let releaseFirst: (reply: unknown) => void = () => undefined;
    const get = vi.fn(
      async (path: string, init?: { params?: { path?: { admissionId?: string } } }) => {
        if (path !== "/api/v1/admissions/{admissionId}/hope") return ok({});
        if (init?.params?.path?.admissionId === admissionId)
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        return ok({ ...workflow(), admissionId: other });
      },
    );
    render(
      <SessionProvider session={SESSION}>
        <MemoryRouter initialEntries={[HUV1]}>
          <ApiClientProvider client={{ GET: get, POST: vi.fn() } as unknown as ApiClient}>
            <Link to={`/admissions/${other}/hope/timepoints/02_huv1`}>to other</Link>
            <Routes>
              <Route
                path="/admissions/:admissionId/hope/timepoints/:kind"
                element={<HopeTimepointCapture />}
              />
              <Route path="/admissions/:admissionId/hope" element={<Probe />} />
            </Routes>
          </ApiClientProvider>
        </MemoryRouter>
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "to other" }));
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    await act(async () => {
      releaseFirst(ok(workflow()));
    });
    fireEvent.click(screen.getByRole("button", { name: "HOPE Overview" }));
    expect(screen.getByLabelText("location").textContent).toBe(`/admissions/${other}/hope`);
  });
});
