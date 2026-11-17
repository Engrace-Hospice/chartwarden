// @vitest-environment jsdom
import type { ApiClient } from "@chartwarden/ui";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { useHopeRecordActions } from "../use-hope-record-actions";
import { SESSION, ok } from "./workspace-test-kit";

// The re-read that follows a stale-version refusal must not run on a screen the clinician has already left, whichever
// write was refused. (The inactivation case is covered in use-hope-record-actions.dom.test.tsx; the correction's own
// guard, in the `finally` after a lookup that may take a while, was not.)

const ASSESSMENT = {
  status: "signed",
  version: 7,
  targetDate: "2026-09-08T00:00:00.000Z",
  rfaKind: "01_admission",
  patientId: "patient-1",
};
const KNOWN_ROWS = [{ id: "hope-1", status: "signed", correctsAssessmentId: null }];

const refusal = (status: number) => ({
  data: undefined,
  error: { error: { code: "CONFLICT", message: "This record changed." } },
  response: new Response(null, { status }),
});

/** A request whose answer the test releases by hand. */
function pending<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup(api: { GET: unknown; POST: unknown }) {
  const refresh = vi.fn(async () => true);
  const navigate = vi.fn();
  const setTimeline = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionProvider session={SESSION}>{children}</SessionProvider>
  );
  const hook = renderHook(
    () =>
      useHopeRecordActions({
        api: { PATCH: vi.fn(), ...api } as never,
        client: {} as ApiClient,
        id: "hope-1",
        assessment: ASSESSMENT,
        workspaceVersion: 7,
        timeline: KNOWN_ROWS,
        setTimeline,
        refresh,
        setSaving: vi.fn(),
        closeInactivation: vi.fn(),
        navigate,
      }),
    { wrapper },
  );
  return { ...hook, refresh, navigate, setTimeline };
}

describe("creating a correction that the server refuses as stale", () => {
  it("re-reads the screen when the clinician is still on it", async () => {
    const { result, refresh } = setup({
      GET: vi.fn(async () => ok({ assessments: KNOWN_ROWS })),
      POST: vi.fn(async () => refusal(409)),
    });

    await act(() => result.current.createCorrection("Wrong date", "RN"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not re-read a screen that was left while the timeline lookup was out", async () => {
    const lookup = pending<unknown>();
    const { result, unmount, refresh, setTimeline, navigate } = setup({
      GET: vi.fn(() => lookup.promise),
      POST: vi.fn(async () => refusal(409)),
    });

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.createCorrection("Wrong date", "RN");
    });
    // The 409 has landed (the conflict is noted); only the lookup that follows it is still out.
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      lookup.release(ok({ assessments: KNOWN_ROWS }));
      await creating;
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(setTimeline).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
