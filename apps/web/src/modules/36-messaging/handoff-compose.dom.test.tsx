// M36 WP 3.5: the compose drawer. Caseload selection is capped at 50, pre-filled items are removable pointers, a source
// that could not be read is named, the recipient is required, and refusals map to field text without leaking a reason.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { HandoffComposeDialog } from "./handoff-compose-dialog";
import { HANDOFF_FIXTURE } from "./handoffs-test-fixture";

const patient = (n: number) => ({
  patient_id: `p${n}`,
  display_name: `Pat ${n}.`,
  mrn_suffix: String(1000 + n),
});

function mount(opts: { caseload?: unknown[]; prefill?: unknown; post?: unknown } = {}) {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/messaging/handoffs/caseload")
      return { data: { patients: opts.caseload ?? [patient(1), patient(2)] } };
    if (path === "/api/v1/messaging/handoffs/policy")
      return { data: { expiry_minutes: 120, platform_max_minutes: 240, customised: true } };
    if (path === "/api/v1/messaging/dm/staff")
      return {
        data: {
          staff: [
            { userId: "u1", displayName: "Me Myself", roles: [] },
            { userId: "u3", displayName: "Rae Covering", roles: [] },
          ],
        },
      };
    return { error: {}, response: { status: 404 } };
  });
  const POST = vi.fn(async (path: string) =>
    path === "/api/v1/messaging/handoffs/prefill"
      ? (opts.prefill ?? {
          data: {
            patients: [
              {
                patient_id: "p1",
                items: [
                  { kind: "patient", ref_id: "p1" },
                  { kind: "visit", ref_id: "v1", status: "scheduled" },
                ],
                unavailable_sources: ["refill_request"],
              },
            ],
          },
        })
      : ((opts.post as object) ?? { data: { handoff: HANDOFF_FIXTURE, created: true } }),
  );
  const onOffered = vi.fn();
  render(
    <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
      <HandoffComposeDialog meId="u1" onClose={vi.fn()} onOffered={onOffered} />
    </ApiClientProvider>,
  );
  return { GET, POST, onOffered };
}

async function loadWork() {
  await userEvent.click(await screen.findByRole("checkbox", { name: /Pat 1\./ }));
  await userEvent.click(screen.getByRole("button", { name: "Load open work (1)" }));
  await screen.findByText("Callbacks are not included in this version.");
}

describe("HandoffComposeDialog", () => {
  it("caps the selection at 50 patients", async () => {
    mount({ caseload: Array.from({ length: 60 }, (_, i) => patient(i + 1)) });
    await userEvent.click(await screen.findByRole("button", { name: "Select all" }));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.filter((box) => box.checked)).toHaveLength(50);
    expect(boxes.filter((box) => !box.checked).every((box) => box.disabled)).toBe(true);
    expect(screen.getByText("You can hand off up to 50 patients at once.")).toBeTruthy();
  });

  it("names a source that could not be read and keeps every other item removable", async () => {
    mount();
    await loadWork();
    expect(
      screen.getByText("Refill requests could not be loaded and are not included."),
    ).toBeTruthy();
    const visit = screen.getByRole("checkbox", { name: /Next visit: scheduled/ });
    expect((visit as HTMLInputElement).checked).toBe(true);
    await userEvent.click(visit);
    expect((visit as HTMLInputElement).checked).toBe(false);
  });

  it("states the expiry from the policy and that nobody is paged", async () => {
    mount();
    await loadWork();
    expect(await screen.findByText(/If not accepted within 2 hours/)).toBeTruthy();
    expect(screen.getByText(/Handoffs do not page anyone/)).toBeTruthy();
  });

  it("requires a recipient and offers exactly the kept items", async () => {
    const { POST, onOffered } = mount();
    await loadWork();
    await userEvent.click(screen.getByRole("checkbox", { name: /Next visit/ }));
    await userEvent.click(screen.getByRole("button", { name: "Offer handoff (1)" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Choose who this handoff is for.");
    expect(POST).toHaveBeenCalledTimes(1);

    const picker = screen.getByRole("list", { name: "Colleagues" });
    expect(await within(picker).findByRole("button", { name: "Rae Covering" })).toBeTruthy();
    expect(within(picker).queryByRole("button", { name: "Me Myself" })).toBeNull();
    await userEvent.click(within(picker).getByRole("button", { name: "Rae Covering" }));
    await userEvent.click(screen.getByRole("button", { name: "Offer handoff (1)" }));
    await waitFor(() => expect(onOffered).toHaveBeenCalledWith(HANDOFF_FIXTURE, true));
    expect(POST).toHaveBeenLastCalledWith("/api/v1/messaging/handoffs", {
      body: {
        to_user_id: "u3",
        items: [{ kind: "patient", ref_id: "p1", patient_id: "p1" }],
      },
    });
  });

  it("shows one generic recipient message for the uniform 422, with no reason", async () => {
    mount({
      post: { error: { error: { code: "HANDOFF_RECIPIENT_INVALID" } }, response: { status: 422 } },
    });
    await loadWork();
    const picker = screen.getByRole("list", { name: "Colleagues" });
    await userEvent.click(await within(picker).findByRole("button", { name: "Rae Covering" }));
    await userEvent.click(screen.getByRole("button", { name: /Offer handoff/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cannot receive this handoff/);
    expect(alert.textContent).not.toMatch(/part 2|consent|permission|caseload/i);
  });

  it("maps an item conflict to field text without data about the other offer", async () => {
    mount({
      post: { error: { error: { code: "HANDOFF_ITEM_CONFLICT" } }, response: { status: 409 } },
    });
    await loadWork();
    const picker = screen.getByRole("list", { name: "Colleagues" });
    await userEvent.click(await within(picker).findByRole("button", { name: "Rae Covering" }));
    await userEvent.click(screen.getByRole("button", { name: /Offer handoff/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /already part of another open handoff/,
    );
  });

  it("says politely when the caseload cannot be loaded", async () => {
    const GET = vi.fn().mockResolvedValue({ error: {}, response: { status: 404 } });
    render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <HandoffComposeDialog meId="u1" onClose={vi.fn()} onOffered={vi.fn()} />
      </ApiClientProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be started now/);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const GET = vi.fn().mockResolvedValue({ data: { patients: [] } });
    render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <HandoffComposeDialog meId="u1" onClose={onClose} onOffered={vi.fn()} />
      </ApiClientProvider>,
    );
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
