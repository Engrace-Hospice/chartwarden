// @vitest-environment jsdom
import type { ApiClient } from "@chartwarden/ui";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { useHopeRecordActions } from "../use-hope-record-actions";
import { SESSION, ok } from "./workspace-test-kit";

// Group g1 (web-k18): a record write whose outcome could not be confirmed (no answer, a timeout, an empty 5xx, a server fault) may
// have been applied, and its words tell the clinician to check the record. So the screen is re-read, and (for a correction or an
// inactivation, which show up as a draft in the timeline) so is the timeline. A refusal that was answered (4xx) applied nothing
// and re-reads nothing; M10_RECORD_BUSY (409, not applied) neither.

const SIGNED = {
  status: "signed",
  version: 7,
  targetDate: "2026-09-08T00:00:00.000Z",
  rfaKind: "01_admission",
  patientId: "patient-1",
};
const DRAFT_HUV = { ...SIGNED, status: "draft", rfaKind: "02_huv1" };
const KNOWN_ROWS = [{ id: "hope-1", status: "signed", correctsAssessmentId: null }];
const FRESH_ROWS = [
  ...KNOWN_ROWS,
  { id: "inactivation-9", status: "draft", correctsAssessmentId: "hope-1" },
];

const reply = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});
const refusal = (status: number, code: string) =>
  reply(status, { error: { code, message: `server words for ${code}` } });

/** A request whose answer the test releases by hand. */
function pending<T>() {
  let release: (value: T) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

function setup(
  api: { POST?: unknown; PATCH?: unknown; GET?: unknown },
  assessment: typeof SIGNED = SIGNED,
) {
  const refresh = vi.fn(async () => true);
  const setTimeline = vi.fn();
  const get = vi.fn(async () => ok({ assessments: FRESH_ROWS }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionProvider session={SESSION}>{children}</SessionProvider>
  );
  const hook = renderHook(
    () =>
      useHopeRecordActions({
        api: { GET: get, PATCH: vi.fn(), POST: vi.fn(), ...api } as never,
        client: {} as ApiClient,
        id: "hope-1",
        assessment,
        workspaceVersion: 7,
        timeline: KNOWN_ROWS,
        setTimeline,
        refresh,
        setSaving: vi.fn(),
        closeInactivation: vi.fn(),
        navigate: vi.fn(),
      }),
    { wrapper },
  );
  return { ...hook, refresh, setTimeline, get };
}

const UNKNOWN_OUTCOMES: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ["a rejected request", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ["an empty 502", async () => reply(502)],
  ["a server fault with a body", async () => refusal(500, "INTERNAL")],
];

describe("an inactivation whose outcome is not known", () => {
  it.each(UNKNOWN_OUTCOMES)(
    "re-reads the screen and the timeline after %s, and frees the dialog",
    async (_name, answer) => {
      const { result, refresh, setTimeline, get } = setup({ POST: vi.fn(answer) });

      await act(() => result.current.createInactivation("Entered in error", "RN"));

      expect(result.current.inactivationError).toMatch(/could not (be )?confirm/i);
      expect(result.current.inactivating).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(1);
      expect(setTimeline).toHaveBeenCalledWith(FRESH_ROWS);
    },
  );

  it.each([
    ["a 403 refusal", refusal(403, "FORBIDDEN")],
    ["a 422 refusal", refusal(422, "VALIDATION_FAILED")],
    ["a 409 M10_RECORD_BUSY (not applied)", refusal(409, "M10_RECORD_BUSY")],
  ])("re-reads nothing after %s", async (_name, answer) => {
    const { result, refresh, get } = setup({ POST: vi.fn(async () => answer) });

    await act(() => result.current.createInactivation("Entered in error", "RN"));

    expect(refresh).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not hold the dialog shut while the re-read is out", async () => {
    const { result, refresh } = setup({ POST: vi.fn(async () => reply(502)) });
    refresh.mockImplementation(() => new Promise<boolean>(() => undefined)); // a read nobody answers

    await act(() => result.current.createInactivation("Entered in error", "RN"));

    expect(result.current.inactivating).toBe(false);
  });

  it("does not re-read a screen the clinician has left", async () => {
    const write = pending<unknown>();
    const { result, unmount, refresh, get, setTimeline } = setup({
      POST: vi.fn(() => write.promise),
    });

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.createInactivation("Entered in error", "RN");
    });
    unmount();
    await act(async () => {
      write.fail(new TypeError("Failed to fetch"));
      await creating;
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(setTimeline).not.toHaveBeenCalled();
  });

  it("does not replace the timeline with a lookup that came back after the clinician left", async () => {
    const lookup = pending<unknown>();
    const { result, unmount, setTimeline } = setup({
      POST: vi.fn(async () => reply(502)),
      GET: vi.fn(() => lookup.promise),
    });

    await act(() => result.current.createInactivation("Entered in error", "RN"));
    unmount();
    await act(async () => {
      lookup.release(ok({ assessments: FRESH_ROWS }));
      await Promise.resolve();
    });

    expect(setTimeline).not.toHaveBeenCalled();
  });
});

describe("a correction whose outcome is not known", () => {
  it("looks the timeline up and re-reads the screen after a rejected request (the refusal path already looked it up)", async () => {
    const { result, refresh, get, setTimeline } = setup({
      POST: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(result.current.correctionError).toContain("Could not confirm");
    expect(get).toHaveBeenCalledTimes(1);
    expect(setTimeline).toHaveBeenCalledWith(FRESH_ROWS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads the screen after an empty 502 (and looks the timeline up once, as it always did)", async () => {
    const { result, refresh, get } = setup({ POST: vi.fn(async () => reply(502)) });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(get).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not re-read the screen after a 403 refusal", async () => {
    const { result, refresh } = setup({ POST: vi.fn(async () => refusal(403, "FORBIDDEN")) });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not re-read a screen the clinician has left", async () => {
    const write = pending<unknown>();
    const { result, unmount, refresh, get } = setup({ POST: vi.fn(() => write.promise) });

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.createCorrection("Wrong date", "RN");
    });
    unmount();
    await act(async () => {
      write.fail(new TypeError("Failed to fetch"));
      await creating;
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("a HUV completion date whose outcome is not known", () => {
  it.each(UNKNOWN_OUTCOMES)("re-reads the screen after %s", async (_name, answer) => {
    const { result, refresh } = setup({ PATCH: vi.fn(answer) }, DRAFT_HUV);

    await act(() => result.current.setHuvCompletionDate("2026-09-10"));

    expect(result.current.completionDateError).toMatch(/could not (be )?confirm/i);
    expect(result.current.completionDateSaving).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 422 refusal", refusal(422, "VALIDATION_FAILED")],
    ["a 409 M10_RECORD_BUSY (not applied)", refusal(409, "M10_RECORD_BUSY")],
  ])("re-reads nothing after %s", async (_name, answer) => {
    const { result, refresh } = setup({ PATCH: vi.fn(async () => answer) }, DRAFT_HUV);

    await act(() => result.current.setHuvCompletionDate("2026-09-10"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not re-read a screen the clinician has left", async () => {
    const write = pending<unknown>();
    const { result, unmount, refresh } = setup({ PATCH: vi.fn(() => write.promise) }, DRAFT_HUV);

    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.setHuvCompletionDate("2026-09-10");
    });
    unmount();
    await act(async () => {
      write.fail(new TypeError("Failed to fetch"));
      await saving;
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});
