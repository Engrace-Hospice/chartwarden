// @vitest-environment jsdom
import type { ApiClient } from "@chartwarden/ui";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { useHopeRecordActions } from "../use-hope-record-actions";
import { SESSION, ok } from "./workspace-test-kit";

// Group g1: a 409 M10_RECORD_BUSY on a record write is a lock wait that timed out and the step was NOT applied: the version this page
// holds is not stale, so it is neither re-read nor called a conflict. Any other 409 is (the pair is told apart by the code alone).

const SIGNED = {
  status: "signed",
  version: 7,
  targetDate: "2026-09-08T00:00:00.000Z",
  rfaKind: "01_admission",
  patientId: "patient-1",
};
const DRAFT_HUV = { ...SIGNED, status: "draft", rfaKind: "02_huv1" };
const ROWS = [{ id: "hope-1", status: "signed", correctsAssessmentId: null }];

const refused409 = (code: string) => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status: 409 }),
});

function setup(api: { POST?: unknown; PATCH?: unknown }, assessment: typeof SIGNED = SIGNED) {
  const refresh = vi.fn(async () => true);
  const setSaving = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionProvider session={SESSION}>{children}</SessionProvider>
  );
  const hook = renderHook(
    () =>
      useHopeRecordActions({
        api: {
          GET: vi.fn(async () => ok({ assessments: ROWS })),
          PATCH: vi.fn(),
          POST: vi.fn(),
          ...api,
        } as never,
        client: {} as ApiClient,
        id: "hope-1",
        assessment,
        workspaceVersion: 7,
        timeline: ROWS,
        setTimeline: vi.fn(),
        refresh,
        setSaving,
        closeInactivation: vi.fn(),
        navigate: vi.fn(),
      }),
    { wrapper },
  );
  return { ...hook, refresh, setSaving };
}

describe("a record write answered 409 M10_RECORD_BUSY", () => {
  it("does not re-read the page after a correction, and shows the server's words", async () => {
    const { result, refresh } = setup({ POST: vi.fn(async () => refused409("M10_RECORD_BUSY")) });
    await act(() => result.current.createCorrection("Wrong date", "RN"));
    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.correctionError).toBe("server words for M10_RECORD_BUSY");
    expect(result.current.correcting).toBe(false);
  });

  it("does not re-read the page after an inactivation", async () => {
    const { result, refresh } = setup({ POST: vi.fn(async () => refused409("M10_RECORD_BUSY")) });
    await act(() => result.current.createInactivation("Entered in error", "RN"));
    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.inactivationError).toBe("server words for M10_RECORD_BUSY");
    expect(result.current.inactivating).toBe(false);
  });

  it("does not call a HUV completion date a conflict, and does not re-read", async () => {
    const { result, refresh, setSaving } = setup(
      { PATCH: vi.fn(async () => refused409("M10_RECORD_BUSY")) },
      DRAFT_HUV,
    );
    await act(() => result.current.setHuvCompletionDate("2026-09-08"));
    expect(refresh).not.toHaveBeenCalled();
    expect(setSaving).toHaveBeenCalledWith("failed");
    expect(setSaving).not.toHaveBeenCalledWith("conflict");
    expect(result.current.completionDateError).toBe("server words for M10_RECORD_BUSY");
  });
});

describe("a record write answered with any other 409", () => {
  it("still re-reads the page after a correction, an inactivation and a HUV completion date", async () => {
    const stale = vi.fn(async () => refused409("CONFLICT"));
    const correction = setup({ POST: stale });
    await act(() => correction.result.current.createCorrection("Wrong date", "RN"));
    expect(correction.refresh).toHaveBeenCalledTimes(1);

    const inactivation = setup({ POST: stale });
    await act(() => inactivation.result.current.createInactivation("Entered in error", "RN"));
    expect(inactivation.refresh).toHaveBeenCalledTimes(1);

    const huv = setup({ PATCH: stale }, DRAFT_HUV);
    await act(() => huv.result.current.setHuvCompletionDate("2026-09-08"));
    expect(huv.refresh).toHaveBeenCalledTimes(1);
    expect(huv.setSaving).toHaveBeenCalledWith("conflict");
  });
});
