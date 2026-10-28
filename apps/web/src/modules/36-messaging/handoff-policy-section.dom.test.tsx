import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.5: the handoff expiry control. Tighten-only (platform maximum shown, range enforced before sending), hidden
// when the policy cannot be read, with save and reset to the platform default.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HandoffPolicySection } from "./handoff-policy-section";

const POLICY = { expiry_minutes: 120, platform_max_minutes: 240, customised: true };

function mount(get: unknown, write: unknown = { data: POLICY, response: { status: 200 } }) {
  const GET = vi.fn().mockResolvedValue(get);
  const PUT = vi.fn().mockResolvedValue(write);
  const DELETE = vi.fn().mockResolvedValue(write);
  render(
    <ApiClientProvider client={{ GET, PUT, DELETE } as unknown as ApiClient}>
      <HandoffPolicySection />
    </ApiClientProvider>,
  );
  return { GET, PUT, DELETE };
}

describe("HandoffPolicySection", () => {
  it.each([403, 404])("renders nothing when the policy read answers %s", async (status) => {
    const { GET } = mount({ error: {}, response: { status } });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("form", { name: "Handoff policy" })).toBeNull();
  });

  it("shows the stored minutes and the platform maximum", async () => {
    mount({ data: POLICY });
    const form = await screen.findByRole("form", { name: "Handoff policy" });
    const input = within(form).getByLabelText(
      "Minutes before an offer expires",
    ) as HTMLInputElement;
    expect(input.value).toBe("120");
    expect(input.max).toBe("240");
    expect(within(form).getByText(/platform maximum is 240 minutes/)).toBeTruthy();
  });

  it("refuses a longer value without sending it", async () => {
    const { PUT } = mount({ data: POLICY });
    const input = await screen.findByLabelText("Minutes before an offer expires");
    await userEvent.clear(input);
    await userEvent.type(input, "300");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/from 15 to 240/)).toBeTruthy();
    expect(PUT).not.toHaveBeenCalled();
  });

  it("saves a shorter expiry and announces it", async () => {
    const { PUT } = mount({ data: POLICY });
    const input = await screen.findByLabelText("Minutes before an offer expires");
    await userEvent.clear(input);
    await userEvent.type(input, "60");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(PUT).toHaveBeenCalledWith("/api/v1/messaging/template-admin/handoff-policy", {
        body: { expiry_minutes: 60 },
      }),
    );
    expect(await screen.findByText("Handoff policy saved.")).toBeTruthy();
  });

  it("resets to the platform default", async () => {
    const { DELETE } = mount({ data: POLICY });
    await userEvent.click(await screen.findByRole("button", { name: "Reset to platform default" }));
    await waitFor(() =>
      expect(DELETE).toHaveBeenCalledWith("/api/v1/messaging/template-admin/handoff-policy"),
    );
  });

  it("shows the server's refusal as text", async () => {
    mount(
      { data: POLICY },
      { error: { error: { code: "HANDOFF_POLICY_INVALID" } }, response: { status: 422 } },
    );
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText(/whole number of minutes/)).toBeTruthy();
  });
});
