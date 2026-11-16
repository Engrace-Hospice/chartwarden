// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { PatientHopeTimeline } from "../patient-hope-timeline";

type Reply = { data?: unknown; error?: unknown; response?: Response };
/** What openapi-fetch gives for a non-OK reply with no body: no data, and `error` undefined (or ""). */
const emptyReply = (status: number, error?: ""): Reply => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});
type Reader = (patientId: string) => Promise<Reply> | Reply;

const row = (id: string, admissionId = "adm-1") => ({
  id,
  admissionId,
  rfaKind: "01_admission",
  status: "signed",
  targetDate: "2026-09-08T00:00:00.000Z",
  authorDiscipline: "",
  j2051MaxSeverity: null,
  j2051TriggerFired: false,
  wasLate: false,
  supersededByAssessmentId: null,
});

const patientOf = (id: string) => ({
  id,
  mrn: `MRN-${id}`,
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1948-03-02",
  status: "active",
});

interface Readers {
  /** The patient's HOPE timeline. */
  readonly timeline: Reader;
  /** The patient's admissions; default: none. */
  readonly admissions?: Reader;
}

/** A client whose reads answer per patient, so one screen can be taken from a patient to another. */
function clientWith(readers: Readers): ApiClient {
  type Init = { params?: { path?: { patientId?: string; id?: string } } };
  return {
    GET: vi.fn(async (path: string, init?: Init) => {
      const patientId = init?.params?.path?.patientId ?? init?.params?.path?.id ?? "";
      if (path === "/api/v1/patients/{patientId}/hope/assessments")
        return readers.timeline(patientId);
      if (path === "/api/v1/patients/{patientId}/admissions")
        return readers.admissions ? readers.admissions(patientId) : { data: { items: [] } };
      return path === "/api/v1/patients/{id}" ? { data: patientOf(patientId) } : { data: {} };
    }),
    POST: vi.fn(async () => ({
      data: { admissionId: "adm-1" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    })),
  } as unknown as ApiClient;
}

function renderTimeline(client: ApiClient, path = "/patients/patient-1/hope") {
  render(
    <SessionProvider session={null}>
      <MemoryRouter initialEntries={[path]}>
        <ApiClientProvider client={client}>
          <ToastProvider>
            <Link to="/patients/patient-2/hope">Go to patient two</Link>
            <Routes>
              <Route path="/patients/:patientId/hope" element={<PatientHopeTimeline />} />
            </Routes>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}

const count = () => screen.queryByText(/\d+ timepoints?/);
const withTimeline = (reply: Promise<Reply> | Reply): Readers => ({ timeline: () => reply });

describe("PatientHopeTimeline", () => {
  it("shows no timepoint count while the timeline is still loading, and says what it is loading", async () => {
    let finish: (reply: Reply) => void = () => undefined;
    renderTimeline(
      clientWith(
        withTimeline(
          new Promise<Reply>((resolve) => {
            finish = resolve;
          }),
        ),
      ),
    );
    await screen.findByRole("heading", { name: "HOPE Timeline" });
    expect(count()).toBeNull();
    expect(screen.getByRole("status", { name: "Loading HOPE timeline…" })).toBeTruthy();

    await act(async () => finish({ data: { assessments: [row("a-1"), row("a-2")] } }));
    expect((await screen.findByText(/2 timepoints/)).textContent).toContain("2 timepoints");
  });

  it("counts a loaded timeline of one as a singular timepoint", async () => {
    renderTimeline(clientWith(withTimeline({ data: { assessments: [row("a-1")] } })));
    expect(await screen.findByText(/1 timepoint\b/)).toBeTruthy();
  });

  it("keeps the chart's module rail beside the content pane, which holds the timeline", async () => {
    renderTimeline(clientWith(withTimeline({ data: { assessments: [row("a-1")] } })));
    const main = await screen.findByRole("main");
    expect(within(main).getByRole("heading", { name: "HOPE Timeline" })).toBeTruthy();
    expect(main.querySelector("nav")).toBeNull();
    expect(main.parentElement?.querySelector("nav")).not.toBeNull();
  });

  describe("when it cannot be read", () => {
    it("says so with a Try again that reads it again, and shows no count", async () => {
      const timeline = vi
        .fn<Reader>()
        .mockResolvedValueOnce({ error: { error: { message: "down" } } })
        .mockResolvedValueOnce({ data: { assessments: [row("a-1")] } });
      renderTimeline(clientWith({ timeline }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Could not load HOPE timeline.");
      expect(count()).toBeNull();
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      expect(await screen.findByText(/1 timepoint\b/)).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("treats a rejected read as the same failure, not an endless spinner", async () => {
      const timeline = vi.fn<Reader>().mockRejectedValueOnce(new TypeError("offline"));
      renderTimeline(clientWith({ timeline }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Could not load HOPE timeline.");
      expect(screen.queryByRole("status", { name: "Loading HOPE timeline…" })).toBeNull();
    });

    it.each([
      ["no error at all", emptyReply(502)],
      ["an empty error body", emptyReply(503, "")],
    ])(
      "treats a non-OK reply with %s as a failure, never as an empty timeline",
      async (_name, reply) => {
        renderTimeline(clientWith(withTimeline(reply)));
        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("Could not load HOPE timeline.");
        expect(screen.queryByText("No HOPE timepoints")).toBeNull();
        expect(count()).toBeNull();
      },
    );

    it("does the same for a reload of a timeline that was showing: an error and Try again, not 'No HOPE timepoints'", async () => {
      const timeline = vi
        .fn<Reader>()
        .mockResolvedValueOnce({ data: { assessments: [row("a-1", "adm-p1")] } })
        .mockResolvedValueOnce(emptyReply(502));
      renderTimeline(clientWith({ timeline }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Create missing timepoint windows" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Create missing windows" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Could not load HOPE timeline.");
      expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(screen.queryByText("No HOPE timepoints")).toBeNull();
    });

    it("carries a failed admissions read quietly: the timeline still shows", async () => {
      const admissions = vi.fn<Reader>().mockRejectedValue(new TypeError("offline"));
      renderTimeline(
        clientWith({ timeline: () => ({ data: { assessments: [row("a-1")] } }), admissions }),
      );
      expect(await screen.findByText(/1 timepoint\b/)).toBeTruthy();
    });
  });

  describe("reading it again for the same patient", () => {
    it("keeps the record controls on screen while a reload is in flight, when the admissions read is unavailable", async () => {
      let finish: (reply: Reply) => void = () => undefined;
      let reads = 0;
      const client = clientWith({
        // The first read answers at once; the reload that "Recompute" triggers is held open.
        timeline: () =>
          ++reads === 1
            ? { data: { assessments: [row("a-1", "adm-p1")] } }
            : new Promise<Reply>((resolve) => {
                finish = resolve;
              }),
        admissions: () => {
          throw new TypeError("offline");
        },
      });
      renderTimeline(client);
      fireEvent.click(
        await screen.findByRole("button", { name: "Create missing timepoint windows" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Create missing windows" }));

      await waitFor(() =>
        expect(screen.getByRole("status", { name: "Loading HOPE timeline…" })).toBeTruthy(),
      );
      expect(screen.getByRole("button", { name: "Record timepoint" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Create missing timepoint windows" })).toBeTruthy();
      await act(async () => finish({ data: { assessments: [row("a-1", "adm-p1")] } }));
    });

    it("Try again reads the admissions again too, so a transient failure of that read heals", async () => {
      const admissions = vi
        .fn<Reader>()
        .mockRejectedValueOnce(new TypeError("offline"))
        .mockResolvedValue({ data: { items: [{ id: "adm-p1", dischargedAt: null }] } });
      const timeline = vi
        .fn<Reader>()
        .mockResolvedValueOnce({ error: { error: { message: "down" } } })
        .mockResolvedValueOnce({ data: { assessments: [] } });
      renderTimeline(clientWith({ timeline, admissions }));

      const alert = await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: "Record timepoint" })).toBeNull();
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

      // No timepoint exists, so only a successful admissions read can offer the control.
      expect(await screen.findByRole("button", { name: "Record timepoint" })).toBeTruthy();
      expect(admissions).toHaveBeenCalledTimes(2);
    });
  });

  describe("a failed admissions read on a reload", () => {
    const OPEN_ADMISSION = { data: { items: [{ id: "adm-p1", dischargedAt: null }] } };

    it.each([
      [
        "an error reply",
        { error: { error: { message: "down" } }, response: new Response(null, { status: 500 }) },
      ],
      ["a non-OK reply with no body", emptyReply(502)],
      ["a rejected read", null],
    ])(
      "keeps the admission already known, so Record timepoint stays for a patient with no timepoints (%s)",
      async (_name, failure) => {
        const admissions = vi.fn<Reader>().mockResolvedValueOnce(OPEN_ADMISSION);
        if (failure === null) admissions.mockRejectedValue(new TypeError("offline"));
        else admissions.mockResolvedValue(failure);
        const timeline = vi
          .fn<Reader>()
          .mockResolvedValueOnce(emptyReply(503))
          .mockResolvedValueOnce({ data: { assessments: [] } });
        renderTimeline(clientWith({ timeline, admissions }));

        const alert = await screen.findByRole("alert");
        expect(screen.getByRole("button", { name: "Record timepoint" })).toBeTruthy();
        fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("No HOPE timepoints")).toBeTruthy();
        expect(admissions).toHaveBeenCalledTimes(2);
        // No timepoint to fall back on, and the second admissions read said nothing usable: the first one still stands.
        expect(screen.getByRole("button", { name: "Record timepoint" })).toBeTruthy();
      },
    );

    it("still takes the control away when a successful read says there is no open admission", async () => {
      const admissions = vi
        .fn<Reader>()
        .mockResolvedValueOnce(OPEN_ADMISSION)
        .mockResolvedValue({ data: { items: [{ id: "adm-p1", dischargedAt: "2026-09-01" }] } });
      const timeline = vi
        .fn<Reader>()
        .mockResolvedValueOnce(emptyReply(503))
        .mockResolvedValueOnce({ data: { assessments: [] } });
      renderTimeline(clientWith({ timeline, admissions }));

      fireEvent.click(
        within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }),
      );
      await screen.findByText("No HOPE timepoints");
      expect(screen.queryByRole("button", { name: "Record timepoint" })).toBeNull();
    });
  });

  describe("Try again keeps the keyboard user's place", () => {
    it("moves focus to the loading state when the retry starts, and back to the error if it fails again", async () => {
      let finish: (reply: Reply) => void = () => undefined;
      const timeline = vi
        .fn<Reader>()
        .mockResolvedValueOnce(emptyReply(503))
        .mockImplementationOnce(
          () =>
            new Promise<Reply>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce({ data: { assessments: [row("a-1")] } });
      renderTimeline(clientWith({ timeline }));

      const tryAgain = within(await screen.findByRole("alert")).getByRole("button", {
        name: "Try again",
      });
      tryAgain.focus();
      fireEvent.click(tryAgain);

      const loading = await screen.findByRole("region", { name: "Loading HOPE timeline…" });
      expect(document.activeElement).toBe(loading);

      await act(async () => finish(emptyReply(503)));
      const alert = await screen.findByRole("alert");
      expect(document.activeElement).toBe(alert.parentElement);
      // The Try again button is the next Tab stop, and a retry that works leaves focus alone.
      expect(alert.parentElement?.contains(screen.getByRole("button", { name: "Try again" }))).toBe(
        true,
      );
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText(/1 timepoint\b/)).toBeTruthy();
    });

    it("takes no focus on the first load: the loading state is only a place to land after Try again", async () => {
      renderTimeline(clientWith(withTimeline({ data: { assessments: [row("a-1")] } })));
      await screen.findByText(/1 timepoint\b/);
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("moving from one patient to another", () => {
    const ADMISSION_P1 = { items: [{ id: "adm-p1", dischargedAt: null }] };

    it("never lets the previous patient's admission or rows reach the next patient's controls", async () => {
      const client = clientWith({
        timeline: (patientId) =>
          patientId === "patient-1"
            ? { data: { assessments: [row("a-1", "adm-p1")] } }
            : { error: { error: { message: "down" } } },
        admissions: (patientId) => ({
          data: patientId === "patient-1" ? ADMISSION_P1 : { items: [] },
        }),
      });
      renderTimeline(client);
      expect(await screen.findByRole("button", { name: "Record timepoint" })).toBeTruthy();

      fireEvent.click(screen.getByRole("link", { name: "Go to patient two" }));

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Could not load HOPE timeline.",
      );
      expect(screen.queryByRole("button", { name: "Record timepoint" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Create missing timepoint windows" })).toBeNull();
      expect(screen.queryByText("1st admission")).toBeNull();
      expect(count()).toBeNull();
    });

    it("starts the next patient from nothing while their timeline loads", async () => {
      let finish: (reply: Reply) => void = () => undefined;
      const client = clientWith({
        timeline: (patientId) =>
          patientId === "patient-1"
            ? { data: { assessments: [row("a-1", "adm-p1")] } }
            : new Promise<Reply>((resolve) => {
                finish = resolve;
              }),
        admissions: (patientId) => ({
          data: patientId === "patient-1" ? ADMISSION_P1 : { items: [] },
        }),
      });
      renderTimeline(client);
      await screen.findByRole("button", { name: "Record timepoint" });

      fireEvent.click(screen.getByRole("link", { name: "Go to patient two" }));
      await waitFor(() =>
        expect(screen.getByRole("status", { name: "Loading HOPE timeline…" })).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: "Record timepoint" })).toBeNull();
      await act(async () => finish({ data: { assessments: [] } }));
    });
  });

  // The controls act on an admission. Until the admissions read answers, the only one known is the timeline's own newest row, which
  // may not be the open one: a dialog opened on it would switch admissions under the clinician when the read lands.
  describe("the controls wait for the admissions read", () => {
    it("offers neither control while that read is out, then offers both", async () => {
      let finish: (reply: Reply) => void = () => undefined;
      renderTimeline(
        clientWith({
          timeline: () => ({ data: { assessments: [row("a-1", "adm-old")] } }),
          admissions: () =>
            new Promise<Reply>((resolve) => {
              finish = resolve;
            }),
        }),
      );
      await screen.findByText(/1 timepoint\b/);
      expect(screen.queryByRole("button", { name: "Record timepoint" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Create missing timepoint windows" })).toBeNull();

      await act(async () => finish({ data: { items: [{ id: "adm-open", dischargedAt: null }] } }));
      expect(await screen.findByRole("button", { name: "Record timepoint" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Create missing timepoint windows" })).toBeTruthy();
    });

    it("falls back to the timeline's own row once that read has failed", async () => {
      renderTimeline(
        clientWith({
          timeline: () => ({ data: { assessments: [row("a-1", "adm-old")] } }),
          admissions: () => emptyReply(502),
        }),
      );
      expect(await screen.findByRole("button", { name: "Record timepoint" })).toBeTruthy();
    });
  });

  describe("Create missing timepoint windows", () => {
    // The route answers with the windows the admission has AFTERWARDS, not how many it added, so that is what is said.
    it.each([
      [3, "Timepoint windows checked: this admission now has 3 windows."],
      [1, "Timepoint windows checked: this admission now has 1 window."],
    ])("says how many windows the admission has afterwards (%s)", async (scheduleCount, words) => {
      const client = clientWith({
        timeline: () => ({ data: { assessments: [row("a-1")] } }),
        admissions: () => ({ data: { items: [{ id: "adm-1", dischargedAt: null }] } }),
      });
      (client as unknown as { POST: unknown }).POST = vi.fn(async () => ({
        data: { admissionId: "adm-1", scheduleCount },
        error: undefined,
        response: new Response(null, { status: 200 }),
      }));
      renderTimeline(client);

      fireEvent.click(
        await screen.findByRole("button", { name: "Create missing timepoint windows" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Create missing windows" }));

      expect(await screen.findByText(words)).toBeTruthy();
    });
  });
});
