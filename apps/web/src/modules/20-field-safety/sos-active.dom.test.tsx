// @vitest-environment jsdom
// Acknowledging an SOS on the active board is a form on a list screen, so it opens as a drawer in the detail rail beside
// the board (the redesign's pattern): the board keeps polling and stays in view while the responder writes what they did.
// Cancel closes it and records nothing; the record button stays disabled until the account is long enough.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSosView } from "./safety-api";
import { ActiveSosScreen } from "./sos-active";

afterEach(cleanup);

const board: ActiveSosView = {
  fetchedAt: "2026-11-18T12:00:00.000Z",
  alerts: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      postedByMembershipId: "m-lopez",
      postedByFirstName: "Maya",
      postedAt: "2026-11-18T11:50:00.000Z",
      lifecycleState: "escalation_tier_1",
      minutesOpen: 10,
      acknowledgedAt: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      postedByMembershipId: "m-okafor",
      postedByFirstName: "Noor",
      postedAt: "2026-11-18T11:55:00.000Z",
      lifecycleState: "raised",
      minutesOpen: 5,
      acknowledgedAt: null,
    },
  ],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/safety/sos/active" ? ok(board) : ok({ version: 3 }),
    ),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ActiveSosScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const ACTION = "Reached the daughter on the number we hold and asked her to stay with the nurse.";
const ackOf = async (name: string): Promise<HTMLElement> => {
  const row = (await screen.findByText(name)).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Acknowledge" }));
  return screen.findByRole("complementary", { name: `Acknowledge ${name}'s SOS` });
};

describe("active SOS board — acknowledge an alert", () => {
  it("opens the form as a drawer beside the board, not a dialog over it", async () => {
    mount();
    const drawer = await ackOf("Maya");
    expect(within(drawer).getByLabelText("What did you do?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The board stays on the page, with the other alert still on it.
    expect(screen.getByText("Noor")).toBeTruthy();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const drawer = await ackOf("Maya");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Record acknowledgment disabled until the account says enough", async () => {
    mount();
    const drawer = await ackOf("Maya");
    const record = within(drawer).getByRole("button", {
      name: "Record acknowledgment",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: "Called her." },
    });
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    expect(record.disabled).toBe(false);
  });

  it("records the acknowledgment against the version read on open, then closes", async () => {
    const { post } = mount();
    const drawer = await ackOf("Maya");
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/safety/sos/{sosAlertId}/acknowledge");
    expect(call[1].body).toMatchObject({ actionTaken: ACTION });
    expect(call[1].headers["If-Match"]).toBe("3");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });

  it("starts a fresh form when another alert is opened while one is open", async () => {
    mount();
    const first = await ackOf("Maya");
    fireEvent.change(within(first).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    const second = await ackOf("Noor");
    expect((within(second).getByLabelText("What did you do?") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull();
  });
});
