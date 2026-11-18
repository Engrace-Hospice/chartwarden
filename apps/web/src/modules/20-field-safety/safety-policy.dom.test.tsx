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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// The version in force before `policy` replaced it: what a replay of an earlier instant answers.
const pastPolicy: SafetyPolicyView = {
  ...policy,
  versionId: "pol-v2",
  effectiveTo: "2026-09-19T20:17:00.000Z",
  midVisitCadenceMinutes: 60,
};

function mount(
  opts: {
    patch?: () => Promise<unknown>;
    read?: (asOf: string | undefined) => Promise<unknown>;
  } = {},
): {
  patch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const patch = vi.fn(opts.patch ?? (async () => ok(policy)));
  const get = vi.fn(async (_path: string, init?: { params?: { query?: { asOf?: string } } }) =>
    opts.read ? opts.read(init?.params?.query?.asOf) : ok(policy),
  );
  const client = { GET: get, PATCH: patch } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SafetyPolicyScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { patch, get };
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

describe("safety policy — replay beside the editor, and a write that fails", () => {
  const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const pickInstant = async (): Promise<void> => {
    fireEvent.change(await screen.findByLabelText("Read the policy as it stood at"), {
      target: { value: "2026-10-01T09:00" },
    });
  };
  const saveWith = (drawer: HTMLElement): void => {
    fireEvent.change(within(drawer).getByLabelText("Why are you changing this?"), {
      target: { value: REASON },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save new version" }));
  };

  it("disables the replay controls while the editor is open", async () => {
    mount();
    await pickInstant();
    expect(button("Time-travel").disabled).toBe(false);
    const drawer = await openEditor();
    expect(button("Time-travel").disabled).toBe(true);
    expect(button("Back to current").disabled).toBe(true);
    expect(
      (screen.getByLabelText("Read the policy as it stood at") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(button("Time-travel").disabled).toBe(false));
    expect(button("Back to current").disabled).toBe(false);
  });

  it("cannot open the editor, and so cannot save, once a replay is showing", async () => {
    const { patch } = mount();
    await pickInstant();
    fireEvent.click(button("Time-travel"));
    await screen.findByText(/Historical view for/);
    expect(button("Edit policy").disabled).toBe(true);
    fireEvent.click(button("Edit policy"));
    expect(screen.queryByRole("complementary", { name: "Edit the safety policy" })).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it("makes the page inert while the new version is being written, then live again", async () => {
    const write = deferred<unknown>();
    mount({ patch: () => write.promise });
    const drawer = await openEditor();
    const timeTravel = button("Time-travel");
    saveWith(drawer);
    await waitFor(() => expect(isInert(timeTravel)).toBe(true));
    expect(isInert(button("Back to current"))).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "Safety board" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok(policy));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit the safety policy" })).toBeNull(),
    );
    expect(isInert(timeTravel)).toBe(false);
  });

  it("recovers when the new version's request is rejected by the network", async () => {
    mount({
      patch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await openEditor();
    saveWith(drawer);
    // The drawer's own warning is also an alert, so find the failure by its words.
    const failure = await within(drawer).findByText(/No answer came back/);
    expect(failure.getAttribute("role")).toBe("alert");
    expect(
      (within(drawer).getByRole("button", { name: "Save new version" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("safety policy — which version the screen holds", () => {
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const pickInstant = async (): Promise<void> => {
    fireEvent.change(await screen.findByLabelText("Read the policy as it stood at"), {
      target: { value: "2026-10-01T09:00" },
    });
  };

  it("cannot open the editor between Back to current and its read landing", async () => {
    const back = deferred<unknown>();
    let currentReads = 0;
    const { patch } = mount({
      read: (asOf) => {
        if (asOf) return Promise.resolve(ok(pastPolicy));
        currentReads += 1;
        return currentReads === 1 ? Promise.resolve(ok(policy)) : back.promise;
      },
    });
    await pickInstant();
    fireEvent.click(button("Time-travel"));
    await screen.findByText(/Version pol-v2 in force/);
    fireEvent.click(button("Back to current"));
    // The toggle is already off, but the screen still holds the past version until the read lands.
    await waitFor(() => expect(screen.queryByText(/Historical view for/)).toBeNull());
    expect(screen.getByText(/Version pol-v2 in force/)).toBeTruthy();
    expect(button("Edit policy").disabled).toBe(true);
    fireEvent.click(button("Edit policy"));
    expect(screen.queryByRole("complementary", { name: "Edit the safety policy" })).toBeNull();
    back.resolve(ok(policy));
    await screen.findByText(/Version pol-v3 in force/);
    await waitFor(() => expect(button("Edit policy").disabled).toBe(false));
    expect(patch).not.toHaveBeenCalled();
  });

  it("ignores a replay read that lands after Back to current", async () => {
    const replay = deferred<unknown>();
    mount({ read: (asOf) => (asOf ? replay.promise : Promise.resolve(ok(policy))) });
    await pickInstant();
    fireEvent.click(button("Time-travel"));
    fireEvent.click(button("Back to current"));
    await waitFor(() => expect(button("Edit policy").disabled).toBe(false));
    replay.resolve(ok(pastPolicy));
    // Let the late answer land; it must not replace the current version.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText(/Version pol-v3 in force/)).toBeTruthy();
    expect(screen.queryByText(/Version pol-v2 in force/)).toBeNull();
    expect(button("Edit policy").disabled).toBe(false);
  });

  it("does not stay loading when a policy read is rejected by the network", async () => {
    let reads = 0;
    mount({
      read: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(ok(policy))
          : Promise.reject(new TypeError("Failed to fetch"));
      },
    });
    await pickInstant();
    fireEvent.click(button("Time-travel"));
    expect(await screen.findByText(/no answer came back/)).toBeTruthy();
  });
});

describe("safety policy — nothing outlives a dismissed editor", () => {
  it("reopens with an empty reason and without the last failure", async () => {
    mount({
      patch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await openEditor();
    fireEvent.change(within(drawer).getByLabelText("Why are you changing this?"), {
      target: { value: REASON },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save new version" }));
    await within(drawer).findByText(/No answer came back/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit the safety policy" })).toBeNull(),
    );
    const again = await openEditor();
    expect(
      (within(again).getByLabelText("Why are you changing this?") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(within(again).queryByText(/No answer came back/)).toBeNull();
  });
});
