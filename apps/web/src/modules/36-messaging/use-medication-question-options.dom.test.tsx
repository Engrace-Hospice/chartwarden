import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.10: the options read fails closed and ignores a late answer for a channel the person has left.
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { optionsAnswer } from "./medication-question-test-fixture";
import { useMedicationQuestionOptions } from "./use-medication-question-options";

const wrap = (GET: ReturnType<typeof vi.fn>) => {
  const client = { GET } as unknown as ApiClient;
  return ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
};

describe("useMedicationQuestionOptions", () => {
  it("is ready when the route says enabled and patient-linked", async () => {
    const GET = vi.fn().mockResolvedValue(optionsAnswer());
    const { result } = renderHook(() => useMedicationQuestionOptions("c1", false), {
      wrapper: wrap(GET),
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it.each([
    ["enabled:false", { data: { enabled: false } }],
    ["not patient-linked", optionsAnswer({ patient_linked: false })],
    ["a 403/404 (no data)", { error: {}, response: { status: 404 } }],
  ])("stays hidden on %s", async (_name, answer) => {
    const GET = vi.fn().mockResolvedValue(answer);
    const { result } = renderHook(() => useMedicationQuestionOptions("c1", false), {
      wrapper: wrap(GET),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.status).toBe("hidden");
  });

  it("stays hidden when the client throws", async () => {
    const GET = vi.fn(() => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useMedicationQuestionOptions("c1", false), {
      wrapper: wrap(GET),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.status).toBe("hidden");
  });

  it("reads nothing when skipped", () => {
    const GET = vi.fn();
    renderHook(() => useMedicationQuestionOptions("c1", true), { wrapper: wrap(GET) });
    expect(GET).not.toHaveBeenCalled();
  });

  it("drops a late answer for the channel that was left", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const GET = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ data: { enabled: false } });
    const { result, rerender } = renderHook(({ id }) => useMedicationQuestionOptions(id, false), {
      wrapper: wrap(GET),
      initialProps: { id: "c1" },
    });
    rerender({ id: "c2" });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    resolveFirst(optionsAnswer());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.status).toBe("hidden");
  });

  it("never returns the previous channel's options for the new channel", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce(optionsAnswer())
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ id }) => useMedicationQuestionOptions(id, false), {
      wrapper: wrap(GET),
      initialProps: { id: "c1" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ id: "c2" });
    expect(result.current.status).toBe("hidden");
  });
});
