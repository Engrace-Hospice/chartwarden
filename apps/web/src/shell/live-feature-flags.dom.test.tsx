// The shell loads the org's real flags so `useFeatureFlag` consumers (SBAR, clinical links, presence) are reachable.
import { render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider, useFeatureFlag } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { LiveFeatureFlagProvider } from "./live-feature-flags";
import { type Session, SessionProvider } from "./session";

const SESSION = { userId: "u1", organizationId: "org-1" } as Session;

function Probe(): JSX.Element {
  return <p>{useFeatureFlag("messaging.sbar") ? "sbar on" : "sbar off"}</p>;
}

function mount(
  GET: ReturnType<typeof vi.fn>,
  session: Session | null,
  flags?: Record<string, boolean>,
) {
  return render(
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>
      <SessionProvider session={session}>
        <LiveFeatureFlagProvider flags={flags}>
          <Probe />
        </LiveFeatureFlagProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("LiveFeatureFlagProvider", () => {
  it("loads the tenant flags once a session is bound to an organization", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { flags: { "messaging.sbar": true } } });
    mount(GET, SESSION);
    expect(screen.getByText("sbar off")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("sbar on")).toBeTruthy());
    expect(GET).toHaveBeenCalledWith("/api/v1/system/feature-flags");
  });

  it("reads nothing while signed out and keeps every flag off", () => {
    const GET = vi.fn();
    mount(GET, null);
    expect(GET).not.toHaveBeenCalled();
    expect(screen.getByText("sbar off")).toBeTruthy();
  });

  it("fails closed when the read fails", async () => {
    const GET = vi.fn().mockRejectedValue(new Error("network"));
    mount(GET, SESSION);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.getByText("sbar off")).toBeTruthy();
  });

  it("uses fixed flags without reading", () => {
    const GET = vi.fn();
    mount(GET, SESSION, { "messaging.sbar": true });
    expect(GET).not.toHaveBeenCalled();
    expect(screen.getByText("sbar on")).toBeTruthy();
  });
});
