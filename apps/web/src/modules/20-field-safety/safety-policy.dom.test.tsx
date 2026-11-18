// @vitest-environment jsdom
// Editing the safety policy writes a new immutable version, so it needs a reason; the form opens as a drawer in the
// detail rail beside the policy it changes (the redesign's pattern), not as a dialog over it. Cancel closes it and
// writes nothing; the save button stays disabled until the reason is long enough.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafetyPolicyView } from "./safety-api";
import { SafetyPolicyScreen } from "./safety-policy";

afterEach(cleanup);

const policy: SafetyPolicyView = {
  organizationId: "org-1",
  versionId: "pol-v3",
  effectiveFrom: "2026-09-19T20:17:00.000Z",
  effectiveTo: null,
  midVisitCadenceMinutes: 45,
  midVisitMinVisitDurationMinutes: 30,
  preVisitWindowMinutes: 15,
  postVisitWindowMinutes: 30,
  gentleReminderMinutes: 10,
  supervisorAlertMinutes: 20,
  escalationMinutes: 35,
  sosEquivalentMinutes: 60,
  sosCancelWindowSeconds: 5,
  sosCancelRequiresBiometric: false,
  sosContinuousLocationEnabled: true,
  sosContinuousLocationSampleSeconds: 30,
  sosContinuousLocationMaxDurationHours: 4,
  sosTier1SlaSeconds: 60,
  sosTier2SlaSeconds: 180,
  sosTier3SlaSeconds: 300,
  subscriptionModel: "explicit_only",
  afterHoursStartHour: 18,
  afterHoursEndHour: 7,
  oshaReportableAutoFlagCategories: ["physical_assault"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { patch: ReturnType<typeof vi.fn> } {
  const patch = vi.fn(async () => ok(policy));
  const client = {
    GET: vi.fn(async () => ok(policy)),
    PATCH: patch,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SafetyPolicyScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { patch };
}

const REASON = "Raised the mid-visit cadence after the spring review of overdue pages.";
const openEditor = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: "Edit policy" }));
  return screen.findByRole("complementary", { name: "Edit the safety policy" });
};

describe("safety policy — edit the policy", () => {
  it("opens the editor as a drawer beside the policy, not a dialog over it", async () => {
    mount();
    const drawer = await openEditor();
    expect(within(drawer).getByLabelText("Why are you changing this?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The version in force stays on the page while the editor is open.
    expect(screen.getByText("Tenant safety defaults")).toBeTruthy();
  });

  it("starts from the version in force", async () => {
    mount();
    const drawer = await openEditor();
    expect((within(drawer).getByLabelText(/^Mid-visit cadence/) as HTMLInputElement).value).toBe(
      "45",
    );
    expect(
      (within(drawer).getByLabelText("After-hours starts at (hour, 0-23)") as HTMLInputElement)
        .value,
    ).toBe("18");
  });

  it("closes from Cancel without writing a new version", async () => {
    const { patch } = mount();
    const drawer = await openEditor();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit the safety policy" })).toBeNull(),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps Save new version disabled until the reason is long enough", async () => {
    mount();
    const drawer = await openEditor();
    const save = within(drawer).getByRole("button", {
      name: "Save new version",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Why are you changing this?"), {
      target: { value: "too short" },
    });
    expect(save.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Why are you changing this?"), {
      target: { value: REASON },
    });
    expect(save.disabled).toBe(false);
  });

  it("writes the new version with the reason and closes the drawer", async () => {
    const { patch } = mount();
    const drawer = await openEditor();
    fireEvent.change(within(drawer).getByLabelText(/^Mid-visit cadence/), {
      target: { value: "50" },
    });
    fireEvent.change(within(drawer).getByLabelText("Why are you changing this?"), {
      target: { value: REASON },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const call = patch.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/safety/policy");
    expect(call[1].body).toMatchObject({ editReason: REASON, midVisitCadenceMinutes: 50 });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit the safety policy" })).toBeNull(),
    );
  });
});
