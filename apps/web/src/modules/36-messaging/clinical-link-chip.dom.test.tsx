import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichBodyView } from "./rich-body-view";

// WP 3.2: the chip resolves read-through, says "unavailable" without saying why, links only to in-app paths, degrades to
// the plain placeholder when the tenant flag is off, aborts and ignores a superseded request.
afterEach(cleanup);

const ENTITY = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const AS_OF = "2026-10-14T12:00:00.000Z";
const body = {
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "clinicalLink", kind: "medication", entityId: ENTITY }],
      },
    ],
  },
} as never;
const links = [{ link_id: LINK_ID, kind: "medication", entity_id: ENTITY }];

function mount(get: unknown, clinicalLinks: typeof links | null = links) {
  const api = { GET: get } as unknown as ApiClient;
  return render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <RichBodyView
          bodyDoc={body}
          references={[]}
          fallbackText="[linked record]"
          clinicalLinks={clinicalLinks ?? undefined}
        />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}
const ok = (link: string) =>
  vi.fn().mockResolvedValue({
    data: {
      state: "ok",
      kind: "medication",
      status: "on_hold",
      occurred_at: null,
      as_of: AS_OF,
      link,
      patient_id: null,
    },
  });

describe("ClinicalLinkChip", () => {
  it("H-04: a medication link carries the fixed no-order line in every state", async () => {
    const line = "Messages can't change medications. Orders are entered in Orders.";
    mount(ok("/patients/p-1/medications"));
    expect(await screen.findByText(line)).toBeTruthy();
    cleanup();
    mount(vi.fn(), null);
    expect(screen.getByText(line)).toBeTruthy();
    cleanup();
    mount(vi.fn().mockResolvedValue({ error: {}, response: { status: 404 } }));
    await waitFor(() => expect(screen.getByText(line)).toBeTruthy());
  });

  it("shows kind, status and as-of, and links to the owning screen", async () => {
    const get = ok("/patients/p-1/medications");
    mount(get);

    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toBe("/patients/p-1/medications");
    expect(link.getAttribute("aria-label")).toMatch(/^Open linked Medication, on hold, as of /);
    expect(link.textContent).toContain("on hold");
    expect(get).toHaveBeenCalledWith("/api/v1/messaging/clinical-links/{linkId}/resolve", {
      params: { path: { linkId: LINK_ID } },
      signal: expect.any(AbortSignal),
    });
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it.each([
    "https://evil.example/x",
    "//evil.example/x",
    "javascript:alert(1)",
    "patients/p-1",
    "/\t/evil.com",
    "/\n/evil.com",
  ])("renders no anchor for the destination %s", async (link) => {
    mount(ok(link));

    const chip = await screen.findByLabelText(/^Linked Medication, on hold/);
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("tabindex")).toBe("0");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says Record unavailable without a reason, and stays keyboard reachable", async () => {
    mount(vi.fn().mockResolvedValue({ data: { state: "unavailable" } }));

    const chip = await screen.findByText("Record unavailable");
    await userEvent.tab();
    expect(document.activeElement).toBe(chip);
    expect(document.body.textContent).not.toMatch(/forbidden|permission|erased|deleted|denied/i);
  });

  it("shows a loading status, then a retryable alert on failure", async () => {
    let settle: (value: unknown) => void = () => {};
    const get = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      )
      .mockResolvedValueOnce({ data: { state: "unavailable" } });
    mount(get);

    expect((await screen.findByRole("status")).textContent).toMatch(/Loading linked medication/);
    await act(async () => settle({ data: undefined, error: {}, response: { status: 500 } }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Record unavailable")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("also treats a rejected request as an error", async () => {
    mount(vi.fn().mockRejectedValue(new Error("network")));

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("degrades to the plain placeholder when the flag is off (404)", async () => {
    mount(vi.fn().mockResolvedValue({ data: undefined, error: {}, response: { status: 404 } }));

    await waitFor(() => expect(screen.getByText("[linked record]")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the placeholder and makes no request when the message carries no link id", () => {
    const get = vi.fn();
    mount(get, null);

    expect(screen.getByText("[linked record]")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it("aborts the resolve request on unmount", async () => {
    const get = vi.fn().mockReturnValue(new Promise(() => {}));
    const view = mount(get);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const signal = (get.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);

    view.unmount();

    expect(signal.aborted).toBe(true);
  });

  it("does not let a superseded request overwrite the chip for the new link id", async () => {
    const OTHER_ID = "44444444-4444-4444-8444-444444444444";
    let settleFirst: (value: unknown) => void = () => {};
    const get = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({
        data: { state: "ok", status: "active", as_of: AS_OF, link: "/patients/p-2" },
      });
    const view = mount(get);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    view.rerender(
      <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
        <MemoryRouter>
          <RichBodyView
            bodyDoc={body}
            references={[]}
            fallbackText="[linked record]"
            clinicalLinks={[{ link_id: OTHER_ID, kind: "medication", entity_id: ENTITY }]}
          />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    expect((await screen.findByRole("link")).getAttribute("href")).toBe("/patients/p-2");

    await act(async () => settleFirst({ data: { state: "unavailable" } }));

    expect(screen.getByRole("link").getAttribute("href")).toBe("/patients/p-2");
    expect(screen.queryByText("Record unavailable")).toBeNull();
  });

  it("omits the as-of text when the server's timestamp is not a date", async () => {
    mount(
      vi.fn().mockResolvedValue({
        data: { state: "ok", status: "active", as_of: "not-a-date", link: "/patients/p-1" },
      }),
    );

    const link = await screen.findByRole("link");
    expect(link.textContent).not.toMatch(/Invalid Date|as of/);
    expect(link.getAttribute("aria-label")).toBe("Open linked Medication, active");
  });

  it("waits until the chip is on screen when IntersectionObserver exists", async () => {
    let notify: (entries: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const get = ok("/patients/p-1");
      mount(get);
      expect(get).not.toHaveBeenCalled();

      await act(async () => notify([{ isIntersecting: true }]));

      await screen.findByRole("link");
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
