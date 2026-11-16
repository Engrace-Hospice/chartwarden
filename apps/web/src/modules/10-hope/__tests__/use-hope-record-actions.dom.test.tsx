// @vitest-environment jsdom
import type { ApiClient } from "@chartwarden/ui";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { useHopeRecordActions } from "../use-hope-record-actions";
import { SESSION, ok } from "./workspace-test-kit";

// The hook the assessment screen's record writes go through, driven directly: what it does to the screen's state
// (the timeline it keeps, where it navigates, what it re-reads) rather than only what ends up drawn.

const ASSESSMENT = {
  status: "signed",
  version: 7,
  targetDate: "2026-09-08T00:00:00.000Z",
  rfaKind: "01_admission",
  patientId: "patient-1",
};
/** A HUV completion date is only written to a draft. */
const DRAFT = { ...ASSESSMENT, status: "draft", rfaKind: "02_huv1" };
const KNOWN_ROWS = [
  { id: "hope-1", status: "signed", correctsAssessmentId: null },
  { id: "older", status: "signed", correctsAssessmentId: null },
];
const TIMELINE_PATH = "/api/v1/patients/{patientId}/hope/assessments";

const reply = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});

function setup(
  api: { GET: unknown; PATCH?: unknown; POST: unknown },
  assessment: typeof ASSESSMENT = ASSESSMENT,
) {
  const setTimeline = vi.fn();
  const navigate = vi.fn();
  const refresh = vi.fn(async () => true);
  const setSaving = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionProvider session={SESSION}>{children}</SessionProvider>
  );
  const hook = renderHook(
    () =>
      useHopeRecordActions({
        api: { PATCH: vi.fn(), ...api } as never,
        client: {} as ApiClient,
        id: "hope-1",
        assessment,
        workspaceVersion: 7,
        timeline: KNOWN_ROWS,
        setTimeline,
        refresh,
        setSaving,
        closeInactivation: vi.fn(),
        navigate,
      }),
    { wrapper },
  );
  return { ...hook, setTimeline, navigate, refresh, setSaving };
}

describe("creating a correction: the lookup that follows a refusal", () => {
  const refused = async () =>
    reply(409, { error: { code: "CONFLICT", message: "This record changed." } });

  it.each([
    ["answers with an error", async () => reply(502)],
    ["is rejected", async () => Promise.reject(new TypeError("offline"))],
  ])("leaves the timeline on screen alone when it %s", async (_name, lookup) => {
    const { result, setTimeline } = setup({ GET: vi.fn(lookup), POST: vi.fn(refused) });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(setTimeline).not.toHaveBeenCalled();
  });

  it("replaces the timeline with what it read when it succeeds", async () => {
    const rows = [...KNOWN_ROWS, { id: "newer", status: "signed", correctsAssessmentId: null }];
    const { result, setTimeline } = setup({
      GET: vi.fn(async () => ok({ assessments: rows })),
      POST: vi.fn(refused),
    });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(setTimeline).toHaveBeenCalledWith(rows);
  });

  it("reports the create's own refusal, not a 'could not confirm', when the lookup is rejected", async () => {
    const { result } = setup({
      GET: vi.fn(async () => Promise.reject(new TypeError("offline"))),
      POST: vi.fn(async () =>
        reply(403, {
          error: { code: "M10_DISCIPLINE_NOT_PERMITTED", message: "Not your discipline." },
        }),
      ),
    });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(result.current.correctionError).toBe("Not your discipline.");
  });

  it("still tells the clinician it could not confirm when the create itself got a non-answer and the lookup fails too", async () => {
    const { result } = setup({
      GET: vi.fn(async () => Promise.reject(new TypeError("offline"))),
      POST: vi.fn(async () => reply(502)),
    });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(result.current.correctionError).toContain("Could not confirm");
  });
});

describe("a create that is answered after the clinician has left the record", () => {
  /** A write whose reply the test releases by hand. */
  function pending<T>() {
    let release: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it("does not navigate to the correction it created", async () => {
    const write = pending<unknown>();
    const { result, unmount, navigate } = setup({
      GET: vi.fn(),
      POST: vi.fn(() => write.promise),
    });

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.createCorrection("Wrong date", "RN");
    });
    unmount();
    await act(async () => {
      write.release(ok({ id: "correction-9" }));
      await creating;
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate to the inactivation it created", async () => {
    const write = pending<unknown>();
    const { result, unmount, navigate } = setup({
      GET: vi.fn(),
      POST: vi.fn(() => write.promise),
    });

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.createInactivation("Wrong patient", "RN");
    });
    unmount();
    await act(async () => {
      write.release(ok({ id: "inactivation-9" }));
      await creating;
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not re-read a screen that is gone after a 409", async () => {
    const write = pending<unknown>();
    const { result, unmount, refresh } = setup({
      GET: vi.fn(async () => ok({ assessments: [] })),
      POST: vi.fn(() => write.promise),
    });

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.createInactivation("Wrong patient", "RN");
    });
    unmount();
    await act(async () => {
      write.release(reply(409, { error: { code: "CONFLICT", message: "Changed." } }));
      await creating;
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("still navigates when the clinician is still on the record", async () => {
    const { result, navigate } = setup({
      GET: vi.fn(),
      POST: vi.fn(async () => ok({ id: "correction-9" })),
    });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(navigate).toHaveBeenCalledWith("/hope/assessments/correction-9");
  });
});

describe("confirming a HUV completion date", () => {
  const patchAnswering = (answer: () => Promise<unknown>) => ({
    GET: vi.fn(),
    POST: vi.fn(),
    PATCH: vi.fn(answer),
  });

  it("does not hold the control shut while the re-read that follows is out", async () => {
    const api = patchAnswering(async () => ok({ assessmentId: "hope-1", z0350: "2026-09-10" }));
    const { result, refresh } = setup(api, DRAFT);
    refresh.mockImplementation(() => new Promise<boolean>(() => undefined)); // a read nobody answers

    await act(() => result.current.setHuvCompletionDate("2026-09-10"));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.completionDateSaving).toBe(false);
  });

  it("reports a version conflict as one and re-reads, so the retry carries the current version", async () => {
    const api = patchAnswering(async () =>
      reply(409, { error: { code: "M10_VERSION_CONFLICT", message: "Changed elsewhere." } }),
    );
    const { result, setSaving, refresh } = setup(api, DRAFT);

    await act(() => result.current.setHuvCompletionDate("2026-09-10"));

    expect(setSaving).toHaveBeenCalledWith("conflict");
    expect(setSaving).not.toHaveBeenCalledWith("failed");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(result.current.completionDateSaving).toBe(false);
  });

  // A 4xx applied nothing, so nothing is re-read; an outcome nobody confirmed may have been applied, so the screen is re-read.
  it.each([
    [
      "a refusal that is not a conflict",
      async () => reply(422, { error: { code: "VALIDATION_FAILED" } }),
      "failed",
      false,
    ],
    ["a non-OK reply with no body", async () => reply(502), "unconfirmed", true],
    [
      "a rejected request",
      async () => Promise.reject(new TypeError("offline")),
      "unconfirmed",
      true,
    ],
  ])("reports the save for %s with the right status", async (_name, answer, expected, rereads) => {
    const { result, setSaving, refresh } = setup(patchAnswering(answer), DRAFT);

    await act(() => result.current.setHuvCompletionDate("2026-09-10"));

    expect(setSaving).toHaveBeenCalledWith(expected);
    if (rereads) await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    else expect(refresh).not.toHaveBeenCalled();
  });
});
