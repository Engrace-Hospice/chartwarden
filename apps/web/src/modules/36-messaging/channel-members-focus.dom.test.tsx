// M36 WP 2.11 round 5 — post-commit focus handoffs, empty list, announcements, and locked controls.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ChannelMembersDialog } from "./channel-members-dialog";

const MEMBERS = "/api/v1/messaging/channels/{id}/members";
const person = (id: string, name: string) => ({
  userId: id,
  displayName: name,
  role: "member",
  source: "manual",
});
const listOf = (...people: ReturnType<typeof person>[]) => ({
  data: { members: people },
  error: undefined,
});
const FAILURE = { data: undefined, error: { message: "x" }, response: { status: 500 } };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Reply = Record<string, unknown>;
function makeClient(handlers: {
  members?: () => Reply | Promise<Reply>;
  staff?: Array<{ userId: string; displayName: string; roles: string[] }>;
}) {
  return {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === MEMBERS
          ? (handlers.members?.() ?? listOf())
          : { data: { staff: handlers.staff ?? [] }, error: undefined },
      ),
    ),
    POST: vi.fn(() => Promise.resolve({ error: undefined })),
    DELETE: vi.fn(() => Promise.resolve({ error: undefined })),
  };
}
const provide = (api: ReturnType<typeof makeClient>, ui: React.ReactElement) => (
  <MemoryRouter>
    <ApiClientProvider client={api as unknown as ApiClient}>{ui}</ApiClientProvider>
  </MemoryRouter>
);
const dialog = (props: Partial<React.ComponentProps<typeof ChannelMembersDialog>> = {}) => (
  <ChannelMembersDialog channelId="ch-1" channelTitle="North" open onClose={() => {}} {...props} />
);

describe("focus after a successful Retry, outside act (the real scheduler)", () => {
  it("lands on the heading even though the commit that removes Retry comes later", async () => {
    const reply = deferred<Reply>();
    let calls = 0;
    const api = makeClient({
      members: () => {
        calls += 1;
        return calls === 1 ? FAILURE : (reply.promise as unknown as Reply);
      },
    });
    render(provide(api, dialog()));
    const retry = await screen.findByRole("button", { name: "Retry" });
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const before = env.IS_REACT_ACT_ENVIRONMENT;
    // No act(): updates after the await are batched and committed by the scheduler, as in the browser.
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      retry.focus();
      retry.click();
      reply.resolve(listOf(person("u-1", "Ann")));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Members" }));
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = before;
    }
  });
});

describe("reload failure after a successful change", () => {
  it("moves focus to Retry when the list is replaced by the error block", async () => {
    let calls = 0;
    const api = makeClient({
      members: () => {
        calls += 1;
        return calls === 1 ? listOf(person("u-1", "Ann")) : FAILURE;
      },
    });
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Ann" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(document.activeElement).toBe(retry));
  });
});

describe("a handoff left by a failed reload", () => {
  it("does not outlive the failure: a later Retry lands on the heading, not a stale row", async () => {
    let calls = 0;
    const three = listOf(person("u-1", "Ann"), person("u-2", "Bea"), person("u-3", "Cy"));
    const api = makeClient({
      members: () => {
        calls += 1;
        return calls === 2 ? FAILURE : three;
      },
    });
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Bea" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "Channel members" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Members" })),
    );
  });
});

describe("empty list, announcements and locked controls", () => {
  it("says there are no members instead of rendering an empty list", async () => {
    render(provide(makeClient({ members: () => listOf() }), dialog()));
    expect(await screen.findByText("No members yet")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Channel members" })).toBeNull();
  });

  it("announces removals and additions in an always-mounted status region", async () => {
    let members = listOf(person("u-1", "Ann"), person("u-2", "Bea"));
    const api = makeClient({
      members: () => members,
      staff: [{ userId: "u-9", displayName: "Zed", roles: [] }],
    });
    api.DELETE.mockImplementation(() => {
      members = listOf(person("u-2", "Bea"));
      return Promise.resolve({ error: undefined });
    });
    render(provide(api, dialog()));
    const status = await screen.findByRole("status", { name: "Member changes" });
    expect(status.textContent).toBe("");
    await userEvent.click(await screen.findByRole("button", { name: "Remove Ann" }));
    await waitFor(() => expect(status.textContent).toBe("Ann removed."));
    await screen.findByRole("option", { name: "Zed" });
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(status.textContent).toBe("Zed added."));
  });

  it("keeps Add aria-disabled and inert while the list is loading or failed", async () => {
    const api = makeClient({
      members: () => new Promise(() => {}),
      staff: [{ userId: "u-9", displayName: "Zed", roles: [] }],
    });
    const { unmount } = render(provide(api, dialog()));
    await screen.findByRole("option", { name: "Zed" });
    const add = screen.getByRole("button", { name: "Add" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(add);
    expect(api.POST).not.toHaveBeenCalled();
    unmount();
    const failing = makeClient({
      members: () => FAILURE,
      staff: [{ userId: "u-9", displayName: "Zed", roles: [] }],
    });
    render(provide(failing, dialog()));
    await screen.findByRole("option", { name: "Zed" });
    await screen.findByRole("alert");
    const addAfterFailure = screen.getByRole("button", { name: "Add" });
    expect(addAfterFailure.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(addAfterFailure);
    expect(failing.POST).not.toHaveBeenCalled();
  });

  it("clears the staff search results when the dialog is reopened", async () => {
    const api = makeClient({ staff: [{ userId: "u-9", displayName: "Zed", roles: [] }] });
    const { rerender } = render(provide(api, dialog()));
    await screen.findByRole("option", { name: "Zed" });
    api.GET.mockImplementation(
      (path: string) =>
        Promise.resolve(
          path === MEMBERS ? listOf() : new Promise(() => {}),
        ) as unknown as Promise<never>,
    );
    rerender(provide(api, dialog({ open: false })));
    rerender(provide(api, dialog({ open: true })));
    await screen.findByText("No members yet");
    expect(screen.queryByRole("option", { name: "Zed" })).toBeNull();
  });
});
