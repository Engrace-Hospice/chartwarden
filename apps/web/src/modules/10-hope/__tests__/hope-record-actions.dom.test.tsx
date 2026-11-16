// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import {
  SESSION,
  SESSION_RN_NP,
  SIGNED,
  assessment,
  clientFor,
  ok,
  renderWorkspace,
  review,
  sessionWith,
  workspace,
} from "./workspace-test-kit";

// The writes on the record itself: request the summary, create a correction, inactivate, confirm a HUV completion
// date. Each must end in something the clinician can SEE (never a silent failure, never a dialog that cannot be left),
// and none may leave a rejected request unhandled.

type Mocked = ReturnType<typeof vi.fn>;
const asMock = (fn: unknown) => fn as Mocked;
const reply = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A POST that answers as the server's TypeBox boundary does: a body missing a required field, or carrying a discipline
 * outside the union, is refused 422 before anything else. The kit's default POST accepts any body, which is how a missing
 * `authorDiscipline` once passed every test and failed every clinician.
 */
const DISCIPLINES = ["RN", "NP", "MD", "LPN", "LVN"];
function validatingPost(
  required: readonly string[],
  answer: unknown,
): (path: string, init?: { body?: Record<string, unknown> }) => Promise<unknown> {
  return async (_path, init) => {
    const body = init?.body ?? {};
    const missing = required.filter((field) => body[field] === undefined || body[field] === "");
    const badDiscipline = !DISCIPLINES.includes(body.authorDiscipline as string);
    if (missing.length > 0 || badDiscipline)
      return reply(422, {
        error: { code: "VALIDATION_ERROR", message: `Invalid request: ${missing.join(", ")}` },
      });
    return answer;
  };
}
const sentBody = (client: ReturnType<typeof clientFor>, n = 0): Record<string, unknown> =>
  (asMock(client.POST).mock.calls[n] as [string, { body: Record<string, unknown> }])[1].body;

describe("Inactivate a signed record", () => {
  async function openInactivation(
    client: ReturnType<typeof clientFor>,
    session: typeof SESSION = SESSION,
  ) {
    renderWorkspace(client, session);
    fireEvent.click(await screen.findByRole("button", { name: "Inactivate" }));
    const dialog = await screen.findByRole("dialog", { name: "Inactivate Admission" });
    const reason = within(dialog).getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: "Entered on the wrong patient" } });
    return { dialog, reason };
  }
  const create = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Create inactivation" }) as HTMLButtonElement;

  it("sends what the server's boundary requires: the reason, the version and the acting user's own discipline", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockImplementation(
      validatingPost(["reason", "authorDiscipline"], ok({ id: "inactivation-3" })),
    );
    const { dialog } = await openInactivation(client);
    fireEvent.click(create(dialog));
    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/hope/assessments/inactivation-3",
      ),
    );
    expect(sentBody(client)).toEqual({
      reason: "Entered on the wrong patient",
      ifVersion: SIGNED.version,
      authorDiscipline: "RN",
    });
  });

  it("attributes it to the acting user's discipline, not the discipline the record was authored under", async () => {
    // The signed record says RN; the clinician inactivating it is an NP, and the server refuses any other attribution.
    const client = clientFor({ assessment: { ...SIGNED, authorDiscipline: "RN" } });
    asMock(client.POST).mockImplementation(
      validatingPost(["reason", "authorDiscipline"], ok({ id: "inactivation-4" })),
    );
    const { dialog } = await openInactivation(client, sessionWith(["np"]));
    fireEvent.click(create(dialog));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(sentBody(client).authorDiscipline).toBe("NP");
  });

  it("makes a clinician who holds two disciplines choose, and sends the one chosen", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockImplementation(
      validatingPost(["reason", "authorDiscipline"], ok({ id: "inactivation-5" })),
    );
    const { dialog } = await openInactivation(client, SESSION_RN_NP);
    expect(create(dialog).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Author discipline" }), {
      target: { value: "NP" },
    });
    fireEvent.click(create(dialog));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(sentBody(client).authorDiscipline).toBe("NP");
  });

  it("sends nothing, and says why, when none of the clinician's roles may author an inactivation", async () => {
    const client = clientFor({ assessment: SIGNED });
    const { dialog } = await openInactivation(client, sessionWith(["social_worker"]));
    expect(dialog.textContent).toContain("Your role cannot author an inactivation");
    expect(create(dialog).disabled).toBe(true);
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("is not a trap when the request is rejected: the dialog says so, Cancel and Escape work, the reason is kept", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { dialog, reason } = await openInactivation(client);
    fireEvent.click(create(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Could not confirm that the inactivation was created.");
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(create(dialog).disabled).toBe(false);
    expect(reason.value).toBe("Entered on the wrong patient");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Inactivate Admission" })).toBeNull(),
    );
  });

  it("is not locked for good by a request nobody answers: after the wait it says it could not confirm, and Cancel and Escape work", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockImplementation(() => new Promise(() => undefined));
    const { dialog } = await openInactivation(client);
    vi.useFakeTimers();
    try {
      fireEvent.click(create(dialog));
      const creating = within(dialog).getByRole("button", { name: "Creating..." });
      expect((creating as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    const alert = within(dialog).getByRole("alert");
    expect(alert.textContent).toContain("Could not confirm that the inactivation was created.");
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(document.activeElement).toBe(alert);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Inactivate Admission" })).toBeNull(),
    );
  });

  it("shows a refusal's own words in the dialog, keeps it open with the reason typed, and a retry can succeed", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST)
      .mockResolvedValueOnce(
        reply(409, {
          error: { code: "CONFLICT", message: "An inactivation is already in progress." },
        }),
      )
      .mockResolvedValueOnce(ok({ id: "inactivation-1" }));
    const { dialog, reason } = await openInactivation(client);
    fireEvent.click(create(dialog));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "An inactivation is already in progress.",
    );
    expect(screen.getByRole("dialog", { name: "Inactivate Admission" })).toBe(dialog);
    expect(reason.value).toBe("Entered on the wrong patient");

    fireEvent.click(create(dialog));
    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/hope/assessments/inactivation-1",
      ),
    );
    expect(client.POST).toHaveBeenCalledTimes(2);
  });

  it("re-reads the record after a 409, so the retry carries the version the record has now", async () => {
    const client = clientFor({ assessment: SIGNED });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let refused = false;
    let rereads = 0;
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (!refused || path !== "/api/v1/hope/assessments/{id}") return initial(path, init);
      rereads += 1;
      return ok({ ...SIGNED, version: SIGNED.version + 5 });
    });
    asMock(client.POST)
      .mockImplementationOnce(async () => {
        refused = true;
        return reply(409, { error: { code: "CONFLICT", message: "This record changed." } });
      })
      .mockResolvedValueOnce(ok({ id: "inactivation-6" }));
    const { dialog } = await openInactivation(client);
    fireEvent.click(create(dialog));
    await within(dialog).findByText("This record changed.");

    // The re-read lands behind the dialog; the retry that follows sends the new version, not the refused one.
    await waitFor(() => expect(rereads).toBe(1));
    await act(async () => undefined);
    fireEvent.click(create(dialog));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(sentBody(client, 0).ifVersion).toBe(SIGNED.version);
    expect(sentBody(client, 1).ifVersion).toBe(SIGNED.version + 5);
  });

  it("does not show a server fault's raw text, and does not claim nothing was created", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockResolvedValueOnce(
      reply(500, { error: { code: "INTERNAL", message: "ECONNREFUSED 10.0.0.5:5432" } }),
    );
    const { dialog } = await openInactivation(client);
    fireEvent.click(create(dialog));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("the result could not be confirmed");
    expect(alert.textContent).not.toContain("ECONNREFUSED");
  });

  it.each([
    ["a refusal with no body", reply(403), "The server refused the request without saying why."],
    [
      "an unreadable gateway reply",
      reply(502),
      "Could not confirm that the inactivation was created.",
    ],
  ])("says %s plainly", async (_name, answer, text) => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockResolvedValueOnce(answer);
    const { dialog } = await openInactivation(client);
    fireEvent.click(create(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(text);
  });

  it("closes and opens the new inactivation draft when it works", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockResolvedValueOnce(ok({ id: "inactivation-2" }));
    const { dialog } = await openInactivation(client);
    fireEvent.click(create(dialog));
    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/hope/assessments/inactivation-2",
      ),
    );
    expect(screen.queryByRole("dialog", { name: "Inactivate Admission" })).toBeNull();
  });
});

describe("Request summary", () => {
  const summaryButton = () => screen.findByRole("button", { name: /summary/i });

  it("says it was requested when the server accepted it", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockResolvedValueOnce(ok({ assessmentId: "hope-1", requested: true }));
    renderWorkspace(client, SESSION);
    fireEvent.click(await summaryButton());
    expect(await screen.findByRole("button", { name: "Summary requested" })).toBeTruthy();
  });

  it.each([
    ["a non-OK reply with no body (no error, no data)", reply(502)],
    [
      "an empty error body",
      { data: undefined, error: "", response: new Response(null, { status: 500 }) },
    ],
    ["a refusal", reply(403, { error: { code: "FORBIDDEN", message: "No." } })],
  ])("offers a retry, not 'requested', for %s", async (_name, answer) => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockResolvedValueOnce(answer);
    renderWorkspace(client, SESSION);
    fireEvent.click(await summaryButton());
    expect(await screen.findByRole("button", { name: "Retry summary request" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Summary requested" })).toBeNull();
  });

  it("offers a retry when the request is rejected, without an unhandled rejection", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderWorkspace(client, SESSION);
    fireEvent.click(await summaryButton());
    expect(await screen.findByRole("button", { name: "Retry summary request" })).toBeTruthy();
  });
});

describe("Create correction", () => {
  async function openCorrection(
    client: ReturnType<typeof clientFor>,
    session: typeof SESSION = SESSION,
  ) {
    renderWorkspace(client, session);
    fireEvent.click(await screen.findByRole("button", { name: "Create correction" }));
    const dialog = await screen.findByRole("dialog", { name: "Correct Admission" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "The date was wrong" },
    });
    return dialog;
  }
  const create = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Create correction draft" }) as HTMLButtonElement;

  it("sends what the server's boundary requires, attributed to the acting user's own discipline", async () => {
    const client = clientFor({ assessment: { ...SIGNED, authorDiscipline: "RN" } });
    asMock(client.POST).mockImplementation(
      validatingPost(
        ["correctionReason", "targetDate", "authorDiscipline", "data"],
        ok({ id: "correction-1" }),
      ),
    );
    // An NP correcting an RN-authored record: the server refuses RN (403) because it is not the NP's own discipline.
    const dialog = await openCorrection(client, sessionWith(["np"]));
    fireEvent.click(create(dialog));
    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/hope/assessments/correction-1",
      ),
    );
    expect(sentBody(client)).toEqual({
      correctionReason: "The date was wrong",
      ifVersion: SIGNED.version,
      targetDate: SIGNED.targetDate,
      authorDiscipline: "NP",
      data: {},
    });
  });

  it("makes a clinician who holds two disciplines choose, and sends nothing when none of their roles may author it", async () => {
    const both = clientFor({ assessment: SIGNED });
    asMock(both.POST).mockImplementation(
      validatingPost(["correctionReason", "authorDiscipline"], ok({ id: "correction-2" })),
    );
    const dialog = await openCorrection(both, SESSION_RN_NP);
    expect(create(dialog).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Author discipline" }), {
      target: { value: "RN" },
    });
    fireEvent.click(create(dialog));
    await waitFor(() => expect(both.POST).toHaveBeenCalledTimes(1));
    expect(sentBody(both).authorDiscipline).toBe("RN");
  });

  it("blocks the write with a message when none of the clinician's roles may author a correction", async () => {
    const client = clientFor({ assessment: SIGNED });
    const dialog = await openCorrection(client, sessionWith(["social_worker"]));
    expect(dialog.textContent).toContain("Your role cannot author a correction");
    expect(create(dialog).disabled).toBe(true);
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("says so, and keeps the dialog and the reason, when the request is rejected", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const dialog = await openCorrection(client);
    fireEvent.click(create(dialog));
    const alert = await within(dialog).findByText(
      /Could not confirm that the correction was created/,
    );
    expect(alert.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(alert);
    expect(
      (within(dialog).getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement).value,
    ).toBe("The date was wrong");
  });

  it("is freed after the wait when the request is never answered", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockImplementation(() => new Promise(() => undefined));
    const dialog = await openCorrection(client);
    vi.useFakeTimers();
    try {
      fireEvent.click(create(dialog));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Could not confirm that the correction was created",
    );
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says so when the lookup that follows a failed create is rejected too", async () => {
    const client = clientFor({ assessment: SIGNED });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let created = false;
    asMock(client.POST).mockImplementation(async () => {
      created = true;
      return reply(502);
    });
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (created && path === "/api/v1/patients/{patientId}/hope/assessments")
        throw new TypeError("offline");
      return initial(path, init);
    });
    const dialog = await openCorrection(client);
    fireEvent.click(create(dialog));
    expect(
      await within(dialog).findByText(/Could not confirm that the correction was created/),
    ).toBeTruthy();
  });

  it("opens the correction another session already started, found by the lookup that follows a refusal", async () => {
    const client = clientFor({ assessment: SIGNED });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let refused = false;
    asMock(client.POST).mockImplementation(async () => {
      refused = true;
      return reply(409, { error: { code: "CONFLICT", message: "A correction is pending." } });
    });
    get.mockImplementation(async (path: string, init?: unknown) =>
      refused && path === "/api/v1/patients/{patientId}/hope/assessments"
        ? ok({
            assessments: [
              SIGNED,
              {
                ...assessment,
                id: "correction-9",
                status: "draft",
                correctsAssessmentId: "hope-1",
              },
            ],
          })
        : initial(path, init),
    );
    const dialog = await openCorrection(client);
    fireEvent.click(create(dialog));
    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/hope/assessments/correction-9",
      ),
    );
  });

  it("shows the refusal's own words, and a plain create, when the lookup after it answers with an error", async () => {
    const client = clientFor({
      assessment: SIGNED,
      timeline: [SIGNED, { ...assessment, id: "older", status: "signed" }],
    });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let refused = false;
    asMock(client.POST).mockImplementation(async () => {
      refused = true;
      return reply(409, { error: { code: "CONFLICT", message: "This record changed." } });
    });
    get.mockImplementation(async (path: string, init?: unknown) =>
      refused && path === "/api/v1/patients/{patientId}/hope/assessments"
        ? reply(502)
        : initial(path, init),
    );
    const dialog = await openCorrection(client);
    fireEvent.click(create(dialog));
    expect(await within(dialog).findByText("This record changed.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Create correction" })).toBeTruthy();
    // That the failed lookup leaves the timeline rows alone is not visible from here (neither row is an open draft, so an
    // emptied timeline draws the same); `use-hope-record-actions.dom.test.tsx` asserts it on the state itself.
  });

  it("shows the create's own refusal, not 'could not confirm', when the lookup after it is rejected", async () => {
    const client = clientFor({ assessment: SIGNED });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let refused = false;
    asMock(client.POST).mockImplementation(async () => {
      refused = true;
      return reply(403, {
        error: { code: "M10_DISCIPLINE_NOT_PERMITTED", message: "Not your discipline." },
      });
    });
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (refused && path === "/api/v1/patients/{patientId}/hope/assessments")
        throw new TypeError("offline");
      return initial(path, init);
    });
    const dialog = await openCorrection(client);
    fireEvent.click(create(dialog));
    expect(await within(dialog).findByText("Not your discipline.")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Could not confirm");
  });

  it("shows a refusal's own words", async () => {
    const client = clientFor({ assessment: SIGNED });
    asMock(client.POST).mockResolvedValueOnce(
      reply(409, { error: { code: "CONFLICT", message: "This record changed." } }),
    );
    const dialog = await openCorrection(client);
    fireEvent.click(create(dialog));
    expect(await within(dialog).findByText("This record changed.")).toBeTruthy();
  });
});

describe("Sign a record when the request is never answered", () => {
  const readyReview = () =>
    review({
      validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
      readiness: { readyToSign: true, blockers: [] },
    });

  it("says it could not confirm after the wait, frees the dialog, and tells the signer to reload rather than retry", async () => {
    const client = clientFor({ review: readyReview() });
    asMock(client.POST).mockImplementation(() => new Promise(() => undefined));
    renderWorkspace(client, SESSION);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
    vi.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Could not confirm that the assessment was signed. Reload the record before trying again.",
    );
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("Re-reading the record after it is signed", () => {
  it("keeps the timeline it already has when the timeline read answers with an error, so an open correction is still offered as one", async () => {
    // The correction draft is already in the timeline; the record turns signed once the signature lands.
    const correction = {
      ...assessment,
      id: "correction-9",
      status: "draft",
      correctsAssessmentId: "hope-1",
    };
    const client = clientFor({
      review: review({
        validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
        readiness: { readyToSign: true, blockers: [] },
      }),
      timeline: [assessment, correction],
    });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let signed = false;
    asMock(client.POST).mockImplementation(async () => {
      signed = true;
      return ok({ assessmentId: "hope-1", status: "signed", version: 5 });
    });
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (!signed) return initial(path, init);
      if (path === "/api/v1/patients/{patientId}/hope/assessments") return reply(502);
      return path === "/api/v1/hope/assessments/{id}" ? ok(SIGNED) : initial(path, init);
    });
    renderWorkspace(client, SESSION);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    expect(await screen.findByRole("button", { name: "Open correction draft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create correction" })).toBeNull();
  });
});

describe("Re-reading the record after it is signed, when the workspace or the review cannot be read", () => {
  /** Signs a draft whose three reads answer as `afterSign` says once the signature has landed. */
  async function signThenReread(afterSign: (path: string) => unknown | undefined) {
    const client = clientFor({
      review: review({
        validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
        readiness: { readyToSign: true, blockers: [] },
      }),
    });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let signed = false;
    asMock(client.POST).mockImplementation(async () => {
      signed = true;
      return ok({ assessmentId: "hope-1", status: "signed", version: 5 });
    });
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (!signed) return initial(path, init);
      if (path === "/api/v1/hope/assessments/{id}") return ok(SIGNED);
      return afterSign(path) ?? initial(path, init);
    });
    renderWorkspace(client, SESSION);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
  }
  const NOTICE = "The record was signed, but this page could not refresh. Reload to see it.";

  it.each([
    ["answers with a gateway error", reply(502)],
    ["answers with an error body", reply(500, { error: { message: "boom" } })],
  ])(
    "keeps the record on screen, and says the page could not refresh, when the workspace read %s",
    async (_name, failure) => {
      await signThenReread((path) => (path.endsWith("/workspace") ? failure : undefined));

      expect(await screen.findByText(NOTICE)).toBeTruthy();
      // The record is still the one the clinician was signing, not the "Workspace unavailable" page.
      expect(screen.queryByText("Workspace unavailable")).toBeNull();
      expect(screen.getAllByText(/Admission/).length).toBeGreaterThan(0);
    },
  );

  it("says the page could not refresh when only the review read fails, and keeps the review it had", async () => {
    await signThenReread((path) => (path.endsWith("/review") ? reply(502) : undefined));

    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText("Workspace unavailable")).toBeNull();
  });

  it("says nothing when every read after the signature succeeds", async () => {
    let finished = false;
    await signThenReread((path) => {
      // The last read of the re-read: once it has answered, the notice (if any) is a flush away.
      if (path.endsWith("/addresses")) finished = true;
      return undefined;
    });

    await waitFor(() => expect(finished).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText("Workspace unavailable")).toBeNull();
  });
});

describe("Confirm the HUV completion date", () => {
  const huvWorkspace = () => {
    const base = workspace();
    return { ...base, assessment: { ...base.assessment, isc: "HUV", rfaKind: "02_huv1" } };
  };
  const HUV = { ...assessment, rfaKind: "02_huv1" };

  async function confirmDate(client: ReturnType<typeof clientFor>) {
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
    fireEvent.change(await screen.findByLabelText("Assessment completed on"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm date" }));
  }

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline")), "Save not confirmed"],
    ["a non-OK reply with no body", async () => reply(502), "Save not confirmed"],
    [
      "a refusal",
      async () => reply(422, { error: { code: "VALIDATION_FAILED", message: "No." } }),
      "Save failed",
    ],
  ])(
    "shows %s as the header says, never a failure that may have landed",
    async (_name, answer, header) => {
      const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
      asMock(client.PATCH).mockImplementationOnce(answer);
      await confirmDate(client);
      expect(await screen.findByText(header)).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Confirm date" }) as HTMLButtonElement).textContent,
      ).toBe("Confirm date");
    },
  );

  it("shows the conflict banner on a version conflict, and the retry carries the version the record has now", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let conflicted = false;
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (!conflicted) return initial(path, init);
      // Another session saved first: the record is now at version 9.
      if (path.includes("/workspace")) {
        const base = huvWorkspace();
        return ok({ ...base, assessment: { ...base.assessment, version: 9 } });
      }
      return initial(path, init);
    });
    asMock(client.PATCH)
      .mockImplementationOnce(async () => {
        conflicted = true;
        return reply(409, { error: { code: "M10_VERSION_CONFLICT", message: "Changed." } });
      })
      .mockResolvedValueOnce(ok({ assessmentId: "hope-1", z0350: "2026-09-10" }));
    await confirmDate(client);

    expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();
    expect(screen.queryByText("Save failed")).toBeNull();
    const ifVersionOf = (n: number) =>
      (asMock(client.PATCH).mock.calls[n] as [string, { body: { ifVersion: number } }])[1].body
        .ifVersion;
    expect(ifVersionOf(0)).toBe(4);

    const confirm = (await screen.findByRole("button", {
      name: "Confirm date",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(2));
    expect(ifVersionOf(1)).toBe(9);
  });

  it("shows it saved when the server answered", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    asMock(client.PATCH).mockResolvedValueOnce(ok({ assessmentId: "hope-1", z0350: "2026-09-10" }));
    await confirmDate(client);
    expect(await screen.findByText(/Auto-saved/)).toBeTruthy();
  });
});

describe("Saving an answer", () => {
  it("shows Save not confirmed, and the field's message, when the save request is rejected", async () => {
    const client = clientFor();
    asMock(client.PATCH).mockRejectedValueOnce(new TypeError("offline"));
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));
    expect(await screen.findByText("Save not confirmed")).toBeTruthy();
    expect(screen.queryByText("Save failed")).toBeNull();
    // A rejected request may have been applied: the field and the header both say it could not be confirmed.
    expect(await screen.findByText(/Could not confirm that this answer was saved/)).toBeTruthy();
  });
});
