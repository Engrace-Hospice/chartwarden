// apps/admin/src/modules/34-saas-platform — the `useSlugAvailability` hook on its own: answers that arrive out of order, an
// unmounted form, and the two checking modes (a typed slug is checked after a short pause; a slug still FOLLOWING the legal
// name is checked only once the operator leaves that field). Every probe is an audited platform read, so how often the hook
// asks is part of its contract. The drawer-level behaviour is in tenant-provision.dom.test.tsx.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLUG_CHECK_DEBOUNCE_MS, type SlugStatus, useSlugAvailability } from "./slug-field";

const AVAILABILITY_PATH = /^\/api\/v1\/platform\/tenant-slugs\/([^/]+)\/availability$/;

interface PendingProbe {
  slug: string;
  /** Answer this probe, whenever the test decides (the mock ignores abort, like a response already on the wire). */
  respond: (body: Record<string, unknown>) => void;
}

/** A client whose probes stay pending until the test answers them, in any order. */
function deferredClient() {
  const probes: PendingProbe[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const slug = decodeURIComponent(AVAILABILITY_PATH.exec(new URL(req.url).pathname)?.[1] ?? "");
      return new Promise<Response>((resolve) => {
        probes.push({
          slug,
          respond: (body) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
        });
      });
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return { probes, wrapper };
}

const free = (slug: string) => ({
  slug,
  valid: true,
  available: true,
  url: `https://${slug}.chartwarden.cloud`,
});
const taken = (slug: string) => ({ slug, valid: true, available: false, reason: "taken" });

/** Let the debounce elapse and the resulting effect (and any resolved promise) run. */
const settle = (ms = SLUG_CHECK_DEBOUNCE_MS) => act(async () => void vi.advanceTimersByTime(ms));
const flush = () =>
  act(async () => {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSlugAvailability", () => {
  const typed = (slug: string) => ({ slug, following: false });
  const mountHook = (wrapper: ReturnType<typeof deferredClient>["wrapper"], slug: string) =>
    renderHook(({ slug: s, following }) => useSlugAvailability(s, following), {
      wrapper,
      initialProps: typed(slug),
    });

  it("an older answer that arrives after a newer one does not win", async () => {
    const { probes, wrapper } = deferredClient();
    const hook = mountHook(wrapper, "alpha");
    await settle();
    hook.rerender(typed("beta"));
    await settle();
    expect(probes.map((p) => p.slug)).toEqual(["alpha", "beta"]);

    await act(async () => probes[1]?.respond(free("beta")));
    await flush();
    expect(hook.result.current.status).toEqual({
      kind: "available",
      url: "https://beta.chartwarden.cloud",
    });

    await act(async () => probes[0]?.respond(taken("alpha")));
    await flush();
    expect(hook.result.current.status).toEqual({
      kind: "available",
      url: "https://beta.chartwarden.cloud",
    });
  });

  it("never shows the answer for a value the operator has already changed away from", async () => {
    const { probes, wrapper } = deferredClient();
    const hook = mountHook(wrapper, "alpha");
    await settle();
    hook.rerender(typed("beta"));
    await settle();

    await act(async () => probes[0]?.respond(taken("alpha")));
    await flush();

    expect(hook.result.current.status).toEqual<SlugStatus>({ kind: "checking" });
  });

  it("cancels the probe still in flight when the slug changes, and when the form unmounts", async () => {
    // jsdom's AbortSignal does not propagate into the Request the client builds, so the abort itself is what is observed.
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const { wrapper } = deferredClient();
    const hook = mountHook(wrapper, "alpha");
    await settle();
    expect(abort).not.toHaveBeenCalled();

    hook.rerender(typed("beta"));
    await settle();
    expect(abort).toHaveBeenCalledTimes(1);

    hook.unmount();
    expect(abort).toHaveBeenCalledTimes(2);
    abort.mockRestore();
  });

  it("a typed slug is checked once, after the debounce, whatever was typed on the way", async () => {
    const { probes, wrapper } = deferredClient();
    const hook = mountHook(wrapper, "s");
    for (const slug of ["su", "sun", "sunr", "sunri", "sunrise"]) {
      hook.rerender(typed(slug));
      await settle(SLUG_CHECK_DEBOUNCE_MS - 1);
    }
    expect(probes).toHaveLength(0);

    await settle(1);

    expect(probes.map((p) => p.slug)).toEqual(["sunrise"]);
  });

  describe("while the slug follows the legal name", () => {
    const following = (slug: string) => ({ slug, following: true });
    const mountFollowing = (wrapper: ReturnType<typeof deferredClient>["wrapper"], slug: string) =>
      renderHook(({ slug: s, following: f }) => useSlugAvailability(s, f), {
        wrapper,
        initialProps: following(slug),
      });

    it("asks nothing as the name settles, however long the pause", async () => {
      const { probes, wrapper } = deferredClient();
      const hook = mountFollowing(wrapper, "cedar");
      hook.rerender(following("cedar-ridge"));

      await settle(60_000);

      expect(probes).toHaveLength(0);
      expect(hook.result.current.status).toEqual<SlugStatus>({ kind: "idle" });
    });

    it("asks once, for the value then showing, when the operator leaves the legal name", async () => {
      const { probes, wrapper } = deferredClient();
      const hook = mountFollowing(wrapper, "cedar");
      hook.rerender(following("cedar-ridge"));

      act(() => hook.result.current.checkSuggestion());
      await flush();

      expect(probes.map((p) => p.slug)).toEqual(["cedar-ridge"]);
      expect(hook.result.current.status).toEqual<SlugStatus>({ kind: "checking" });
      await act(async () => probes[0]?.respond(free("cedar-ridge")));
      await flush();
      expect(hook.result.current.status).toMatchObject({ kind: "available" });
    });

    it("drops a verdict once the name changes again, until the next time the field is left", async () => {
      const { probes, wrapper } = deferredClient();
      const hook = mountFollowing(wrapper, "cedar");
      act(() => hook.result.current.checkSuggestion());
      await flush();
      await act(async () => probes[0]?.respond(taken("cedar")));
      await flush();
      expect(hook.result.current.status).toEqual<SlugStatus>({ kind: "taken" });

      hook.rerender(following("cedar-ridge"));
      await settle(60_000);

      expect(hook.result.current.status).toEqual<SlugStatus>({ kind: "idle" });
      expect(probes).toHaveLength(1);
    });

    it("still refuses a malformed or reserved suggestion locally, with no request", async () => {
      const { probes, wrapper } = deferredClient();
      const hook = mountFollowing(wrapper, "admin");
      act(() => hook.result.current.checkSuggestion());

      await settle();

      expect(hook.result.current.status).toEqual<SlugStatus>({
        kind: "invalid",
        reason: "reserved",
      });
      expect(probes).toHaveLength(0);
    });

    it("hands back to the short debounce as soon as the operator types a slug of their own", async () => {
      const { probes, wrapper } = deferredClient();
      const hook = mountFollowing(wrapper, "cedar-ridge");

      hook.rerender(typed("my-own"));
      await settle();

      expect(probes.map((p) => p.slug)).toEqual(["my-own"]);
    });
  });
});
