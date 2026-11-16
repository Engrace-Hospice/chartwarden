import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { HopeSfvCapture, HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION, SESSION_RN_NP, sessionWith } from "./workspace-test-kit";

afterEach(() => {
  vi.useRealTimers();
});

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workflow(status = "late") {
  return {
    admissionId,
    patientId: "patient-1",
    admissionStatus: "active",
    admissionAt: "2026-08-27T00:00:00.000Z",
    admissionAssessment: {
      kind: "01_admission",
      status: "completed",
      windowStart: "2026-08-27T00:00:00.000Z",
      windowEnd: "2026-08-31T23:59:59.999Z",
      lateDeadline: "2026-09-07T23:59:59.999Z",
      assessmentId: "assess-adm",
    },
    huv1: {
      kind: "02_huv1",
      status,
      windowStart: "2026-09-02T00:00:00.000Z",
      windowEnd: "2026-09-11T23:59:59.999Z",
      lateDeadline: "2026-09-18T23:59:59.999Z",
      assessmentId: null,
    },
    huv2: {
      kind: "03_huv2",
      status: "upcoming",
      windowStart: "2026-09-12T00:00:00.000Z",
      windowEnd: "2026-09-26T23:59:59.999Z",
      lateDeadline: "2026-10-03T23:59:59.999Z",
      assessmentId: null,
    },
    sfvs: [
      {
        id: "sfv-1",
        status: "open",
        triggeringAssessmentId: "assess-adm",
        triggeringRfaKind: "01_admission",
        dueAt: "2026-09-04T23:59:59.999Z",
        completingAssessmentId: null,
      },
    ],
    dischargeAssessment: {
      kind: "05_discharge",
      status: "not_applicable",
      windowStart: null,
      windowEnd: null,
      lateDeadline: null,
      assessmentId: null,
    },
  };
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function fail(code: string) {
  return {
    data: undefined,
    error: { error: { code } },
    response: new Response(null, { status: code === "M10_LATE_REASON_REQUIRED" ? 400 : 409 }),
  };
}

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return (
    <>
      <output aria-label="location">{location.pathname}</output>
      <output aria-label="location query">{location.search}</output>
    </>
  );
}

function renderRoute(
  client: ApiClient,
  initial: string,
  session: typeof SESSION | null = SESSION,
): void {
  render(
    <SessionProvider session={session}>
      <MemoryRouter initialEntries={[initial]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route
              path="/admissions/:admissionId/hope/timepoints/:kind"
              element={
                <>
                  <HopeTimepointCapture />
                  <LocationProbe />
                </>
              }
            />
            <Route
              path="/admissions/:admissionId/hope/sfv/:sfvId"
              element={
                <>
                  <HopeSfvCapture />
                  <LocationProbe />
                </>
              }
            />
            <Route path="/hope/assessments/:id" element={<LocationProbe />} />
            <Route path="/admissions/:admissionId/hope" element={<LocationProbe />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("HOPE capture workspace", () => {
  it("shows late-completion reason when M10 reports a late HUV window", async () => {
    const client = {
      GET: vi.fn(async () => ok(workflow("late"))),
      POST: vi.fn(async () => ok({ id: "draft-1" })),
    } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "HUV1 Assessment" })).toBeTruthy(),
    );
    expect(screen.getByText("Late completion")).toBeTruthy();
    expect(screen.getByLabelText("Late completion reason")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Late completion reason"), {
      target: { value: "hospitalization" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe("/hope/assessments/draft-1"),
    );
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admissions/{admissionId}/hope/timepoints",
      expect.objectContaining({
        body: expect.objectContaining({
          rfaKind: "02_huv1",
          lateCompletionReasonCode: "hospitalization",
        }),
      }),
    );
  });

  it("renders structured M10 late and before-window errors instead of recalculating in React", async () => {
    // The page loaded while the window was open; by the time it is submitted the server judges it late. The refusal is not
    // "select a reason" (no such control is on a page that read the item as open): the workflow is re-read, so the control is.
    let reads = 0;
    const client = {
      GET: vi.fn(async () => ok(workflow(reads++ === 0 ? "open" : "late"))),
      POST: vi.fn(async () => fail("M10_LATE_REASON_REQUIRED")),
    } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "HUV1 Assessment" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "changed while you were on this page",
      ),
    );
    expect(screen.getByLabelText("Late completion reason")).toBeTruthy();
  });

  it("does not offer to record an SFV here: it sends the clinician to the assessment that holds the J2053 questions", async () => {
    // The server refuses an SFV completion with no J2053 answers, and this page has no such fields, so it
    // must not submit one: the follow-up is completed in the triggering assessment's "Complete SFV" dialog.
    const client = {
      GET: vi.fn(async () => ok(workflow("open"))),
      POST: vi.fn(async () => ok({ id: "sfv-assessment-1" })),
    } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/sfv/sfv-1`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Symptom Follow-Up" })).toBeTruthy(),
    );
    expect(screen.getByText("Triggered by Admission.")).toBeTruthy();
    // The button opens the assessment with its completion dialog ready, so the copy no longer sends the clinician looking for it.
    expect(screen.getByText(/the completion dialog opens/i)).toBeTruthy();
    expect(screen.queryByText(/choose Complete SFV in section J/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Create HOPE draft/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /I attest/ })).toBeNull();
    expect(screen.queryByLabelText("Target date/time")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Open the triggering assessment/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe("/hope/assessments/assess-adm"),
    );
    // Lands where the action is: the assessment opens its completion dialog.
    expect(screen.getByLabelText("location query").textContent).toBe("?completeSfv=1");
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("names the patient and shows the admission's calendar day in any timezone", async () => {
    // admissionAt is a date serialized as midnight UTC; in a US zone a local-time render reads Aug 26.
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/patients/{id}"
        ? ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" })
        : ok(workflow("open")),
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    expect(await screen.findByText("Lovelace, Ada")).toBeTruthy();
    expect(screen.queryByText("patient-1")).toBeNull();
    // The calendar day stored (27 August), in the viewer's own locale: formatted in UTC, so neither the machine's zone nor
    // its locale decides the expectation, and not by the component's own formatter, which would agree with any mistake.
    const storedDay = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-08-27T00:00:00.000Z"));
    expect(screen.getByText((text) => text.includes(`Admission ${storedDay}`))).toBeTruthy();
  });

  it("falls back to the patient id when the name cannot be read", async () => {
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/patients/{id}" ? { data: undefined, error: {} } : ok(workflow("open")),
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    expect(await screen.findByText("patient-1")).toBeTruthy();
  });
});

describe("HOPE capture workspace: who the capture is attributed to", () => {
  const HUV1 = `/admissions/${admissionId}/hope/timepoints/02_huv1`;
  const create = () =>
    screen.getByRole("button", { name: /Create HOPE draft/ }) as HTMLButtonElement;
  const clientAnswering = (post: ReturnType<typeof vi.fn>) =>
    ({ GET: vi.fn(async () => ok(workflow("open"))), POST: post }) as unknown as ApiClient;
  const sentDiscipline = (post: ReturnType<typeof vi.fn>) =>
    (post.mock.calls[0] as unknown as [string, { body: { authorDiscipline: string } }])[1].body
      .authorDiscipline;

  it("attributes the capture to the clinician's own discipline, not a fixed RN", async () => {
    const post = vi.fn(async () => ok({ id: "draft-1" }));
    renderRoute(clientAnswering(post), HUV1, sessionWith(["np"]));
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    expect(
      (screen.getByRole("combobox", { name: "Author discipline" }) as HTMLSelectElement).value,
    ).toBe("NP");
    fireEvent.click(create());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentDiscipline(post)).toBe("NP");
  });

  it("makes a clinician who holds two disciplines choose, and sends the one chosen", async () => {
    const post = vi.fn(async () => ok({ id: "draft-1" }));
    renderRoute(clientAnswering(post), HUV1, SESSION_RN_NP);
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    expect(create().disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Author discipline" }), {
      target: { value: "NP" },
    });
    expect(create().disabled).toBe(false);
    fireEvent.click(create());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentDiscipline(post)).toBe("NP");
  });

  it("sends nothing, and says why, when none of the clinician's roles may author it", async () => {
    const post = vi.fn(async () => ok({ id: "draft-1" }));
    renderRoute(clientAnswering(post), HUV1, sessionWith(["lpn"]));
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    expect(screen.queryByRole("combobox", { name: "Author discipline" })).toBeNull();
    expect(screen.getByText(/None of your roles can be recorded/)).toBeTruthy();
    expect(create().disabled).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("says nothing of RN, NP or MD when the server refuses the discipline: it shows the server's own words", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: {
        error: { code: "M10_DISCIPLINE_NOT_PERMITTED", message: "Not one of your disciplines." },
      },
      response: new Response(null, { status: 403 }),
    }));
    renderRoute(clientAnswering(post), HUV1);
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.click(create());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Not one of your disciplines.");
    expect(alert.textContent).not.toContain("RN, NP or MD");
  });
});

describe("HOPE capture workspace: a write that does not answer cleanly", () => {
  const HUV1 = `/admissions/${admissionId}/hope/timepoints/02_huv1`;
  const create = () =>
    screen.getByRole("button", { name: /Create HOPE draft|Recording/ }) as HTMLButtonElement;
  const clientAnswering = (post: ReturnType<typeof vi.fn>) =>
    ({ GET: vi.fn(async () => ok(workflow("open"))), POST: post }) as unknown as ApiClient;

  it("frees the form and says it could not confirm when the request is rejected", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const post = vi.fn(async () => Promise.reject(new TypeError("offline")));
      renderRoute(clientAnswering(post), HUV1);
      await screen.findByRole("heading", { name: "HUV1 Assessment" });
      fireEvent.click(create());
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Could not confirm that the timepoint was recorded",
      );
      expect(create().textContent).toContain("Create HOPE draft");
      expect(create().disabled).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("says the result could not be confirmed, not a generic failure, for a gateway reply with no body", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: undefined,
      response: new Response(null, { status: 502 }),
    }));
    renderRoute(clientAnswering(post), HUV1);
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.click(create());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "the result could not be confirmed",
    );
  });

  it("is freed after the wait when the request is never answered", async () => {
    const post = vi.fn(() => new Promise(() => undefined));
    renderRoute(clientAnswering(post), HUV1);
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    vi.useFakeTimers();
    try {
      fireEvent.click(create());
      expect(create().disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("alert").textContent).toContain("Could not confirm");
    expect(create().disabled).toBe(false);
  });

  it("does not pull the clinician to the draft it created once they have left the page", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderRoute(clientAnswering(post), HUV1);
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.click(create());
    fireEvent.click(screen.getByRole("button", { name: "HOPE Overview" }));
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(`/admissions/${admissionId}/hope`),
    );
    await act(async () => {
      release(ok({ id: "draft-9" }));
    });
    expect(screen.getByLabelText("location").textContent).toBe(`/admissions/${admissionId}/hope`);
  });
});
