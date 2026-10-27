import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// Joining a visit refreshes the roster in the background. That refresh must NOT swap the page for the full-page
// spinner: doing so unmounts the live video iframe and remounts it (same participant token) when the load ends.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TelehealthRoom } from "../telehealth-room";

const ROW = {
  telehealthVisitId: "tv-1",
  m17VisitId: "v-1",
  patientId: "p-1",
  lifecycleState: "waiting",
  vendor: "daily_co",
  audioOnlyFallbackActive: false,
  visitStartedAt: null,
  visitEndedAt: null,
};
const TICKET = {
  vendor: "daily_co",
  vendorJoinUrl: "https://hospice.daily.co/room-1",
  vendorParticipantToken: "tok-1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("TelehealthRoom", () => {
  it("keeps the same video iframe mounted while the post-join refresh is in flight and after it lands", async () => {
    const refresh = deferred<{ data: { items: unknown[] }; error?: undefined }>();
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [ROW] }, error: undefined })
      .mockReturnValueOnce(refresh.promise);
    const post = vi.fn(async () => ({ data: TICKET, error: undefined }));
    render(
      <ApiClientProvider client={{ GET: get, POST: post } as unknown as ApiClient}>
        <TelehealthRoom />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    const frame = await screen.findByTitle("Video visit");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    // Refresh still in flight: the iframe must be the very same node, not a remount behind a spinner.
    expect(screen.getByTitle("Video visit")).toBe(frame);

    refresh.resolve({ data: { items: [ROW] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy());
    expect(screen.getByTitle("Video visit")).toBe(frame);
  });

  it("keeps the live room and reports inline when a refresh fails", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [ROW] }, error: undefined })
      .mockResolvedValueOnce({ data: undefined, error: { error: { code: "X" } } });
    const post = vi.fn(async () => ({ data: TICKET, error: undefined }));
    render(
      <ApiClientProvider client={{ GET: get, POST: post } as unknown as ApiClient}>
        <TelehealthRoom />
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    const frame = await screen.findByTitle("Video visit");
    await screen.findByText("The telehealth visit list could not be loaded.");
    expect(screen.getByTitle("Video visit")).toBe(frame);
  });
});
