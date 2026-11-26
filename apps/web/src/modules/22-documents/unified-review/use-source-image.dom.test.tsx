import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overrideImageProperty } from "./review-test-support";
import { useSourceImage } from "./use-source-image";
import type { SourceImageOptions } from "./use-source-image";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type ProbeOutcome = number | "network" | "pending";

const probes: { url: string; method: string | undefined }[] = [];
const waiting: ((response: Response) => void)[] = [];

function stubProbe(outcome: ProbeOutcome): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      probes.push({ url: input, method: init?.method });
      if (outcome === "network") throw new TypeError("Failed to fetch");
      if (outcome === "pending")
        return await new Promise<Response>((resolve) => {
          waiting.push(resolve);
        });
      return new Response(null, { status: outcome });
    }),
  );
}

function Probe(options: Partial<SourceImageOptions> & { resetKey: string }): JSX.Element {
  const source = useSourceImage({ batchId: BATCH, page: 1, withheld: false, ...options });
  return (
    <div>
      <output data-testid="state">{source.state}</output>
      <output data-testid="width">{String(source.naturalWidth)}</output>
      <output data-testid="key">{source.imageKey}</output>
      {source.src ? (
        <img
          ref={source.imageRef}
          key={source.imageKey}
          src={source.src}
          alt="synthetic page"
          onLoad={source.onLoad}
          onError={source.onError}
        />
      ) : null}
      <button type="button" onClick={source.retry}>
        retry
      </button>
    </div>
  );
}

const state = (): string => screen.getByTestId("state").textContent ?? "";

afterEach(() => {
  probes.length = 0;
  waiting.length = 0;
  vi.unstubAllGlobals();
});

describe("useSourceImage", () => {
  it("is loading until the image loads, then ready with its natural width", () => {
    const onAvailabilityChange = vi.fn();
    render(<Probe resetKey="a" onAvailabilityChange={onAvailabilityChange} />);
    expect(state()).toBe("loading");

    const image = screen.getByRole("img");
    Object.defineProperty(image, "naturalWidth", { value: 900, configurable: true });
    fireEvent.load(image);

    expect(state()).toBe("ready");
    expect(screen.getByTestId("width").textContent).toBe("900");
    expect(onAvailabilityChange).toHaveBeenCalledWith(1, false);
  });

  it("treats an image that was already complete when it mounted as ready", () => {
    const restoreComplete = overrideImageProperty("complete", true);
    const restoreWidth = overrideImageProperty("naturalWidth", 640);
    try {
      render(<Probe resetKey="a" />);

      expect(state()).toBe("ready");
      expect(screen.getByTestId("width").textContent).toBe("640");
    } finally {
      restoreWidth();
      restoreComplete();
    }
  });

  it("requests the page image URL with a HEAD probe after an error", async () => {
    stubProbe(503);
    render(<Probe resetKey="a" />);

    fireEvent.error(screen.getByRole("img"));

    await waitFor(() => expect(state()).toBe("unavailable"));
    expect(probes).toEqual([
      { url: `/api/v1/intake/uploads/${BATCH}/pages/1/image`, method: "HEAD" },
    ]);
  });

  it.each([
    [403, "forbidden"],
    [401, "expired"],
    [500, "unavailable"],
    ["network", "unavailable"],
  ] as const)("reads a %s answer as %s", async (outcome, expected) => {
    stubProbe(outcome);
    const onAvailabilityChange = vi.fn();
    render(<Probe resetKey="a" onAvailabilityChange={onAvailabilityChange} />);

    fireEvent.error(screen.getByRole("img"));

    await waitFor(() => expect(state()).toBe(expected));
    expect(onAvailabilityChange).toHaveBeenCalledWith(1, true);
  });

  it("starts a fresh load on retry", async () => {
    stubProbe(503);
    render(<Probe resetKey="a" />);
    fireEvent.error(screen.getByRole("img"));
    await waitFor(() => expect(state()).toBe("unavailable"));
    const before = screen.getByTestId("key").textContent;

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    expect(state()).toBe("loading");
    expect(screen.getByTestId("key").textContent).not.toBe(before);
  });

  it("forgets what it knew when what is on screen changes, even on a return to an earlier image", () => {
    const { rerender } = render(<Probe resetKey="a" />);
    fireEvent.load(screen.getByRole("img"));
    expect(state()).toBe("ready");

    rerender(<Probe resetKey="b" />);
    expect(state()).toBe("loading");

    rerender(<Probe resetKey="a" />);
    expect(state()).toBe("loading");
  });

  it("drops a probe answer that arrives after the image changed", async () => {
    stubProbe("pending");
    const onAvailabilityChange = vi.fn();
    const { rerender } = render(<Probe resetKey="a" onAvailabilityChange={onAvailabilityChange} />);
    fireEvent.error(screen.getByRole("img"));
    await waitFor(() => expect(probes).toHaveLength(1));

    rerender(<Probe resetKey="b" onAvailabilityChange={onAvailabilityChange} />);
    for (const release of waiting.splice(0)) release(new Response(null, { status: 503 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state()).toBe("loading");
    expect(onAvailabilityChange).not.toHaveBeenCalled();
  });

  it("drops a probe answer that arrives after it unmounted", async () => {
    stubProbe("pending");
    const onAvailabilityChange = vi.fn();
    const { unmount } = render(<Probe resetKey="a" onAvailabilityChange={onAvailabilityChange} />);
    fireEvent.error(screen.getByRole("img"));
    await waitFor(() => expect(probes).toHaveLength(1));

    unmount();
    for (const release of waiting.splice(0)) release(new Response(null, { status: 503 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAvailabilityChange).not.toHaveBeenCalled();
  });

  it("reads withheld content as restricted and never reports availability for it", () => {
    const onAvailabilityChange = vi.fn();
    const restoreComplete = overrideImageProperty("complete", true);
    const restoreWidth = overrideImageProperty("naturalWidth", 640);
    try {
      render(<Probe resetKey="a" withheld onAvailabilityChange={onAvailabilityChange} />);

      expect(state()).toBe("forbidden");
      expect(onAvailabilityChange).not.toHaveBeenCalled();
    } finally {
      restoreWidth();
      restoreComplete();
    }
  });

  it("requests nothing when there is no page", () => {
    render(<Probe resetKey="a" page={null} />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(state()).toBe("loading");
  });

  it("uses the support-session URL in a support session", async () => {
    stubProbe(503);
    render(
      <Probe resetKey="a" access={{ organizationId: "org-1", supportSessionId: "support-1" }} />,
    );

    fireEvent.error(screen.getByRole("img"));

    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0]?.url).toBe(
      `/api/v1/platform/organizations/org-1/intake/uploads/${BATCH}/pages/1/image?supportSessionId=support-1`,
    );
  });
});
