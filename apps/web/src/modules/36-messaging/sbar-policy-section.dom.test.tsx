// M36 WP 3.3: the SBAR policy panel for a template manager. Tighten-only: the platform floor is the lowest value offered,
// the server's floor refusal is shown, and the panel is absent when the policy cannot be read (403 / flag off).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { SbarPolicySection } from "./sbar-policy-section";

const POLICY = {
  minChars: { situation: 20, background: 1, assessment: 1, recommendation: 1 },
  maxChars: 2000,
  requirePatientChannel: false,
  hints: {},
  customized: true,
};

function mount(get: unknown, write: () => unknown = () => ({ data: {}, error: undefined })) {
  const GET = vi.fn(() => Promise.resolve(get));
  const PUT = vi.fn(() => Promise.resolve(write()));
  const DELETE = vi.fn(() => Promise.resolve(write()));
  render(
    <ApiClientProvider client={{ GET, PUT, DELETE } as unknown as ApiClient}>
      <SbarPolicySection />
    </ApiClientProvider>,
  );
  return { GET, PUT, DELETE };
}

describe("SbarPolicySection", () => {
  it.each([403, 404])("renders nothing when the policy read answers %s", async (status) => {
    const { GET } = mount({ data: undefined, error: {}, response: { status } });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("form", { name: "SBAR policy" })).toBeNull();
  });

  it("shows the stored values with the platform floor as the minimum", async () => {
    mount({ data: POLICY, error: undefined });
    const form = await screen.findByRole("form", { name: "SBAR policy" });
    const situation = within(form).getByLabelText("Situation minimum length") as HTMLInputElement;
    expect(situation.value).toBe("20");
    expect(situation.min).toBe("1");
    expect(within(form).getByText(/You can raise this, not lower it/)).toBeTruthy();
  });

  it("saves minimums, the patient-channel requirement and hints", async () => {
    const { PUT } = mount({ data: POLICY, error: undefined });
    const form = await screen.findByRole("form", { name: "SBAR policy" });
    const background = within(form).getByLabelText("Background minimum length");
    await userEvent.clear(background);
    await userEvent.type(background, "40");
    await userEvent.type(within(form).getByLabelText("Assessment guidance"), "Your impression");
    await userEvent.click(within(form).getByRole("checkbox"));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(PUT).toHaveBeenCalledWith("/api/v1/messaging/template-admin/sbar-policy", {
      body: {
        minChars: { situation: 20, background: 40, assessment: 1, recommendation: 1 },
        requirePatientChannel: true,
        hints: { assessment: "Your impression" },
      },
    });
    await screen.findByText("SBAR policy saved.");
  });

  it("refuses a value under the floor on the client without calling the server", async () => {
    const { PUT } = mount({ data: POLICY, error: undefined });
    const form = await screen.findByRole("form", { name: "SBAR policy" });
    const situation = within(form).getByLabelText("Situation minimum length");
    await userEvent.clear(situation);
    await userEvent.type(situation, "0");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(PUT).not.toHaveBeenCalled();
    expect(await within(form).findByText(/You can raise this, not lower it/)).toBeTruthy();
  });

  it("shows the floor message when the server refuses with SBAR_POLICY_FLOOR_VIOLATION", async () => {
    mount({ data: POLICY, error: undefined }, () => ({
      data: undefined,
      error: { error: { code: "SBAR_POLICY_FLOOR_VIOLATION", message: "below floor" } },
      response: { status: 422 },
    }));
    const form = await screen.findByRole("form", { name: "SBAR policy" });
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    const alerts = await within(form).findAllByText(/You can raise this, not lower it/);
    expect(alerts.length).toBeGreaterThan(1);
  });

  it("resets to the platform defaults", async () => {
    const { DELETE } = mount({ data: POLICY, error: undefined });
    const form = await screen.findByRole("form", { name: "SBAR policy" });
    await userEvent.click(within(form).getByRole("button", { name: "Reset to platform defaults" }));
    await waitFor(() =>
      expect(DELETE).toHaveBeenCalledWith("/api/v1/messaging/template-admin/sbar-policy"),
    );
  });
});
