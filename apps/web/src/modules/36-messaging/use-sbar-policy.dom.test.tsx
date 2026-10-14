// M36 WP 3.3: the SBAR policy read retries a transient failure (network error / 5xx) with bounded backoff and never
// retries a refusal (403/404) or an unreadable body.
import { act, renderHook } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY_RETRY_DELAYS_MS, useSbarPolicy } from "./use-sbar-policy";

const POLICY = {
  minChars: { situation: 1, background: 1, assessment: 1, recommendation: 1 },
  maxChars: 2000,
  requirePatientChannel: false,
  hints: {},
  customized: false,
};
const ok = { data: POLICY, error: undefined, response: { status: 200 } };
const status = (code: number) => ({ data: undefined, error: {}, response: { status: code } });

function setup(answers: Array<() => Promise<unknown>>, active = true) {
  const GET = vi.fn();
  for (const answer of answers) GET.mockImplementationOnce(answer);
  GET.mockImplementation(answers[answers.length - 1] as () => Promise<unknown>);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>{children}</ApiClientProvider>
  );
  const view = renderHook(() => useSbarPolicy(active), { wrapper });
  return { GET, ...view };
}
const resolve = (value: unknown) => () => Promise.resolve(value);
const reject = () => Promise.reject(new Error("network"));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("useSbarPolicy retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ["a network error", reject],
    ["a 5xx", resolve(status(503))],
  ])("recovers after %s", async (_name, fail) => {
    const { GET, result } = setup([fail, resolve(ok)]);
    await advance(0);
    expect(result.current.status).toBe("transient");
    await advance(POLICY_RETRY_DELAYS_MS[0]);
    expect(result.current.status).toBe("ready");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404])("never retries a %s", async (code) => {
    const { GET, result } = setup([resolve(status(code))]);
    await advance(60_000);
    expect(result.current.status).toBe(code === 403 ? "forbidden" : "unavailable");
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a malformed body without retrying", async () => {
    const { GET, result } = setup([resolve({ data: { minChars: 5 }, response: { status: 200 } })]);
    await advance(60_000);
    expect(result.current.status).toBe("unavailable");
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("stops at the retry cap", async () => {
    const { GET, result } = setup([resolve(status(500))]);
    await advance(60_000);
    expect(GET).toHaveBeenCalledTimes(1 + POLICY_RETRY_DELAYS_MS.length);
    expect(result.current.status).toBe("transient");
  });

  it("stops retrying after unmount", async () => {
    const { GET, unmount } = setup([resolve(status(500))]);
    await advance(0);
    unmount();
    await advance(60_000);
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("reload after the cap reads again and can recover", async () => {
    const { GET, result } = setup([resolve(status(500))]);
    await advance(60_000);
    GET.mockImplementation(resolve(ok));
    act(() => result.current.reload());
    await advance(0);
    expect(result.current.status).toBe("ready");
  });
});
