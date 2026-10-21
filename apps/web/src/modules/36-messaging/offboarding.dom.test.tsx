// M36 WP 5.9 (ADR-0084, PROPOSED) - the offboarding screen: the checklist (state as a word plus a glyph, counts, "Done N of M"), the REQUIRED confirm
// before running (cancel sends nothing), the server's answer replacing the list, a failed row and a person-needs row staying visible, a stale
// step-up sending the officer to the step-up screen, the 401/403/404/409/error states, a bad id refused before any request, keyboard operation, axe.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { OffboardingDto, OffboardingItemDto, OffboardingItemKey } from "@chartwarden/types";
import { OFFBOARDING_ITEM_KEYS } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OffboardingWorkflow } from "./offboarding-workflow";

const USER = "99999999-9999-4999-8999-000000000009";
const URL_OK = `/messaging/governance/offboarding/${USER}`;

const item = (
  key: OffboardingItemKey,
  over: Partial<OffboardingItemDto> = {},
): OffboardingItemDto => ({
  key,
  state: "done",
  count: 0,
  acted: 0,
  needs_person: 0,
  ...over,
});

function dto(
  over: Partial<Record<OffboardingItemKey, Partial<OffboardingItemDto>>>,
): OffboardingDto {
  const items = OFFBOARDING_ITEM_KEYS.map((key) => item(key, over[key]));
  const blocked = items.filter((i) => ["pending", "needs_person", "failed"].includes(i.state));
  return {
    user_id: USER,
    items,
    done: items.filter((i) => i.state === "done" || i.state === "kept").length,
    total: items.length,
    complete: blocked.length === 0,
    blocked_by: blocked.map((i) => i.key),
  };
}

const PREVIEW = dto({
  sessions_devices: { state: "pending", count: 5 },
  ack_assigned: { state: "pending", count: 2 },
  ack_sent: { state: "kept", count: 1 },
  oncall_seats: { state: "advisory" },
  drafts: { state: "kept", count: 3 },
});

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (body: OffboardingDto): Reply => ({ data: body, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

function mount(handlers: { get: () => Reply; post?: () => Reply }, entry = URL_OK) {
  const GET = vi.fn((_path: string, _init?: unknown) => Promise.resolve(handlers.get()));
  const POST = vi.fn((_path: string, _init?: unknown) =>
    Promise.resolve(handlers.post?.() ?? fail(500)),
  );
  const PUT = vi.fn();
  const PATCH = vi.fn();
  const DELETE = vi.fn();
  const Where = () => (
    <output data-testid="where">{useLocation().pathname + useLocation().search}</output>
  );
  const view = render(
    <MemoryRouter initialEntries={[entry]}>
      <ApiClientProvider client={{ GET, POST, PUT, PATCH, DELETE } as unknown as ApiClient}>
        <main>
          <Routes>
            <Route
              path="/messaging/governance/offboarding/:userId"
              element={<OffboardingWorkflow />}
            />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
          <Where />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, writes: [PUT, PATCH, DELETE], ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OffboardingWorkflow", () => {
  it("shows the checklist: progress as text, every state as a word, counts, and the kept/advisory notes", async () => {
    const { GET } = mount({ get: () => ok(PREVIEW) });
    const list = await screen.findByRole("list", { name: "Offboarding checklist" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(OFFBOARDING_ITEM_KEYS.length);
    expect(screen.getByText("Done 8 of 11")).toBeTruthy();
    expect(screen.getByText(/Not complete: 2 items still need attention\./)).toBeTruthy();
    const sessions = rows[0] as HTMLElement;
    expect(within(sessions).getByText("Sessions and devices")).toBeTruthy();
    expect(within(sessions).getByText("To do")).toBeTruthy();
    expect(within(sessions).getByText("5 items left")).toBeTruthy();
    const sent = rows.find((r) =>
      within(r).queryByText("Requests this person sent"),
    ) as HTMLElement;
    expect(within(sent).getByText("Kept")).toBeTruthy();
    const oncall = rows.find((r) => within(r).queryByText("On-call seats")) as HTMLElement;
    expect(within(oncall).getByText("Check manually")).toBeTruthy();
    expect(screen.getByText(/Attribution is kept\. Messages are never deleted\./)).toBeTruthy();
    expect(GET).toHaveBeenCalledWith("/api/v1/messaging/governance/offboarding/{userId}", {
      params: { path: { userId: USER } },
    });
    expect(list.textContent).not.toContain(USER); // no id on the page
  });

  it("asks before running: cancel sends nothing; confirm runs, shows the server's answer and announces it", async () => {
    const after = dto({
      sessions_devices: { state: "done", acted: 5 },
      ack_assigned: { state: "needs_person", count: 1, acted: 1, needs_person: 1 },
    });
    const { POST } = mount({ get: () => ok(PREVIEW), post: () => ok(after) });
    fireEvent.click(await screen.findByRole("button", { name: "Run offboarding" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/ends every session and push notification/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(POST).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run offboarding" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run offboarding" }),
    );
    await waitFor(() => expect(screen.getByText("Needs a person")).toBeTruthy());
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/governance/offboarding/{userId}/execute", {
      params: { path: { userId: USER } },
    });
    expect(screen.getByText("Offboarding ran. The checklist shows what is left.")).toBeTruthy();
    expect(screen.getByText("Changed 1. 1 item left")).toBeTruthy();
    // The request nobody could take stays reachable: a link to the supervisors' queue, and the button now says "Run again".
    expect(
      (
        screen.getByRole("link", { name: "Open the unacknowledged queue" }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/messaging/unacknowledged");
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Offboarding checklist");
  });

  it("a failed row says so in words and the whole run can be repeated", async () => {
    mount({
      get: () => ok(PREVIEW),
      post: () => ok(dto({ handoffs: { state: "failed", count: 1 } })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run offboarding" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run offboarding" }),
    );
    expect(await screen.findByText("Failed, run again")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
  });

  it("an unknown run outcome re-reads the checklist so it shows what is true", async () => {
    const { GET } = mount({ get: () => ok(PREVIEW), post: () => fail(500) });
    fireEvent.click(await screen.findByRole("button", { name: "Run offboarding" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run offboarding" }),
    );
    await screen.findByRole("alert");
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
  });

  it("a complete checklist with a manual item still says what to check", async () => {
    mount({ get: () => ok(dto({ oncall_seats: { state: "advisory" } })) });
    expect(await screen.findByText(/1 item to check manually\./)).toBeTruthy();
  });

  it("a finished checklist says it is complete", async () => {
    mount({ get: () => ok(dto({ drafts: { state: "kept", count: 2 } })) });
    expect(await screen.findByText(/Complete: nothing is left for messaging to do\./)).toBeTruthy();
    expect(screen.getByText("Done 11 of 11")).toBeTruthy();
  });

  it("a request that could not be sent keeps the checklist and says so", async () => {
    mount({ get: () => ok(PREVIEW), post: () => fail(500) });
    fireEvent.click(await screen.findByRole("button", { name: "Run offboarding" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run offboarding" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The result of the run is unknown",
    );
    expect(screen.getByRole("list", { name: "Offboarding checklist" })).toBeTruthy();
  });

  it("a stale step-up sends the officer to the step-up screen and back", async () => {
    mount({
      get: () => ok(PREVIEW),
      post: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run offboarding" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run offboarding" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
  });

  it.each([
    [401, /session has ended/i],
    [403, /not permitted/i],
    [404, /was not found/i],
    [409, /has not left/i],
  ])("a %i on the read is said in a sentence, with no retry loop", async (status, text) => {
    const { GET } = mount({ get: () => fail(status) });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(GET).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Run offboarding" })).toBeNull();
  });

  it("a failed read offers Retry", async () => {
    let calls = 0;
    mount({ get: () => (++calls === 1 ? fail(500) : ok(PREVIEW)) });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Offboarding checklist" })).toBeTruthy();
  });

  it("refuses a malformed id before any request", () => {
    const { GET } = mount(
      { get: () => ok(PREVIEW) },
      "/messaging/governance/offboarding/not-an-id",
    );
    expect(screen.getByText(/was not found in your organization/)).toBeTruthy();
    expect(GET).not.toHaveBeenCalled();
  });

  it("is operable by keyboard: the run button is a native button that opens the confirm", async () => {
    mount({ get: () => ok(PREVIEW) });
    const run = (await screen.findByRole("button", {
      name: "Run offboarding",
    })) as HTMLButtonElement;
    run.focus();
    expect(document.activeElement).toBe(run);
    expect(run.tagName).toBe("BUTTON");
    fireEvent.click(run); // Enter/Space on a native button is a click
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("has no axe violations, with the checklist and with the confirm open", async () => {
    const { container } = mount({ get: () => ok(PREVIEW) });
    await screen.findByRole("list", { name: "Offboarding checklist" });
    expect((await axe.run(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Run offboarding" }));
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});
